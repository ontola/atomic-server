//! Benchmarks for Loro CRDT operations on Resources.
//! Run with: `cargo bench -p atomic_lib --bench loro_bench`

use atomic_lib::loro::AtomicLoroDoc;
use atomic_lib::values::Value;
use atomic_lib::Resource;
use criterion::{criterion_group, criterion_main, BenchmarkId, Criterion};

const STROKE_PROP: &str = "https://atomicdata.dev/ontology/canvas/strokeData";

fn sample_stroke(i: usize) -> serde_json::Value {
    serde_json::json!({
        "color": 4278190080u64 + (i as u64 % 256),
        "width": 3.0,
        "path": [[i as f64, i as f64 * 2.0], [i as f64 + 10.0, i as f64 * 2.0 + 10.0]]
    })
}

fn make_resource_with_strokes(n: usize) -> Resource {
    let mut r = Resource::new("did:ad:bench-canvas".to_string());
    r.set_unsafe(STROKE_PROP.into(), Value::JsonArray(vec![]))
        .unwrap();
    r.ensure_materialized().unwrap();
    for i in 0..n {
        r.push_list_item(STROKE_PROP, sample_stroke(i)).unwrap();
    }
    r
}

fn bench_loro_doc_init(c: &mut Criterion) {
    let mut group = c.benchmark_group("loro_doc_init");

    for &n in &[0, 10, 50, 200] {
        let r = make_resource_with_strokes(n);
        let snapshot = r.materialized_state().unwrap();

        group.bench_with_input(
            BenchmarkId::new("from_snapshot", n),
            &snapshot,
            |b, snap| {
                b.iter(|| {
                    AtomicLoroDoc::from_snapshot(snap).unwrap();
                });
            },
        );
    }

    for &n in &[0, 10, 50] {
        group.bench_with_input(
            BenchmarkId::new("ensure_materialized_from_propvals", n),
            &n,
            |b, &n| {
                b.iter_batched(
                    || {
                        let mut r = Resource::new("did:ad:bench".into());
                        r.set_unsafe(
                            STROKE_PROP.into(),
                            Value::JsonArray((0..n).map(sample_stroke).collect()),
                        )
                        .unwrap();
                        r
                    },
                    |mut r| {
                        r.ensure_materialized().unwrap();
                    },
                    criterion::BatchSize::SmallInput,
                );
            },
        );
    }

    group.finish();
}

fn bench_push_list_item(c: &mut Criterion) {
    let mut group = c.benchmark_group("push_list_item");

    for &existing in &[0, 10, 50, 200] {
        group.bench_with_input(
            BenchmarkId::new("push_one", existing),
            &existing,
            |b, &n| {
                b.iter_batched(
                    || make_resource_with_strokes(n),
                    |mut r| {
                        r.push_list_item(STROKE_PROP, sample_stroke(9999)).unwrap();
                    },
                    criterion::BatchSize::SmallInput,
                );
            },
        );
    }

    group.finish();
}

fn bench_delete_list_item(c: &mut Criterion) {
    let mut group = c.benchmark_group("delete_list_item");

    for &n in &[10, 50, 200] {
        group.bench_with_input(BenchmarkId::new("delete_middle", n), &n, |b, &n| {
            b.iter_batched(
                || make_resource_with_strokes(n),
                |mut r| {
                    r.delete_list_item(STROKE_PROP, n / 2).unwrap();
                },
                criterion::BatchSize::SmallInput,
            );
        });
    }

    group.finish();
}

fn bench_insert_list_item(c: &mut Criterion) {
    let mut group = c.benchmark_group("insert_list_item");

    for &n in &[10, 50, 200] {
        group.bench_with_input(BenchmarkId::new("insert_middle", n), &n, |b, &n| {
            b.iter_batched(
                || make_resource_with_strokes(n),
                |mut r| {
                    r.insert_list_item(STROKE_PROP, n / 2, sample_stroke(9999))
                        .unwrap();
                },
                criterion::BatchSize::SmallInput,
            );
        });
    }

    group.finish();
}

fn bench_undo_redo(c: &mut Criterion) {
    let mut group = c.benchmark_group("undo_redo");

    for &n in &[5, 20, 50] {
        group.bench_with_input(BenchmarkId::new("undo", n), &n, |b, &n| {
            b.iter_batched(
                || {
                    let mut r = Resource::new("did:ad:bench-undo".into());
                    r.set_unsafe(STROKE_PROP.into(), Value::JsonArray(vec![]))
                        .unwrap();
                    r.ensure_materialized().unwrap();
                    r.init_undo();
                    for i in 0..n {
                        r.push_list_item(STROKE_PROP, sample_stroke(i)).unwrap();
                    }
                    r
                },
                |mut r| {
                    r.undo().unwrap();
                },
                criterion::BatchSize::SmallInput,
            );
        });

        group.bench_with_input(BenchmarkId::new("redo", n), &n, |b, &n| {
            b.iter_batched(
                || {
                    let mut r = Resource::new("did:ad:bench-redo".into());
                    r.set_unsafe(STROKE_PROP.into(), Value::JsonArray(vec![]))
                        .unwrap();
                    r.ensure_materialized().unwrap();
                    r.init_undo();
                    for i in 0..n {
                        r.push_list_item(STROKE_PROP, sample_stroke(i)).unwrap();
                    }
                    r.undo().unwrap();
                    r
                },
                |mut r| {
                    r.redo().unwrap();
                },
                criterion::BatchSize::SmallInput,
            );
        });
    }

    group.finish();
}

fn bench_export_snapshot(c: &mut Criterion) {
    let mut group = c.benchmark_group("export_snapshot");

    for &n in &[10, 50, 200] {
        let r = make_resource_with_strokes(n);
        let snapshot = r.materialized_state().unwrap();
        let doc = AtomicLoroDoc::from_snapshot(&snapshot).unwrap();

        group.bench_with_input(BenchmarkId::new("export", n), &doc, |b, doc| {
            b.iter(|| {
                doc.export_snapshot();
            });
        });
    }

    group.finish();
}

fn bench_view_at(c: &mut Criterion) {
    let mut group = c.benchmark_group("view_at");

    for &n in &[10, 50, 200] {
        let mut r = make_resource_with_strokes(n);
        r.ensure_materialized().unwrap();
        let version = r.get_current_version().unwrap();

        group.bench_with_input(BenchmarkId::new("view_at", n), &version, |b, v| {
            b.iter(|| {
                r.view_at(v).unwrap();
            });
        });
    }

    group.finish();
}

criterion_group!(
    benches,
    bench_loro_doc_init,
    bench_push_list_item,
    bench_delete_list_item,
    bench_insert_list_item,
    bench_undo_redo,
    bench_export_snapshot,
    bench_view_at,
);
criterion_main!(benches);
