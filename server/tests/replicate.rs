//! Integration test: a server pushes one of its drives to a *different* server.
//!
//! This is the self-hosted → hosted backup path. The source holds the complete
//! drive; the target has never seen it and runs under a different agent. The
//! question the test answers is the one an earlier design got wrong: **does the
//! data actually land?**
//!
//! Run with: cargo test -p atomic-server --test replicate

use atomic_lib::{
    agents::ForAgent,
    sync::replicate::{replicate_drive_to_remote, ReplicateAuth},
    Db, Storelike,
};
use atomic_server_lib as atomic_server;
use std::time::Duration;

/// Start an AtomicServer on a random port in a background thread.
fn start_server(unique: &str) -> u16 {
    let port = portpicker::pick_unused_port().expect("no free port");

    use clap::Parser;
    let opts = atomic_server::config::Opts::parse_from([
        "atomic-server",
        "--initialize",
        "--port",
        &port.to_string(),
        "--data-dir",
        &format!("./.temp/replicate_{}/db", unique),
        "--config-dir",
        &format!("./.temp/replicate_{}/config", unique),
    ]);

    let mut config = atomic_server::config::build_config(opts).expect("config failed");
    config.search_index_path = format!("./.temp/replicate_{}/search", unique).into();

    std::thread::spawn(move || {
        let rt = actix_web::rt::System::new();
        rt.block_on(async {
            atomic_server::serve::serve(config).await.unwrap();
        });
    });

    port
}

async fn wait_for_server(port: u16) {
    let base = format!("http://localhost:{}", port);

    for _ in 0..50 {
        if reqwest::get(&base).await.is_ok() {
            return;
        }

        tokio::time::sleep(Duration::from_millis(100)).await;
    }

    panic!("Server did not start within 5 seconds");
}

/// A self-hosted node: its own store, its own agent, one private drive with a
/// child resource in it.
async fn source_node(unique: &str) -> (Db, atomic_lib::agents::Agent, String, String) {
    let db = Db::init_temp(&format!("replicate_src_{unique}"))
        .await
        .unwrap();
    let (agent, drive) = db.setup("Alice").await.unwrap();

    let child = db
        .create_resource(
            atomic_lib::urls::CLASS,
            &drive,
            "Alice's notes",
            Some(vec![(
                atomic_lib::urls::DESCRIPTION,
                atomic_lib::Value::String("Something only Alice can read".into()),
            )]),
        )
        .await
        .unwrap();

    (db, agent, drive, child)
}

/// The whole point of the feature: a drive on a server the target has never
/// heard of, pushed to it, and *verifiably* present afterwards.
///
/// `in_sync` is the assertion that matters. The receiver answers `SYNC_OK` even
/// when it silently discards an import for lack of write rights, so only a
/// second version-vector probe agreeing proves the data is really there.
#[tokio::test]
async fn pushes_a_drive_to_a_server_that_has_never_seen_it() {
    let port = start_server("lands");
    wait_for_server(port).await;
    let ws_url = format!("ws://localhost:{}/ws", port);

    let (db, agent, drive, _child) = source_node("lands").await;
    let export_as = ForAgent::AgentSubject(agent.subject.clone());

    let outcome = replicate_drive_to_remote(
        &db,
        &drive,
        &ws_url,
        &export_as,
        ReplicateAuth::Agent(Box::new(agent)),
    )
    .await
    .expect("replication should succeed");

    assert!(
        outcome.pushed >= 2,
        "the drive root and its child should both be pushed, got {}",
        outcome.pushed
    );
    assert!(
        outcome.in_sync,
        "the target's drive hash must match ours after the push — it did not, \
         so the data did not land"
    );
}

/// Pushing the same drive twice is a no-op, not a duplicate. The second run
/// finds the hashes already equal and pushes nothing — which also proves the
/// first run's data survived, since a fresh connection re-derives the hash from
/// what the target stored.
#[tokio::test]
async fn replicating_twice_pushes_nothing_the_second_time() {
    let port = start_server("twice");
    wait_for_server(port).await;
    let ws_url = format!("ws://localhost:{}/ws", port);

    let (db, agent, drive, _child) = source_node("twice").await;
    let export_as = ForAgent::AgentSubject(agent.subject.clone());

    let first = replicate_drive_to_remote(
        &db,
        &drive,
        &ws_url,
        &export_as,
        ReplicateAuth::Agent(Box::new(agent.clone())),
    )
    .await
    .expect("first replication should succeed");
    assert!(first.in_sync, "first push should land");

    let second = replicate_drive_to_remote(
        &db,
        &drive,
        &ws_url,
        &export_as,
        ReplicateAuth::Agent(Box::new(agent)),
    )
    .await
    .expect("second replication should succeed");

    assert_eq!(
        second.pushed, 0,
        "an unchanged drive should push nothing on a second run"
    );
    assert!(second.in_sync, "and should still report in sync");
}

/// The export is bounded by what the *requesting* identity may read. An
/// anonymous request must not be able to use this server as a pump to copy a
/// private drive somewhere else.
#[tokio::test]
async fn refuses_to_export_a_private_drive_for_an_anonymous_requester() {
    let port = start_server("anon");
    wait_for_server(port).await;
    let ws_url = format!("ws://localhost:{}/ws", port);

    let (db, agent, drive, _child) = source_node("anon").await;

    // Drives are world-readable by default; make this one actually private, so
    // the read gate has something to bite on.
    let mut drive_resource = db.get_resource(&drive.as_str().into()).await.unwrap();
    drive_resource.ensure_materialized().unwrap();
    drive_resource
        .set_unsafe(
            atomic_lib::urls::READ.into(),
            atomic_lib::Value::ResourceArray(vec![agent.subject.to_string().into()]),
        )
        .unwrap();
    drive_resource.save_locally(&db).await.unwrap();

    let outcome = replicate_drive_to_remote(
        &db,
        &drive,
        &ws_url,
        // Authenticating as Alice, but asking to export as the public — the read
        // gate is what bounds the export, and the public cannot read her drive.
        &ForAgent::Public,
        ReplicateAuth::Agent(Box::new(agent)),
    )
    .await
    .expect("the attempt itself should not error");

    assert_eq!(
        outcome.pushed, 0,
        "a private drive must not be exported for an anonymous requester"
    );
}
