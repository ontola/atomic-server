//! Rights / hierarchy authorization benchmarks.
//!
//! The ACL-zones PR replaces the recursive parent walk in `check_rights` with
//! a nearest-zone-root lookup. Cost of a rights check should stop growing with
//! parent-chain depth once the resource carries a `drive` stamp / resolves to
//! a zone that is already near the root.
//!
//! Compare this branch against `develop` with the same fixture:
//!
//! ```text
//! cargo bench -p atomic_lib --bench rights_bench --features db-redb \
//!   -- --save-baseline <label>
//! ```
//!
//! Then point Criterion's HTML report (or the printed means) at both runs.

use atomic_lib::{
    agents::ForAgent,
    hierarchy::{check_rights, Right},
    urls, Db, Resource, Storelike, Subject, Value,
};
use criterion::{criterion_group, criterion_main, BenchmarkId, Criterion};

const BENCH_CLASS: &str = urls::CLASS;

fn shortname(j: usize) -> Option<Vec<(&'static str, Value)>> {
    Some(vec![(
        urls::SHORTNAME,
        Value::Slug(format!("rights-bench-{j}")),
    )])
}

/// Build Alice's drive with a linear parent chain of `depth` resources.
/// Returns `(store, leaf subject, alice agent subject)`.
async fn deep_chain(label: &str, depth: usize) -> (Db, Subject, String) {
    let store = Db::init_temp(label).await.expect("temp db");
    let (alice, drive) = store.setup("Alice").await.expect("setup");
    let mut parent: String = drive.to_string();
    for i in 0..depth {
        parent = store
            .create_resource(BENCH_CLASS, &parent, &format!("node {i}"), shortname(i))
            .await
            .expect("create child");
    }
    (store, parent.as_str().into(), alice.subject.to_string())
}

/// Many siblings under one drive — models collection/query readability filtering.
async fn wide_siblings(label: &str, n: usize) -> (Db, Vec<Subject>, String) {
    let store = Db::init_temp(label).await.expect("temp db");
    let (alice, drive) = store.setup("Alice").await.expect("setup");
    let drive_s = drive.to_string();
    let mut kids = Vec::with_capacity(n);
    for i in 0..n {
        let subject = store
            .create_resource(BENCH_CLASS, &drive_s, &format!("sib {i}"), shortname(i))
            .await
            .expect("create sibling");
        kids.push(subject.as_str().into());
    }
    (store, kids, alice.subject.to_string())
}

fn bench_rights(c: &mut Criterion) {
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();

    // --- Depth: how check_rights scales with parent-chain length ----------
    {
        let mut group = c.benchmark_group("rights_depth");
        group.sample_size(20);
        // Warm trees once per depth; measure hot checks only.
        for depth in [1usize, 5, 10, 25, 50] {
            let (store, leaf, alice) =
                rt.block_on(deep_chain(&format!("rights_depth_{depth}"), depth));
            let leaf_res = rt.block_on(store.get_resource(&leaf)).expect("load leaf");
            let agent: ForAgent = alice.as_str().into();
            let public = ForAgent::Public;

            group.bench_with_input(
                BenchmarkId::new("check_read_owner", depth),
                &depth,
                |b, _| {
                    b.to_async(&rt).iter(|| async {
                        check_rights(&store, &leaf_res, &agent, Right::Read)
                            .await
                            .expect("owner can read");
                    });
                },
            );

            group.bench_with_input(
                BenchmarkId::new("check_write_owner", depth),
                &depth,
                |b, _| {
                    b.to_async(&rt).iter(|| async {
                        check_rights(&store, &leaf_res, &agent, Right::Write)
                            .await
                            .expect("owner can write");
                    });
                },
            );

            group.bench_with_input(
                BenchmarkId::new("check_read_public_deny", depth),
                &depth,
                |b, _| {
                    b.to_async(&rt).iter(|| async {
                        let _ = check_rights(&store, &leaf_res, &public, Right::Read).await;
                    });
                },
            );
        }
        group.finish();
    }

    // --- Width: filter N siblings (query-style readability pass) ----------
    {
        let mut group = c.benchmark_group("rights_width");
        group.sample_size(15);
        for n in [50usize, 200, 1000] {
            let (store, kids, alice) = rt.block_on(wide_siblings(&format!("rights_width_{n}"), n));
            let resources: Vec<Resource> = rt.block_on(async {
                let mut out = Vec::with_capacity(kids.len());
                for s in &kids {
                    out.push(store.get_resource(s).await.expect("load sib"));
                }
                out
            });
            let agent: ForAgent = alice.as_str().into();

            group.bench_with_input(BenchmarkId::new("check_read_owner_all", n), &n, |b, _| {
                b.to_async(&rt).iter(|| async {
                    for r in &resources {
                        check_rights(&store, r, &agent, Right::Read)
                            .await
                            .expect("owner can read");
                    }
                });
            });
        }
        group.finish();
    }

    // --- Create path: genesis without inserting write[] (zones) vs with ---
    {
        let mut group = c.benchmark_group("rights_create");
        group.sample_size(12);
        const N: usize = 200;
        group.bench_function("create_200_under_drive", |b| {
            b.iter_custom(|iters| {
                rt.block_on(async {
                    let mut total = std::time::Duration::ZERO;
                    for i in 0..iters {
                        let store = Db::init_temp(&format!("rights_create_{i}")).await.unwrap();
                        let (_agent, drive) = store.setup("Bench").await.unwrap();
                        let start = std::time::Instant::now();
                        for j in 0..N {
                            store
                                .create_resource(
                                    BENCH_CLASS,
                                    &drive,
                                    &format!("item {j}"),
                                    shortname(j),
                                )
                                .await
                                .unwrap();
                        }
                        total += start.elapsed();
                    }
                    total
                })
            });
        });
        group.finish();
    }
}

criterion_group!(benches, bench_rights);
criterion_main!(benches);
