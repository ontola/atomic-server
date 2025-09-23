//! Benchmarks for DB bootstrap (populate base models + default store).
//! Run with: `cargo bench -p atomic_lib --bench populate_bench --features db-redb`

use criterion::{criterion_group, criterion_main, Criterion};

fn bench_populate(c: &mut Criterion) {
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();

    let mut group = c.benchmark_group("populate");
    group.sample_size(10);

    group.bench_function("bootstrap", |b| {
        b.iter_custom(|iters| {
            rt.block_on(async {
                let mut total = std::time::Duration::ZERO;
                for i in 0..iters {
                    let store = atomic_lib::Db::init_temp(&format!("pop_{i}")).await.unwrap();
                    let start = std::time::Instant::now();
                    atomic_lib::populate::bootstrap(&store).await.unwrap();
                    total += start.elapsed();
                }
                total
            })
        })
    });

    group.finish();
}

criterion_group!(benches, bench_populate);
criterion_main!(benches);
