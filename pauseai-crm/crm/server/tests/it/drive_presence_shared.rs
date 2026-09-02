//! Repro for #1229 field report: two DIFFERENT agents in one drive that is
//! shared explicitly (B added to the drive's `read` array — not public).
//! Presence must relay in both directions.
//!
//! Run with: cargo test -p atomic-server --test drive_presence_shared

use atomic_lib::{
    client::{
        connected::Client,
        ws::{WsClient, WsMessage},
    },
    errors::AtomicResult,
    urls, Value,
};
use std::time::Duration;
use tokio::sync::broadcast::Receiver;

use crate::common::{start_server, wait_for_server};

async fn recv_presence(rx: &mut Receiver<WsMessage>, drive: &str, secs: u64) -> Option<Vec<u8>> {
    tokio::time::timeout(Duration::from_secs(secs), async {
        loop {
            match rx.recv().await {
                Ok(WsMessage::PresenceUpdate { subject, update }) if subject == drive => {
                    return Some(update);
                }
                Ok(_) => continue,
                Err(_) => return None,
            }
        }
    })
    .await
    .unwrap_or(None)
}

#[tokio::test]
async fn presence_between_two_agents_in_shared_private_drive() -> AtomicResult<()> {
    let port = start_server("drive_presence_shared");
    wait_for_server(port).await;
    let server_url = format!("http://localhost:{}", port);
    let ws_url = format!("ws://localhost:{}/ws", port);

    let client_a = Client::new(&server_url).await?;
    let agent_a = client_a.new_agent("AgentA").await?;
    // Private drive: only A can read/write at creation.
    let drive = client_a.new_drive(&agent_a, "Shared Drive").await?;

    let client_b = Client::new(&server_url).await?;
    let agent_b = client_b.new_agent("AgentB").await?;

    // A shares the drive with B: read = [A, B].
    let mut drive_resource = client_a.get_resource(&drive).await?;
    drive_resource.set_unsafe(
        urls::READ.into(),
        Value::ResourceArray(vec![
            agent_a.subject.to_string().into(),
            agent_b.subject.to_string().into(),
        ]),
    )?;
    drive_resource.save_remote(client_a.store()).await?;

    // Both connect + subscribe presence with their own agents.
    let ws_a = WsClient::connect(&ws_url).await?;
    ws_a.authenticate(&agent_a).await?;
    ws_a.subscribe_presence(&drive).await?;

    let ws_b = WsClient::connect(&ws_url).await?;
    ws_b.authenticate(&agent_b).await?;
    ws_b.subscribe_presence(&drive).await?;

    let mut rx_a = ws_a.subscribe();
    let mut rx_b = ws_b.subscribe();
    tokio::time::sleep(Duration::from_millis(300)).await;

    // A → B
    ws_a.send_presence_update(&drive, b"a-is-here").await?;
    let received_by_b = recv_presence(&mut rx_b, &drive, 5).await;
    assert_eq!(
        received_by_b.as_deref(),
        Some(b"a-is-here".as_slice()),
        "B (explicit read via share) should receive A's presence"
    );

    // B → A: B has read but NOT write on the drive. Presence must not
    // require write — viewing is enough to be visible.
    ws_b.send_presence_update(&drive, b"b-is-here").await?;
    let received_by_a = recv_presence(&mut rx_a, &drive, 5).await;
    assert_eq!(
        received_by_a.as_deref(),
        Some(b"b-is-here".as_slice()),
        "A should receive read-only B's presence"
    );

    Ok(())
}
