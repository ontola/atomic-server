//! Various benchmarks for atomic_lib.
//! Should be run using `cargo criterion` or `cargo bench --all-features`.
//! See contribute.md for more information.

use atomic_lib::utils::random_string;
use atomic_lib::*;
use criterion::{criterion_group, criterion_main, Criterion};
use tokio::runtime::Runtime;

fn random_atom_string() -> Atom {
    Atom::new(
        format!("https://localhost/{}", random_string(10)),
        urls::DESCRIPTION.into(),
        Value::Markdown(random_string(200)),
    )
}

fn random_subject() -> String {
    format!("https://localhost/{}", random_string(10))
}

fn random_array(n: usize) -> Vec<String> {
    (0..n).map(|_| random_subject()).collect()
}

fn random_atom_array() -> Atom {
    Atom::new(
        format!("https://localhost/{}", random_string(10)),
        urls::COLLECTION_MEMBERS.into(),
        random_array(200).into(),
    )
}

fn random_resource(atom: &Atom) -> Resource {
    let mut resource = Resource::new(atom.subject.clone());
    resource.set_unsafe(atom.property.clone(), atom.value.clone());
    resource
}

fn criterion_benchmark(c: &mut Criterion) {
    let rt = Runtime::new().unwrap();
    let store = rt.block_on(Db::init_temp("bench")).unwrap();

    let mut flushing = c.benchmark_group("IO bound benchmarks");
    flushing.significance_level(0.1).sample_size(10);

    flushing.bench_function("flush 100 resources", |b| {
        b.iter_batched(
            || {
                rt.block_on(async {
                    // SETUP: Create 100 dirty resources
                    for _ in 0..100 {
                        let resource = random_resource(&random_atom_string());
                        store
                            .add_resource_opts(&resource, true, true, false)
                            .await
                            .unwrap();
                    }
                })
            },
            |()| {
                // MEASURE: Only the flush
                store.flush().unwrap();
            },
            criterion::BatchSize::SmallInput,
        )
    });

    flushing.bench_function("resource.save() string", |b| {
        b.iter_custom(|iters| {
            rt.block_on(async {
                let mut total_duration = std::time::Duration::new(0, 0);
                let mut i = 0;
                let flush_interval = 100;

                while i < iters {
                    let batch_size = std::cmp::min(flush_interval, iters - i);

                    let start = std::time::Instant::now();
                    for _ in 0..batch_size {
                        let mut resource = random_resource(&random_atom_string());
                        resource.save_locally(&store).await.unwrap();
                    }
                    total_duration += start.elapsed();

                    store.flush().unwrap();
                    i += batch_size;
                }
                total_duration
            })
        })
    });

    flushing.bench_function("resource.save() array", |b| {
        b.iter_custom(|iters| {
            rt.block_on(async {
                let mut total_duration = std::time::Duration::new(0, 0);
                let mut i = 0;
                let flush_interval = 100;

                while i < iters {
                    let batch_size = std::cmp::min(flush_interval, iters - i);

                    let start = std::time::Instant::now();
                    for _ in 0..batch_size {
                        let mut resource = random_resource(&random_atom_array());
                        resource.save_locally(&store).await.unwrap();
                    }
                    total_duration += start.elapsed();

                    store.flush().unwrap();
                    i += batch_size;
                }
                total_duration
            })
        })
    });

    flushing.finish();

    let big_resource = rt
        .block_on(store.get_resource_extended(
            "https://localhost/collections",
            false,
            &agents::ForAgent::Public,
        ))
        .unwrap();

    c.bench_function("resource.to_json_ad()", |b| {
        b.iter(|| {
            big_resource.to_json_ad(None).unwrap();
        })
    });

    c.bench_function("resource.to_json_ld()", |b| {
        b.to_async(&rt).iter(|| async {
            big_resource.to_json_ld(&store).await.unwrap();
        })
    });

    c.bench_function("resource.to_json()", |b| {
        b.to_async(&rt).iter(|| async {
            big_resource.to_json(&store).await.unwrap();
        })
    });

    c.bench_function("resource.to_n_triples()", |b| {
        b.to_async(&rt).iter(|| async {
            big_resource.to_n_triples(&store).await.unwrap();
        })
    });

    let mut all_resources_group = c.benchmark_group("all_resources");
    all_resources_group.sample_size(10);

    all_resources_group.bench_function("all_resources()", |b| {
        b.iter(|| {
            let _all = store.all_resources(false).collect::<Vec<Resource>>();
        })
    });

    all_resources_group.finish();
    println!("Clearing store");
    // If this takes a long time, it probably means there is still a lot of data that needs to be flushed.
    store.clear_all_danger().unwrap();
    println!("Store cleared");
}

criterion_group!(benches, criterion_benchmark);
criterion_main!(benches);
