//! What does the server actually spend per commit, and what would moving the
//! work off a connection's thread buy?
//!
//! `lib/tests/commit_throughput.rs` established that the store parallelises:
//! neither redb's single writer nor the per-subject lock is the wall. What is
//! left is the server, where `web_sockets.rs` applies a `COMMIT` frame with
//! `ctx.spawn`, so it runs on the connection's actor thread. Applying a commit
//! is CPU-bound and nothing in `server/` offloads it, so a client that sends
//! nineteen at once has them charged to one thread in turn.
//!
//! Three legs, the same signed commits in each:
//!
//! * **one connection, sequential** — the per-commit cost, end to end.
//! * **one connection, all at once** — what a client sending a burst gets
//!   today. `post_commit` multiplexes on `request_id`, so these really are
//!   in flight together.
//! * **one connection each, all at once** — the same burst spread over
//!   connections, so it lands on different workers.
//!
//! The third against the second is the prize for moving that work off the
//! actor thread, measured rather than predicted. Run it in **release**: a
//! debug build makes Ed25519 and Loro dominate and reports a number roughly
//! fifty times too slow.
//!
//! ```
//! cargo test -p atomic-server --release --test it commit_throughput \
//!   -- --ignored --nocapture
//! ```
//!
//! `COMMIT_THROUGHPUT_N` sets the commits per leg (default 20, about what
//! `ensureSchema` issues).

use atomic_lib::{
    client::{connected::Client, ws::WsClient},
    errors::AtomicResult,
};
use std::sync::atomic::{AtomicU16, Ordering};
use std::time::{Duration, Instant};

use crate::common::{start_server, wait_for_server};

static REQ_ID: AtomicU16 = AtomicU16::new(1);

fn n_per_leg() -> usize {
    std::env::var("COMMIT_THROUGHPUT_N")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(20)
}

fn ms(d: Duration) -> f64 {
    d.as_secs_f64() * 1000.0
}

/// A signed genesis commit for a brand-new resource, built but not sent — the
/// same construction `Resource::save_remote` uses for a `did:ad:placeholder`.
/// Signing happens up front for every leg so the timed section is server work
/// only.
async fn signed_genesis(
    client: &Client,
    drive: &str,
    agent: &atomic_lib::agents::Agent,
    label: &str,
) -> AtomicResult<String> {
    let mut resource = client.new_resource(drive)?;
    resource.set_name(label)?;
    resource.set_unsafe(
        atomic_lib::urls::IS_A.into(),
        atomic_lib::Value::ResourceArray(vec![atomic_lib::urls::FOLDER.into()]),
    )?;
    let snapshot = resource.build_state_doc()?.export_snapshot();
    let mut builder = resource.get_commit_builder().clone();
    builder.is_genesis = true;
    builder.set_loro_update(snapshot);
    let commit = atomic_lib::Commit::create_did(builder, agent, client.store()).await?;
    atomic_lib::client::commit_to_wire_json(&commit, client.store()).await
}

async fn post_all_on_one(ws: &WsClient, commits: &[String]) -> Duration {
    let start = Instant::now();
    let posts = commits.iter().map(|json| {
        let id = REQ_ID.fetch_add(1, Ordering::Relaxed);
        ws.post_commit(id, json)
    });
    for result in futures::future::join_all(posts).await {
        result.expect("commit accepted");
    }
    start.elapsed()
}

#[tokio::test]
#[ignore = "starts a server and writes a few hundred resources; run explicitly"]
async fn where_the_server_spends_a_burst_of_commits() -> AtomicResult<()> {
    let n = n_per_leg();
    let port = start_server("commit_throughput");
    wait_for_server(port).await;
    let server_url = format!("http://localhost:{port}");
    let ws_url = format!("ws://localhost:{port}/ws");

    let client = Client::new(&server_url).await?;
    let agent = client.new_agent("Bench").await?;
    let drive = client.new_public_drive(&agent, "Throughput Drive").await?;

    // Sign everything first: three legs of `n` commits, all distinct
    // subjects, none of them sent yet.
    let mut legs = Vec::new();
    for leg in 0..3 {
        let mut commits = Vec::with_capacity(n);
        for i in 0..n {
            commits.push(signed_genesis(&client, &drive, &agent, &format!("row {leg}-{i:04}")).await?);
        }
        legs.push(commits);
    }

    let ws = WsClient::connect(&ws_url).await?;
    ws.authenticate(&agent).await?;

    // Leg 1: one connection, one at a time. The per-commit cost end to end.
    let start = Instant::now();
    for json in &legs[0] {
        let id = REQ_ID.fetch_add(1, Ordering::Relaxed);
        ws.post_commit(id, json).await?;
    }
    let sequential = start.elapsed();

    // Leg 2: one connection, all at once. What a client gets today.
    let one_conn = post_all_on_one(&ws, &legs[1]).await;

    // Leg 3: the same burst spread over its own connections, so the work
    // lands on different actix workers. This is the ceiling that moving the
    // CPU work off the connection's thread could reach.
    let mut sockets = Vec::with_capacity(n);
    for _ in 0..n {
        let s = WsClient::connect(&ws_url).await?;
        s.authenticate(&agent).await?;
        sockets.push(s);
    }
    let start = Instant::now();
    let posts = sockets.iter().zip(&legs[2]).map(|(s, json)| {
        let id = REQ_ID.fetch_add(1, Ordering::Relaxed);
        s.post_commit(id, json)
    });
    for result in futures::future::join_all(posts).await {
        result.expect("commit accepted");
    }
    let many_conns = start.elapsed();

    let threads = std::thread::available_parallelism()
        .map(|p| p.get())
        .unwrap_or(1);
    let prize = one_conn.as_secs_f64() / many_conns.as_secs_f64();

    println!("\n=== server commit throughput, n={n} per leg, {threads} cores ===");
    for (label, d) in [
        ("one connection, sequential", sequential),
        ("one connection, at once  ", one_conn),
        ("one conn each, at once   ", many_conns),
    ] {
        println!(
            "{label}  {:>9.1} ms total   {:>7.2} ms/commit",
            ms(d),
            ms(d) / n as f64
        );
    }
    println!("\nspreading the burst over workers: {prize:.2}x");
    println!(
        "{}",
        if prize > 1.3 {
            "That factor is what moving the apply off the connection's actor \
             thread is worth. Below it, the cost is per-commit work, which \
             threading cannot remove."
        } else {
            "Spreading over workers buys nothing, so the actor thread is not \
             the limit here — the cost is per-commit work. Threading the \
             handler would not help; look at what each commit does instead."
        }
    );

    assert!(sequential > Duration::ZERO && one_conn > Duration::ZERO);
    Ok(())
}
