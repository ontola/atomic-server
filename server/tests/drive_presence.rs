//! Integration test: drive-scoped ephemeral presence (issue #1229).
//!
//! Presence updates are opaque Loro EphemeralStore blobs relayed through
//! `LoroSyncBroadcaster`'s drive-keyed presence map. The contract pinned
//! here:
//!
//! 1. An update broadcast by one presence subscriber reaches every other
//!    subscriber of the same drive — and never echoes back to the sender.
//! 2. The broadcaster caches each connection's latest state and replays it
//!    to late joiners at subscribe time, so a newly-opened tab sees who is
//!    present without waiting for the next heartbeat.
//! 3. Subscribing is the auth gate: an agent without read access on the
//!    drive never gets fan-out, and a connection that skipped
//!    `PRESENCE_SUBSCRIBE` cannot broadcast into the drive.
//!
//! Run with: cargo test -p atomic-server --test drive_presence

use atomic_lib::{
    client::{
        connected::Client,
        ws::{WsClient, WsMessage},
    },
    errors::AtomicResult,
};
use atomic_server_lib as atomic_server;
use std::time::Duration;
use tokio::sync::broadcast::Receiver;

/// Start an AtomicServer on a random port in a background thread.
fn start_server() -> u16 {
    let unique = atomic_lib::utils::random_string(10);
    let port = portpicker::pick_unused_port().expect("no free port");

    use clap::Parser;
    let opts = atomic_server::config::Opts::parse_from([
        "atomic-server",
        "--initialize",
        "--port",
        &port.to_string(),
        "--data-dir",
        &format!("./.temp/drive_presence_{}/db", unique),
        "--config-dir",
        &format!("./.temp/drive_presence_{}/config", unique),
    ]);

    let mut config = atomic_server::config::build_config(opts).expect("config failed");
    config.search_index_path = format!("./.temp/drive_presence_{}/search", unique).into();

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
    for _ in 0..600 {
        if reqwest::get(&base).await.is_ok() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    panic!("Server did not start within 60 seconds");
}

/// Wait up to `secs` for a `PresenceUpdate` on `drive`; `None` on timeout.
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
async fn presence_relays_caches_and_gates() -> AtomicResult<()> {
    let port = start_server();
    wait_for_server(port).await;
    let server_url = format!("http://localhost:{}", port);
    let ws_url = format!("ws://localhost:{}/ws", port);

    let client = Client::new(&server_url).await?;
    let agent_a = client.new_agent("Alice").await?;
    let drive = client.new_public_drive(&agent_a, "Presence Drive").await?;

    let client_b = Client::new(&server_url).await?;
    let agent_b = client_b.new_agent("Bob").await?;

    // ----- Alice and Bob subscribe to the drive's presence channel -----
    let ws_a = WsClient::connect(&ws_url).await?;
    ws_a.authenticate(&agent_a).await?;
    ws_a.subscribe_presence(&drive).await?;

    let ws_b = WsClient::connect(&ws_url).await?;
    ws_b.authenticate(&agent_b).await?;
    ws_b.subscribe_presence(&drive).await?;

    let mut rx_a = ws_a.subscribe();
    let mut rx_b = ws_b.subscribe();

    // Let both subscriptions register in the broadcaster's map.
    tokio::time::sleep(Duration::from_millis(300)).await;

    // ----- Relay: Alice broadcasts, Bob receives, Alice gets no echo -----
    // Bytes are opaque to the server; production sends
    // `EphemeralStore.encodeAll()`, a distinctive blob suffices here.
    let alice_state: Vec<u8> = b"alice-presence-state".to_vec();
    ws_a.send_presence_update(&drive, &alice_state).await?;

    let received = recv_presence(&mut rx_b, &drive, 5)
        .await
        .expect("Bob should receive Alice's presence update");
    assert_eq!(
        received, alice_state,
        "Bob should receive the exact bytes Alice broadcast"
    );

    assert!(
        recv_presence(&mut rx_a, &drive, 1).await.is_none(),
        "Sender should not receive its own presence update (got echo)"
    );

    // ----- Cache replay: a late joiner sees Alice's state immediately -----
    let client_c = Client::new(&server_url).await?;
    let agent_c = client_c.new_agent("Carol").await?;
    let ws_c = WsClient::connect(&ws_url).await?;
    ws_c.authenticate(&agent_c).await?;
    let mut rx_c = ws_c.subscribe();
    ws_c.subscribe_presence(&drive).await?;

    let replayed = recv_presence(&mut rx_c, &drive, 5)
        .await
        .expect("Late joiner should receive Alice's cached presence state");
    assert_eq!(
        replayed, alice_state,
        "Replayed state should be Alice's latest broadcast"
    );

    // ----- Gate: broadcasting without subscribing goes nowhere -----
    let ws_d = WsClient::connect(&ws_url).await?;
    ws_d.authenticate(&agent_b).await?;
    ws_d.send_presence_update(&drive, b"not-subscribed").await?;

    assert!(
        recv_presence(&mut rx_b, &drive, 1).await.is_none(),
        "Updates from a non-subscribed connection must not fan out"
    );

    // ----- Gate: no read access on the drive → subscribe is refused -----
    // Alice's *private* drive: Bob can't read it, so his subscription is
    // dropped and Alice's broadcasts never reach him.
    let private_drive = client.new_drive(&agent_a, "Private Drive").await?;

    let ws_a2 = WsClient::connect(&ws_url).await?;
    ws_a2.authenticate(&agent_a).await?;
    ws_a2.subscribe_presence(&private_drive).await?;

    let ws_b2 = WsClient::connect(&ws_url).await?;
    ws_b2.authenticate(&agent_b).await?;
    let mut rx_b2 = ws_b2.subscribe();
    ws_b2.subscribe_presence(&private_drive).await?;

    tokio::time::sleep(Duration::from_millis(300)).await;
    ws_a2
        .send_presence_update(&private_drive, b"secret-location")
        .await?;

    assert!(
        recv_presence(&mut rx_b2, &private_drive, 1).await.is_none(),
        "Agent without read access must not receive presence for a private drive"
    );

    Ok(())
}
