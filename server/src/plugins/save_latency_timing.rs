//! Timing probe: does `Resource::save` slow down as the store fills with
//! commits? Ignored by default; run with
//! `cargo test --release -p atomic-server --lib save_latency_timing -- --ignored --nocapture`.

use std::time::{Duration, Instant};

use atomic_lib::{urls, Db, Resource, Storelike, Value};

use crate::plugins::test_fixture::{fixture, genesis};

const VIEW: &str = "https://atomicdata.dev/classes/View";
const TABLE_VIEWS: &str = "https://atomicdata.dev/properties/table-views";
const VIEW_KIND: &str = "https://atomicdata.dev/properties/view-kind";

fn summarize(label: &str, times: &[Duration]) {
    let mut sorted = times.to_vec();
    sorted.sort();
    let ms = |d: Duration| d.as_secs_f64() * 1000.0;
    let first: f64 = times.iter().take(20).map(|d| ms(*d)).sum::<f64>() / 20.0;
    let last: f64 = times.iter().rev().take(20).map(|d| ms(*d)).sum::<f64>() / 20.0;
    println!(
        "{label}: n={} first20={first:.1}ms last20={last:.1}ms p50={:.1}ms p99={:.1}ms",
        times.len(),
        ms(sorted[sorted.len() / 2]),
        ms(sorted[sorted.len() * 99 / 100]),
    );
}

async fn timed_save(resource: &mut Resource, store: &impl Storelike) -> Duration {
    let start = Instant::now();
    resource.save(store).await.unwrap();
    start.elapsed()
}

#[tokio::test]
#[ignore]
async fn save_latency_timing() {
    let f = fixture("save_latency_timing").await;
    run(&f.appstate.store, &f.drive).await;
}

/// Same workload on a bare `atomic_lib` store: no search/vector index, no
/// commit monitor, no class extenders.
#[tokio::test]
#[ignore]
async fn save_latency_timing_bare_db() {
    let store = Db::init_temp("save_latency_timing_bare_db").await.unwrap();
    atomic_lib::test_utils::setup_test_env(&store).await.unwrap();
    let drive = store
        .get_drive_did("localhost")
        .await
        .unwrap()
        .unwrap()
        .to_string();
    run(&store, &drive).await;
}

async fn run(store: &Db, drive: &str) {
    let f_drive = drive.to_string();

    let row_class = genesis(
        store,
        vec![
            (urls::IS_A, Value::ResourceArray(vec![urls::CLASS.into()])),
            (urls::PARENT, Value::AtomicUrl(f_drive.as_str().into())),
            (urls::SHORTNAME, Value::Slug("row".into())),
            (urls::DESCRIPTION, Value::Markdown("row".into())),
        ],
    )
    .await;
    let table = genesis(
        store,
        vec![
            (urls::IS_A, Value::ResourceArray(vec![urls::TABLE.into()])),
            (urls::PARENT, Value::AtomicUrl(f_drive.as_str().into())),
            (urls::NAME, Value::String("table".into())),
            (urls::CLASSTYPE_PROP, Value::AtomicUrl(row_class.as_str().into())),
        ],
    )
    .await;
    let view = genesis(
        store,
        vec![
            (urls::IS_A, Value::ResourceArray(vec![VIEW.into()])),
            (urls::PARENT, Value::AtomicUrl(table.as_str().into())),
            (urls::NAME, Value::String("view".into())),
        ],
    )
    .await;
    let mut table_resource = store.get_resource(&table.as_str().into()).await.unwrap();
    table_resource
        .set_unsafe(
            TABLE_VIEWS.into(),
            Value::ResourceArray(vec![view.as_str().into()]),
        )
        .unwrap();
    table_resource.save(store).await.unwrap();
    let row = genesis(
        store,
        vec![
            (urls::IS_A, Value::ResourceArray(vec![row_class.as_str().into()])),
            (urls::PARENT, Value::AtomicUrl(table.as_str().into())),
            (urls::NAME, Value::String("row".into())),
        ],
    )
    .await;

    let (mut names, mut kinds, mut rows, mut all) = (vec![], vec![], vec![], vec![]);
    for round in 0..3 {
        for i in 0..210 {
            let mut r = store.get_resource(&view.as_str().into()).await.unwrap();
            r.set_unsafe(urls::NAME.into(), Value::String(format!("view {round} {i}")))
                .unwrap();
            let t = timed_save(&mut r, store).await;
            names.push(t);
            all.push(t);
        }
        for i in 0..210 {
            let mut r = store.get_resource(&view.as_str().into()).await.unwrap();
            let kind = if i % 2 == 0 { "table" } else { "board" };
            r.set_unsafe(VIEW_KIND.into(), Value::String(kind.into()))
                .unwrap();
            let t = timed_save(&mut r, store).await;
            kinds.push(t);
            all.push(t);
        }
        for i in 0..210 {
            let mut r = store.get_resource(&row.as_str().into()).await.unwrap();
            r.set_unsafe(urls::NAME.into(), Value::String(format!("row {round} {i}")))
                .unwrap();
            let t = timed_save(&mut r, store).await;
            rows.push(t);
            all.push(t);
        }
    }
    summarize("view name", &names);
    summarize("view kind", &kinds);
    summarize("row name", &rows);
    summarize("all", &all);
    // Per-100 buckets, to see the shape of the growth.
    for (i, chunk) in all.chunks(105).enumerate() {
        let avg = chunk.iter().map(|d| d.as_secs_f64() * 1000.0).sum::<f64>() / chunk.len() as f64;
        println!("bucket {i}: {avg:.1}ms");
    }
}
