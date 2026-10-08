//! Timing of OR / path filters against the AND-only index path on ~10k
//! resources. Ignored by default (it creates 10k signed commits).
//! Run: cargo test -p atomic_lib --features db-redb --test query_composite_perf --release -- --ignored --nocapture
#![cfg(feature = "db-redb")]

use atomic_lib::{
    storelike::{CompositeFilter, PathFilter, Query, ValueIn},
    urls, Db, Storelike, Subject, Value,
};
use std::time::Instant;

fn names_in(property: &str, values: &[&str]) -> ValueIn {
    ValueIn {
        property: property.into(),
        values: values.iter().map(|v| Value::String((*v).into())).collect(),
    }
}

async fn timed(label: &str, store: &Db, q: &Query) {
    let t = Instant::now();
    let first = store.query(q).await.unwrap();
    let cold = t.elapsed();
    let runs = 20;
    let mut samples = Vec::new();
    for _ in 0..runs {
        let t = Instant::now();
        let r = store.query(q).await.unwrap();
        assert_eq!(r.count, first.count);
        samples.push(t.elapsed());
    }
    samples.sort();
    println!(
        "{label:<34} hits={:<5} first={:>9.2?} median={:>9.2?}",
        first.count,
        cold,
        samples[runs / 2]
    );
}

#[tokio::test]
#[ignore]
async fn composite_filters_on_10k_resources() {
    let store = Db::init_temp("composite_perf").await.unwrap();
    let (_agent, drive) = store.setup("Alice").await.unwrap();

    let t = Instant::now();
    let mut folders = Vec::new();
    for f in 0..100 {
        let folder = store
            .create_resource(urls::FOLDER, &drive, &format!("F{f}"), None)
            .await
            .unwrap();
        for i in 0..100 {
            store
                .create_resource(urls::FOLDER, &folder, &format!("t{f}-{i}"), None)
                .await
                .unwrap();
        }
        folders.push(folder);
    }
    println!("created 10100 resources in {:.2?}", t.elapsed());

    let base = || Query {
        drive: Some(Subject::from(drive.clone())),
        sort_by: Some(urls::NAME.into()),
        include_nested: false,
        ..Query::new()
    };

    // The AND-only path (unchanged code): children of one folder.
    let mut and_q = base();
    and_q.property = Some(urls::PARENT.into());
    and_q.value = Some(Value::AtomicUrl(folders[3].clone().into()));
    timed("AND only: parent = F3", &store, &and_q).await;

    let mut or_q = base();
    or_q.composite = CompositeFilter {
        value_in: vec![names_in(urls::NAME, &["t1-1", "t50-50", "t99-99"])],
        paths: vec![],
    };
    timed("OR: name IN (3 values)", &store, &or_q).await;

    let mut path_q = base();
    path_q.composite = CompositeFilter {
        value_in: vec![],
        paths: vec![PathFilter {
            via: urls::PARENT.into(),
            target: names_in(urls::NAME, &["F3", "F7"]),
        }],
    };
    timed("path: parent.name IN (F3,F7)", &store, &path_q).await;

    let mut path_one = base();
    path_one.limit = Some(30);
    path_one.composite = path_q.composite.clone();
    timed("path, page of 30", &store, &path_one).await;

    // Baseline a path filter replaces: walk everything.
    let t = Instant::now();
    let mut hits = 0;
    for r in store.all_resources(false) {
        if let Ok(p) = r.get(urls::PARENT) {
            if let Ok(parent) = store.get_resource_shallow(&Subject::from(p.to_string())) {
                if matches!(parent.get(urls::NAME).map(|n| n.to_string()), Ok(n) if n == "F3" || n == "F7")
                {
                    hits += 1;
                }
            }
        }
    }
    println!(
        "{:<34} hits={hits:<5} (full scan)      {:>9.2?}",
        "naive scan: parent.name IN (F3,F7)",
        t.elapsed()
    );
}
