//! WebSocket DESTROY broadcast integration test.
//!
//! Asserts that a destroy commit triggers a `DESTROY (0x12)` frame to
//! resource subscribers (rather than an `UPDATE`). The existing
//! `multi_client_sync` / `ws_commit` flows only exercise UPDATE; this
//! locks the destroy fanout path.
//!
//! Run: cargo test -p atomic-server --test ws_destroy

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
async fn ws_destroy_broadcasts_to_subscriber() -> AtomicResult<()> {
    let port = start_server("ws_destroy");
    wait_for_server(port).await;
    let server_url = format!("http://localhost:{}", port);
    let ws_url = format!("ws://localhost:{}/ws", port);

    // Author + resource.
    let client_a = Client::new(&server_url).await?;
    let agent_a = client_a.new_agent("Alice").await?;
    let drive = client_a.new_public_drive(&agent_a, "Destroy Drive").await?;

    let mut resource = client_a.new_resource(&drive)?;
    resource.set_name("Doomed Resource")?;
    resource.set_unsafe(
        atomic_lib::urls::IS_A.into(),
        atomic_lib::Value::ResourceArray(vec![atomic_lib::urls::CLASS.into()]),
    )?;
    resource.set_unsafe(
        atomic_lib::urls::SHORTNAME.into(),
        atomic_lib::Value::Slug("doomed".into()),
    )?;
    resource.set_unsafe(
        atomic_lib::urls::DESCRIPTION.into(),
        atomic_lib::Value::String("Will be destroyed".into()),
    )?;
    let subject = resource.save_remote(client_a.store()).await?;
    let resource = client_a.get_resource(&subject).await?;

    // Subscriber (Bob) attaches before the destroy fires.
    let client_b = Client::new(&server_url).await?;
    let agent_b = client_b.new_agent("Bob").await?;
    let ws_b = WsClient::connect(&ws_url).await?;
    ws_b.authenticate(&agent_b).await?;
    ws_b.subscribe_resource(&subject).await?;
    let mut rx = ws_b.subscribe();

    // Give the SUB registration a moment to land on the server.
    tokio::time::sleep(Duration::from_millis(200)).await;

    // Alice destroys via a WS COMMIT carrying `destroy: true`. We use the WS
    // commit path (rather than HTTP) so the destroy travels the same code
    // path real browser clients use today.
    let mut commitbuilder = resource.get_commit_builder().clone();
    commitbuilder.destroy(true);
    let commit = commitbuilder
        .sign(&agent_a, client_a.store(), &resource)
        .await?;
    let commit_json = atomic_lib::client::commit_to_wire_json(&commit, client_a.store()).await?;

    let ws_a = WsClient::connect(&ws_url).await?;
    ws_a.authenticate(&agent_a).await?;
    let request_id = REQ_ID.fetch_add(1, Ordering::Relaxed);
    let _ok = ws_a.post_commit(request_id, &commit_json).await?;

    // Bob should receive a DESTROY for that subject, not an UPDATE.
    let outcome = tokio::time::timeout(Duration::from_secs(10), async {
        while let Ok(msg) = rx.recv().await {
            match msg {
                WsMessage::Destroy { subject: s } if s == subject => {
                    return Some(Ok::<(), String>(()));
                }
                WsMessage::Update { subject: s, .. } if s == subject => {
                    return Some(Err(format!(
                        "expected DESTROY for {}, got UPDATE — server is not \
                         emitting the destroy broadcast",
                        s
                    )));
                }
                _ => continue,
            }
        }
        None
    })
    .await
    .map_err(|_| atomic_lib::errors::AtomicError::from("Timed out waiting for DESTROY"))?
    .ok_or_else(|| atomic_lib::errors::AtomicError::from("WS closed before any frame arrived"))?;

    outcome.map_err(atomic_lib::errors::AtomicError::from)?;
    Ok(())
}
