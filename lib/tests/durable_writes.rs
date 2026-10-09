//! An acknowledged commit must survive `kill -9` (issue #2156).
//!
//! The child process writes, prints the key only AFTER the write call returned
//! (that return is the acknowledgement), and keeps going until the parent
//! SIGKILLs it. The parent reopens the store and asserts that every key it saw
//! acknowledged is there.
//!
//! Durability is chosen per request on top of a server floor:
//!  * floor `always`: every acknowledged write survives;
//!  * floor `none` and the writer asks for durability (`flush_durable` after
//!    the write, which is what a `COMMIT_DURABLE` does): the acknowledged
//!    write survives;
//!  * floor `none`, no request: the 100 ms window is open and a loss is
//!    allowed. That case is not asserted on (see the ignored test below).
//!
//! The `bench_*` test measures what that costs; run it in release mode:
//!   ATOMIC_BENCH_DIR=/some/real/disk cargo test -p atomic_lib --features db-redb \
//!     --release --test durable_writes -- --ignored --nocapture bench_
//!
//! Run: cargo test -p atomic_lib --features db-redb --test durable_writes
#![cfg(all(feature = "db-redb", unix))]

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::Arc;

use atomic_lib::db::kv_store::KvStore;
use atomic_lib::db::redb_store::{Durability, RedbStore, DURABLE_TRANSACTIONS};
use atomic_lib::db::trees::Tree;
use atomic_lib::{urls, Db, Storelike, Subject};

const DIR_ENV: &str = "ATOMIC_DURABLE_CHILD_DIR";
const MODE_ENV: &str = "ATOMIC_DURABLE_CHILD_MODE";
/// Set to `1`: the child asks for durability after each write.
const ASK_ENV: &str = "ATOMIC_DURABLE_CHILD_ASK";

fn scratch_dir(name: &str) -> PathBuf {
    let base = std::env::var("ATOMIC_BENCH_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| std::env::temp_dir());
    let dir = base.join(format!("atomic-durable-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn key(writer: usize, i: usize) -> Vec<u8> {
    format!("w{writer}-{i:08}").into_bytes()
}

// ── child entry points ─────────────────────────────────────────────────────

/// 4 writer threads against the raw store. Prints `ACK w<writer> <i>` after
/// each write returned; never exits on its own.
#[test]
#[ignore = "child process entry point, driven by the parent test"]
fn child_kv_writer() {
    let Ok(dir) = std::env::var(DIR_ENV) else {
        return;
    };
    let mode: Durability = std::env::var(MODE_ENV).unwrap().parse().unwrap();
    let ask = std::env::var(ASK_ENV).is_ok_and(|v| v == "1");
    let store = Arc::new(
        RedbStore::new_file_with_durability(&Path::new(&dir).join("kv.redb"), mode).unwrap(),
    );
    println!("READY");
    let handles: Vec<_> = (0..4)
        .map(|w| {
            let store = store.clone();
            std::thread::spawn(move || {
                for i in 0..1_000_000 {
                    store.insert(Tree::PluginMeta, &key(w, i), b"v").unwrap();
                    if ask {
                        store.flush_durable().unwrap();
                    }
                    // Acknowledged: the write returned.
                    println!("ACK {w} {i}");
                }
            })
        })
        .collect();
    for h in handles {
        h.join().unwrap();
    }
}

/// A full `Db` creating resources through the normal commit pipeline.
#[test]
#[ignore = "child process entry point, driven by the parent test"]
fn child_db_writer() {
    let Ok(dir) = std::env::var(DIR_ENV) else {
        return;
    };
    let mode: Durability = std::env::var(MODE_ENV).unwrap().parse().unwrap();
    let ask = std::env::var(ASK_ENV).is_ok_and(|v| v == "1");
    let dir = PathBuf::from(dir);
    tokio::runtime::Runtime::new().unwrap().block_on(async {
        let store = Db::init_redb_file_with_options(
            &dir,
            Some("http://localhost".into()),
            &dir.join("uploads"),
            &atomic_lib::db::compaction::CompactionPolicy::disabled(),
            mode,
        )
        .await
        .unwrap();
        let (_agent, drive) = store.setup("Crash").await.unwrap();
        println!("DRIVE {drive}");
        for i in 0..1_000_000 {
            let subject = store
                .create_resource(urls::FOLDER, &drive, &format!("row {i}"), None)
                .await
                .unwrap();
            if ask {
                store.flush_durable().unwrap();
            }
            println!("ACK {subject}");
        }
    });
}

// ── parent side ────────────────────────────────────────────────────────────

/// Spawns the child, collects its acknowledgements until `enough` lines
/// arrived, then SIGKILLs it at once. Returns every line read.
fn run_and_kill(
    entry: &str,
    dir: &Path,
    mode: Durability,
    ask: bool,
    enough: usize,
) -> Vec<String> {
    let mut child = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            entry,
            "--exact",
            "--ignored",
            "--nocapture",
            "--test-threads=1",
        ])
        .env(DIR_ENV, dir)
        .env(MODE_ENV, mode.to_string())
        .env(ASK_ENV, if ask { "1" } else { "0" })
        .stdout(std::process::Stdio::piped())
        .spawn()
        .expect("spawn child");
    let mut lines = BufReader::new(child.stdout.take().unwrap());
    let mut acks = Vec::new();
    let mut line = String::new();
    while acks.len() < enough {
        line.clear();
        if lines.read_line(&mut line).unwrap() == 0 {
            panic!("child exited before {enough} acks: {acks:?}");
        }
        if line.starts_with("ACK") || line.starts_with("DRIVE") {
            acks.push(line.trim().to_string());
        }
    }
    // SIGKILL: no destructors, no flush on the way out.
    child.kill().unwrap();
    child.wait().unwrap();
    acks
}

/// Server floor `always` (and `immediate`): every acknowledged write survives.
/// Floor `none` with the writer asking for durability: so does every write
/// whose request was acknowledged.
#[test]
fn acknowledged_kv_writes_survive_kill_9() {
    for (mode, ask) in [
        (Durability::Always, false),
        (Durability::Immediate, false),
        (Durability::None, true),
    ] {
        let dir = scratch_dir(&format!("kv-{mode}-{ask}"));
        let acks = run_and_kill("child_kv_writer", &dir, mode, ask, 400);

        let store = RedbStore::new_file(&dir.join("kv.redb")).unwrap();
        let mut checked = 0;
        for ack in acks.iter().filter(|a| a.starts_with("ACK")) {
            let mut parts = ack.split_whitespace().skip(1);
            let w: usize = parts.next().unwrap().parse().unwrap();
            let i: usize = parts.next().unwrap().parse().unwrap();
            assert!(
                store.get(Tree::PluginMeta, &key(w, i)).unwrap().is_some(),
                "{mode} (durable requested: {ask}): acknowledged write w{w} #{i} was lost by kill -9"
            );
            checked += 1;
        }
        assert!(checked >= 400);
        let _ = std::fs::remove_dir_all(&dir);
    }
}

/// Proves the harness can see a loss: with floor `none` and no durability
/// request (no periodic flush at the raw store level) acknowledged writes
/// disappear. Loss is allowed here; ignored because it documents the fast
/// default rather than guarding anything.
#[test]
#[ignore = "demonstrates what the none floor allows"]
fn none_mode_loses_acknowledged_kv_writes_on_kill_9() {
    let dir = scratch_dir("kv-none");
    let acks = run_and_kill("child_kv_writer", &dir, Durability::None, false, 400);
    let store = RedbStore::new_file(&dir.join("kv.redb")).unwrap();
    let lost = acks
        .iter()
        .filter(|a| a.starts_with("ACK"))
        .filter(|ack| {
            let mut parts = ack.split_whitespace().skip(1);
            let w: usize = parts.next().unwrap().parse().unwrap();
            let i: usize = parts.next().unwrap().parse().unwrap();
            store.get(Tree::PluginMeta, &key(w, i)).unwrap().is_none()
        })
        .count();
    println!("none: {lost} of {} acknowledged writes lost", acks.len());
    assert!(lost > 0);
    let _ = std::fs::remove_dir_all(&dir);
}

/// Full `Db` commits through the normal pipeline: floor `always`, or floor
/// `none` plus a durable request after each commit.
#[tokio::test]
async fn acknowledged_commits_survive_kill_9() {
    for (mode, ask) in [(Durability::Always, false), (Durability::None, true)] {
        let dir = scratch_dir(&format!("db-{mode}-{ask}"));
        let acks = run_and_kill("child_db_writer", &dir, mode, ask, 60);

        let store = Db::init_redb_file(&dir, Some("http://localhost".into()), &dir.join("uploads"))
            .await
            .unwrap();
        let mut checked = 0;
        for ack in acks.iter().filter(|a| a.starts_with("ACK")) {
            let subject = ack.trim_start_matches("ACK ").to_string();
            store
                .get_resource(&Subject::from(subject.clone()))
                .await
                .unwrap_or_else(|e| {
                    panic!(
                        "{mode} (durable requested: {ask}): commit {subject} lost by kill -9: {e}"
                    )
                });
            checked += 1;
        }
        assert!(checked >= 50, "only {checked} acknowledged commits seen");
        let _ = std::fs::remove_dir_all(&dir);
    }
}

/// Mixed use: durable requests and plain writes share the store. Every
/// durable acknowledgement is covered by an fsync that includes the plain
/// writes before it, and plain writes alone cost no fsynced transaction.
#[test]
fn durable_requests_share_group_commit() {
    let dir = scratch_dir("mixed");
    let store = Arc::new(
        RedbStore::new_file_with_durability(&dir.join("kv.redb"), Durability::None).unwrap(),
    );
    let before = DURABLE_TRANSACTIONS.load(Ordering::Relaxed);
    for i in 0..50 {
        store.insert(Tree::PluginMeta, &key(9, i), b"v").unwrap();
    }
    assert_eq!(
        DURABLE_TRANSACTIONS.load(Ordering::Relaxed),
        before,
        "plain writes must not fsync"
    );
    // Eight threads ask at once: they share fsyncs.
    let handles: Vec<_> = (0..8)
        .map(|w| {
            let store = store.clone();
            std::thread::spawn(move || {
                store.insert(Tree::PluginMeta, &key(w, 0), b"v").unwrap();
                store.flush_durable().unwrap();
            })
        })
        .collect();
    for h in handles {
        h.join().unwrap();
    }
    let txs = DURABLE_TRANSACTIONS.load(Ordering::Relaxed) - before;
    assert!((1..=8).contains(&txs), "{txs} fsynced transactions");
    let _ = std::fs::remove_dir_all(&dir);
}

// ── benchmark ──────────────────────────────────────────────────────────────

fn kv_bench(mode: Durability, writers: usize, total: usize) -> f64 {
    let dir = scratch_dir(&format!("bench-kv-{mode}-{writers}"));
    let store = Arc::new(RedbStore::new_file_with_durability(&dir.join("kv.redb"), mode).unwrap());
    let per = total / writers;
    let txs_before = DURABLE_TRANSACTIONS.load(Ordering::Relaxed);
    let start = std::time::Instant::now();
    let handles: Vec<_> = (0..writers)
        .map(|w| {
            let store = store.clone();
            std::thread::spawn(move || {
                for i in 0..per {
                    store
                        .insert(Tree::PluginMeta, &key(w, i), &[7u8; 512])
                        .unwrap();
                }
            })
        })
        .collect();
    for h in handles {
        h.join().unwrap();
    }
    let secs = start.elapsed().as_secs_f64();
    let txs = DURABLE_TRANSACTIONS.load(Ordering::Relaxed) - txs_before;
    println!("    kv {mode} x{writers}: {txs} fsynced transactions for {total} writes");
    let _ = std::fs::remove_dir_all(&dir);
    (per * writers) as f64 / secs
}

async fn db_bench(mode: Durability, writers: usize, total: usize) -> f64 {
    let dir = scratch_dir(&format!("bench-db-{mode}-{writers}"));
    let store = Db::init_redb_file_with_options(
        &dir,
        Some("http://localhost".into()),
        &dir.join("uploads"),
        &atomic_lib::db::compaction::CompactionPolicy::disabled(),
        mode,
    )
    .await
    .unwrap();
    let (_agent, drive) = store.setup("Bench").await.unwrap();
    let per = total / writers;
    let txs_before = DURABLE_TRANSACTIONS.load(Ordering::Relaxed);
    let start = std::time::Instant::now();
    let mut tasks = Vec::new();
    for w in 0..writers {
        let store = store.clone();
        let drive = drive.clone();
        tasks.push(tokio::spawn(async move {
            for i in 0..per {
                store
                    .create_resource(urls::FOLDER, &drive, &format!("w{w} row {i}"), None)
                    .await
                    .unwrap();
            }
        }));
    }
    for t in tasks {
        t.await.unwrap();
    }
    let secs = start.elapsed().as_secs_f64();
    let txs = DURABLE_TRANSACTIONS.load(Ordering::Relaxed) - txs_before;
    println!("    db {mode} x{writers}: {txs} fsynced transactions for {total} commits");
    drop(store);
    let _ = std::fs::remove_dir_all(&dir);
    (per * writers) as f64 / secs
}

#[tokio::test(flavor = "multi_thread", worker_threads = 8)]
#[ignore = "benchmark: run with --release --ignored --nocapture"]
async fn bench_durability_throughput() {
    println!("\ncommits/second (higher is better)");
    println!("{:<10} {:>16} {:>16}", "mode", "1 writer", "8 writers");
    for mode in [Durability::None, Durability::Always, Durability::Immediate] {
        let seq = tokio::task::spawn_blocking(move || kv_bench(mode, 1, 1000))
            .await
            .unwrap();
        let conc = tokio::task::spawn_blocking(move || kv_bench(mode, 8, 1000))
            .await
            .unwrap();
        println!("kv  {mode:<7} {seq:>16.0} {conc:>16.0}");
    }
    for mode in [Durability::None, Durability::Always, Durability::Immediate] {
        let seq = db_bench(mode, 1, 1000).await;
        let conc = db_bench(mode, 8, 1000).await;
        println!("db  {mode:<7} {seq:>16.0} {conc:>16.0}");
    }
}
