//! Iroh peer-to-peer transport for the v2 binary protocol.
//!
//! Any device running atomic-lib with the `iroh` feature becomes a peer node.
//! Peers connect via NodeID — no port forwarding, DNS, or TLS needed.
//!
//! Addressing (relay URL, direct addresses) is handled by Iroh's `discovery_n0()`.
//! Peer discovery (agent → NodeID) is handled by pkarr in `discovery.rs`.

use crate::{agents::ForAgent, Db, Storelike};
use iroh::{protocol::Router, Endpoint, NodeId};
use std::sync::OnceLock;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// Map Iroh I/O errors to AtomicError.
fn io_err(e: impl std::fmt::Display) -> crate::errors::AtomicError {
    format!("Iroh I/O error: {e}").into()
}

/// ALPN protocol identifier for Atomic Data over Iroh.
const ATOMIC_ALPN: &[u8] = b"atomic/1";

/// Global NodeID, set once on startup.
static NODE_ID: OnceLock<String> = OnceLock::new();

/// Returns the Iroh NodeID if the peer node is running.
pub fn get_node_id() -> Option<&'static str> {
    NODE_ID.get().map(|s| s.as_str())
}

/// Key used to persist the Iroh secret key in the DB.
const IROH_SECRET_KEY: &[u8] = b"_iroh_secret_key";
const DEVICE_NAME_KEY: &[u8] = b"_device_name";

/// Get the persisted device name.
pub fn get_device_name(store: &Db) -> String {
    store.kv.get(crate::db::trees::Tree::PluginMeta, DEVICE_NAME_KEY)
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
    if let Ok(Some(bytes)) = store.kv.get(crate::db::trees::Tree::PluginMeta, IROH_SECRET_KEY) {
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
    let relay_url = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        wait_for_relay(relay),
    ).await;
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
        let my_id = get_node_id().unwrap_or_default().to_string();

        // Initial delay to let relay establish
        tokio::time::sleep(std::time::Duration::from_secs(3)).await;

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
                if peer.node_id == my_id { continue; }
                if live_peer_ids().contains(&peer.node_id) { continue; }

                // Only the device with the smaller NodeID initiates.
                // The other device waits for the incoming connection.
                if my_id.as_str() > peer.node_id.as_str() {
                    all_connected = false; // still not connected, but we wait
                    continue;
                }

                all_connected = false;
                tracing::info!("[auto_connect] connecting to {}", &peer.node_id[..peer.node_id.len().min(12)]);
                match sync_drive_with_peer(&peer.node_id, &drive, &auto_store).await {
                    Ok(count) => {
                        tracing::info!("[auto_connect] synced {count} resources, live connection established");
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
            let remote_str = remote.to_string();
            tracing::info!("[accept] incoming connection from {remote}");

            // Auto-add to known peers
            add_known_peer(&store, &remote_str, "");

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

use std::sync::Mutex;
use std::collections::HashMap;

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

/// Flag: true while importing from a peer (prevents echo back).
static IMPORTING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Returns true if we're currently importing data from a remote peer.
pub fn is_importing() -> bool {
    IMPORTING.load(std::sync::atomic::Ordering::Relaxed)
}

/// Start the live sync system. Watches for local changes and pushes to all connected peers.
fn start_live_sync(store: Db) {
    // Initialize globals
    {
        let mut map = LIVE_PEERS.lock().unwrap();
        if map.is_none() { *map = Some(HashMap::new()); }
    }
    {
        let mut conns = LIVE_CONNECTIONS.lock().unwrap();
        if conns.is_none() { *conns = Some(Vec::new()); }
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

            if IMPORTING.load(std::sync::atomic::Ordering::Relaxed) { continue; }

            let msg = match &event {
                crate::DbEvent::Changed { subject, delta: Some(delta) } if !delta.is_empty() => {
                    let frame = super::protocol::encode_update(0, 0, subject.as_str(), None, delta);
                    let len = frame.len() as u32;
                    let mut msg = Vec::with_capacity(4 + frame.len());
                    msg.extend_from_slice(&len.to_be_bytes());
                    msg.extend_from_slice(&frame);
                    msg
                }
                crate::DbEvent::Destroyed { subject } => {
                    let frame = super::protocol::encode_destroy(0, subject.as_str());
                    let len = frame.len() as u32;
                    let mut msg = Vec::with_capacity(4 + frame.len());
                    msg.extend_from_slice(&len.to_be_bytes());
                    msg.extend_from_slice(&frame);
                    msg
                }
                _ => continue, // Changed without delta — nothing to push
            };

            let peers = LIVE_PEERS.lock().unwrap();
            if let Some(map) = peers.as_ref() {
                for (peer_id, tx) in map {
                    match tx.try_send(msg.clone()) {
                        Ok(_) => {}
                        Err(tokio::sync::mpsc::error::TrySendError::Full(_)) => {
                            tracing::warn!("[live_sync] buffer full for {}", &peer_id[..peer_id.len().min(12)]);
                        }
                        Err(tokio::sync::mpsc::error::TrySendError::Closed(_)) => {
                            tracing::warn!("[live_sync] closed for {}", &peer_id[..peer_id.len().min(12)]);
                        }
                    }
                }
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
    let (tx, mut rx) = tokio::sync::mpsc::channel::<Vec<u8>>(64);
    // Cloned for the read loop so it can send responses (e.g. BLOB_RESPONSE
    // back to the requester) through the same write loop.
    let tx_for_read = tx.clone();

    // Add to peer map — replace if already connected (incoming may supersede outgoing)
    {
        let mut map = LIVE_PEERS.lock().unwrap();
        if let Some(m) = map.as_mut() {
            if m.contains_key(&peer_id) {
                tracing::info!("[live] replacing existing connection to {}", &peer_id[..peer_id.len().min(12)]);
            }
            m.insert(peer_id.clone(), tx);
        }
    }

    let peer_short = peer_id[..peer_id.len().min(12)].to_string();
    tracing::info!("[live] registered peer {peer_short}");
    push_event(&peer_id, 0, "connected");

    // Write loop: sends queued UPDATE frames to the peer
    let write_peer_id = peer_id.clone();
    tokio::spawn(async move {
        tracing::info!("[live] write loop started for {}", &write_peer_id[..write_peer_id.len().min(12)]);
        while let Some(msg) = rx.recv().await {
            match send.write_all(&msg).await {
                Ok(_) => {
                    tracing::trace!("[live] wrote {} bytes to {}", msg.len(), &write_peer_id[..write_peer_id.len().min(12)]);
                }
                Err(e) => {
                    tracing::warn!("[live] write failed to {}: {e}", &write_peer_id[..write_peer_id.len().min(12)]);
                    break;
                }
            }
        }
        tracing::info!("[live] write loop ended for {}", &write_peer_id[..write_peer_id.len().min(12)]);
    });

    // Read loop: receives UPDATE frames from the peer, imports them
    let read_peer_id = peer_id.clone();
    tokio::spawn(async move {
        tracing::info!("[live] read loop started for {}", &read_peer_id[..read_peer_id.len().min(12)]);
        loop {
            let len = match recv.read_u32().await {
                Ok(n) => {
                    tracing::trace!("[live] received frame {} bytes from {}", n, &read_peer_id[..read_peer_id.len().min(12)]);
                    n as usize
                }
                Err(e) => {
                    tracing::info!("[live] read error from {}: {e}", &read_peer_id[..read_peer_id.len().min(12)]);
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
                    let subject = std::str::from_utf8(&buf[3..]).unwrap_or_default().to_string();
                    if !subject.is_empty() {
                        IMPORTING.store(true, std::sync::atomic::Ordering::Relaxed);
                        let subj = crate::Subject::from_raw(&subject, store.get_base_domain().as_deref());
                        let _ = store.remove_resource(&subj).await;
                        let _ = store.kv.remove(crate::db::trees::Tree::LoroSnapshots, subject.as_bytes());
                        IMPORTING.store(false, std::sync::atomic::Ordering::Relaxed);
                        tracing::info!("[live] deleted {}", &subject[..subject.len().min(20)]);
                    }
                }
                continue;
            }

            // Handle UPDATE frames
            if buf[0] == super::protocol::tag::UPDATE {
                let payload = &buf[1..];
                if payload.len() < 5 {
                    continue;
                }
                let _flags = payload[0];
                let _request_id = u16::from_be_bytes([payload[1], payload[2]]);
                let subject_len = u16::from_be_bytes([payload[3], payload[4]]) as usize;
                if payload.len() < 5 + subject_len {
                    continue;
                }
                let subject = std::str::from_utf8(&payload[5..5 + subject_len])
                    .unwrap_or_default()
                    .to_string();
                let loro_bytes = &payload[5 + subject_len..];

                if !loro_bytes.is_empty() {
                    IMPORTING.store(true, std::sync::atomic::Ordering::Relaxed);

                    // Import into local store
                    let doc = if let Ok(Some(existing)) = store.kv.get(
                        crate::db::trees::Tree::LoroSnapshots,
                        subject.as_bytes(),
                    ) {
                        match crate::loro::AtomicLoroDoc::from_snapshot(&existing) {
                            Ok(d) => {
                                if let Err(e) = d.import_update(loro_bytes) {
                                    tracing::warn!("[live] import_update failed for {}: {e}", &subject[..subject.len().min(20)]);
                                }
                                d
                            }
                            Err(_) => match crate::loro::AtomicLoroDoc::from_snapshot(loro_bytes) {
                                Ok(d) => d,
                                Err(_) => { IMPORTING.store(false, std::sync::atomic::Ordering::Relaxed); continue; }
                            },
                        }
                    } else {
                        match crate::loro::AtomicLoroDoc::from_snapshot(loro_bytes) {
                            Ok(d) => d,
                            Err(_) => {
                                let d = crate::loro::AtomicLoroDoc::new();
                                if d.import_update(loro_bytes).is_err() {
                                    IMPORTING.store(false, std::sync::atomic::Ordering::Relaxed);
                                    continue;
                                }
                                d
                            }
                        }
                    };

                    let snapshot = doc.export_snapshot();
                    let _ = store.kv.insert(
                        crate::db::trees::Tree::LoroSnapshots,
                        subject.as_bytes(),
                        &snapshot,
                    );

                    let subj = crate::Subject::from_raw(&subject, store.get_base_domain().as_deref());
                    let mut resource = store
                        .get_resource(&subj)
                        .await
                        .unwrap_or_else(|_| crate::Resource::new(subject.clone()));

                    if resource.replace_state_from_loro_doc(doc).is_ok() {
                        let _ = store.add_resource_opts(&resource, false, true, true).await;
                    }

                    IMPORTING.store(false, std::sync::atomic::Ordering::Relaxed);
                    tracing::trace!("[live] imported update for {} from {}", &subject[..subject.len().min(20)], &read_peer_id[..read_peer_id.len().min(12)]);
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

        // Remove from map FIRST, then fire event (so count is correct when UI reads it)
        {
            let mut map = LIVE_PEERS.lock().unwrap();
            if let Some(m) = map.as_mut() {
                m.remove(&read_peer_id);
            }
        }
        tracing::info!("[live] peer {} disconnected", &read_peer_id[..read_peer_id.len().min(12)]);
        push_event(&read_peer_id, 0, "disconnected");
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
fn default_event_kind() -> String { "sync".into() }

static SYNC_EVENT_TX: OnceLock<tokio::sync::broadcast::Sender<SyncEvent>> = OnceLock::new();

fn get_event_tx() -> &'static tokio::sync::broadcast::Sender<SyncEvent> {
    SYNC_EVENT_TX.get_or_init(|| tokio::sync::broadcast::channel(32).0)
}

fn push_sync_event(remote_node_id: &str, resources_imported: usize) {
    push_event(remote_node_id, resources_imported, "sync");
}

fn push_event(remote_node_id: &str, resources_imported: usize, kind: &str) {
    let event = SyncEvent {
        remote_node_id: remote_node_id.to_string(),
        resources_imported,
        timestamp: crate::utils::now() as u64,
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
        if count != current { return count; }
        // Wait for any event (connect/disconnect changes count)
        match tokio::time::timeout(std::time::Duration::from_secs(5), rx.recv()).await {
            Ok(Ok(_)) => {
                let count = live_peer_count();
                if count != current { return count; }
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
pub async fn sync_drive_with_peer(
    remote_node_id: &str,
    drive: &str,
    store: &Db,
) -> crate::errors::AtomicResult<usize> {
    let endpoint = ENDPOINT
        .get()
        .ok_or("Iroh peer not started. Call start() first.")?;
    sync_drive_with_peer_using(endpoint, remote_node_id, drive, store).await
}

/// Sync a drive using a specific Iroh endpoint. Useful for tests where
/// multiple endpoints exist in the same process.
pub async fn sync_drive_with_peer_using(
    endpoint: &Endpoint,
    remote_node_id: &str,
    drive: &str,
    store: &Db,
) -> crate::errors::AtomicResult<usize> {

    let node_id: NodeId = remote_node_id
        .parse()
        .map_err(|e| format!("Invalid NodeID '{remote_node_id}': {e}"))?;

    let my_node_id = endpoint.node_id();
    let my_relay = endpoint.home_relay();
    tracing::info!(
        "[sync] my NodeID: {}, relay: {:?}, connecting to: {}, drive: {}",
        &my_node_id.to_string()[..16],
        my_relay.get(),
        &node_id.to_string()[..node_id.to_string().len().min(16)],
        &drive[..drive.len().min(20)],
    );

    let conn = endpoint
        .connect(node_id, ATOMIC_ALPN)
        .await
        .map_err(|e| {
            tracing::error!("[sync] connect failed to {}: {e}", &node_id.to_string()[..16]);
            format!("Iroh connect to {} failed: {e}", &node_id.to_string()[..16])
        })?;

    tracing::info!("[sync] connected! Opening bi stream...");

    let (mut send, mut recv) = conn
        .open_bi()
        .await
        .map_err(|e| {
            tracing::error!("[sync] open_bi failed: {e}");
            format!("Iroh open_bi failed: {e}")
        })?;

    tracing::info!("[sync] bi stream open, sending AUTH...");

    // Authenticate: send AUTH frame so the server knows who we are
    let agent = store.get_default_agent()?;
    let auth_frame = super::protocol::encode_auth(&agent, drive)?;
    send.write_u32(auth_frame.len() as u32).await.map_err(io_err)?;
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

    // Build our local sync state
    let drive_subject =
        crate::Subject::from_raw(drive, store.get_base_domain().as_deref());
    let drive_subjects = super::engine::collect_drive_subjects(store, &drive_subject);
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
    send.write_u32(sync_frame.len() as u32).await.map_err(io_err)?;
    send.write_all(&sync_frame).await.map_err(io_err)?;

    // Read response frames
    let mut total_imported = 0;
    let mut pull_subjects: Vec<String> = Vec::new();

    // Read frames until the peer is done
    loop {
        let len = match recv.read_u32().await {
            Ok(n) => n as usize,
            Err(_) => break,
        };
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
            super::protocol::tag::SYNC_OK => {
                tracing::info!("Peer says drive {drive} is in sync");
                break;
            }
            super::protocol::tag::SYNC_DIFF => {
                if let Some(diff) = super::protocol::decode_sync_diff(payload) {
                    tracing::info!(
                        "SYNC_DIFF: server pushes {}, server pulls {}",
                        diff.push.len(),
                        diff.pull.len()
                    );
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
                                for chunk in
                                    super::protocol::encode_sync_push_chunks(drive, &refs)
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
                    let (count, blob_requests) = super::engine::import_sync_push(&push, store, &crate::agents::ForAgent::Sudo).await;
                    total_imported += count;

                    // Send blob requests if any
                    for req_frame in blob_requests {
                        send.write_u32(req_frame.len() as u32).await.map_err(io_err)?;
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

    tracing::info!("sync_drive_with_peer: imported {total_imported} resources from {remote_node_id}");

    // Transition to live mode: reuse the same bi stream for real-time updates.
    // Don't close it — the server's handle_stream will also transition after
    // the sync exchange completes.
    tracing::info!("[live] transitioning to live mode with {}", &remote_node_id[..remote_node_id.len().min(12)]);
    {
        let mut conns = LIVE_CONNECTIONS.lock().unwrap();
        if let Some(v) = conns.as_mut() { v.push(conn); }
    }
    register_live_peer(remote_node_id.to_string(), send, recv, store.clone());

    Ok(total_imported)
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
    if let Ok(Some(bytes)) = store.kv.get(crate::db::trees::Tree::PluginMeta, KNOWN_PEERS_KEY) {
        serde_json::from_slice(&bytes).unwrap_or_default()
    } else {
        vec![]
    }
}

/// Add a peer to the known peers list. Updates name if already known.
pub fn add_known_peer(store: &Db, node_id: &str, name: &str) {
    let mut peers = get_known_peers(store);
    if let Some(existing) = peers.iter_mut().find(|p| p.node_id == node_id) {
        if !name.is_empty() {
            existing.name = name.to_string();
        }
    } else {
        peers.push(KnownPeer {
            node_id: node_id.to_string(),
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
    let mut peers = get_known_peers(store);
    peers.retain(|p| p.node_id != node_id);
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
    let mut agent = ForAgent::Public;
    let mut total_imported = 0;

    loop {
        let len = match recv.read_u32().await {
            Ok(n) => n as usize,
            Err(_) => break,
        };

        if len == 0 || len > 10_000_000 {
            break;
        }

        let mut buf = vec![0u8; len];
        recv.read_exact(&mut buf).await.map_err(io_err)?;

        // Track imports from SYNC_PUSH frames
        if !buf.is_empty() && buf[0] == super::protocol::tag::SYNC_PUSH {
            if let Some(push) = super::protocol::decode_sync_push(&buf[1..]) {
                total_imported += push.entries.len();
            }
        }

        let responses = super::engine::handle_frame(&buf, &store, &mut agent).await;

        // Check if the client sent us a SYNC_PUSH (bidirectional data exchange complete)
        let client_pushed = !buf.is_empty() && buf[0] == super::protocol::tag::SYNC_PUSH;
        // Check if we responded with SYNC_OK (fast path — already in sync)
        let sync_ok = responses.iter().any(|r| !r.is_empty() && r[0] == super::protocol::tag::SYNC_OK);

        for response in responses {
            send.write_u32(response.len() as u32).await?;
            send.write_all(&response).await?;
        }

        // Transition to live mode after the sync exchange is fully complete:
        // - SYNC_OK: no data to exchange, we're done
        // - Client's SYNC_PUSH: bidirectional exchange complete
        if sync_ok || client_pushed {
            tracing::info!("[accept] sync complete, transitioning to live mode with {}", &remote_id[..remote_id.len().min(12)]);
            register_live_peer(remote_id, send, recv, store);
            return Ok(total_imported);
        }
    }

    Ok(total_imported)
}
