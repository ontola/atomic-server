//! Integration tests for the WebSocket trust gates: which frames need an
//! AUTH first, that a subscription without read rights is refused out loud,
//! and that a refused SYNC_PUSH is answered with an ERROR and never with
//! SYNC_OK.
//!
//! Every refusal here used to be silent (a dropped frame, or a `SYNC_OK`
//! for an import that never happened). These tests pin the *visible*
//! answer: an `ERROR` frame whose code says what went wrong.
//!
//! Run with: cargo test -p atomic-server --test it ws_auth_gate

use atomic_lib::{
    agents::Agent,
    client::{
        connected::Client,
        ws::{WsClient, WsMessage},
    },
    sync::protocol,
};
use std::time::Duration;
use tokio::sync::broadcast::Receiver;

use crate::common::{start_server, wait_for_server};

/// Wait for the next `ERROR` the server sends on this connection.
async fn next_error(rx: &mut Receiver<WsMessage>) -> String {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            match rx.recv().await {
                Ok(WsMessage::Error(e)) => return e,
                Ok(_) => continue,
                Err(e) => panic!("connection closed before an ERROR arrived: {e}"),
            }
        }
    })
    .await
    .expect("server answers a refused frame with an ERROR within 5s")
}

/// Assert that no `SYNC_OK` (and no ERROR either) shows up for a while.
async fn assert_quiet(rx: &mut Receiver<WsMessage>) {
    let unexpected = tokio::time::timeout(Duration::from_millis(700), async {
        loop {
            match rx.recv().await {
                Ok(WsMessage::SyncOk { .. }) => return "SYNC_OK",
                Ok(WsMessage::Error(_)) => return "ERROR",
                Ok(_) => continue,
                Err(_) => return "closed",
            }
        }
    })
    .await;
    assert!(
        unexpected.is_err(),
        "expected silence, got {}",
        unexpected.unwrap()
    );
}

/// A SYNC_PUSH frame for `drive` carrying one entry with `bytes`. The
/// content is irrelevant to a rights refusal: the gate fires before any
/// entry is looked at.
fn sync_push(drive: &str, subject: &str, bytes: &[u8]) -> Vec<u8> {
    protocol::encode_sync_push(drive, &[(subject, bytes)], true)
}

/// A private drive owned by `owner`, plus one child in it that a stranger
/// cannot read.
async fn private_drive_with_child(client: &Client, owner: &Agent) -> (String, String) {
    let drive = client.new_drive(owner, "Private").await.unwrap();
    let mut child = client.new_resource(&drive).unwrap();
    child.set_name("Secret").unwrap();
    child
        .set_unsafe(
            atomic_lib::urls::SHORTNAME.into(),
            atomic_lib::Value::Slug("secret".into()),
        )
        .unwrap();
    child
        .set_unsafe(
            atomic_lib::urls::DESCRIPTION.into(),
            atomic_lib::Value::String("only the owner can read this".into()),
        )
        .unwrap();
    child
        .set_unsafe(
            atomic_lib::urls::IS_A.into(),
            atomic_lib::Value::ResourceArray(vec![atomic_lib::urls::CLASS.into()]),
        )
        .unwrap();
    let subject = child.save_remote(client.store()).await.unwrap();
    (drive, subject)
}

/// Frames that write, or that carry an identity to peers, are refused
/// before AUTH with `AUTH_REQUIRED`. The socket stays open: an anonymous
/// session of a public share link keeps reading.
#[tokio::test]
async fn anonymous_writes_and_identity_subscriptions_are_refused() {
    let port = start_server("ws_gate_anon");
    wait_for_server(port).await;
    let server_url = format!("http://localhost:{port}");
    let ws_url = format!("ws://localhost:{port}/ws");

    let client = Client::new(&server_url).await.unwrap();
    let alice = client.new_agent("Alice").await.unwrap();
    let drive = client.new_public_drive(&alice, "Public").await.unwrap();

    let ws = WsClient::connect(&ws_url).await.unwrap();
    let mut rx = ws.subscribe();

    // Binary SYNC_PUSH: the one that used to bootstrap a stranger's drive
    // onto an open node without anyone saying who they were.
    ws.send_binary(sync_push(&drive, "did:ad:x", b"junk"))
        .await
        .unwrap();
    let err = next_error(&mut rx).await;
    assert!(err.contains("AUTH required"), "{err}");

    // The text frames that carry an identity or write.
    for frame in [
        format!("SUBSCRIBE {drive}"),
        format!(r#"SUBSCRIBE_QUERY {{"drive":"{drive}"}}"#),
        format!(r#"LORO_SYNC_SUBSCRIBE {{"subject":"{drive}"}}"#),
        format!(r#"LORO_SYNC_UPDATE {{"subject":"{drive}","update":""}}"#),
        format!(r#"PRESENCE_SUBSCRIBE {{"subject":"{drive}"}}"#),
        format!(r#"PRESENCE_UPDATE {{"subject":"{drive}","update":""}}"#),
    ] {
        ws.send_raw(&frame).await.unwrap();
        let err = next_error(&mut rx).await;
        assert!(err.contains("AUTH required"), "{frame} -> {err}");
    }

    // And the socket is still usable: AUTH now succeeds on the same
    // connection, so the refusals were per frame, not per connection.
    ws.authenticate(&alice)
        .await
        .expect("the connection survives its refused frames");
}

/// Anonymous *reads* are not gated by AUTH — `SUB <drive>` is what a
/// public share link uses for live updates. The read gate is `check_read`,
/// which an anonymous session passes for a public drive.
#[tokio::test]
async fn anonymous_drive_subscription_on_a_public_drive_is_accepted() {
    let port = start_server("ws_gate_anon_sub");
    wait_for_server(port).await;
    let server_url = format!("http://localhost:{port}");
    let ws_url = format!("ws://localhost:{port}/ws");

    let client = Client::new(&server_url).await.unwrap();
    let alice = client.new_agent("Alice").await.unwrap();
    let drive = client.new_public_drive(&alice, "Public").await.unwrap();

    let ws = WsClient::connect(&ws_url).await.unwrap();
    let mut rx = ws.subscribe();
    ws.send_binary(protocol::encode_sub(&drive)).await.unwrap();
    assert_quiet(&mut rx).await;
}

/// An authenticated agent without read rights on the subject is told so
/// (`UNAUTHORIZED_READ`) instead of being left to wait for updates that
/// never come.
#[tokio::test]
async fn subscription_without_read_right_is_refused_out_loud() {
    let port = start_server("ws_gate_read");
    wait_for_server(port).await;
    let server_url = format!("http://localhost:{port}");
    let ws_url = format!("ws://localhost:{port}/ws");

    let client = Client::new(&server_url).await.unwrap();
    let alice = client.new_agent("Alice").await.unwrap();
    let (drive, secret) = private_drive_with_child(&client, &alice).await;
    let mallory = client.new_agent("Mallory").await.unwrap();

    let ws = WsClient::connect(&ws_url).await.unwrap();
    ws.authenticate(&mallory).await.unwrap();
    let mut rx = ws.subscribe();

    ws.subscribe_resource(&secret).await.unwrap();
    let err = next_error(&mut rx).await;
    assert!(
        err.contains("SUBSCRIBE refused") && err.contains(&secret),
        "{err}"
    );

    ws.send_binary(protocol::encode_sub(&drive)).await.unwrap();
    let err = next_error(&mut rx).await;
    assert!(err.contains("SUB refused") && err.contains(&drive), "{err}");

    ws.send_raw(&format!(r#"SUBSCRIBE_QUERY {{"drive":"{drive}"}}"#))
        .await
        .unwrap();
    let err = next_error(&mut rx).await;
    assert!(err.contains("SUBSCRIBE_QUERY refused"), "{err}");

    ws.subscribe_loro_sync(&secret).await.unwrap();
    let err = next_error(&mut rx).await;
    assert!(err.contains("LORO_SYNC_SUBSCRIBE refused"), "{err}");

    ws.send_raw(&format!(r#"PRESENCE_SUBSCRIBE {{"subject":"{drive}"}}"#))
        .await
        .unwrap();
    let err = next_error(&mut rx).await;
    assert!(err.contains("PRESENCE_SUBSCRIBE refused"), "{err}");

    // The owner's subscriptions to the same things go through silently.
    let ws_owner = WsClient::connect(&ws_url).await.unwrap();
    ws_owner.authenticate(&alice).await.unwrap();
    let mut rx_owner = ws_owner.subscribe();
    ws_owner.subscribe_resource(&secret).await.unwrap();
    ws_owner
        .send_binary(protocol::encode_sub(&drive))
        .await
        .unwrap();
    assert_quiet(&mut rx_owner).await;
}

/// A SYNC_PUSH into a drive the agent may not write is answered with
/// `SYNC_REJECTED` — and, the point of the change, *not* with `SYNC_OK`.
#[tokio::test]
async fn rejected_sync_push_gets_error_not_sync_ok() {
    let port = start_server("ws_gate_push");
    wait_for_server(port).await;
    let server_url = format!("http://localhost:{port}");
    let ws_url = format!("ws://localhost:{port}/ws");

    let client = Client::new(&server_url).await.unwrap();
    let alice = client.new_agent("Alice").await.unwrap();
    let (drive, secret) = private_drive_with_child(&client, &alice).await;
    let mallory = client.new_agent("Mallory").await.unwrap();

    let ws = WsClient::connect(&ws_url).await.unwrap();
    ws.authenticate(&mallory).await.unwrap();
    let mut rx = ws.subscribe();

    ws.send_binary(sync_push(&drive, &secret, b"junk"))
        .await
        .unwrap();

    let answer = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            match rx.recv().await {
                Ok(WsMessage::Error(e)) => return Ok(e),
                Ok(WsMessage::SyncOk { drive }) => return Err(drive),
                Ok(_) => continue,
                Err(e) => panic!("connection closed: {e}"),
            }
        }
    })
    .await
    .expect("the push is answered within 5s");
    let err = answer.expect("a refused push is answered with ERROR, not SYNC_OK");
    assert!(
        err.contains("SYNC_PUSH rejected") && err.contains(&drive),
        "{err}"
    );
    assert!(err.contains("no write right"), "{err}");
    assert_quiet(&mut rx).await;
}
