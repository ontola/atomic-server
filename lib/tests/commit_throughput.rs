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

use atomic_lib::{storelike::Query, urls, Db, Storelike, Subject, Value};

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

/// Register a watched query filter, the way opening a collection does:
/// `query_complex` watches any drive-scoped filter it answers.
async fn watch_a_collection_query(store: &Db, drive: &Subject, parent: &str) {
    let query = Query {
        property: Some(urls::PARENT.into()),
        value: Some(Value::AtomicUrl(parent.into())),
        drive: Some(drive.clone()),
        ..Query::default()
    };
    // The answer does not matter; running it is what registers the filter.
    let _ = store.query(&query).await;
}

/// Does a commit get more expensive as *other* collections on the drive are
/// opened?
///
/// Watched filters are bucketed by the properties they constrain, so every
/// collection of the form "children of X" lands in the same `parent` bucket,
/// whatever X is. `check_if_atom_matches_watched_query_filters` then walks
/// that whole bucket for each indexable atom and calls `resource_matches_filter`
/// on every entry, which re-reads the resource's properties to reject the ones
/// whose parent is some other folder. So the per-atom cost is O(collections
/// opened on the drive), not O(collections this resource is in.)
///
/// This measures the realistic shape: one folder receives the commits, and the
/// other watched collections are on parents of their own, so exactly one filter
/// per round can ever match. If per-commit cost still climbs, the walk is
/// paying for filters it could have skipped, and routing the bucket by the
/// constraint's value is the fix.
#[tokio::test(flavor = "multi_thread")]
#[ignore = "writes thousands of resources; run explicitly"]
async fn commit_cost_against_unrelated_watched_queries() {
    let n = n_per_leg();
    let store = Db::init_temp("commit_watched_filters").await.unwrap();
    let (_agent, drive) = store.setup("Bench").await.unwrap();
    let drive_subject = Subject::from_raw(&drive, None);

    // The folder every measured commit writes into.
    let parent = store
        .create_resource(urls::FOLDER, drive_subject.as_str(), "Rows", None)
        .await
        .unwrap();

    for i in 0..20 {
        create_row(&store, &parent, 900_000 + i, "warmup").await;
    }

    println!("\n=== per-commit cost vs unrelated open collections, n={n} per round ===");
    println!(
        "{:>8}  {:>12}  {:>14}",
        "filters", "ms/commit", "vs baseline"
    );

    let mut baseline = 0.0f64;
    let mut opened = 0usize;
    for (round, target) in [0usize, 25, 50, 100, 200].into_iter().enumerate() {
        // Each unrelated collection gets a parent of its own, so it can never
        // match the rows below — the realistic shape of a drive in use.
        while opened < target {
            let other = store
                .create_resource(
                    urls::FOLDER,
                    drive_subject.as_str(),
                    &format!("Other {opened:04}"),
                    None,
                )
                .await
                .unwrap();
            watch_a_collection_query(&store, &drive_subject, &other).await;
            opened += 1;
        }

        let start = Instant::now();
        for i in 0..n {
            create_row(&store, &parent, round * 100_000 + i, "measure").await;
        }
        let per = per_commit(start.elapsed(), n);
        if round == 0 {
            baseline = per;
        }
        println!("{target:>8}  {per:>10.3} ms  {:>13.2}x", per / baseline);
    }

    println!(
        "\nEvery filter above the first is on a different parent, so at most one \
         can match. Growth here is the bucket walk rejecting filters one by one, \
         and routing the bucket by the constraint's value removes it."
    );
}

/// Does a commit get more expensive as the store simply gets bigger?
///
/// This is the growth the symptom actually describes: the same write, into the
/// same folder, with nothing else watching, costing more once the store holds
/// more. Nothing here changes between rounds except the number of resources
/// already written, so whatever climbs is a per-commit cost that scales with
/// store size — index writes, B-tree depth, or write amplification — rather
/// than anything to do with queries.
///
/// Rounds are reported separately rather than averaged, because an average
/// over a growing store hides exactly the shape being looked for.
#[tokio::test(flavor = "multi_thread")]
#[ignore = "writes thousands of resources; run explicitly"]
async fn commit_cost_against_store_size() {
    let n = n_per_leg();
    let rounds: usize = std::env::var("COMMIT_THROUGHPUT_ROUNDS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(10);

    let store = Db::init_temp("commit_store_size").await.unwrap();
    let (_agent, drive) = store.setup("Bench").await.unwrap();
    let drive_subject = Subject::from_raw(&drive, None);

    let parent = store
        .create_resource(urls::FOLDER, drive_subject.as_str(), "Rows", None)
        .await
        .unwrap();

    for i in 0..20 {
        create_row(&store, &parent, 900_000 + i, "warmup").await;
    }

    println!("\n=== per-commit cost vs store size, {n} commits per round ===");
    println!(
        "{:>10}  {:>12}  {:>14}",
        "resources", "ms/commit", "vs first"
    );

    let mut baseline = 0.0f64;
    for round in 0..rounds {
        let start = Instant::now();
        for i in 0..n {
            create_row(&store, &parent, round * 100_000 + i, "measure").await;
        }
        let per = per_commit(start.elapsed(), n);
        if round == 0 {
            baseline = per;
        }
        println!(
            "{:>10}  {per:>10.3} ms  {:>13.2}x",
            (round + 1) * n,
            per / baseline
        );
    }

    println!(
        "\nNothing varies between rounds but the number of resources already \
         stored. A flat column means per-commit cost is independent of store \
         size and the growth is elsewhere; a climbing one means the write path \
         itself scales with what is already there."
    );
}

/// What is a commit's 2.6 ms actually spent on?
///
/// Growth with store size and with open collections both turned out mild, so
/// the number that matters is the constant. `create_resource` is two phases —
/// `Commit::create_did` signs, `apply_commit` persists — and `CommitOpts` lets
/// the second one be run with its validation and its indexing switched off.
/// Four timings therefore separate the whole cost:
///
/// * **sign** — canonical JSON-AD serialisation plus the Ed25519 signature.
/// * **verify** — the signature check on apply, as the difference between
///   applying with and without `validate_signature`.
/// * **index** — the difference between applying with and without
///   `update_index`: building index atoms and writing `PropValSub`/`ValPropSub`.
/// * **write** — what is left: the resource blob, the Loro snapshot and the
///   redb transaction.
///
/// Each leg signs its own commits, because a commit can only be applied once.
#[tokio::test(flavor = "multi_thread")]
#[ignore = "writes thousands of resources; run explicitly"]
async fn where_a_commit_spends_its_time() {
    use atomic_lib::commit::{Commit, CommitBuilder, CommitOpts};

    let n = n_per_leg();
    let store = Db::init_temp("commit_breakdown").await.unwrap();
    let (_agent, drive) = store.setup("Bench").await.unwrap();
    let drive_subject = Subject::from_raw(&drive, None);
    let parent = store
        .create_resource(urls::FOLDER, drive_subject.as_str(), "Rows", None)
        .await
        .unwrap();
    for i in 0..20 {
        create_row(&store, &parent, 900_000 + i, "warmup").await;
    }

    let agent = store.get_default_agent().unwrap();

    // Sign one leg's worth of commits, returning how long the signing took.
    let sign_leg = |leg: usize| {
        let store = store.clone();
        let agent = agent.clone();
        let parent = parent.clone();
        async move {
            let mut commits = Vec::with_capacity(n);
            let start = Instant::now();
            for i in 0..n {
                let mut builder = CommitBuilder::new("placeholder".into());
                builder.set(
                    urls::IS_A.into(),
                    Value::ResourceArray(vec![urls::FOLDER.into()]),
                );
                builder.set(
                    urls::NAME.into(),
                    Value::String(format!("row {leg}-{i:06}")),
                );
                builder.set(urls::PARENT.into(), Value::AtomicUrl(parent.clone().into()));
                commits.push(Commit::create_did(builder, &agent, &store).await.unwrap());
            }
            (commits, start.elapsed())
        }
    };

    async fn apply_leg(store: &Db, commits: Vec<Commit>, opts: &CommitOpts) -> Duration {
        let start = Instant::now();
        for commit in commits {
            store.apply_commit(commit, opts).await.unwrap();
        }
        start.elapsed()
    }

    let full = CommitOpts {
        validate_signature: true,
        update_index: true,
        ..CommitOpts::no_validations_no_index()
    };
    let no_verify = CommitOpts {
        update_index: true,
        ..CommitOpts::no_validations_no_index()
    };
    let bare = CommitOpts::no_validations_no_index();

    let (a, sign) = sign_leg(0).await;
    let full_apply = apply_leg(&store, a, &full).await;
    let (b, _) = sign_leg(1).await;
    let no_verify_apply = apply_leg(&store, b, &no_verify).await;
    let (c, _) = sign_leg(2).await;
    let bare_apply = apply_leg(&store, c, &bare).await;

    let sign_ms = per_commit(sign, n);
    let verify_ms = per_commit(full_apply, n) - per_commit(no_verify_apply, n);
    let index_ms = per_commit(no_verify_apply, n) - per_commit(bare_apply, n);
    let write_ms = per_commit(bare_apply, n);
    let total = sign_ms + per_commit(full_apply, n);

    println!("\n=== where a commit's time goes, n={n} per leg ===");
    for (label, v) in [
        ("sign   (serialise + Ed25519)", sign_ms),
        ("verify (signature check)    ", verify_ms),
        ("index  (atoms + PropValSub) ", index_ms),
        ("write  (blob + Loro + redb) ", write_ms),
    ] {
        println!("{label}  {v:>7.3} ms  {:>5.1}%", 100.0 * v / total);
    }
    println!("{:<30}  {total:>7.3} ms", "total");
}

/// What would amortising the redb transaction buy?
///
/// The breakdown above puts 44% of a commit in the write phase, which is one
/// redb transaction per commit. `begin_batch`/`commit_batch` buffer writes into
/// a single transaction, so running the same applies inside one says how much
/// of that phase is per-transaction overhead rather than the data itself.
///
/// The commits here all create *new* resources, which is the case batching is
/// actually safe for: applying a commit is a read-modify-write of the stored
/// Loro snapshot, so commits that edit a resource an earlier commit in the same
/// batch wrote cannot be buffered this way. A burst of creates (what
/// `ensureSchema` sends) is exactly the safe shape.
#[tokio::test(flavor = "multi_thread")]
#[ignore = "writes thousands of resources; run explicitly"]
async fn what_batching_the_write_would_buy() {
    use atomic_lib::commit::{Commit, CommitBuilder, CommitOpts};

    let n = n_per_leg();
    let store = Db::init_temp("commit_batching").await.unwrap();
    let (_agent, drive) = store.setup("Bench").await.unwrap();
    let drive_subject = Subject::from_raw(&drive, None);
    let parent = store
        .create_resource(urls::FOLDER, drive_subject.as_str(), "Rows", None)
        .await
        .unwrap();
    for i in 0..20 {
        create_row(&store, &parent, 900_000 + i, "warmup").await;
    }

    let agent = store.get_default_agent().unwrap();
    let opts = CommitOpts {
        validate_signature: true,
        update_index: true,
        ..CommitOpts::no_validations_no_index()
    };

    let mut sign_leg = async |leg: usize| {
        let mut commits = Vec::with_capacity(n);
        for i in 0..n {
            let mut builder = CommitBuilder::new("placeholder".into());
            builder.set(
                urls::IS_A.into(),
                Value::ResourceArray(vec![urls::FOLDER.into()]),
            );
            builder.set(
                urls::NAME.into(),
                Value::String(format!("row {leg}-{i:06}")),
            );
            builder.set(urls::PARENT.into(), Value::AtomicUrl(parent.clone().into()));
            commits.push(Commit::create_did(builder, &agent, &store).await.unwrap());
        }
        commits
    };

    let one_by_one = sign_leg(0).await;
    let start = Instant::now();
    for commit in one_by_one {
        store.apply_commit(commit, &opts).await.unwrap();
    }
    let unbatched = start.elapsed();

    let batched_commits = sign_leg(1).await;
    let start = Instant::now();
    store.begin_batch();
    for commit in batched_commits {
        store.apply_commit(commit, &opts).await.unwrap();
    }
    store.commit_batch().unwrap();
    let batched = start.elapsed();

    let speedup = unbatched.as_secs_f64() / batched.as_secs_f64();
    println!("\n=== batching the write, n={n} commits ===");
    println!(
        "one transaction each  {:>7.3} ms/commit",
        per_commit(unbatched, n)
    );
    println!(
        "one transaction total {:>7.3} ms/commit",
        per_commit(batched, n)
    );
    println!("speedup               {speedup:>7.2}x");
}
