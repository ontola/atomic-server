//! WebSocket COMMIT / COMMIT_OK integration test.
//!
//! Run: cargo test -p atomic-server --test ws_commit

use atomic_lib::{
    client::{
        connected::Client,
        ws::{WsClient, WsMessage},
    },
    errors::AtomicResult,
};
use std::sync::atomic::{AtomicU16, Ordering};
use std::time::Duration;

static REQ_ID: AtomicU16 = AtomicU16::new(1);

use crate::common::{start_server, wait_for_server};

#[tokio::test]
async fn ws_commit_syncs_to_subscriber() -> AtomicResult<()> {
    let port = start_server("ws_commit");
    wait_for_server(port).await;
    let server_url = format!("http://localhost:{}", port);
    let ws_url = format!("ws://localhost:{}/ws", port);

    let client_a = Client::new(&server_url).await?;
    let agent_a = client_a.new_agent("Alice").await?;
    let drive = client_a.new_public_drive(&agent_a, "Commit Drive").await?;

    let mut resource = client_a.new_resource(&drive)?;
    resource.set_name("Sync Target")?;
    resource.set_unsafe(
        atomic_lib::urls::IS_A.into(),
        atomic_lib::Value::ResourceArray(vec![atomic_lib::urls::CLASS.into()]),
    )?;
    resource.set_unsafe(
        atomic_lib::urls::SHORTNAME.into(),
        atomic_lib::Value::Slug("sync-target".into()),
    )?;
    resource.set_unsafe(
        atomic_lib::urls::DESCRIPTION.into(),
        atomic_lib::Value::String("A test resource for ws commit".into()),
    )?;
    let subject = resource.save_remote(client_a.store()).await?;
    let subject_str = subject.clone();
    // Reload so local Loro state matches server (same as a real client after save_remote).
    let mut resource = client_a.get_resource(&subject_str).await?;

    let client_b = Client::new(&server_url).await?;
    let agent_b = client_b.new_agent("Bob").await?;
    let ws_b = WsClient::connect(&ws_url).await?;
    ws_b.authenticate(&agent_b).await?;
    ws_b.subscribe_resource(&subject_str).await?;

    let mut rx = ws_b.subscribe();
    tokio::time::sleep(Duration::from_millis(200)).await;

    // Agent A posts a commit over WS (same commit construction as save_remote)
    resource.set_name("Updated via WS commit")?;
    let snapshot = resource.build_state_doc()?.export_snapshot();
    let mut commitbuilder = resource.get_commit_builder().clone();
    commitbuilder.set_loro_update(snapshot);
    let commit = commitbuilder
        .sign(&agent_a, client_a.store(), &resource)
        .await?;
    let commit_json = atomic_lib::client::commit_to_wire_json(&commit, client_a.store()).await?;

    let ws_a = WsClient::connect(&ws_url).await?;
    ws_a.authenticate(&agent_a).await?;
    let request_id = REQ_ID.fetch_add(1, Ordering::Relaxed);
    let commit_id = ws_a.post_commit(request_id, &commit_json).await?;
    // `WsClient` lists `commit-ok-slim` in its HELLO, so the ack is the bare
    // commit id, not the commit JSON; `post_commit` returns it either way.
    assert!(
        atomic_lib::identifiers::is_commit_id(&commit_id) || commit_id.contains("/commits/"),
        "COMMIT_OK should carry the server's commit id, got {commit_id}"
    );
    assert!(
        ws_a.server_capabilities()
            .iter()
            .any(|c| c == "commit-ok-slim"),
        "{:?}",
        ws_a.server_capabilities()
    );

    // Bob should receive an UPDATE for the resource
    let received = tokio::time::timeout(Duration::from_secs(10), async {
        while let Ok(msg) = rx.recv().await {
            if let WsMessage::Update { subject: s, .. } = msg {
                if s == subject_str {
                    return true;
                }
            }
        }
        false
    })
    .await
    .unwrap_or(false);

    assert!(received, "subscriber should receive UPDATE after WS COMMIT");

    Ok(())
}

/// A signed update of `resource`, as the wire JSON a client posts.
async fn signed_update(
    client: &Client,
    agent: &atomic_lib::agents::Agent,
    resource: &mut atomic_lib::Resource,
    name: &str,
) -> AtomicResult<String> {
    resource.set_name(name)?;
    let snapshot = resource.build_state_doc()?.export_snapshot();
    let mut builder = resource.get_commit_builder().clone();
    builder.set_loro_update(snapshot);
    let commit = builder.sign(agent, client.store(), resource).await?;
    atomic_lib::client::commit_to_wire_json(&commit, client.store()).await
}

/// Durability is chosen per request. The server floor is `none` (the default),
/// so a plain commit is acknowledged without an fsync, and a commit sent as
/// `COMMIT_DURABLE` over WebSocket or `POST /commit?durable=true` is
/// acknowledged only after one (`DURABLE_TRANSACTIONS` counts the fsynced
/// transactions; the server runs in this process).
#[tokio::test]
async fn durable_commit_is_acknowledged_after_an_fsync() -> AtomicResult<()> {
    use atomic_lib::db::redb_store::DURABLE_TRANSACTIONS;
    let fsyncs = || DURABLE_TRANSACTIONS.load(Ordering::SeqCst);

    let port = start_server("ws_commit_durable");
    wait_for_server(port).await;
    let server_url = format!("http://localhost:{}", port);
    let ws_url = format!("ws://localhost:{}/ws", port);

    let client = Client::new(&server_url).await?;
    let agent = client.new_agent("Dora").await?;
    let drive = client.new_public_drive(&agent, "Durable Drive").await?;
    let mut resource = client.new_resource(&drive)?;
    resource.set_name("Durable Target")?;
    resource.set_unsafe(
        atomic_lib::urls::IS_A.into(),
        atomic_lib::Value::ResourceArray(vec![atomic_lib::urls::CLASS.into()]),
    )?;
    resource.set_unsafe(
        atomic_lib::urls::SHORTNAME.into(),
        atomic_lib::Value::Slug("durable-target".into()),
    )?;
    resource.set_unsafe(
        atomic_lib::urls::DESCRIPTION.into(),
        atomic_lib::Value::String("A test resource for durable commits".into()),
    )?;
    let subject = resource.save_remote(client.store()).await?;
    let mut resource = client.get_resource(&subject).await?;

    let ws = WsClient::connect(&ws_url).await?;
    ws.authenticate(&agent).await?;
    assert!(
        ws.server_capabilities()
            .iter()
            .any(|c| c == "commit-durable"),
        "{:?}",
        ws.server_capabilities()
    );

    // A plain commit: acknowledged, no fsynced transaction of its own.
    // Settle first: `save_remote` above was plain too, so nothing is pending.
    let before = fsyncs();
    let json = signed_update(&client, &agent, &mut resource, "plain").await?;
    ws.post_commit(REQ_ID.fetch_add(1, Ordering::Relaxed), &json)
        .await?;
    assert_eq!(
        fsyncs(),
        before,
        "a plain commit must not wait for an fsync"
    );

    // The same over WebSocket as COMMIT_DURABLE: at least one fsynced
    // transaction has happened by the time the acknowledgement arrives.
    let mut resource = client.get_resource(&subject).await?;
    let json = signed_update(&client, &agent, &mut resource, "durable over ws").await?;
    let before = fsyncs();
    let commit_id = ws
        .post_commit_durable(REQ_ID.fetch_add(1, Ordering::Relaxed), &json)
        .await?;
    assert!(commit_id.contains("commit"), "{commit_id}");
    assert!(
        fsyncs() > before,
        "COMMIT_OK for a COMMIT_DURABLE came without an fsync"
    );

    // And over HTTP.
    let mut resource = client.get_resource(&subject).await?;
    let json = signed_update(&client, &agent, &mut resource, "durable over http").await?;
    let before = fsyncs();
    let resp = reqwest::Client::new()
        .post(format!("{server_url}/commit?durable=true"))
        .header("Content-Type", "application/ad+json")
        .body(json)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    assert_eq!(resp.status().as_u16(), 200, "{:?}", resp.text().await);
    assert!(
        fsyncs() > before,
        "a durable HTTP commit was acknowledged without an fsync"
    );

    Ok(())
}
