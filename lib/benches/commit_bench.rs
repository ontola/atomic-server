//! Stage-level benchmarks for the commit hot path.
//!
//! Isolates clone / sign / apply costs that `lifecycle_bench` rolls into a
//! single create/edit number. See `planning/commit-performance.md`.
//!
//! Run with:
//! `cargo bench -p atomic_lib --bench commit_bench --features db-redb`

use atomic_lib::{urls, Db, Storelike, Subject, Value};
use criterion::{criterion_group, criterion_main, BenchmarkId, Criterion};

const BENCH_CLASS: &str = atomic_lib::urls::CLASS;

fn bench_props(j: usize) -> Option<Vec<(&'static str, Value)>> {
    Some(vec![(
        urls::SHORTNAME,
        Value::Slug(format!("bench-item-{j}")),
    )])
}

fn bench_commit_stages(c: &mut Criterion) {
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();

    let mut group = c.benchmark_group("commit_stages");
    group.sample_size(20);

    // --- Db::init_temp (ontology bootstrap dominates cold; template-copy after)
    group.bench_function("init_temp", |b| {
        b.iter_custom(|iters| {
            rt.block_on(async {
                // Warm the process-local template so we measure the common
                // (Nth call) path that tests actually hit in a suite.
                let _ = Db::init_temp("cb_init_warm").await.unwrap();
                let mut total = std::time::Duration::ZERO;
                for i in 0..iters {
                    let start = std::time::Instant::now();
                    let _ = Db::init_temp(&format!("cb_init_{i}")).await.unwrap();
                    total += start.elapsed();
                }
                total
            })
        })
    });

    // --- Resource::clone of a saved resource (live Loro doc present) --------
    // Before the fork() change this was export_snapshot + from_snapshot.
    group.bench_function("resource_clone_after_save", |b| {
        b.iter_custom(|iters| {
            rt.block_on(async {
                let store = Db::init_temp("cb_clone").await.unwrap();
                let (_agent, drive) = store.setup("Bench").await.unwrap();
                let did = store
                    .create_resource(BENCH_CLASS, &drive, "item", bench_props(0))
                    .await
                    .unwrap();
                let resource = store
                    .get_resource(&Subject::from(did))
                    .await
                    .unwrap();

                let start = std::time::Instant::now();
                for _ in 0..iters {
                    std::hint::black_box(resource.clone());
                }
                start.elapsed()
            })
        })
    });

    // --- save_locally edit (sign + apply_commit) on an existing resource ----
    for &history in &[1usize, 10, 50] {
        group.bench_with_input(
            BenchmarkId::new("edit_save_locally", history),
            &history,
            |b, &history| {
                b.iter_custom(|iters| {
                    rt.block_on(async {
                        let mut total = std::time::Duration::ZERO;
                        for i in 0..iters {
                            let store =
                                Db::init_temp(&format!("cb_edit_{history}_{i}")).await.unwrap();
                            let (_agent, drive) = store.setup("Bench").await.unwrap();
                            let did = store
                                .create_resource(BENCH_CLASS, &drive, "item", bench_props(0))
                                .await
                                .unwrap();

                            // Grow oplog history so snapshot-vs-delta cost shows up.
                            for h in 0..history {
                                let mut resource = store
                                    .get_resource(&Subject::from(did.clone()))
                                    .await
                                    .unwrap();
                                resource
                                    .set(
                                        urls::DESCRIPTION.into(),
                                        Value::Markdown(format!("warmup {h}")),
                                        &store,
                                    )
                                    .await
                                    .unwrap();
                                resource.save_locally(&store).await.unwrap();
                            }

                            let mut resource = store
                                .get_resource(&Subject::from(did))
                                .await
                                .unwrap();
                            resource
                                .set(
                                    urls::DESCRIPTION.into(),
                                    Value::Markdown("measured edit".into()),
                                    &store,
                                )
                                .await
                                .unwrap();

                            let start = std::time::Instant::now();
                            resource.save_locally(&store).await.unwrap();
                            total += start.elapsed();
                        }
                        total
                    })
                })
            },
        );
    }

    // --- loroUpdate payload size after N edits (correctness of incremental) -
    // Not a timing bench: asserts the signed commit carries a delta much
    // smaller than a full snapshot once history exists.
    group.bench_function("loro_update_is_incremental", |b| {
        b.iter_custom(|iters| {
            rt.block_on(async {
                let mut total = std::time::Duration::ZERO;
                for i in 0..iters {
                    let store = Db::init_temp(&format!("cb_delta_{i}")).await.unwrap();
                    let (_agent, drive) = store.setup("Bench").await.unwrap();
                    let did = store
                        .create_resource(BENCH_CLASS, &drive, "item", bench_props(0))
                        .await
                        .unwrap();

                    for h in 0..20 {
                        let mut resource = store
                            .get_resource(&Subject::from(did.clone()))
                            .await
                            .unwrap();
                        resource
                            .set(
                                urls::DESCRIPTION.into(),
                                Value::Markdown(format!("history {h} {}", "x".repeat(64))),
                                &store,
                            )
                            .await
                            .unwrap();
                        resource.save_locally(&store).await.unwrap();
                    }

                    let mut resource = store
                        .get_resource(&Subject::from(did))
                        .await
                        .unwrap();
                    let full_snapshot_len = resource
                        .materialized_state()
                        .map(|s| s.len())
                        .unwrap_or(0);
                    resource
                        .set(
                            urls::DESCRIPTION.into(),
                            Value::Markdown("small edit".into()),
                            &store,
                        )
                        .await
                        .unwrap();

                    let start = std::time::Instant::now();
                    let resp = resource.save_locally(&store).await.unwrap();
                    total += start.elapsed();

                    let delta_len = resp
                        .commit
                        .loro_update
                        .as_ref()
                        .map(|u| u.len())
                        .unwrap_or(0);
                    // Delta should be well under half a full snapshot once
                    // history is non-trivial. Factor-of-two is a soft guard
                    // against accidentally reverting to export_snapshot().
                    assert!(
                        delta_len < full_snapshot_len / 2 || full_snapshot_len < 200,
                        "loroUpdate len {delta_len} should be incremental vs snapshot {full_snapshot_len}"
                    );
                    std::hint::black_box((delta_len, full_snapshot_len));
                }
                total
            })
        })
    });

    group.finish();
}

criterion_group!(benches, bench_commit_stages);
criterion_main!(benches);
