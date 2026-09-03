//! `UNSUB` (0x21) cancels a drive subscription.
//!
//! Until 2026-09 the frame only edited a set on the connection actor that
//! nothing read, so the fan-out kept delivering for the life of the socket.
//! This pins the real behaviour: after `UNSUB`, a commit in the drive
//! produces no frame on that connection, while a second subscriber still
//! gets it.
//!
//! Run: cargo test -p atomic-server --test it ws_unsub

use atomic_lib::{
    client::{
        connected::Client,
        ws::{WsClient, WsMessage},
    },
    errors::AtomicResult,
};
use std::time::Duration;
use tokio::sync::broadcast::Receiver;

use crate::common::{start_server, wait_for_server};

/// Wait for an `UPDATE` naming `subject`.
async fn expect_update(rx: &mut Receiver<WsMessage>, subject: &str) {
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            match rx.recv().await {
                Ok(WsMessage::Update { subject: s, .. }) if s == subject => return,
                Ok(_) => continue,
                Err(e) => panic!("connection closed before the UPDATE arrived: {e}"),
            }
        }
    })
    .await
    .unwrap_or_else(|_| panic!("no UPDATE for {subject} within 10s"));
}

/// Assert that no `UPDATE` for `subject` arrives for a while.
async fn expect_no_update(rx: &mut Receiver<WsMessage>, subject: &str) {
    let leaked = tokio::time::timeout(Duration::from_millis(1500), async {
        loop {
            match rx.recv().await {
                Ok(WsMessage::Update { subject: s, .. }) if s == subject => return true,
                Ok(_) => continue,
                Err(_) => return false,
            }
        }
    })
    .await;
    assert!(
        !matches!(leaked, Ok(true)),
        "an UPDATE for {subject} arrived after UNSUB"
    );
}

#[tokio::test]
async fn unsub_stops_drive_fanout_for_that_connection_only() -> AtomicResult<()> {
    let port = start_server("ws_unsub");
    wait_for_server(port).await;
    let server_url = format!("http://localhost:{port}");
    let ws_url = format!("ws://localhost:{port}/ws");

    let client = Client::new(&server_url).await?;
    let alice = client.new_agent("Alice").await?;
    let drive = client.new_public_drive(&alice, "Unsub Drive").await?;

    let mut resource = client.new_resource(&drive)?;
    resource.set_name("v1")?;
    let subject = resource.save_remote(client.store()).await?;

    // Two subscribers to the drive.
    let ws_a = WsClient::connect(&ws_url).await?;
    let mut rx_a = ws_a.subscribe();
    ws_a.subscribe_drive(&drive).await?;
    let ws_b = WsClient::connect(&ws_url).await?;
    let mut rx_b = ws_b.subscribe();
    ws_b.subscribe_drive(&drive).await?;
    tokio::time::sleep(Duration::from_millis(300)).await;

    // Both see the first edit.
    let mut resource = client.get_resource(&subject).await?;
    resource.set_name("v2")?;
    resource.save_remote(client.store()).await?;
    expect_update(&mut rx_a, &subject).await;
    expect_update(&mut rx_b, &subject).await;

    // A unsubscribes; B stays.
    ws_a.unsubscribe_drive(&drive).await?;
    tokio::time::sleep(Duration::from_millis(300)).await;

    let mut resource = client.get_resource(&subject).await?;
    resource.set_name("v3")?;
    resource.save_remote(client.store()).await?;
    expect_update(&mut rx_b, &subject).await;
    expect_no_update(&mut rx_a, &subject).await;

    Ok(())
}
