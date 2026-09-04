//! Full-text search scaling over the KV inverted index.
//!
//! Seeds N documents directly into the search trees (no commit signing) so
//! query latency is isolated from apply_commit cost, then measures:
//!
//! - **index_docs** — time to index N documents
//! - **query_exact** — exact title match among N docs
//! - **query_prefix** — 3-char typeahead
//! - **query_fuzzy** — 1-edit typo (`avacado` → `avocado`)
//!
//! N ∈ {1_000, 10_000, 50_000}.
//!
//! Run with:
//!
//! ```
//! cargo bench -p atomic_lib --bench search_bench --features db-redb
//! ```

use atomic_lib::{
    client::search::SearchOpts, search, urls, utils::random_string, Db, Resource, Value,
};
use criterion::{criterion_group, criterion_main, BenchmarkId, Criterion};
use std::time::Instant;

fn opts(drive: &str) -> SearchOpts {
    SearchOpts {
        parents: Some(vec![drive.to_string()]),
        limit: Some(10),
        ..Default::default()
    }
}

fn seed_search_docs(store: &Db, drive: &str, n: usize) {
    let mut resources = Vec::with_capacity(n);
    for i in 0..n {
        let mut resource = Resource::new(format!("did:ad:fts-bench:{i}"));
        let name = if i == n / 2 {
            "avocado unique".to_string()
        } else {
            format!("note number {i} filler")
        };
        resource
            .set_unsafe(urls::NAME.into(), Value::String(name))
            .unwrap();
        if i % 7 == 0 {
            resource
                .set_unsafe(
                    urls::DESCRIPTION.into(),
                    Value::Markdown(format!("description for note {i}")),
                )
                .unwrap();
        }
        resource
            .set_unsafe(urls::PARENT.into(), Value::AtomicUrl(drive.into()))
            .unwrap();
        resource
            .set_unsafe(urls::DRIVE_PROP.into(), Value::AtomicUrl(drive.into()))
            .unwrap();
        resources.push(resource);
    }
    search::index_resources(store, &resources, 2000).unwrap();
}

fn bench_search(c: &mut Criterion) {
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();

    let mut index_group = c.benchmark_group("search_index");
    index_group.sample_size(10);
    for &n in &[1_000usize, 10_000] {
        index_group.bench_with_input(BenchmarkId::from_parameter(n), &n, |b, &n| {
            b.iter_custom(|iters| {
                let mut total = std::time::Duration::ZERO;
                for _ in 0..iters {
                    let (store, drive) = rt.block_on(async {
                        let store = Db::init_temp(&format!("fts_idx_{n}_{}", random_string(6)))
                            .await
                            .unwrap();
                        let (_agent, drive) = store.setup("Bench").await.unwrap();
                        (store, drive)
                    });
                    let start = Instant::now();
                    seed_search_docs(&store, &drive, n);
                    total += start.elapsed();
                }
                total
            });
        });
    }
    index_group.finish();

    let mut query_group = c.benchmark_group("search_query");
    query_group.sample_size(20);
    for &n in &[1_000usize, 10_000, 50_000] {
        let (store, drive) = rt.block_on(async {
            let store = Db::init_temp(&format!("fts_q_{n}_{}", random_string(6)))
                .await
                .unwrap();
            let (_agent, drive) = store.setup("Bench").await.unwrap();
            (store, drive)
        });
        seed_search_docs(&store, &drive, n);
        let search_opts = opts(&drive);

        query_group.bench_with_input(BenchmarkId::new("exact", n), &n, |b, _| {
            b.iter(|| {
                let hits = search::query(&store, "avocado unique", &search_opts).unwrap();
                assert!(!hits.is_empty(), "exact match missing at n={n}");
                hits
            });
        });

        query_group.bench_with_input(BenchmarkId::new("prefix", n), &n, |b, _| {
            b.iter(|| {
                let hits = search::query(&store, "avo", &search_opts).unwrap();
                assert!(!hits.is_empty(), "prefix match missing at n={n}");
                hits
            });
        });

        query_group.bench_with_input(BenchmarkId::new("fuzzy", n), &n, |b, _| {
            b.iter(|| {
                let hits = search::query(&store, "avacado", &search_opts).unwrap();
                assert!(!hits.is_empty(), "fuzzy match missing at n={n}");
                hits
            });
        });
    }
    query_group.finish();
}

criterion_group!(benches, bench_search);
criterion_main!(benches);
