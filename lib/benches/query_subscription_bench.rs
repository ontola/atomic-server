//! Benchmarks for query-subscription scaling.
//!
//! These exercise the lib-level hot paths the live-query system runs through
//! on every commit:
//!
//! - **Drive-prefix scan of `Tree::WatchedQueries`.** `add_atom_to_index`
//!   calls `check_if_atom_matches_watched_query_filters`, which scans every
//!   watched filter that's scoped to the commit's drive (v3 encoding). For
//!   each, it msgpack-decodes the filter and runs `should_update_property`.
//!   The scan cost is roughly O(N_watched_in_drive × atoms_per_commit).
//! - **Membership-event emission.** After `apply_transaction` succeeds, the
//!   new code scans the transaction's `Tree::QueryMembers` ops and broadcasts
//!   one `DbEvent::QueryMembershipChanged` per op. Every matched filter
//!   produces an op, so this scales with the number of *matched* filters per
//!   commit, not just registered filters.
//! - **`QueryFilter::watch` registration.** A KV insert into
//!   `Tree::WatchedQueries`, plus encoding the filter. Scales the size of
//!   the tree.
//!
//! Three scenarios:
//!
//! 1. `commit_vs_watched_count` — N filters with *distinct* values. Each
//!    new commit matches at most one. Reveals the pure scan cost.
//! 2. `fanout_same_target` — N filters all matching the same parent. Every
//!    new commit fans out to N matches. Reveals the per-match update +
//!    event-emission cost.
//! 3. `watch_filter_registration` — register filter N+1 against a tree
//!    that already has N. Tests subscription throughput on a busy server.
//!
//! Run with:
//!
//! ```
//! cargo bench -p atomic_lib --bench query_subscription_bench --features db-redb
//! ```

use atomic_lib::{db::QueryFilter, urls, utils::random_string, Db, Subject, Value};
use criterion::{criterion_group, criterion_main, BenchmarkId, Criterion};

/// Build a child resource and create-commit it under `parent`. `update_index`
/// is on, so this is exactly the path a real /commit goes through.
async fn create_child(store: &Db, parent: &str, name: &str) {
    store
        .create_resource(urls::CLASS, parent, name, None)
        .await
        .expect("create_resource");
}

/// Seed the WatchedQueries tree with `count` filters that all live in
/// `drive` but each target a *distinct* parent — so any single commit
/// matches at most one of them. Tests the scan-and-reject path.
async fn seed_distinct_parent_filters(store: &Db, drive: &Subject, count: usize) {
    for i in 0..count {
        let f = QueryFilter {
            property: Some(urls::PARENT.to_string()),
            value: Some(Value::String(format!("did:ad:bench:parent:{i}"))),
            sort_by: Some(urls::NAME.to_string()),
            drive: drive.clone(),
        };
        f.watch(store).expect("watch");
    }
}

/// Seed `count` filters that all match the *same* `target_parent`,
/// differing only in `sort_by` (so they encode to distinct keys in
/// `Tree::WatchedQueries`). Tests the fan-out case where one commit
/// matches every registered filter.
async fn seed_same_target_filters(store: &Db, drive: &Subject, target_parent: &str, count: usize) {
    for i in 0..count {
        let f = QueryFilter {
            property: Some(urls::PARENT.to_string()),
            value: Some(Value::String(target_parent.to_string())),
            sort_by: Some(format!("https://example.com/bench/sort/{i}")),
            drive: drive.clone(),
        };
        f.watch(store).expect("watch");
    }
}

fn bench_query_subscriptions(c: &mut Criterion) {
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();

    let mut group = c.benchmark_group("query_subscriptions");
    group.sample_size(20);

    // Scenario 1: distinct-parent filters. Each commit matches at most one.
    // Cost should be dominated by the prefix-scan + decode loop in
    // `check_if_atom_matches_watched_query_filters`. Expected: roughly
    // linear in N for the per-commit time.
    for &n in &[0usize, 100, 1_000, 10_000] {
        group.bench_with_input(
            BenchmarkId::new("commit_vs_watched_count", n),
            &n,
            |b, &n| {
                b.iter_custom(|iters| {
                    rt.block_on(async {
                        let store = Db::init_temp(&format!("qs_n{n}_{}", random_string(4)))
                            .await
                            .unwrap();
                        let (_agent, drive_str) = store.setup("Alice").await.unwrap();
                        let drive = Subject::from(drive_str);

                        // Materialise the parent resource so commits can reference it
                        // without tripping any "parent missing" validation paths.
                        // Use parent index 0 so exactly one watched filter (the one
                        // with value="...:parent:0") matches each child commit.
                        let parent_subject = "did:ad:bench:parent:0";

                        seed_distinct_parent_filters(&store, &drive, n).await;

                        let start = std::time::Instant::now();
                        for i in 0..iters {
                            create_child(&store, parent_subject, &format!("child {i}")).await;
                        }
                        start.elapsed()
                    })
                })
            },
        );
    }

    // Scenario 2: fan-out — every filter matches every commit. Each commit
    // produces N `update_indexed_member` calls inside the index transaction
    // and N `DbEvent::QueryMembershipChanged` broadcasts after the apply.
    // Expected: per-commit time grows linearly with N, with a steeper slope
    // than scenario 1 (more index writes + more events per commit).
    for &n in &[0usize, 100, 1_000, 10_000] {
        group.bench_with_input(BenchmarkId::new("fanout_same_target", n), &n, |b, &n| {
            b.iter_custom(|iters| {
                rt.block_on(async {
                    let store = Db::init_temp(&format!("qs_fan_n{n}_{}", random_string(4)))
                        .await
                        .unwrap();
                    let (_agent, drive_str) = store.setup("Alice").await.unwrap();
                    let drive = Subject::from(drive_str);
                    let parent = "did:ad:bench:hot_parent";

                    seed_same_target_filters(&store, &drive, parent, n).await;

                    let start = std::time::Instant::now();
                    for i in 0..iters {
                        create_child(&store, parent, &format!("fan child {i}")).await;
                    }
                    start.elapsed()
                })
            })
        });
    }

    // Scenario 3: registration throughput. How fast can we add filter N+1
    // given that N already exist? The KV insert into `Tree::WatchedQueries`
    // is a redb point write — should be O(log N) with constant overhead
    // from the encoding. If it grows worse than that, we have a problem.
    for &n in &[0usize, 1_000, 10_000] {
        group.bench_with_input(
            BenchmarkId::new("watch_filter_registration", n),
            &n,
            |b, &n| {
                b.iter_custom(|iters| {
                    rt.block_on(async {
                        let store = Db::init_temp(&format!("qs_reg_n{n}_{}", random_string(4)))
                            .await
                            .unwrap();
                        let (_agent, drive_str) = store.setup("Alice").await.unwrap();
                        let drive = Subject::from(drive_str);

                        seed_distinct_parent_filters(&store, &drive, n).await;

                        let start = std::time::Instant::now();
                        for i in 0..iters {
                            // Use values from a high range so they don't collide with
                            // the seeded filters and we genuinely pay the insert cost.
                            let f = QueryFilter {
                                property: Some(urls::PARENT.to_string()),
                                value: Some(Value::String(format!(
                                    "did:ad:bench:fresh:{}",
                                    n + i as usize
                                ))),
                                sort_by: Some(urls::NAME.to_string()),
                                drive: drive.clone(),
                            };
                            f.watch(&store).expect("watch");
                        }
                        start.elapsed()
                    })
                })
            },
        );
    }

    group.finish();
}

criterion_group!(benches, bench_query_subscriptions);
criterion_main!(benches);
