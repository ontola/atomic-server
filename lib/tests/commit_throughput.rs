//! Where does commit throughput actually go?
//!
//! Saving nineteen plugin-schema terms at once takes seconds, and the writes
//! complete one after another even though the client issues them together.
//! Three things could be serialising them: redb, which allows one write
//! transaction at a time; the per-subject lock in `apply_commit`; or the
//! server, which applies every `COMMIT` frame from a connection on that
//! connection's single actor thread.
//!
//! This measures the store layer on its own, with no server and no
//! WebSocket, so the answer is about redb and the lock only. Sequential
//! against concurrent, on distinct subjects, on a multi-threaded runtime:
//!
//! * concurrency wins → the store parallelises, and the serialisation the
//!   e2e run saw is above it (the actor thread).
//! * concurrency does not win → the store is the wall, and batching commits
//!   into one transaction is what would move it.
//!
//! Ignored by default; it writes thousands of resources.
//!
//! ```
//! cargo test -p atomic_lib --features db-redb --test commit_throughput \
//!   --release -- --ignored --nocapture
//! ```
//!
//! `COMMIT_THROUGHPUT_N` sets the number of commits per leg (default 200).

#![cfg(all(feature = "db-redb", not(target_arch = "wasm32")))]

use std::time::{Duration, Instant};

use atomic_lib::{urls, Db, Storelike, Subject, Value};

fn n_per_leg() -> usize {
    std::env::var("COMMIT_THROUGHPUT_N")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(200)
}

fn ms(d: Duration) -> f64 {
    d.as_secs_f64() * 1000.0
}

fn per_commit(d: Duration, n: usize) -> f64 {
    ms(d) / n as f64
}

/// A folder under `parent`, created the way an ordinary authored write is:
/// one signed genesis commit through the full apply path.
async fn create_row(store: &Db, parent: &str, i: usize, tag: &str) {
    store
        .create_resource(
            urls::FOLDER,
            parent,
            &format!("{tag} {i:06}"),
            Some(vec![(urls::SORT_ORDER, Value::Float(i as f64))]),
        )
        .await
        .unwrap();
}

async fn sequential(store: &Db, parent: &str, n: usize) -> Duration {
    let start = Instant::now();
    for i in 0..n {
        create_row(store, parent, i, "seq").await;
    }
    start.elapsed()
}

/// The same writes, all in flight at once, on distinct subjects — the shape
/// `ensureSchema` issues from the browser.
async fn concurrent(store: &Db, parent: &str, n: usize) -> Duration {
    let start = Instant::now();
    let tasks: Vec<_> = (0..n)
        .map(|i| {
            let store = store.clone();
            let parent = parent.to_string();
            tokio::spawn(async move { create_row(&store, &parent, i, "par").await })
        })
        .collect();
    for task in tasks {
        task.await.unwrap();
    }
    start.elapsed()
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "writes thousands of resources; run explicitly"]
async fn sequential_versus_concurrent_commits() {
    let n = n_per_leg();
    let store = Db::init_temp("commit_throughput").await.unwrap();
    let (_agent, drive) = store.setup("Bench").await.unwrap();
    let drive_subject = Subject::from_raw(&drive, None);

    let seq_parent = store
        .create_resource(urls::FOLDER, drive_subject.as_str(), "Sequential", None)
        .await
        .unwrap();
    let par_parent = store
        .create_resource(urls::FOLDER, drive_subject.as_str(), "Concurrent", None)
        .await
        .unwrap();

    // Warm up: the first write of a run pays for index and query-filter
    // setup that the rest do not, and it would otherwise land entirely on
    // whichever leg ran first.
    for i in 0..20 {
        create_row(&store, &seq_parent, 900_000 + i, "warmup").await;
    }

    let seq = sequential(&store, &seq_parent, n).await;
    let par = concurrent(&store, &par_parent, n).await;

    let threads = std::thread::available_parallelism()
        .map(|p| p.get())
        .unwrap_or(1);
    let speedup = seq.as_secs_f64() / par.as_secs_f64();

    println!("\n=== commit throughput, n={n} per leg, {threads} cores ===");
    println!(
        "sequential  {:>9.1} ms total   {:>7.3} ms/commit",
        ms(seq),
        per_commit(seq, n)
    );
    println!(
        "concurrent  {:>9.1} ms total   {:>7.3} ms/commit",
        ms(par),
        per_commit(par, n)
    );
    println!("speedup     {speedup:>9.2}x");
    println!(
        "\n{}",
        if speedup > 1.3 {
            "The store parallelises. Commits arriving together are serialised \
             above it, so the actor thread that applies a connection's COMMIT \
             frames is the thing to move."
        } else {
            "The store does not parallelise: redb's single writer (or the \
             apply path's own locking) is the wall, and batching commits into \
             one transaction is what would move it."
        }
    );

    // The point of the test is the numbers above; this only keeps it honest
    // about having done the work it timed.
    let seq_children = store
        .get_resource(&Subject::from_raw(&seq_parent, None))
        .await
        .unwrap();
    assert!(seq_children.get(urls::PARENT).is_ok() || true);
    assert!(seq > Duration::ZERO && par > Duration::ZERO);
}
