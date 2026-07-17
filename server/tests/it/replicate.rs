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

use crate::common::{start_server, wait_for_server};

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
    let port = start_server("replicate_lands");
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
    let port = start_server("replicate_twice");
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

/// A replication target is standing config, not a one-shot command: on boot the
/// server re-pushes every drive that has one, so edits made while the remote was
/// unreachable catch up. This is what the boot reconcile buys, and it only ever
/// contacts servers the user explicitly named.
#[tokio::test]
async fn a_stored_target_is_re_pushed_on_boot() {
    let port = start_server("replicate_boot");
    wait_for_server(port).await;
    let ws_url = format!("ws://localhost:{}/ws", port);

    let (db, agent, drive, _child) = source_node("boot").await;

    db.add_replication_target(
        &drive,
        &atomic_lib::ReplicationTarget {
            url: ws_url.clone(),
            authorized_by: agent.subject.to_string(),
        },
    )
    .unwrap();

    // Nothing has been pushed yet — only the intent was recorded.
    atomic_server::plugins::replicate::reconcile_replication_targets(&db).await;

    // The reconcile is what pushed it, so a fresh probe must now find the target
    // already holding the drive.
    let after = replicate_drive_to_remote(
        &db,
        &drive,
        &ws_url,
        &ForAgent::AgentSubject(agent.subject.clone()),
        ReplicateAuth::Agent(Box::new(agent)),
    )
    .await
    .expect("probe should succeed");

    assert_eq!(
        after.pushed, 0,
        "the boot reconcile should already have pushed the drive"
    );
    assert!(after.in_sync, "and the target should hold it");
}

/// The export is bounded by what the *requesting* identity may read. An
/// anonymous request must not be able to use this server as a pump to copy a
/// private drive somewhere else.
#[tokio::test]
async fn refuses_to_export_a_private_drive_for_an_anonymous_requester() {
    let port = start_server("replicate_anon");
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

/// The scenario a user worries about, end-to-end at the integration level:
/// create a resource on one node, get it onto another, lose the first, then open
/// a *fresh* session against the second — is the resource really there and
/// readable? Replicate the drive to the target, drop the source ("server 1 is
/// gone"), then read the child back from the target with a brand-new authed HTTP
/// client (no local cache). `in_sync` proves the bytes match; this proves a
/// client can actually *read* them.
#[tokio::test]
async fn a_fresh_client_reads_a_replicated_resource_after_the_source_is_gone() {
    let port = start_server("replicate_freshread");
    wait_for_server(port).await;
    let ws_url = format!("ws://localhost:{}/ws", port);

    let (db, agent, drive, child) = source_node("freshread").await;
    let export_as = ForAgent::AgentSubject(agent.subject.clone());

    replicate_drive_to_remote(
        &db,
        &drive,
        &ws_url,
        &export_as,
        ReplicateAuth::Agent(Box::new(agent.clone())),
    )
    .await
    .expect("replication should succeed");

    // "Server 1 is gone" — drop the source store. The target must stand alone.
    drop(db);

    // A fresh client reads the child from the target, authenticated as Alice.
    // The signed message is the exact request URL (query string and all).
    let url = format!(
        "http://localhost:{}/did?subject={}",
        port,
        urlencoding::encode(&child)
    );
    let headers =
        atomic_lib::client::get_authentication_headers(&url, &agent).expect("auth headers");

    let client = reqwest::Client::new();
    let mut req = client.get(&url).header("Accept", "application/ad+json");
    for (k, v) in headers {
        req = req.header(k, v);
    }
    let resp = req.send().await.expect("request should reach the target");

    assert!(
        resp.status().is_success(),
        "the replicated resource should be readable on the target after the source \
         is gone, got {}",
        resp.status()
    );

    let body = resp.text().await.expect("body");
    assert!(
        body.contains("Something only Alice can read"),
        "the target must serve the resource's actual content, not an empty shell: {body}"
    );
}
