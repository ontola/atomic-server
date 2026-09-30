//! Integration tests for the binary live-channel subscriptions
//! (`EPHEMERAL_SUB` / `EPHEMERAL_UNSUB`, `INDEX_STATUS` 0x45) and the legacy
//! text frames the server still answers for clients up to v0.41.0-beta.7.
//!
//! The point is mixed versions: a client that subscribes the old way (text
//! `LORO_SYNC_SUBSCRIBE` / `PRESENCE_SUBSCRIBE` / `SUBSCRIBE_INDEX_STATUS`)
//! and one that subscribes the new way land in the same subscriber sets and
//! see each other's live updates.
//!
//! Run with: cargo test -p atomic-server --test it ws_ephemeral_sub

use atomic_lib::{
    client::{
        connected::Client,
        ws::{WsClient, WsMessage},
    },
    errors::AtomicResult,
    sync::protocol::{self, ephemeral_channel},
};
use std::time::Duration;
use tokio::sync::broadcast::Receiver;

use crate::common::{start_server, wait_for_server};

/// Wait up to `secs` for the first message `pick` accepts.
async fn recv_matching<T>(
    rx: &mut Receiver<WsMessage>,
    secs: u64,
    mut pick: impl FnMut(WsMessage) -> Option<T>,
) -> Option<T> {
    tokio::time::timeout(Duration::from_secs(secs), async {
        loop {
            match rx.recv().await {
                Ok(msg) => {
                    if let Some(found) = pick(msg) {
                        return Some(found);
                    }
                }
                Err(_) => return None,
            }
        }
    })
    .await
    .unwrap_or(None)
}

/// The server lists `ephemeral-sub`, and a client that sees it subscribes
/// with the binary frame.
#[tokio::test]
async fn ws_ephemeral_sub_is_advertised() -> AtomicResult<()> {
    let port = start_server("ws_ephemeral_sub_caps");
    wait_for_server(port).await;
    let client = Client::new(&format!("http://localhost:{port}")).await?;
    let alice = client.new_agent("Alice").await?;

    let ws = WsClient::connect(&format!("ws://localhost:{port}/ws")).await?;
    ws.authenticate(&alice).await?;
    assert!(
        ws.server_capabilities()
            .iter()
            .any(|c| c == protocol::CAP_EPHEMERAL_SUB),
        "{:?}",
        ws.server_capabilities()
    );
    Ok(())
}

/// A legacy text subscriber and a binary subscriber on the same drive's
/// presence and the same resource's live doc both receive each other's
/// updates.
#[tokio::test]
async fn ws_ephemeral_sub_old_and_new_clients_share_channels() -> AtomicResult<()> {
    let port = start_server("ws_ephemeral_sub_mixed");
    wait_for_server(port).await;
    let server_url = format!("http://localhost:{port}");
    let ws_url = format!("ws://localhost:{port}/ws");

    let client = Client::new(&server_url).await?;
    let alice = client.new_agent("Alice").await?;
    let drive = client.new_public_drive(&alice, "Mixed").await?;
    let mut resource = client.new_resource(&drive)?;
    resource.set_name("Shared doc")?;
    let doc = resource.save_remote(client.store()).await?;

    // Old client: text subscription frames, as a v0.41.0-beta.7 bundle sends.
    let old = WsClient::connect(&ws_url).await?;
    old.authenticate(&alice).await?;
    old.send_raw(&format!(r#"PRESENCE_SUBSCRIBE {{"subject":"{drive}"}}"#))
        .await?;
    old.send_raw(&format!(r#"LORO_SYNC_SUBSCRIBE {{"subject":"{doc}"}}"#))
        .await?;

    // New client: binary `EPHEMERAL_SUB`.
    let bob = client.new_agent("Bob").await?;
    let new = WsClient::connect(&ws_url).await?;
    new.authenticate(&bob).await?;
    new.send_binary(protocol::encode_ephemeral_sub(
        ephemeral_channel::PRESENCE,
        &drive,
    ))
    .await?;
    new.send_binary(protocol::encode_ephemeral_sub(
        ephemeral_channel::LIVE_DOC,
        &doc,
    ))
    .await?;

    let mut rx_old = old.subscribe();
    let mut rx_new = new.subscribe();

    // Subscriptions register asynchronously (a read check runs first), so
    // retry the send a few times like production's presence heartbeat.
    let mut got = None;
    for _ in 0..10 {
        old.send_presence_update(&drive, b"old-presence").await?;
        got = recv_matching(&mut rx_new, 1, |m| match m {
            WsMessage::PresenceUpdate { subject, update } if subject == drive => Some(update),
            _ => None,
        })
        .await;
        if got.is_some() {
            break;
        }
    }
    assert_eq!(
        got.as_deref(),
        Some(&b"old-presence"[..]),
        "old -> new presence"
    );

    new.send_presence_update(&drive, b"new-presence").await?;
    let got = recv_matching(&mut rx_old, 5, |m| match m {
        WsMessage::PresenceUpdate { subject, update } if subject == drive => Some(update),
        _ => None,
    })
    .await;
    assert_eq!(
        got.as_deref(),
        Some(&b"new-presence"[..]),
        "new -> old presence"
    );

    new.send_loro_ephemeral_update(&doc, b"new-cursor").await?;
    let got = recv_matching(&mut rx_old, 5, |m| match m {
        WsMessage::LoroEphemeralUpdate { subject, update } if subject == doc => Some(update),
        _ => None,
    })
    .await;
    assert_eq!(
        got.as_deref(),
        Some(&b"new-cursor"[..]),
        "new -> old cursor"
    );

    old.send_loro_sync_update(&doc, b"old-edit").await?;
    let got = recv_matching(&mut rx_new, 5, |m| match m {
        WsMessage::LoroSyncUpdate { subject, update } if subject == doc => Some(update),
        _ => None,
    })
    .await;
    assert_eq!(got.as_deref(), Some(&b"old-edit"[..]), "old -> new doc ops");

    // Binary unsubscribe: the new client stops receiving presence.
    new.send_binary(protocol::encode_ephemeral_unsub(
        ephemeral_channel::PRESENCE,
        &drive,
    ))
    .await?;
    tokio::time::sleep(Duration::from_millis(300)).await;
    old.send_presence_update(&drive, b"after-unsub").await?;
    let got = recv_matching(&mut rx_new, 1, |m| match m {
        WsMessage::PresenceUpdate { subject, update } if subject == drive => Some(update),
        _ => None,
    })
    .await;
    assert!(got.is_none(), "unsubscribed client still got {got:?}");
    Ok(())
}

/// Index status answers in the form it was asked in: binary `INDEX_STATUS`
/// for `EPHEMERAL_SUB`, the text frame for `SUBSCRIBE_INDEX_STATUS`. Neither
/// needs an identity.
#[tokio::test]
async fn ws_ephemeral_sub_index_status_in_both_forms() -> AtomicResult<()> {
    let port = start_server("ws_ephemeral_sub_index");
    wait_for_server(port).await;
    let client = Client::new(&format!("http://localhost:{port}")).await?;
    let alice = client.new_agent("Alice").await?;
    let drive = client.new_public_drive(&alice, "Indexed").await?;
    let ws_url = format!("ws://localhost:{port}/ws");

    let new = WsClient::connect(&ws_url).await?;
    let mut rx_new = new.subscribe();
    new.send_binary(protocol::encode_ephemeral_sub(
        ephemeral_channel::INDEX_STATUS,
        &drive,
    ))
    .await?;
    let got = recv_matching(&mut rx_new, 5, |m| match m {
        WsMessage::IndexStatus { drive: d, indexing } if d == drive => Some(indexing),
        _ => None,
    })
    .await;
    assert_eq!(got, Some(false), "binary INDEX_STATUS for {drive}");

    let old = WsClient::connect(&ws_url).await?;
    let mut rx_old = old.subscribe();
    old.send_raw(&format!(r#"SUBSCRIBE_INDEX_STATUS {{"drive":"{drive}"}}"#))
        .await?;
    let got = recv_matching(&mut rx_old, 5, |m| match m {
        WsMessage::Unrecognized(text) if text.starts_with("INDEX_STATUS ") => Some(text),
        WsMessage::IndexStatus { .. } => Some("binary".to_string()),
        _ => None,
    })
    .await
    .expect("text INDEX_STATUS");
    let json: serde_json::Value =
        serde_json::from_str(got.trim_start_matches("INDEX_STATUS ")).expect("json");
    assert_eq!(json["drive"], drive.as_str());
    assert_eq!(json["indexing"], false);
    Ok(())
}

/// The live-doc and presence channels carry an identity, so an anonymous
/// `EPHEMERAL_SUB` is refused like the text frames were.
#[tokio::test]
async fn ws_ephemeral_sub_needs_auth_for_identity_channels() -> AtomicResult<()> {
    let port = start_server("ws_ephemeral_sub_anon");
    wait_for_server(port).await;
    let client = Client::new(&format!("http://localhost:{port}")).await?;
    let alice = client.new_agent("Alice").await?;
    let drive = client.new_public_drive(&alice, "Public").await?;

    let ws = WsClient::connect(&format!("ws://localhost:{port}/ws")).await?;
    let mut rx = ws.subscribe();
    for channel in [ephemeral_channel::LIVE_DOC, ephemeral_channel::PRESENCE] {
        ws.send_binary(protocol::encode_ephemeral_sub(channel, &drive))
            .await?;
        let err = recv_matching(&mut rx, 5, |m| match m {
            WsMessage::Error { message, .. } => Some(message),
            _ => None,
        })
        .await
        .expect("an ERROR");
        assert!(err.contains("AUTH required"), "channel {channel}: {err}");
    }
    Ok(())
}
