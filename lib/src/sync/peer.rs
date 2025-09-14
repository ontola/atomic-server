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
        .discovery_local_network()
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

    let router = Router::builder(endpoint)
        .accept(ATOMIC_ALPN, AtomicHandler { store })
        .spawn();

    // Keep router alive globally — dropping it stops incoming connections
    ROUTER.set(router.clone()).ok();

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
            add_known_peer(&store, &remote_str);

            loop {
                let (send, recv) = match connection.accept_bi().await {
                    Ok(pair) => {
                        tracing::info!("[accept] bi stream opened from {remote}");
                        pair
                    }
                    Err(e) => {
                        tracing::info!("[accept] connection closed from {remote}: {e}");
                        break;
                    }
                };

                let store = store.clone();
                let remote_id = remote_str.clone();
                tokio::spawn(async move {
                    match handle_stream(send, recv, store).await {
                        Ok(imported) => {
                            push_sync_event(&remote_id, imported);
                        }
                        Err(e) => {
                            tracing::warn!("[accept] stream error: {e}");
                        }
                    }
                });
            }

            Ok(())
        })
    }
}

/// Global endpoint, set once on startup. Needed for outgoing connections.
static ENDPOINT: OnceLock<Endpoint> = OnceLock::new();

/// Global router, must be kept alive or incoming connections stop working.
static ROUTER: OnceLock<Router> = OnceLock::new();

// ── Sync events (notifies UI of incoming connections) ────────────────────

/// A sync event that the UI can poll for.
#[derive(Debug, Clone, serde::Serialize)]
pub struct SyncEvent {
    pub remote_node_id: String,
    pub resources_imported: usize,
    pub timestamp: u64,
}

static SYNC_EVENTS: std::sync::Mutex<Vec<SyncEvent>> = std::sync::Mutex::new(Vec::new());

fn push_sync_event(remote_node_id: &str, resources_imported: usize) {
    let event = SyncEvent {
        remote_node_id: remote_node_id.to_string(),
        resources_imported,
        timestamp: crate::utils::now() as u64,
    };
    if let Ok(mut events) = SYNC_EVENTS.lock() {
        events.push(event);
        // Keep max 20 events
        let len = events.len();
        if len > 20 {
            events.drain(..len - 20);
        }
    }
}

/// Drain and return all pending sync events. Called by the UI layer.
pub fn poll_sync_events() -> Vec<SyncEvent> {
    if let Ok(mut events) = SYNC_EVENTS.lock() {
        events.drain(..).collect()
    } else {
        vec![]
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
                                let push_frame = super::protocol::encode_sync_push(drive, &refs);
                                send.write_u32(push_frame.len() as u32).await.map_err(io_err)?;
                                send.write_all(&push_frame).await.map_err(io_err)?;
                                tracing::info!("Pushed {} resources to peer", entries.len());
                            }
                        }
                        break;
                    }
                    // Otherwise, continue reading — SYNC_PUSH should follow
                }
            }
            super::protocol::tag::SYNC_PUSH => {
                if let Some(push) = super::protocol::decode_sync_push(payload) {
                    let count = super::engine::import_sync_push(&push, store, &crate::agents::ForAgent::Sudo).await;
                    total_imported += count;
                }
                // After receiving push, send our deltas for subjects the peer needs
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
                        let push_frame = super::protocol::encode_sync_push(drive, &refs);
                        send.write_u32(push_frame.len() as u32).await.map_err(io_err)?;
                        send.write_all(&push_frame).await.map_err(io_err)?;
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

    // Gracefully close the send side so the server can read our last frame
    let _ = send.finish();
    // Give the server time to process our push before dropping the connection
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;

    tracing::info!("sync_drive_with_peer: imported {total_imported} resources from {remote_node_id}");
    Ok(total_imported)
}

// ── Known peers (persisted in DB) ────────────────────────────────────────

const KNOWN_PEERS_KEY: &[u8] = b"_iroh_known_peers";

/// Get all known peer NodeIDs from the DB.
pub fn get_known_peers(store: &Db) -> Vec<String> {
    if let Ok(Some(bytes)) = store.kv.get(crate::db::trees::Tree::PluginMeta, KNOWN_PEERS_KEY) {
        serde_json::from_slice(&bytes).unwrap_or_default()
    } else {
        vec![]
    }
}

/// Add a peer NodeID to the known peers list. Returns true if newly added.
pub fn add_known_peer(store: &Db, node_id: &str) -> bool {
    let mut peers = get_known_peers(store);
    if peers.iter().any(|p| p == node_id) {
        return false;
    }
    peers.push(node_id.to_string());
    let _ = store.kv.insert(
        crate::db::trees::Tree::PluginMeta,
        KNOWN_PEERS_KEY,
        &serde_json::to_vec(&peers).unwrap_or_default(),
    );
    true
}

/// Remove a peer NodeID from the known peers list.
pub fn remove_known_peer(store: &Db, node_id: &str) {
    let mut peers = get_known_peers(store);
    peers.retain(|p| p != node_id);
    let _ = store.kv.insert(
        crate::db::trees::Tree::PluginMeta,
        KNOWN_PEERS_KEY,
        &serde_json::to_vec(&peers).unwrap_or_default(),
    );
}

/// Handle a single bidirectional QUIC stream.
/// Reads length-prefixed v2 binary frames and dispatches them via the sync engine.
/// Returns the number of resources imported from the remote peer.
async fn handle_stream(
    mut send: iroh::endpoint::SendStream,
    mut recv: iroh::endpoint::RecvStream,
    store: Db,
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

        for response in responses {
            send.write_u32(response.len() as u32).await?;
            send.write_all(&response).await?;
        }
    }

    Ok(total_imported)
}
