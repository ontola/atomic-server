//! Rust-level (no HTTP, no JSON-over-the-wire) benchmarks for the same
//! create / edit / history / query lifecycle phases the Node.js e2e benchmark
//! measures over HTTP (`atomic-nextgraph/benchmark/atomic/bench.mjs`). Since
//! everything here runs straight against `Db`/`Resource`, these isolate
//! library-level cost from network + actix + JSON-serialization overhead.
//!
//! The Node benchmark (1000 resources, real HTTP against a release build)
//! found:
//!   - create:  ~3.91ms/op
//!   - edit:    ~3.72ms/op
//!   - history: ~1.43ms/op (100 resources, >=6 commits each)
//!   - query:   ~159ms total for ONE collection fetch of all 1000 members
//!              (roughly 40x a single create/edit round trip)
//!
//! The `query_collection_1000` benchmark below is the one to scrutinize
//! hardest: it isolates whether that 40x asymmetry is inherent to the
//! query/collection-building logic itself or an artifact of the HTTP/JSON
//! layer sitting on top of it.
//!
//! Run with:
//! `cargo bench -p atomic_lib --bench lifecycle_bench --features db-redb`

use atomic_lib::{agents::ForAgent, storelike::Query, urls, Db, Storelike, Subject, Value};
use criterion::{criterion_group, criterion_main, Criterion};

/// `urls::CLASS` (the meta-class describing "Class") is used here purely as
/// a stand-in `isA` value, matching the existing `query_subscription_bench`'s
/// `create_child` helper. It resolves locally (populated by `Db::setup`), so
/// commit validation doesn't need to fetch an external class definition over
/// the network — unlike a synthetic `https://example.com/...` class URL,
/// which is not local and triggers a real HTTP fetch during validation.
const BENCH_CLASS: &str = atomic_lib::urls::CLASS;

const N: usize = 1000;

/// `urls::CLASS` requires a `shortname` — supply one at creation so later
/// `.set()` + `.save_locally()` calls (which re-validate required fields for
/// the resource's class) don't fail on a missing property unrelated to what
/// the benchmark is actually editing.
fn bench_props(j: usize) -> Option<Vec<(&'static str, Value)>> {
    Some(vec![(
        urls::SHORTNAME,
        Value::Slug(format!("bench-item-{j}")),
    )])
}

fn bench_lifecycle(c: &mut Criterion) {
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();

    let mut group = c.benchmark_group("lifecycle");
    // Each iteration creates/edits/queries N=1000 resources against a fresh
    // temp DB - keep the sample size small like the other db-redb benches.
    group.sample_size(10);

    // --- create: N resources, one at a time, via the DID genesis-commit path
    // (`Db::create_resource`), matching how the JS client creates resources
    // for a `did:ad:agent:...` subject (genesis cert signed per resource).
    group.bench_function("create_1000", |b| {
        b.iter_custom(|iters| {
            rt.block_on(async {
                let mut total = std::time::Duration::ZERO;
                for i in 0..iters {
                    let store = Db::init_temp(&format!("lc_create_{i}")).await.unwrap();
                    let (_agent, drive) = store.setup("Bench").await.unwrap();

                    let start = std::time::Instant::now();
                    for j in 0..N {
                        store
                            .create_resource(
                                BENCH_CLASS,
                                &drive,
                                &format!("item {j}"),
                                bench_props(j),
                            )
                            .await
                            .unwrap();
                    }
                    total += start.elapsed();
                }
                total
            })
        })
    });

    // --- edit: create N resources (unmeasured setup), then set a property +
    // save on each one (measured). Mirrors the Node benchmark's edit phase.
    group.bench_function("edit_1000", |b| {
        b.iter_custom(|iters| {
            rt.block_on(async {
                let mut total = std::time::Duration::ZERO;
                for i in 0..iters {
                    let store = Db::init_temp(&format!("lc_edit_{i}")).await.unwrap();
                    let (_agent, drive) = store.setup("Bench").await.unwrap();

                    let mut subjects = Vec::with_capacity(N);
                    for j in 0..N {
                        let did = store
                            .create_resource(
                                BENCH_CLASS,
                                &drive,
                                &format!("item {j}"),
                                bench_props(j),
                            )
                            .await
                            .unwrap();
                        subjects.push(did);
                    }

                    let start = std::time::Instant::now();
                    for subj in &subjects {
                        let mut resource = store
                            .get_resource(&Subject::from(subj.clone()))
                            .await
                            .unwrap();
                        resource
                            .set(
                                urls::DESCRIPTION.into(),
                                Value::Markdown("edited by bench".into()),
                                &store,
                            )
                            .await
                            .unwrap();
                        resource.save_locally(&store).await.unwrap();
                    }
                    total += start.elapsed();
                }
                total
            })
        })
    });

    // --- history: 100 resources, each with 6 commits (1 genesis + 5 edits),
    // then fetch full version history for each (measured phase only).
    group.bench_function("history_100x6_commits", |b| {
        b.iter_custom(|iters| {
            rt.block_on(async {
                let mut total = std::time::Duration::ZERO;
                for i in 0..iters {
                    let store = Db::init_temp(&format!("lc_history_{i}")).await.unwrap();
                    let (_agent, drive) = store.setup("Bench").await.unwrap();

                    let mut subjects = Vec::with_capacity(100);
                    for j in 0..100 {
                        let did = store
                            .create_resource(
                                BENCH_CLASS,
                                &drive,
                                &format!("item {j}"),
                                bench_props(j),
                            )
                            .await
                            .unwrap();
                        for k in 0..5 {
                            let mut resource = store
                                .get_resource(&Subject::from(did.clone()))
                                .await
                                .unwrap();
                            resource
                                .set(
                                    urls::DESCRIPTION.into(),
                                    Value::Markdown(format!("edit {k}")),
                                    &store,
                                )
                                .await
                                .unwrap();
                            resource.save_locally(&store).await.unwrap();
                        }
                        subjects.push(did);
                    }

                    let start = std::time::Instant::now();
                    for subj in &subjects {
                        let resource = store
                            .get_resource(&Subject::from(subj.clone()))
                            .await
                            .unwrap();
                        let versions = atomic_lib::history::versions(&resource).unwrap();
                        assert!(
                            versions.len() >= 6,
                            "expected >=6 commits, got {}",
                            versions.len()
                        );
                    }
                    total += start.elapsed();
                }
                total
            })
        })
    });

    // --- query: create N resources of the same class (unmeasured setup),
    // then run ONE collection query fetching all N members (measured). This
    // is the phase that showed a ~40x asymmetry vs. create/edit at the HTTP
    // level; timing it here shows whether that's inherent to the Rust
    // query/collection-building path or purely an HTTP/JSON artifact.
    group.bench_function("query_collection_1000", |b| {
        b.iter_custom(|iters| {
            rt.block_on(async {
                let mut total = std::time::Duration::ZERO;
                for i in 0..iters {
                    let store = Db::init_temp(&format!("lc_query_{i}")).await.unwrap();
                    let (_agent, drive) = store.setup("Bench").await.unwrap();

                    for j in 0..N {
                        store
                            .create_resource(
                                BENCH_CLASS,
                                &drive,
                                &format!("item {j}"),
                                bench_props(j),
                            )
                            .await
                            .unwrap();
                    }

                    let q = Query {
                        property: Some(urls::IS_A.to_string()),
                        value: Some(Value::AtomicUrl(BENCH_CLASS.to_string().into())),
                        limit: Some(N),
                        include_nested: true,
                        for_agent: ForAgent::Sudo,
                        drive: Some(Subject::from(drive.clone())),
                        ..Query::new()
                    };

                    let start = std::time::Instant::now();
                    let result = store.query(&q).await.unwrap();
                    total += start.elapsed();

                    assert_eq!(
                        result.subjects.len(),
                        N,
                        "query should return all {N} members"
                    );
                }
                total
            })
        })
    });

    // --- same as `query_collection_1000`, but `for_agent` is the actual
    // creating agent instead of `Sudo` — matching what a real HTTP request
    // does (`get_client_agent` resolves the caller's identity, never Sudo).
    // This exercises `hierarchy::check_rights`'s per-member permission walk,
    // including its "drive-first fast path" (`store.get_resource(&drive)`)
    // which re-fetches the *same* drive resource once per member with no
    // caching (see hierarchy.rs:229-239). Comparing this to
    // `query_collection_1000` isolates that per-member permission-check /
    // redundant-drive-fetch cost from the base per-member fetch cost.
    group.bench_function("query_collection_1000_non_sudo_agent", |b| {
        b.iter_custom(|iters| {
            rt.block_on(async {
                let mut total = std::time::Duration::ZERO;
                for i in 0..iters {
                    let store = Db::init_temp(&format!("lc_query_agent_{i}")).await.unwrap();
                    let (agent, drive) = store.setup("Bench").await.unwrap();

                    for j in 0..N {
                        store
                            .create_resource(
                                BENCH_CLASS,
                                &drive,
                                &format!("item {j}"),
                                bench_props(j),
                            )
                            .await
                            .unwrap();
                    }

                    let q = Query {
                        property: Some(urls::IS_A.to_string()),
                        value: Some(Value::AtomicUrl(BENCH_CLASS.to_string().into())),
                        limit: Some(N),
                        include_nested: true,
                        for_agent: ForAgent::AgentSubject(agent.subject.clone()),
                        drive: Some(Subject::from(drive.clone())),
                        ..Query::new()
                    };

                    let start = std::time::Instant::now();
                    let result = store.query(&q).await.unwrap();
                    total += start.elapsed();

                    assert_eq!(
                        result.subjects.len(),
                        N,
                        "query should return all {N} members"
                    );
                }
                total
            })
        })
    });

    group.finish();
}

criterion_group!(benches, bench_lifecycle);
criterion_main!(benches);
