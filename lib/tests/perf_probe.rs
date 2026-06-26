//! Fast, observable perf probe to pin down where commit time goes.
//! Run: cargo test -p atomic_lib --features db-redb --test perf_probe -- --nocapture
#![cfg(feature = "db-redb")]

use atomic_lib::{db::QueryFilter, urls, Db, Subject, Value};
use std::time::Instant;

async fn time_commits(store: &Db, parent: &str, n: usize, label: &str) {
    // Warm up one commit (first commit pays one-time costs).
    store
        .create_resource(urls::CLASS, parent, "warmup", None)
        .await
        .unwrap();

    let start = Instant::now();
    for i in 0..n {
        store
            .create_resource(urls::CLASS, parent, &format!("{label}-{i}"), None)
            .await
            .unwrap();
    }
    let elapsed = start.elapsed();
    eprintln!(
        "[PROBE] {label}: {n} commits in {:?} => {:.2} ms/commit ({:.0} commits/sec)",
        elapsed,
        elapsed.as_secs_f64() * 1000.0 / n as f64,
        n as f64 / elapsed.as_secs_f64(),
    );
}

async fn seed_filters(store: &Db, drive: &Subject, count: usize) {
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

#[tokio::test]
async fn probe_commit_cost_vs_watched_filters() {
    let parent = "did:ad:bench:hot_parent";

    for &n in &[0usize, 500, 2000] {
        let store = Db::init_temp(&format!("probe_n{n}")).await.unwrap();
        let (_agent, drive_str) = store.setup("Alice").await.unwrap();
        let drive = Subject::from(drive_str);

        eprintln!("[PROBE] --- seeding {n} watched filters ---");
        let seed_start = Instant::now();
        seed_filters(&store, &drive, n).await;
        eprintln!("[PROBE] seeded {n} filters in {:?}", seed_start.elapsed());

        time_commits(&store, parent, 100, &format!("watched={n}")).await;
    }
}

#[tokio::test]
async fn probe_flush_vs_no_flush() {
    // Isolate fsync: time commits, then an explicit flush, separately.
    let store = Db::init_temp("probe_flush").await.unwrap();
    let (_agent, _drive) = store.setup("Alice").await.unwrap();
    let parent = "did:ad:bench:hot_parent";

    let start = Instant::now();
    for i in 0..100 {
        store
            .create_resource(urls::CLASS, parent, &format!("noflush-{i}"), None)
            .await
            .unwrap();
    }
    let commit_time = start.elapsed();

    let flush_start = Instant::now();
    store.flush().unwrap();
    let flush_time = flush_start.elapsed();

    eprintln!(
        "[PROBE] 100 commits (no explicit flush): {:?} ({:.2} ms/commit); then one flush(): {:?}",
        commit_time,
        commit_time.as_secs_f64() * 1000.0 / 100.0,
        flush_time,
    );
}
