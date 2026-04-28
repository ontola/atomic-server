//! Iroh peer-to-peer transport for the v2 binary protocol.
//!
//! Any device running atomic-lib with the `iroh` feature becomes a peer node.
//! Peers connect via NodeID — no port forwarding, DNS, or TLS needed.
//!
//! Addressing (relay URL, direct addresses) is handled by Iroh's `discovery_n0()`.
//! Peer discovery (agent → NodeID) is handled by pkarr in `discovery.rs`.
//!
//! Wire format is the same v2 protocol used over WebSocket; see
//! `docs/src/websockets.md` (canonical spec) and [`super::protocol`] for
//! tags / encoders. The one extension peer streams add on top of the
//! browser-WS subset is the `HELLO (0x37)` device-name handshake sent
//! immediately after `AUTH_OK` — see `encode_hello` / `decode_hello` in
//! [`super::protocol`].

use crate::{Db, Storelike, agents::ForAgent};
use iroh::{Endpoint, NodeId, protocol::Router};
use std::sync::OnceLock;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// Map Iroh I/O errors to AtomicError.
fn io_err(e: impl std::fmt::Display) -> crate::errors::AtomicError {
    format!("Iroh I/O error: {e}").into()
}

/// ALPN protocol identifier for Atomic Data over Iroh.
const ATOMIC_ALPN: &[u8] = b"atomic/1";

/// Canonical 64-char lowercase hex NodeID for map keys and UI matching.
pub fn normalize_node_id(id: &str) -> String {
    let mut s = id.trim().to_string();
    if let Some(rest) = s.strip_prefix("did:ad:node:") {
        s = rest.split(':').next().unwrap_or(rest).to_string();
    } else if let Some(rest) = s.strip_prefix("iroh:") {
        s = rest.to_string();
    }
    s.to_lowercase()
}

/// Global NodeID, set once on startup.
static NODE_ID: OnceLock<String> = OnceLock::new();

/// Resolve the device name this node announces in `HELLO` frames.
///
/// Order of precedence:
///  1. Whatever is persisted via [`set_device_name`] (flutter app UI, server
///     `--device-name` / `ATOMIC_DEVICE_NAME` written at startup).
///  2. The OS hostname (`gethostname()`).
///  3. The literal `"Unknown"`.
///
/// Truncates to [`crate::sync::protocol::HELLO_MAX_CHARS`] scalar values
/// so a misconfigured peer can't drive the on-wire length cap into reject.
pub fn effective_device_name(store: &Db) -> String {
    let from_db = get_device_name(store);
    let raw = if !from_db.trim().is_empty() {
        from_db
    } else {
        hostname::get()
            .ok()
            .and_then(|os| os.into_string().ok())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "Unknown".to_string())
    };
    let max = super::protocol::HELLO_MAX_CHARS;
    if raw.chars().count() > max {
        raw.chars().take(max).collect()
    } else {
        raw
    }
}

/// Returns the Iroh NodeID if the peer node is running.
pub fn get_node_id() -> Option<&'static str> {
    NODE_ID.get().map(|s| s.as_str())
}

/// Key used to persist the Iroh secret key in the DB.
const IROH_SECRET_KEY: &[u8] = b"_iroh_secret_key";
const DEVICE_NAME_KEY: &[u8] = b"_device_name";

/// Get the persisted device name.
pub fn get_device_name(store: &Db) -> String {
    store
        .kv
        .get(crate::db::trees::Tree::PluginMeta, DEVICE_NAME_KEY)
        .ok()
        .flatten()
        .and_then(|b| String::from_utf8(b).ok())
        .unwrap_or_default()
}

/// Set the device name (persisted in DB).
pub fn set_device_name(store: &Db, name: &str) {
    let _ = store.kv.insert(
        crate::db::trees::Tree::PluginMeta,
        DEVICE_NAME_KEY,
        name.as_bytes(),
    );
}

/// Load or generate a persistent Iroh secret key.
/// Stored in the DB so the NodeID survives app restarts.
fn load_or_create_secret_key(store: &Db) -> iroh::SecretKey {
    if let Ok(Some(bytes)) = store
        .kv
        .get(crate::db::trees::Tree::PluginMeta, IROH_SECRET_KEY)
    {
        if bytes.len() == 32 {
            let mut arr = [0u8; 32];
            arr.copy_from_slice(&bytes);
            return iroh::SecretKey::from_bytes(&arr);
        }
    }
    // Generate and persist
    let key = iroh::SecretKey::generate(rand::rngs::OsRng);
    let _ = store.kv.insert(
        crate::db::trees::Tree::PluginMeta,
        IROH_SECRET_KEY,
        &key.to_bytes(),
    );
    key
}

/// Start the Iroh peer node. Returns the NodeID and a Router that must be kept alive.
///
/// The NodeID is persistent — derived from a secret key stored in the DB.
/// Waits for the relay connection to be established before returning,
/// so that other peers can discover and connect to us immediately.
pub async fn start(store: Db) -> anyhow::Result<(NodeId, Router)> {
    let secret_key = load_or_create_secret_key(&store);
    let endpoint: Endpoint = Endpoint::builder()
        .secret_key(secret_key)
        .discovery_n0()
        .bind()
        .await?;

    let node_id = endpoint.node_id();
    NODE_ID.set(node_id.to_string()).ok();
    ENDPOINT.set(endpoint.clone()).ok();

    // Wait for relay connection so discovery_n0 can find us
    let relay = endpoint.home_relay();
    tracing::info!("Iroh NodeID: {node_id}, waiting for relay...");
    let relay_url =
        tokio::time::timeout(std::time::Duration::from_secs(10), wait_for_relay(relay)).await;
    match relay_url {
        Ok(Some(url)) => tracing::info!("Iroh relay connected: {url}"),
        Ok(None) => tracing::warn!("Iroh relay: none (direct connections only)"),
        Err(_) => tracing::warn!("Iroh relay: timed out after 10s (connections may fail)"),
    }

    let bg_store = store.clone();
    let router = Router::builder(endpoint)
        .accept(ATOMIC_ALPN, AtomicHandler { store })
        .spawn();

    // Keep router alive globally — dropping it stops incoming connections
    ROUTER.set(router.clone()).ok();

    // Start live sync — watches for local changes, pushes to connected peers
    start_live_sync(bg_store.clone());

    // Auto-connect to known peers in background, retry until connected
    let auto_store = bg_store;
    tokio::spawn(async move {
        let my_id = normalize_node_id(get_node_id().unwrap_or_default());

        // Brief delay so relay can register our NodeID
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;

        loop {
            let drive = match auto_store.get_active_drive() {
                Some(d) => d,
                None => {
                    tokio::time::sleep(std::time::Duration::from_secs(10)).await;
                    continue;
                }
            };
            let peers = get_known_peers(&auto_store);
            if peers.is_empty() {
                tokio::time::sleep(std::time::Duration::from_secs(10)).await;
                continue;
            }

            let mut all_connected = true;
            for peer in &peers {
                if normalize_node_id(&peer.node_id) == my_id {
                    continue;
                }
                let peer_key = normalize_node_id(&peer.node_id);
                if live_peer_ids().contains(&peer_key) {
                    continue;
                }

                // Prefer the device with the smaller NodeID to dial first (avoids
                // duplicate handshakes). The larger NodeID waits briefly, then
                // also dials if still offline — otherwise one side never connects
                // when relay discovery is flaky.
                if normalize_node_id(&my_id) > peer_key {
                    if live_peer_ids().contains(&peer_key) {
                        continue;
                    }
                    tokio::time::sleep(std::time::Duration::from_secs(3)).await;
                    if live_peer_ids().contains(&peer_key) {
                        continue;
                    }
                }

                all_connected = false;
                tracing::info!(
                    "[auto_connect] connecting to {}",
                    &peer.node_id[..peer.node_id.len().min(12)]
                );
                match sync_drive_with_peer_if_needed(&peer.node_id, &drive, &auto_store).await {
                    Ok(count) => {
                        tracing::info!(
                            "[auto_connect] synced {count} resources, live connection established"
                        );
                    }
                    Err(e) => {
                        tracing::debug!("[auto_connect] failed: {e}");
                    }
                }
            }

            if all_connected {
                // All peers connected — wait and check periodically for disconnects or new peers
                tokio::time::sleep(std::time::Duration::from_secs(30)).await;
            } else {
                // Some peers failed — retry sooner
                tokio::time::sleep(std::time::Duration::from_secs(5)).await;
            }
        }
    });

    Ok((node_id, router))
}

/// Wait until the relay watcher emits a Some(url).
async fn wait_for_relay(
    mut watcher: iroh::watchable::Watcher<Option<iroh::RelayUrl>>,
) -> Option<iroh::RelayUrl> {
    // Check current value first
    if let Ok(Some(url)) = watcher.get() {
        return Some(url);
    }
    // Wait for next update
    loop {
        if watcher.updated().await.is_err() {
            return None;
        }
        if let Ok(Some(url)) = watcher.get() {
            return Some(url);
        }
    }
}

#[derive(Debug, Clone)]
struct AtomicHandler {
    store: Db,
}

impl iroh::protocol::ProtocolHandler for AtomicHandler {
    fn accept(
        &self,
        connection: iroh::endpoint::Connection,
    ) -> futures::future::BoxFuture<'static, anyhow::Result<()>> {
        let store = self.store.clone();
        Box::pin(async move {
            let remote = connection.remote_node_id()?;
            let remote_str = normalize_node_id(&remote.to_string());
            tracing::info!("[accept] incoming connection from {remote_str}");

            // Accept the first (and only) bi stream for sync + live
            let (send, recv) = match connection.accept_bi().await {
                Ok(pair) => pair,
                Err(e) => {
                    tracing::info!("[accept] connection closed from {remote}: {e}");
                    return Ok(());
                }
            };

            // Handle initial sync, then transition to live mode on the same stream
            let store_clone = store.clone();
            let remote_id = remote_str.clone();
            match handle_stream_then_live(send, recv, store_clone, remote_id).await {
                Ok(imported) => {
                    push_sync_event(&remote_str, imported);
                }
                Err(e) => {
                    tracing::warn!("[accept] stream error: {e}");
                }
            }

            Ok(())
        })
    }
}

/// Global endpoint, set once on startup. Needed for outgoing connections.
static ENDPOINT: OnceLock<Endpoint> = OnceLock::new();

/// Global router, must be kept alive or incoming connections stop working.
static ROUTER: OnceLock<Router> = OnceLock::new();

// ── Live sync (persistent connections) ──────────────────────────────────

use std::collections::HashMap;
use std::sync::Mutex;

/// Active outgoing send streams keyed by peer NodeID.
/// Used to push UPDATE frames to connected peers.
static LIVE_PEERS: Mutex<Option<HashMap<String, tokio::sync::mpsc::Sender<Vec<u8>>>>> =
    Mutex::new(None);

/// Keep QUIC connections alive so live streams don't drop.
static LIVE_CONNECTIONS: Mutex<Option<Vec<iroh::endpoint::Connection>>> = Mutex::new(None);

/// Returns the number of currently connected live peers.
pub fn live_peer_count() -> usize {
    LIVE_PEERS
        .lock()
        .ok()
        .and_then(|map| map.as_ref().map(|m| m.len()))
        .unwrap_or(0)
}

/// Returns the node IDs of currently connected live peers.
pub fn live_peer_ids() -> Vec<String> {
    LIVE_PEERS
        .lock()
        .ok()
        .and_then(|map| map.as_ref().map(|m| m.keys().cloned().collect()))
        .unwrap_or_default()
}

/// Drop a live peer entry (dead write loop, closed channel, or reconnect).
pub fn remove_live_peer(peer_id: &str) {
    remove_live_peer_inner(peer_id, true);
}

/// Drop without notifying the UI (intentional reconnect / replace).
fn remove_live_peer_quiet(peer_id: &str) {
    remove_live_peer_inner(peer_id, false);
}

fn remove_live_peer_inner(peer_id: &str, notify: bool) {
    let key = normalize_node_id(peer_id);
    let mut removed = false;
    if let Ok(mut guard) = LIVE_PEERS.lock() {
        if let Some(map) = guard.as_mut() {
            removed = map.remove(&key).is_some();
        }
    }
    if removed {
        tracing::info!("[live] removed peer {}", &key[..key.len().min(12)]);
        if notify {
            push_event(&key, 0, "disconnected");
        }
    }
}

static LAST_EVENT_MS: OnceLock<std::sync::Mutex<std::collections::HashMap<(String, String), u64>>> =
    OnceLock::new();

const EVENT_DEBOUNCE_MS: u64 = 15_000;

fn last_event_ms() -> &'static std::sync::Mutex<std::collections::HashMap<(String, String), u64>> {
    LAST_EVENT_MS.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

/// Returns true if we're currently importing data from a remote peer.
pub fn is_importing() -> bool {
    super::ws_apply::is_importing()
}

fn encode_live_update_wire_msg(subject_key: &str, loro_bytes: &[u8]) -> Vec<u8> {
    let frame = super::protocol::encode_update(0, 0, subject_key, None, loro_bytes);
    let len = frame.len() as u32;
    let mut msg = Vec::with_capacity(4 + frame.len());
    msg.extend_from_slice(&len.to_be_bytes());
    msg.extend_from_slice(&frame);
    msg
}

fn send_live_update_wire_msg(msg: Vec<u8>) {
    let mut dead_peers = Vec::new();
    let peers = LIVE_PEERS.lock().unwrap();
    if let Some(map) = peers.as_ref() {
        for (peer_id, tx) in map {
            match tx.try_send(msg.clone()) {
                Ok(_) => {}
                Err(tokio::sync::mpsc::error::TrySendError::Full(m)) => {
                    let peer = peer_id.clone();
                    let tx_retry = tx.clone();
                    tokio::spawn(async move {
                        if tx_retry.send(m).await.is_err() {
                            tracing::warn!(
                                "[live_sync] retry send failed for {}",
                                &peer[..peer.len().min(12)]
                            );
                        }
                    });
                }
                Err(tokio::sync::mpsc::error::TrySendError::Closed(_)) => {
                    dead_peers.push(peer_id.clone());
                }
            }
        }
    }
    drop(peers);
    for peer_id in dead_peers {
        remove_live_peer(&peer_id);
    }
}

/// Push an UPDATE frame to all connected live peers immediately (e.g. after a stroke save).
pub fn broadcast_live_update(subject_key: &str, loro_bytes: &[u8]) {
    if loro_bytes.is_empty() || super::ws_apply::is_importing() {
        return;
    }
    let msg = encode_live_update_wire_msg(subject_key, loro_bytes);
    send_live_update_wire_msg(msg);
}

/// Start the live sync system. Watches for local changes and pushes to all connected peers.
fn start_live_sync(store: Db) {
    // Initialize globals
    {
        let mut map = LIVE_PEERS.lock().unwrap();
        if map.is_none() {
            *map = Some(HashMap::new());
        }
    }
    {
        let mut conns = LIVE_CONNECTIONS.lock().unwrap();
        if conns.is_none() {
            *conns = Some(Vec::new());
        }
    }

    // Spawn the push loop: watches db_events, pushes deltas/destroys to live peers
    tokio::spawn(async move {
        let mut rx = store.subscribe_events();
        tracing::info!("[live_sync] push loop started");

        loop {
            let event = match rx.recv().await {
                Ok(e) => e,
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(_) => {
                    tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                    rx = store.subscribe_events();
                    continue;
                }
            };

            if super::ws_apply::is_importing() {
                continue;
            }

            let subject_key = match &event {
                crate::DbEvent::Changed { subject, .. }
                | crate::DbEvent::Destroyed { subject, .. } => subject.pure_id(),
                _ => continue,
            };

            let loro_bytes: Option<Vec<u8>> = match &event {
                crate::DbEvent::Changed {
                    delta: Some(delta), ..
                } if !delta.is_empty() => Some(delta.clone()),
                crate::DbEvent::Changed { .. } => store
                    .kv
                    .get(
                        crate::db::trees::Tree::LoroSnapshots,
                        subject_key.as_bytes(),
                    )
                    .ok()
                    .flatten()
                    .filter(|b| !b.is_empty()),
                crate::DbEvent::Destroyed { .. } => {
                    let frame = super::protocol::encode_destroy(0, &subject_key);
                    let len = frame.len() as u32;
                    let mut msg = Vec::with_capacity(4 + frame.len());
                    msg.extend_from_slice(&len.to_be_bytes());
                    msg.extend_from_slice(&frame);
                    send_live_update_wire_msg(msg);
                    continue;
                }
                _ => None,
            };

            if let Some(bytes) = loro_bytes {
                let msg = encode_live_update_wire_msg(&subject_key, &bytes);
                send_live_update_wire_msg(msg);
            }
        }
    });
}

/// Register a live peer connection. Spawns read/write loops.
fn register_live_peer(
    peer_id: String,
    mut send: iroh::endpoint::SendStream,
    mut recv: iroh::endpoint::RecvStream,
    store: Db,
) {
    let key = normalize_node_id(&peer_id);
    add_known_peer(&store, &key, "");

    let (tx, mut rx) = tokio::sync::mpsc::channel::<Vec<u8>>(64);
    // Cloned for the read loop so it can send responses (e.g. BLOB_RESPONSE
    // back to the requester) through the same write loop.
    let tx_for_read = tx.clone();

    // Add to peer map — replace if already connected (incoming may supersede outgoing)
    let is_new_peer = {
        let mut map = LIVE_PEERS.lock().unwrap();
        if let Some(m) = map.as_mut() {
            let replacing = m.contains_key(&key);
            if replacing {
                tracing::info!(
                    "[live] replacing existing connection to {}",
                    &key[..key.len().min(12)]
                );
            }
            m.insert(key.clone(), tx);
            !replacing
        } else {
            false
        }
    };

    let peer_short = key[..key.len().min(12)].to_string();
    tracing::info!("[live] registered peer {peer_short} (new={is_new_peer})");
    // Always notify so both sides refresh UI (replacing a dead channel still counts).
    push_event(&key, 0, "connected");

    // Write loop: sends queued UPDATE frames to the peer
    let write_peer_id = key.clone();
    tokio::spawn(async move {
        tracing::info!(
            "[live] write loop started for {}",
            &write_peer_id[..write_peer_id.len().min(12)]
        );
        while let Some(msg) = rx.recv().await {
            match send.write_all(&msg).await {
                Ok(_) => {
                    tracing::trace!(
                        "[live] wrote {} bytes to {}",
                        msg.len(),
                        &write_peer_id[..write_peer_id.len().min(12)]
                    );
                }
                Err(e) => {
                    tracing::warn!(
                        "[live] write failed to {}: {e}",
                        &write_peer_id[..write_peer_id.len().min(12)]
                    );
                    break;
                }
            }
        }
        tracing::info!(
            "[live] write loop ended for {}",
            &write_peer_id[..write_peer_id.len().min(12)]
        );
        remove_live_peer(&write_peer_id);
    });

    // Read loop: receives UPDATE frames from the peer, imports them
    let read_peer_id = key.clone();
    tokio::spawn(async move {
        tracing::info!(
            "[live] read loop started for {}",
            &read_peer_id[..read_peer_id.len().min(12)]
        );
        loop {
            let len = match recv.read_u32().await {
                Ok(n) => {
                    tracing::trace!(
                        "[live] received frame {} bytes from {}",
                        n,
                        &read_peer_id[..read_peer_id.len().min(12)]
                    );
                    n as usize
                }
                Err(e) => {
                    tracing::info!(
                        "[live] read error from {}: {e}",
                        &read_peer_id[..read_peer_id.len().min(12)]
                    );
                    break;
                }
            };
            if len == 0 || len > 50_000_000 {
                break;
            }

            let mut buf = vec![0u8; len];
            if recv.read_exact(&mut buf).await.is_err() {
                break;
            }

            if buf.is_empty() {
                continue;
            }

            // Handle DESTROY frames
            if buf[0] == super::protocol::tag::DESTROY {
                if buf.len() > 3 {
                    let subject = std::str::from_utf8(&buf[3..])
                        .unwrap_or_default()
                        .to_string();
                    let _ = super::ws_apply::apply_destroy(&store, &subject).await;
                }
                continue;
            }

            // Handle UPDATE frames.
            // Authoritative source of truth for the wire format: [docs/src/websockets.md](file:///Users/joep/dev/atomic-server/docs/src/websockets.md)
            if buf[0] == super::protocol::tag::UPDATE {
                if let Some(decoded) = super::protocol::decode_update(&buf[1..]) {
                    if !decoded.loro_bytes.is_empty() {
                        let _ = super::ws_apply::apply_state_update(&store, &decoded.subject, &decoded.loro_bytes).await;
                        tracing::trace!(
                            "[live] imported update for {} from {}",
                            &decoded.subject[..decoded.subject.len().min(20)],
                            &read_peer_id[..read_peer_id.len().min(12)]
                        );
                    }
                }
                continue;
            }

            // Fallback: any unhandled tag (BLOB_REQUEST, BLOB_RESPONSE, future
            // additions) is dispatched through the sync engine, mirroring the
            // WS handler at server/src/handlers/web_sockets.rs. Live mode and
            // handshake mode share the same protocol surface; the read loop
            // shouldn't be selective about which tags it understands.
            let mut agent = crate::agents::ForAgent::Public;
            let responses = super::engine::handle_frame(&buf, &store, &mut agent).await;
            for response in responses {
                let mut framed = Vec::with_capacity(4 + response.len());
                framed.extend_from_slice(&(response.len() as u32).to_be_bytes());
                framed.extend_from_slice(&response);
                if tx_for_read.send(framed).await.is_err() {
                    tracing::warn!(
                        "[live] response channel closed for {}, dropping responses",
                        &read_peer_id[..read_peer_id.len().min(12)]
                    );
                    break;
                }
            }
        }

        remove_live_peer(&read_peer_id);
    });
}

// ── Sync events (notifies UI of incoming connections) ────────────────────

/// A sync event that the UI can poll for.
#[derive(Debug, Clone, serde::Serialize)]
pub struct SyncEvent {
    pub remote_node_id: String,
    pub resources_imported: usize,
    pub timestamp: u64,
    /// "sync", "connected", "disconnected"
    #[serde(default = "default_event_kind")]
    pub kind: String,
}

#[allow(dead_code)] // Used via #[serde(default = "...")] attribute above
fn default_event_kind() -> String {
    "sync".into()
}

static SYNC_EVENT_TX: OnceLock<tokio::sync::broadcast::Sender<SyncEvent>> = OnceLock::new();

fn get_event_tx() -> &'static tokio::sync::broadcast::Sender<SyncEvent> {
    SYNC_EVENT_TX.get_or_init(|| tokio::sync::broadcast::channel(32).0)
}

fn push_sync_event(remote_node_id: &str, resources_imported: usize) {
    push_event(remote_node_id, resources_imported, "sync");
}

fn push_event(remote_node_id: &str, resources_imported: usize, kind: &str) {
    let now = crate::utils::now() as u64;
    let key = (remote_node_id.to_string(), kind.to_string());
    // Never debounce `connected` — both devices must refresh live-peer UI.
    if kind != "connected" {
        if let Ok(mut last) = last_event_ms().lock() {
            if let Some(&prev) = last.get(&key) {
                if now.saturating_sub(prev) < EVENT_DEBOUNCE_MS {
                    tracing::debug!(
                        "[live] debounced {kind} for {}",
                        &remote_node_id[..remote_node_id.len().min(12)]
                    );
                    return;
                }
            }
            last.insert(key, now);
        }
    }

    let event = SyncEvent {
        remote_node_id: remote_node_id.to_string(),
        resources_imported,
        timestamp: now,
        kind: kind.to_string(),
    };
    let _ = get_event_tx().send(event);
}

/// Drain and return all pending sync events (legacy polling API).
pub fn poll_sync_events() -> Vec<SyncEvent> {
    let mut rx = get_event_tx().subscribe();
    let mut events = Vec::new();
    while let Ok(e) = rx.try_recv() {
        events.push(e);
    }
    events
}

/// Block until the next sync event arrives. Reactive — no polling.
pub async fn wait_for_sync_event() -> SyncEvent {
    let mut rx = get_event_tx().subscribe();
    loop {
        match rx.recv().await {
            Ok(event) => return event,
            Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
            Err(_) => {
                tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                rx = get_event_tx().subscribe();
            }
        }
    }
}

/// Block until the live peer count changes from `current`. Reactive.
pub async fn wait_for_peer_count_change(current: usize) -> usize {
    let mut rx = get_event_tx().subscribe();
    loop {
        // Check immediately
        let count = live_peer_count();
        if count != current {
            return count;
        }
        // Wait for any event (connect/disconnect changes count)
        match tokio::time::timeout(std::time::Duration::from_secs(5), rx.recv()).await {
            Ok(Ok(_)) => {
                let count = live_peer_count();
                if count != current {
                    return count;
                }
            }
            Ok(Err(tokio::sync::broadcast::error::RecvError::Lagged(_))) => continue,
            Ok(Err(_)) => {
                rx = get_event_tx().subscribe();
            }
            Err(_) => {} // timeout, loop and check again
        }
    }
}

/// Sync a drive with a remote peer. Initiates the SYNC protocol over Iroh QUIC.
/// Uses the global endpoint (set by `start()`). Returns the number of resources imported.
/// Replaces an existing live connection when `force` is true (QR pair / manual sync).
pub async fn sync_drive_with_peer(
    remote_node_id: &str,
    drive: &str,
    store: &Db,
) -> crate::errors::AtomicResult<usize> {
    sync_drive_with_peer_forced(remote_node_id, drive, store, true).await
}

/// Same as [`sync_drive_with_peer`] but returns the rich [`PeerSyncOutcome`]
/// (resource count + remote's self-reported display name).
pub async fn sync_drive_with_peer_outcome(
    remote_node_id: &str,
    drive: &str,
    store: &Db,
) -> crate::errors::AtomicResult<PeerSyncOutcome> {
    let endpoint = ENDPOINT
        .get()
        .ok_or("Iroh peer not started. Call start() first.")?;
    sync_drive_with_peer_using_outcome(endpoint, remote_node_id, drive, store, true).await
}

/// Bulk sync only when there is no healthy live stream to this peer (auto-connect / nudge).
pub async fn sync_drive_with_peer_if_needed(
    remote_node_id: &str,
    drive: &str,
    store: &Db,
) -> crate::errors::AtomicResult<usize> {
    sync_drive_with_peer_forced(remote_node_id, drive, store, false).await
}

async fn sync_drive_with_peer_forced(
    remote_node_id: &str,
    drive: &str,
    store: &Db,
    force: bool,
) -> crate::errors::AtomicResult<usize> {
    let endpoint = ENDPOINT
        .get()
        .ok_or("Iroh peer not started. Call start() first.")?;
    sync_drive_with_peer_using(endpoint, remote_node_id, drive, store, force).await
}

/// Rich result for a peer sync round-trip. `peer_name` is whatever the
/// remote announced in its `HELLO` frame (or `None` for old peers that
/// don't speak HELLO yet). Display-only — see [`crate::sync::protocol::HELLO_MAX_CHARS`].
#[derive(Debug, Clone)]
pub struct PeerSyncOutcome {
    pub count: usize,
    pub peer_name: Option<String>,
}

/// Sync a drive using a specific Iroh endpoint. Useful for tests where
/// multiple endpoints exist in the same process.
///
/// Returns the number of resources imported. For callers that also want
/// the remote's self-reported display name, use
/// [`sync_drive_with_peer_using_outcome`].
pub async fn sync_drive_with_peer_using(
    endpoint: &Endpoint,
    remote_node_id: &str,
    drive: &str,
    store: &Db,
    force: bool,
) -> crate::errors::AtomicResult<usize> {
    sync_drive_with_peer_using_outcome(endpoint, remote_node_id, drive, store, force)
        .await
        .map(|o| o.count)
}

/// Same as [`sync_drive_with_peer_using`] but returns [`PeerSyncOutcome`]
/// so callers can render the remote's friendly device name.
pub async fn sync_drive_with_peer_using_outcome(
    endpoint: &Endpoint,
    remote_node_id: &str,
    drive: &str,
    store: &Db,
    force: bool,
) -> crate::errors::AtomicResult<PeerSyncOutcome> {
    let remote_key = normalize_node_id(remote_node_id);
    let node_id: NodeId = remote_key
        .parse()
        .map_err(|e| format!("Invalid NodeID '{remote_node_id}': {e}"))?;

    if !force && live_peer_ids().contains(&remote_key) {
        tracing::debug!(
            "[sync] already live with {}, skipping bulk reconnect",
            &remote_key[..remote_key.len().min(12)]
        );
        return Ok(PeerSyncOutcome {
            count: 0,
            peer_name: None,
        });
    }

    if force && live_peer_ids().contains(&remote_key) {
        remove_live_peer_quiet(&remote_key);
    }

    let my_node_id = endpoint.node_id();
    let my_relay = endpoint.home_relay();
    tracing::info!(
        "[sync] my NodeID: {}, relay: {:?}, connecting to: {}, drive: {}",
        &my_node_id.to_string()[..16],
        my_relay.get(),
        &node_id.to_string()[..node_id.to_string().len().min(16)],
        &drive[..drive.len().min(20)],
    );

    const CONNECT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);
    let remote_short = &node_id.to_string()[..node_id.to_string().len().min(16)];
    let conn =
        match tokio::time::timeout(CONNECT_TIMEOUT, endpoint.connect(node_id, ATOMIC_ALPN)).await {
            Ok(Ok(c)) => c,
            Ok(Err(e)) => {
                tracing::error!("[sync] connect failed to {remote_short}: {e}");
                return Err(format!("Iroh connect to {remote_short} failed: {e}").into());
            }
            Err(_) => {
                tracing::error!("[sync] connect timed out to {remote_short}");
                return Err(format!(
                    "Iroh connect to {remote_short} timed out after {}s. \
                 Is the other device online, on the network, and running the app?",
                    CONNECT_TIMEOUT.as_secs()
                )
                .into());
            }
        };

    tracing::info!("[sync] connected! Opening bi stream...");

    let (mut send, mut recv) = conn.open_bi().await.map_err(|e| {
        tracing::error!("[sync] open_bi failed: {e}");
        format!("Iroh open_bi failed: {e}")
    })?;

    tracing::info!("[sync] bi stream open, sending AUTH...");

    // Authenticate: send AUTH frame so the server knows who we are
    let agent = store.get_default_agent()?;
    let auth_frame = super::protocol::encode_auth(&agent, drive)?;
    send.write_u32(auth_frame.len() as u32)
        .await
        .map_err(io_err)?;
    send.write_all(&auth_frame).await.map_err(io_err)?;

    // Read AUTH_OK or ERROR
    let auth_len = match recv.read_u32().await {
        Ok(n) => n as usize,
        Err(e) => return Err(format!("Failed to read auth response: {e}").into()),
    };
    let mut auth_buf = vec![0u8; auth_len];
    recv.read_exact(&mut auth_buf).await.map_err(io_err)?;
    if auth_buf.is_empty() || auth_buf[0] != super::protocol::tag::AUTH_OK {
        let msg = if auth_buf.len() > 3 {
            std::str::from_utf8(&auth_buf[3..]).unwrap_or("unknown error")
        } else {
            "auth rejected"
        };
        return Err(format!("Authentication failed: {msg}").into());
    }
    tracing::info!("Authenticated with peer");

    // Self-introduce. We send unprompted right after AUTH_OK; the accept
    // side does the same in `handle_stream`. Either side's HELLO can arrive
    // at any time (TCP is ordered but we don't block on it here) — the
    // read loop below captures it whenever it lands.
    let hello_frame = super::protocol::encode_hello(&effective_device_name(store));
    send.write_u32(hello_frame.len() as u32)
        .await
        .map_err(io_err)?;
    send.write_all(&hello_frame).await.map_err(io_err)?;

    let mut peer_display_name: Option<String> = None;

    // Build our local sync state
    let drive_subject = crate::Subject::from_raw(drive, store.get_base_domain().as_deref());
    let drive_subjects = super::engine::collect_drive_subjects(store, &drive_subject).await;
    let vvs = super::engine::build_drive_vvs(store, &drive_subjects);
    let drive_hash = super::engine::compute_drive_hash(&vvs);

    // Build compact peer/resource representation
    let mut peer_set = std::collections::BTreeSet::new();
    for vv in vvs.values() {
        for peer_id in vv.keys() {
            peer_set.insert(peer_id.clone());
        }
    }
    let peers: Vec<String> = peer_set.into_iter().collect();
    let peer_index: std::collections::HashMap<&str, usize> = peers
        .iter()
        .enumerate()
        .map(|(i, p)| (p.as_str(), i))
        .collect();

    let mut resources: std::collections::HashMap<String, Vec<i32>> =
        std::collections::HashMap::new();
    for (subject, vv) in &vvs {
        let mut counters = vec![0i32; peers.len()];
        for (pid, &counter) in vv {
            if let Some(&idx) = peer_index.get(pid.as_str()) {
                counters[idx] = counter;
            }
        }
        resources.insert(subject.clone(), counters);
    }

    // Send SYNC frame
    let sync_frame = super::protocol::encode_sync(drive, &drive_hash, &peers, &resources);
    send.write_u32(sync_frame.len() as u32)
        .await
        .map_err(io_err)?;
    send.write_all(&sync_frame).await.map_err(io_err)?;

    // Read response frames
    let mut total_imported = 0;
    let mut pull_subjects: Vec<String> = Vec::new();

    // Read frames until the peer is done
    while let Ok(n) = recv.read_u32().await {
        let len = n as usize;
        if len == 0 || len > 50_000_000 {
            break;
        }

        let mut buf = vec![0u8; len];
        recv.read_exact(&mut buf).await.map_err(io_err)?;

        if buf.is_empty() {
            break;
        }

        let tag = buf[0];
        let payload = &buf[1..];

        match tag {
            super::protocol::tag::HELLO => {
                // First HELLO from the accept side wins; later ones are
                // ignored. Decoder enforces 64-char cap + UTF-8 + strips
                // control chars, so we don't need to sanitize again here.
                if peer_display_name.is_none() {
                    peer_display_name = super::protocol::decode_hello(payload);
                    if let Some(name) = &peer_display_name {
                        tracing::info!(
                            "[sync] peer {} introduced itself as \"{}\"",
                            &remote_key[..remote_key.len().min(12)],
                            name
                        );
                        // Persist into the known-peers table so any UI that
                        // re-reads `get_known_peers` (flutter dialog, server
                        // sidebar) shows the friendly name without needing
                        // a separate codepath. `add_known_peer` is upsert
                        // and only overwrites `name` when non-empty.
                        if !name.is_empty() {
                            add_known_peer(store, &remote_key, name);
                        }
                    }
                }
                continue;
            }
            super::protocol::tag::SYNC_OK => {
                tracing::info!("Peer says drive {drive} is in sync");
                break;
            }
            super::protocol::tag::SYNC_DIFF => {
                if let Some(diff) = super::protocol::decode_sync_diff(payload) {
                    tracing::info!(
                        "SYNC_DIFF: server pushes {}, server pulls {}, remove {}",
                        diff.push.len(),
                        diff.pull.len(),
                        diff.remove.len()
                    );
                    for subject in &diff.remove {
                        let _ = super::ws_apply::apply_destroy(store, subject).await;
                    }
                    pull_subjects = diff.pull.clone();

                    // If server has nothing to push, it won't send SYNC_PUSH.
                    // Send our data now and break.
                    if diff.push.is_empty() {
                        if !diff.pull.is_empty() {
                            let mut entries: Vec<(&str, Vec<u8>)> = Vec::new();
                            for subject in &diff.pull {
                                if let Ok(Some(snapshot)) = store
                                    .kv
                                    .get(crate::db::trees::Tree::LoroSnapshots, subject.as_bytes())
                                {
                                    entries.push((subject.as_str(), snapshot));
                                }
                            }
                            if !entries.is_empty() {
                                let refs: Vec<(&str, &[u8])> =
                                    entries.iter().map(|(s, b)| (*s, b.as_slice())).collect();
                                for chunk in super::protocol::encode_sync_push_chunks(drive, &refs)
                                {
                                    send.write_u32(chunk.len() as u32).await.map_err(io_err)?;
                                    send.write_all(&chunk).await.map_err(io_err)?;
                                }
                                tracing::info!("Pushed {} resources to peer", entries.len());
                            }
                        }
                        break;
                    }
                    // Otherwise, continue reading — SYNC_PUSH should follow
                }
            }
            super::protocol::tag::SYNC_PUSH => {
                let mut last_chunk = false;
                if let Some(push) = super::protocol::decode_sync_push(payload) {
                    last_chunk = push.last;
                    let (count, blob_requests) = super::engine::import_sync_push(
                        &push,
                        store,
                        &crate::agents::ForAgent::Sudo,
                    )
                    .await;
                    total_imported += count;

                    // Send blob requests if any
                    for req_frame in blob_requests {
                        send.write_u32(req_frame.len() as u32)
                            .await
                            .map_err(io_err)?;
                        send.write_all(&req_frame).await.map_err(io_err)?;
                    }
                }
                // SYNC_PUSH is chunked: keep reading until the LAST flag fires.
                // Only after that do we send our pushback and exit the loop.
                if !last_chunk {
                    continue;
                }
                if !pull_subjects.is_empty() {
                    let mut entries: Vec<(&str, Vec<u8>)> = Vec::new();
                    for subject in &pull_subjects {
                        if let Ok(Some(snapshot)) = store
                            .kv
                            .get(crate::db::trees::Tree::LoroSnapshots, subject.as_bytes())
                        {
                            entries.push((subject.as_str(), snapshot));
                        }
                    }
                    if !entries.is_empty() {
                        let refs: Vec<(&str, &[u8])> =
                            entries.iter().map(|(s, b)| (*s, b.as_slice())).collect();
                        for chunk in super::protocol::encode_sync_push_chunks(drive, &refs) {
                            send.write_u32(chunk.len() as u32).await.map_err(io_err)?;
                            send.write_all(&chunk).await.map_err(io_err)?;
                        }
                        tracing::info!("Pushed {} resources back to peer", entries.len());
                    }
                }
                break;
            }
            super::protocol::tag::ERROR => {
                let msg = std::str::from_utf8(&payload[2..]).unwrap_or("unknown error");
                tracing::warn!("Peer returned error: {msg}");
                break;
            }
            _ => {
                tracing::debug!("Unexpected frame tag from peer: 0x{tag:02x}");
            }
        }
    }

    tracing::info!(
        "sync_drive_with_peer: imported {total_imported} resources from {remote_node_id}"
    );

    // Transition to live mode: reuse the same bi stream for real-time updates.
    // Don't close it — the server's handle_stream will also transition after
    // the sync exchange completes.
    tracing::info!(
        "[live] transitioning to live mode with {}",
        &remote_node_id[..remote_node_id.len().min(12)]
    );
    {
        let mut conns = LIVE_CONNECTIONS.lock().unwrap();
        if let Some(v) = conns.as_mut() {
            v.push(conn);
        }
    }
    register_live_peer(remote_key.clone(), send, recv, store.clone());

    Ok(PeerSyncOutcome {
        count: total_imported,
        peer_name: peer_display_name,
    })
}

// ── Known peers (persisted in DB) ────────────────────────────────────────

const KNOWN_PEERS_KEY: &[u8] = b"_iroh_known_peers_v2";

/// A known peer with optional device name.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct KnownPeer {
    pub node_id: String,
    pub name: String,
}

/// Get all known peers from the DB.
pub fn get_known_peers(store: &Db) -> Vec<KnownPeer> {
    if let Ok(Some(bytes)) = store
        .kv
        .get(crate::db::trees::Tree::PluginMeta, KNOWN_PEERS_KEY)
    {
        serde_json::from_slice(&bytes).unwrap_or_default()
    } else {
        vec![]
    }
}

/// Add a peer to the known peers list. Updates name if already known.
pub fn add_known_peer(store: &Db, node_id: &str, name: &str) {
    let key = normalize_node_id(node_id);
    let mut peers = get_known_peers(store);
    if let Some(existing) = peers
        .iter_mut()
        .find(|p| normalize_node_id(&p.node_id) == key)
    {
        if !name.is_empty() {
            existing.name = name.to_string();
        }
    } else {
        peers.push(KnownPeer {
            node_id: key,
            name: name.to_string(),
        });
    }
    let _ = store.kv.insert(
        crate::db::trees::Tree::PluginMeta,
        KNOWN_PEERS_KEY,
        &serde_json::to_vec(&peers).unwrap_or_default(),
    );
}

/// Remove a peer from the known peers list.
pub fn remove_known_peer(store: &Db, node_id: &str) {
    let key = normalize_node_id(node_id);
    let mut peers = get_known_peers(store);
    peers.retain(|p| normalize_node_id(&p.node_id) != key);
    let _ = store.kv.insert(
        crate::db::trees::Tree::PluginMeta,
        KNOWN_PEERS_KEY,
        &serde_json::to_vec(&peers).unwrap_or_default(),
    );
}

/// Handle a single bidirectional QUIC stream.
/// Reads length-prefixed v2 binary frames and dispatches them via the sync engine.
/// Returns the number of resources imported from the remote peer.
/// Handle initial sync frames, then transition to live mode on the same stream.
async fn handle_stream_then_live(
    send: iroh::endpoint::SendStream,
    recv: iroh::endpoint::RecvStream,
    store: Db,
    remote_id: String,
) -> anyhow::Result<usize> {
    let total_imported = handle_stream(send, recv, store, remote_id).await?;
    Ok(total_imported)
}

/// Handle sync frames. After SYNC_OK or SYNC_PUSH response, transitions to
/// live mode by registering the stream for real-time updates.
async fn handle_stream(
    mut send: iroh::endpoint::SendStream,
    mut recv: iroh::endpoint::RecvStream,
    store: Db,
    remote_id: String,
) -> anyhow::Result<usize> {
    let remote_key = normalize_node_id(&remote_id);
    let mut agent = ForAgent::Public;
    let mut total_imported = 0;
    let mut sent_sync_ok = false;
    let mut hello_sent = false;
    let mut peer_display_name: Option<String> = None;

    while let Ok(n) = recv.read_u32().await {
        let len = n as usize;

        if len == 0 || len > 10_000_000 {
            break;
        }

        let mut buf = vec![0u8; len];
        recv.read_exact(&mut buf).await.map_err(io_err)?;

        // HELLO is a peer-stream concern, not an engine concern. Browser WS
        // sessions never see it (they don't speak peer-sync). Intercept here
        // so the engine doesn't have to know about it.
        if !buf.is_empty() && buf[0] == super::protocol::tag::HELLO {
            if peer_display_name.is_none() {
                peer_display_name = super::protocol::decode_hello(&buf[1..]);
                if let Some(name) = &peer_display_name {
                    tracing::info!(
                        "[accept] peer {} introduced itself as \"{}\"",
                        &remote_key[..remote_key.len().min(12)],
                        name
                    );
                    // Persist into known-peers so flutter/server UIs see
                    // the name on their next refresh — even for unsolicited
                    // inbound syncs the local user never initiated.
                    if !name.is_empty() {
                        add_known_peer(&store, &remote_key, name);
                    }
                }
            }
            continue;
        }

        // Track imports from SYNC_PUSH frames
        if !buf.is_empty() && buf[0] == super::protocol::tag::SYNC_PUSH {
            if let Some(push) = super::protocol::decode_sync_push(&buf[1..]) {
                total_imported += push.entries.len();
            }
        }

        let responses = super::engine::handle_frame(&buf, &store, &mut agent).await;

        // Send our HELLO once, immediately after AUTH succeeded. We tack it
        // on to the AUTH_OK response so old peers that don't read past
        // AUTH_OK still get something coherent (an unknown tag they'll just
        // skip). Skipping HELLO before AUTH_OK would leak our hostname to
        // unauthenticated peers — small thing, but no reason to.
        let just_authed = !buf.is_empty()
            && buf[0] == super::protocol::tag::AUTH
            && responses
                .iter()
                .any(|r| !r.is_empty() && r[0] == super::protocol::tag::AUTH_OK);

        // Check if the client sent us a SYNC_PUSH (bidirectional data exchange complete)
        let client_pushed = !buf.is_empty() && buf[0] == super::protocol::tag::SYNC_PUSH;
        // Check if we responded with SYNC_OK (fast path — already in sync)
        let sync_ok = responses
            .iter()
            .any(|r| !r.is_empty() && r[0] == super::protocol::tag::SYNC_OK);
        if sync_ok {
            sent_sync_ok = true;
        }
        // If our SYNC_DIFF does not ask the initiator to push anything back, the
        // bulk exchange is complete once our responses are written. Without this
        // transition, the accept side stays in handshake mode and later live
        // UPDATE frames are dispatched to the sync engine, which ignores them.
        let sync_diff_needs_no_pushback = responses.iter().any(|r| {
            !r.is_empty()
                && r[0] == super::protocol::tag::SYNC_DIFF
                && super::protocol::decode_sync_diff(&r[1..])
                    .is_some_and(|diff| diff.pull.is_empty())
        });

        for response in responses {
            if let Err(e) = send.write_u32(response.len() as u32).await {
                tracing::warn!(
                    "[accept] failed to write response header to {}: {e}",
                    &remote_key[..remote_key.len().min(12)]
                );
                break;
            }
            if let Err(e) = send.write_all(&response).await {
                tracing::warn!(
                    "[accept] failed to write response body to {}: {e}",
                    &remote_key[..remote_key.len().min(12)]
                );
                break;
            }
        }

        if just_authed && !hello_sent {
            hello_sent = true;
            let hello = super::protocol::encode_hello(&effective_device_name(&store));
            // Two-step write so the ? in either step doesn't have to convert
            // between io::Error (write_u32) and WriteError (write_all).
            let header_ok = send.write_u32(hello.len() as u32).await;
            if let Err(e) = header_ok {
                tracing::warn!(
                    "[accept] failed to write HELLO header to {}: {e}",
                    &remote_key[..remote_key.len().min(12)]
                );
            } else if let Err(e) = send.write_all(&hello).await {
                tracing::warn!(
                    "[accept] failed to write HELLO body to {}: {e}",
                    &remote_key[..remote_key.len().min(12)]
                );
            }
        }

        // Transition to live mode after the sync exchange is fully complete:
        // - SYNC_OK: no data to exchange, we're done
        // - Client's SYNC_PUSH: bidirectional exchange complete
        // Register even if the last write failed — the initiator may already have
        // read SYNC_OK and registered, and we must not show "connected" only on one side.
        if sync_ok || client_pushed || sync_diff_needs_no_pushback {
            tracing::info!(
                "[accept] sync complete, transitioning to live mode with {}",
                &remote_key[..remote_key.len().min(12)]
            );
            register_live_peer(remote_key, send, recv, store);
            return Ok(total_imported);
        }
    }

    // Initiator may stop sending after reading our SYNC_OK; we already sent it.
    if sent_sync_ok {
        tracing::info!(
            "[accept] SYNC_OK sent, entering live mode with {}",
            &remote_key[..remote_key.len().min(12)]
        );
        register_live_peer(remote_key, send, recv, store);
    }

    Ok(total_imported)
}
