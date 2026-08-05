use atomic_lib::Storelike;
use flutter_rust_bridge::frb;

// `pub(crate)` where the canvas twin has a private `mod state;`: the meal
// bridge is a sibling module (`api::meals`) rather than app code wedged into
// this copied file, and it needs the same store handle.
pub(crate) mod state;
#[cfg(test)]
mod tests;
pub mod types;
pub mod ws_sync;

pub use atomic_lib::{Commit, Db};

use state::{db, err, set_db};
pub use types::{AgentInfo, SetupResult, VersionMetadata};

/// Save resource locally and push commit over WS when a session is open.
async fn save_and_push(
    resource: &mut atomic_lib::Resource,
    store: &atomic_lib::Db,
) -> Result<(), String> {
    let response = resource.save_locally(store).await.map_err(err)?;
    if let Some(bytes) = &response.commit.loro_update {
        if !bytes.is_empty() {
            let subject_key = response.commit.subject.pure_id();
            atomic_lib::sync::peer::broadcast_live_update(&subject_key, bytes);
        }
    }
    let ws_ok = ws_sync::try_push_commit(store, &response.commit).await;
    // Hub unreachable or no WS session: bulk Iroh reconcile. When live peers exist
    // we already broadcast above; still bulk-nudge if P2P-only (no hub).
    if !ws_ok || atomic_lib::sync::peer::live_peer_count() == 0 {
        nudge_peers_after_local_change(store).await;
    }
    Ok(())
}

fn is_unreachable_hub_url(url: &str) -> bool {
    let lower = url.to_lowercase();
    lower.contains("localhost") || lower.contains("127.0.0.1")
}

/// Start Iroh (live sync + auto-connect loop) and announce on pkarr.
async fn ensure_sync_connectivity(store: &atomic_lib::Db) -> Result<(), String> {
    let Some(drive) = store.get_active_drive() else {
        return Ok(());
    };
    let _ = start_peer().await?;
    let _ = peer_announce(drive).await;
    Ok(())
}

/// Debounce for the bulk peer nudge below — unread under `cfg(test)`, where the
/// nudge itself is compiled out.
#[cfg_attr(test, allow(dead_code))]
static LAST_PEER_NUDGE_MS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// When WS push failed, run a debounced bulk sync with known peers / pkarr discover.
async fn nudge_peers_after_local_change(store: &atomic_lib::Db) {
    // The bridge unit tests assert local store invariants. Standing up a real
    // Iroh endpoint for them would make every save network-dependent and slow
    // for no added coverage — the transport itself is covered by `atomic_lib`'s
    // two-node `sync::iroh_e2e` suite.
    #[cfg(test)]
    {
        let _ = store;
        return;
    }
    #[cfg(not(test))]
    {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        let last = LAST_PEER_NUDGE_MS.load(std::sync::atomic::Ordering::Relaxed);
        if now.saturating_sub(last) < 2_000 {
            return;
        }
        LAST_PEER_NUDGE_MS.store(now, std::sync::atomic::Ordering::Relaxed);

        if ensure_sync_connectivity(store).await.is_err() {
            return;
        }
        if let Err(e) = try_auto_peer_sync(store).await {
            tracing::debug!("[save_and_push] peer nudge failed: {e}");
        }
    }
}

/// Local-first Atomic Data SDK for Flutter.
///
/// API groups:
///   1. Database  — open_db()
///   2. Agent     — setup(), load_agent(), get_active_agent(), clear_agent()
///   3. Drive     — create_drive(), list_drives(), get_active_drive(), set_active_drive()
///   4. Resource  — create_resource(), set_property(), get_property(), rename_resource(),
///                  delete_resource()
///   5. History   — warm_resource_history(), get_resource_history(), get_property_at_version()
///   6. WS sync   — open_ws_sync(), close_ws_sync(), sync_drive_to_server(), resume_app_session()
///   7. Peer      — start_peer(), get_peer_id(), peer_announce(), peer_sync(), peer_discover_sync()
///
/// Networking (groups 6-7) is explicit and opt-in. Nothing in groups 1-5 reaches
/// the network beyond the best-effort push a save makes when a session is open.
///
/// This module is deliberately app-agnostic — no meal, no calorie, nothing this
/// app owns. That lives in [`super::meals`] next door, which is what keeps this
/// file a copy of the Atomic Canvas bridge: merging the two back into one shared
/// crate later stays a copy rather than a diff.

// ── 1. Database ────────────────────────────────────────────────────────────

/// Open a local database. Call once on app start; calling again is a no-op.
///
/// The second call has to be a no-op rather than a second open: redb holds an
/// exclusive lock on the file, so re-opening it fails, and the recovery path
/// below reads any failure as corruption and *deletes the database*. The store
/// is already in a `OnceLock` that a second `set_db` would silently drop, so
/// there was never anything to gain by getting that far.
pub async fn open_db(path: String) -> Result<(), String> {
    if db().is_ok() {
        return Ok(());
    }

    // Set up log filtering — suppress noisy TLS/mDNS/iroh internals
    #[cfg(target_os = "android")]
    {
        use tracing_subscriber::prelude::*;
        let _ = tracing_subscriber::registry()
            .with(tracing_android::layer("atomic").unwrap())
            .with(tracing_subscriber::filter::EnvFilter::new(
                "info,swarm_discovery=error",
            ))
            .try_init();
    }
    #[cfg(not(target_arch = "wasm32"))]
    let store = {
        let base_path = std::path::Path::new(&path);
        let db_path = base_path.join("atomic.redb");
        let uploads_path = base_path.join("uploads");
        match atomic_lib::Db::init_redb_file(base_path, None, &uploads_path).await {
            Ok(s) => s,
            Err(e) => {
                tracing::warn!("DB corrupted, deleting and recreating: {e}");
                let _ = std::fs::remove_file(&db_path);
                atomic_lib::Db::init_redb_file(base_path, None, &uploads_path)
                    .await
                    .map_err(err)?
            }
        }
    };

    #[cfg(target_arch = "wasm32")]
    let store = atomic_lib::Db::init_redb_opfs(None, "atomic.redb")
        .await
        .map_err(err)?;

    set_db(store);
    Ok(())
}

#[frb(init)]
pub fn init_app() {
    flutter_rust_bridge::setup_default_user_utils();

    // Initialize tracing → logcat on Android, stderr elsewhere
    #[cfg(target_os = "android")]
    {
        use tracing_subscriber::layer::SubscriberExt;
        use tracing_subscriber::util::SubscriberInitExt;
        let _ = tracing_subscriber::registry()
            .with(tracing_android::layer("atomic").ok())
            .with(tracing_subscriber::filter::LevelFilter::INFO)
            .try_init();
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = tracing_subscriber::fmt()
            .with_max_level(tracing::Level::INFO)
            .with_ansi(false)
            .try_init();
    }
}

// ── 2. Agent ───────────────────────────────────────────────────────────────

/// Create an agent and a personal drive in one call. Pure local — no networking.
/// Call `start_peer()` + `peer_announce()` afterwards if you want to be discoverable.
pub async fn setup(name: String) -> Result<SetupResult, String> {
    let store = db()?;
    let (agent, drive_subject) = store.setup(&name).await.map_err(err)?;
    let secret = agent.build_secret().map_err(err)?;
    Ok(SetupResult {
        agent_secret: secret,
        agent_subject: agent.subject.to_string(),
        drive_subject,
    })
}

/// Load an existing agent from a secret. Pure local — no networking.
/// If the secret contains a drive DID, it becomes the active drive.
///
/// Returns "needs_sync" if the drive doesn't exist locally (needs QR pairing).
/// Returns the agent subject if everything is available.
pub async fn load_agent(secret: String) -> Result<String, String> {
    let result = db()?.load_agent_from_secret(&secret).await.map_err(err)?;
    if result.drive_needs_sync {
        Ok("needs_sync".to_string())
    } else {
        Ok(result.agent.subject.to_string())
    }
}

/// Get the currently active agent, if any.
pub async fn get_active_agent() -> Result<Option<AgentInfo>, String> {
    let store = db()?;
    match store.get_default_agent() {
        Ok(agent) => {
            let secret = agent.build_secret().map_err(err)?;
            Ok(Some(AgentInfo {
                secret,
                subject: agent.subject.to_string(),
                public_key: agent.public_key.clone(),
                name: agent.name.clone(),
            }))
        }
        Err(_) => Ok(None),
    }
}

/// Clear the active agent.
pub fn clear_agent() -> Result<(), String> {
    if let Ok(store) = db() {
        store.clear_default_agent();
    }
    Ok(())
}

#[frb(sync)]
pub fn create_agent(name: String) -> Result<AgentInfo, String> {
    let agent = atomic_lib::agents::Agent::new(Some(&name)).map_err(err)?;
    let secret = agent.build_secret().map_err(err)?;
    if let Ok(store) = db() {
        store.set_default_agent(agent.clone());
    }
    Ok(AgentInfo {
        secret,
        subject: agent.subject.to_string(),
        public_key: agent.public_key.clone(),
        name: agent.name.clone(),
    })
}

#[frb(sync)]
pub fn agent_from_secret(secret: String) -> Result<AgentInfo, String> {
    let agent = atomic_lib::agents::Agent::from_secret(&secret).map_err(err)?;
    Ok(AgentInfo {
        secret,
        subject: agent.subject.to_string(),
        public_key: agent.public_key.clone(),
        name: agent.name.clone(),
    })
}

// ── 3. Drive ───────────────────────────────────────────────────────────────

/// Create a new drive. Returns the drive subject.
pub async fn create_drive(name: String) -> Result<String, String> {
    db()?.create_drive(&name).await.map_err(err)
}

/// Get the active drive subject, if one is set.
#[frb(sync)]
pub fn get_active_drive() -> Option<String> {
    db().ok()?.get_active_drive()
}

/// Set the active drive.
pub async fn set_active_drive(subject: String) -> Result<(), String> {
    db()?.set_active_drive(&subject).map_err(err)
}

/// List drives belonging to the current agent.
pub async fn list_drives() -> Result<Vec<String>, String> {
    let drives = db()?.list_drives().await.map_err(err)?;
    Ok(drives.iter().map(|d| d.subject.clone()).collect())
}

/// List drives with names. Returns JSON-encoded array of {subject, name}.
pub async fn list_drives_with_names() -> Result<String, String> {
    let drives = db()?.list_drives().await.map_err(err)?;
    serde_json::to_string(&drives).map_err(|e| e.to_string())
}

// ── 4. Resource ────────────────────────────────────────────────────────────

/// Create a named child of `parent_subject`.
///
/// `class` is the `is-a` subject the resource gets, and it is not optional
/// decoration: `create_resource` validates the new resource against it, so a
/// class whose required properties aren't being set here fails the write. The
/// canvas bridge hardcoded `urls::CLASS` — the meta-class used to *define*
/// classes, which requires a `shortname` — and every call through it failed;
/// nothing called it, so nobody found out. Pass [`atomic_lib::urls::FOLDER`]
/// for a plain container, or an app class once its ontology is seeded.
pub async fn create_resource(
    parent_subject: String,
    name: String,
    class: String,
) -> Result<String, String> {
    db()?
        .create_resource(&class, &parent_subject, &name, None)
        .await
        .map_err(err)
}

pub async fn set_property(subject: String, property: String, value: String) -> Result<(), String> {
    let store = db()?;
    let mut resource = store
        .get_resource(&subject.as_str().into())
        .await
        .map_err(err)?;
    resource
        .set_unsafe(property, atomic_lib::Value::String(value))
        .map_err(err)?;
    save_and_push(&mut resource, store.as_ref()).await
}

pub async fn get_property(subject: String, property: String) -> Result<String, String> {
    let store = db()?;
    let resource = store
        .get_resource(&subject.as_str().into())
        .await
        .map_err(err)?;
    Ok(resource
        .get(&property)
        .map(|v| v.to_string())
        .unwrap_or_default())
}

/// Rename any resource (sets the core `name` property).
pub async fn rename_resource(subject: String, name: String) -> Result<(), String> {
    let store = db()?;
    let mut resource = store
        .get_resource(&subject.as_str().into())
        .await
        .map_err(err)?;
    resource
        .set_unsafe(
            atomic_lib::urls::NAME.into(),
            atomic_lib::Value::String(name),
        )
        .map_err(err)?;
    save_and_push(&mut resource, store.as_ref()).await
}

/// Delete a resource with a signed destroy commit, pushed over WS / Iroh.
pub async fn delete_resource(subject: String) -> Result<(), String> {
    tracing::info!("[delete_resource] {}", &subject[..subject.len().min(30)]);
    let store = db()?;
    let mut builder = atomic_lib::commit::CommitBuilder::new(subject.clone().into());
    builder.destroy(true);
    let agent = store.get_default_agent().map_err(err)?;
    let resource = store
        .get_resource(&subject.as_str().into())
        .await
        .map_err(err)?;
    let commit = builder
        .sign(&agent, store.as_ref(), &resource)
        .await
        .map_err(err)?;
    let opts = atomic_lib::commit::CommitOpts {
        validate_signature: true,
        validate_timestamp: false,
        validate_previous_commit: false,
        validate_rights: false,
        update_index: true,
        ..atomic_lib::commit::CommitOpts::no_validations_no_index()
    };
    let response = store.apply_commit(commit, &opts).await.map_err(err)?;
    let ws_ok = ws_sync::try_push_commit(store.as_ref(), &response.commit).await;
    if !ws_ok {
        nudge_peers_after_local_change(store.as_ref()).await;
    }
    Ok(())
}

// ── 5. History ─────────────────────────────────────────────────────────────

/// Load versioned state for history operations.
pub async fn warm_resource_history(subject: String) -> Result<(), String> {
    let store = db()?;
    let mut resource = store
        .get_resource(&subject.as_str().into())
        .await
        .map_err(err)?;
    resource.warm_history().map_err(|e| e.to_string())
}

/// Get the edit history of a resource.
pub async fn get_resource_history(subject: String) -> Result<Vec<VersionMetadata>, String> {
    let store = db()?;
    let mut resource = store
        .get_resource(&subject.as_str().into())
        .await
        .map_err(err)?;
    resource.warm_history().map_err(|e| e.to_string())?;
    Ok(resource
        .get_history()
        .into_iter()
        .map(|m| VersionMetadata {
            id: m.id.bytes().to_vec(),
            timestamp: m.timestamp,
            peer_id: m.peer_id,
            lamport: m.lamport,
            len: m.len as i32,
            message: m.message,
        })
        .collect())
}

/// Read one property as it stood at a historical version.
///
/// Generic where the canvas bridge's twin was stroke-specific: an app whose
/// resources have no single "the content" property has to name the one it wants.
pub async fn get_property_at_version(
    subject: String,
    version_id: Vec<u8>,
    property: String,
) -> Result<String, String> {
    let store = db()?;
    let mut resource = store
        .get_resource(&subject.as_str().into())
        .await
        .map_err(err)?;
    resource.warm_history().map_err(|e| e.to_string())?;
    let version = atomic_lib::history::VersionID::from_bytes(version_id);
    let detached = resource.view_at(&version).map_err(|e| e.to_string())?;
    Ok(detached
        .get(&property)
        .map(|v| v.to_string())
        .unwrap_or_default())
}

// ── 6. WebSocket sync (server-backed, same as browser) ─────────────────────

/// Open a WebSocket sync session to an Atomic Server. Authenticates, SUBs the active drive,
/// and applies incoming UPDATE / QUERY_UPDATE / COMMIT frames to the local DB.
pub async fn open_ws_sync(server_url: String) -> Result<(), String> {
    ws_sync::open_ws_sync(&server_url).await
}

/// Close the WebSocket sync session.
pub async fn close_ws_sync() -> Result<(), String> {
    ws_sync::close_ws_sync().await;
    Ok(())
}

/// Push the active drive to a server, so it is hosted there as well as here.
///
/// [`open_ws_sync`] fetches a drive this device lacks, and pushes commits made
/// from now on — but a drive made here before any server was connected has
/// never been offered to one. This offers it: the same replication
/// `/replicate-drive` runs, signed as this device's agent, which is the drive's
/// owner and so may write it at the remote.
///
/// Returns the number of resources pushed.
pub async fn sync_drive_to_server(server_url: String) -> Result<i32, String> {
    use atomic_lib::sync::replicate::{replicate_drive_to_remote, ReplicateAuth};

    let store = db()?;
    let drive = store.get_active_drive().ok_or("No active drive")?;
    let agent = store.get_default_agent().map_err(err)?;
    let ws_url = ws_sync::server_origin_to_ws_url(&server_url)?;

    tracing::info!(
        "[sync_drive_to_server] pushing {} to {ws_url}",
        &drive[..drive.len().min(20)]
    );

    let outcome = replicate_drive_to_remote(
        store.as_ref(),
        &drive,
        &ws_url,
        // Export as the owner: the drive's own agent, whose key this device
        // holds. Anything they can read is theirs to take with them.
        &atomic_lib::agents::ForAgent::AgentSubject(agent.subject.clone()),
        ReplicateAuth::Agent(Box::new(agent)),
    )
    .await
    .map_err(|e: atomic_lib::AtomicError| {
        tracing::error!("[sync_drive_to_server] failed: {e}");
        e.to_string()
    })?;

    // `in_sync` is the receiver's drive hash matching ours on a second probe.
    // Without it the push was acked but dropped — silently, for lack of write
    // rights — and reporting a count would be reporting a lie.
    if !outcome.in_sync {
        return Err(
            "The server accepted the workspace but does not have it. It may not \
             allow this account to write there."
                .into(),
        );
    }

    tracing::info!(
        "[sync_drive_to_server] pushed {} resources, {} blobs",
        outcome.pushed,
        outcome.blobs_served
    );

    Ok(outcome.pushed as i32)
}

/// Restore agent + drive on app start. Opens WS sync, fetches drive from server when
/// missing. Returns `"ok"` or `"needs_sync"`.
pub async fn resume_app_session(
    server_url: String,
    secret: String,
    drive_hint: Option<String>,
) -> Result<String, String> {
    let store = db()?;
    store.load_agent_from_secret(&secret).await.map_err(err)?;

    if let Some(drive) = drive_hint.filter(|s| !s.is_empty()) {
        let _ = store.set_active_drive(&drive);
    }

    let origin = server_url.trim();
    if !origin.is_empty() && !is_unreachable_hub_url(origin) {
        if let Err(e) = ws_sync::open_ws_sync(origin).await {
            tracing::warn!("[resume] WS sync failed: {e}");
        }
    } else if !origin.is_empty() {
        tracing::info!(
            "[resume] skipping WS hub at {origin} (localhost is not reachable from devices)"
        );
    }

    // Fast on purpose. If a reachable server already has the drive, the WS sync
    // above brought it — bring the Iroh endpoint up for live sync and answer
    // "ok". If it does not, answer "needs_sync" immediately.
    //
    // What it must NOT do is run Iroh discovery to look for the drive: pkarr
    // resolve and a peer-sync attempt time out in tens of seconds, and a fresh
    // sign-in — about to pair by QR — can succeed at neither yet. Discovery
    // lives only in `sync_connectivity_now`, called from a screen that has a
    // loading state for it.
    if drive_resource_exists(store.as_ref()).await {
        let _ = ensure_sync_connectivity(store.as_ref()).await;

        return Ok("ok".into());
    }

    Ok("needs_sync".into())
}

async fn drive_resource_exists(store: &atomic_lib::Db) -> bool {
    let Some(drive) = store.get_active_drive() else {
        return false;
    };
    let subject = atomic_lib::Subject::from_raw(&drive, store.get_base_domain().as_deref());
    store.get_resource(&subject).await.is_ok()
}

const PEER_SYNC_ATTEMPT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(22);
const PKARR_RESOLVE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(12);

#[derive(serde::Serialize, serde::Deserialize)]
pub struct SyncConnectivityReport {
    pub imported: i32,
    pub live_peers: u32,
    pub message: String,
}

/// Start Iroh, sync known peers (then pkarr). Returns JSON [`SyncConnectivityReport`].
pub async fn sync_connectivity_now() -> Result<String, String> {
    let store = db()?;
    let report = tokio::time::timeout(
        std::time::Duration::from_secs(50),
        sync_connectivity_inner(store.as_ref()),
    )
    .await
    .map_err(|_| {
        "Sync timed out. Check Wi‑Fi, keep the other device open, or pair with QR.".to_string()
    })??;
    serde_json::to_string(&report).map_err(|e| e.to_string())
}

async fn sync_connectivity_inner(store: &atomic_lib::Db) -> Result<SyncConnectivityReport, String> {
    ensure_sync_connectivity(store).await?;
    let drive = store.get_active_drive().ok_or("No active drive")?;

    let mut imported: i32 = 0;
    let mut errors: Vec<String> = Vec::new();

    // Known peers first (fast path after QR pairing)
    let peers_json = get_known_peers();
    let peers: Vec<serde_json::Value> = serde_json::from_str(&peers_json).unwrap_or_default();
    for peer in &peers {
        let Some(node_id) = peer.get("node_id").and_then(|v| v.as_str()) else {
            continue;
        };
        if node_id.is_empty() {
            continue;
        }
        match tokio::time::timeout(
            PEER_SYNC_ATTEMPT_TIMEOUT,
            atomic_lib::sync::peer::sync_drive_with_peer_if_needed(node_id, &drive, store),
        )
        .await
        {
            Ok(Ok(count)) => {
                imported += count as i32;
                tracing::info!("[sync_now] peer {}: {count} resources", node_id);
            }
            Ok(Err(e)) => {
                tracing::warn!("[sync_now] peer {} failed: {e}", node_id);
                errors.push(format!("{}: {e}", &node_id[..node_id.len().min(12)]));
            }
            Err(_) => {
                errors.push(format!(
                    "{}: timed out after {}s",
                    &node_id[..node_id.len().min(12)],
                    PEER_SYNC_ATTEMPT_TIMEOUT.as_secs()
                ));
            }
        }
    }

    // pkarr discover when still not live to any peer
    if atomic_lib::sync::peer::live_peer_count() == 0 {
        match tokio::time::timeout(PKARR_RESOLVE_TIMEOUT, async {
            let my_node_id = atomic_lib::sync::peer::get_node_id()
                .ok_or("Peer not started")?
                .to_string();
            atomic_lib::discovery::resolve_node_id_filtered(&drive, Some(&my_node_id)).await
        })
        .await
        {
            Ok(Ok(node_id)) => {
                match tokio::time::timeout(
                    PEER_SYNC_ATTEMPT_TIMEOUT,
                    atomic_lib::sync::peer::sync_drive_with_peer_if_needed(&node_id, &drive, store),
                )
                .await
                {
                    Ok(Ok(count)) => imported += count as i32,
                    Ok(Err(e)) => errors.push(format!("discover: {e}")),
                    Err(_) => errors.push("discover: connect timed out".into()),
                }
            }
            Ok(Err(e)) => errors.push(format!("No peer on network: {e}")),
            Err(_) => errors.push("Peer lookup timed out (pkarr)".into()),
        }
    }

    let live = atomic_lib::sync::peer::live_peer_count() as u32;
    let live_ids: std::collections::HashSet<String> = atomic_lib::sync::peer::live_peer_ids()
        .into_iter()
        .collect();
    let live_names: Vec<String> = peers
        .iter()
        .filter_map(|p| {
            let id = p.get("node_id")?.as_str()?;
            if live_ids.contains(&atomic_lib::sync::peer::normalize_node_id(id)) {
                let name = p.get("name").and_then(|v| v.as_str()).unwrap_or("");
                if name.is_empty() {
                    Some(format!("{}…", &id[..id.len().min(8)]))
                } else {
                    Some(name.to_string())
                }
            } else {
                None
            }
        })
        .collect();
    let message = if live > 0 {
        if live_names.is_empty() {
            format!(
                "Connected to {live} device{}",
                if live == 1 { "" } else { "s" }
            )
        } else {
            format!("Connected to {}", live_names.join(", "))
        }
    } else if imported > 0 {
        "Synced data but no live connection — try again".to_string()
    } else if errors.is_empty() {
        "No peers online. Open the other device or pair with QR.".to_string()
    } else {
        errors.join(" · ")
    };

    Ok(SyncConnectivityReport {
        imported,
        live_peers: live,
        message,
    })
}

/// Iroh: known peers, then pkarr discover. Returns true if any sync ran.
#[allow(dead_code)]
async fn try_auto_peer_sync(store: &atomic_lib::Db) -> Result<bool, String> {
    let report = sync_connectivity_inner(store).await?;
    Ok(report.imported > 0 || report.live_peers > 0)
}

/// Subscribe to live updates for a single resource over WebSocket.
pub async fn ws_subscribe_resource(subject: String) -> Result<(), String> {
    ws_sync::subscribe_resource(&subject).await
}

/// Block until a local DB event arrives. Returns JSON, or None on timeout.
pub async fn poll_db_event(timeout_ms: u32) -> Result<Option<String>, String> {
    let store = db()?;
    let mut rx = store.subscribe_events();
    let timeout = std::time::Duration::from_millis(timeout_ms as u64);

    let event = tokio::time::timeout(timeout, async {
        loop {
            match rx.recv().await {
                Ok(e) => return Some(db_event_to_json(e)),
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(_) => {
                    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                    rx = store.subscribe_events();
                }
            }
        }
    })
    .await
    .ok()
    .flatten();

    Ok(event)
}

fn db_event_to_json(event: atomic_lib::DbEvent) -> String {
    use types::DbEventDto;
    let dto = match event {
        atomic_lib::DbEvent::Changed { subject, .. } => DbEventDto {
            kind: "changed".into(),
            subject: subject.to_string(),
            added: None,
        },
        atomic_lib::DbEvent::Destroyed { subject, .. } => DbEventDto {
            kind: "destroyed".into(),
            subject: subject.to_string(),
            added: None,
        },
        atomic_lib::DbEvent::QueryMembershipChanged { subject, added, .. } => DbEventDto {
            kind: "query_membership".into(),
            subject,
            added: Some(added),
        },
    };
    serde_json::to_string(&dto).unwrap_or_else(|_| "{}".into())
}

// ── 7. Peer / Sync (explicit, opt-in) ─────────────────────────────────────

/// Start the Iroh peer node. Returns the NodeID.
/// Call this before any sync operations.
pub async fn start_peer() -> Result<String, String> {
    tracing::info!("[start_peer] called");
    let store = db()?;
    if let Some(existing) = atomic_lib::sync::peer::get_node_id() {
        tracing::info!("[start_peer] already running: {existing}");
        return Ok(existing.to_string());
    }
    tracing::info!("[start_peer] starting Iroh endpoint...");
    let (node_id, _router) = atomic_lib::sync::peer::start(store.as_ref().clone())
        .await
        .map_err(|e| {
            tracing::error!("[start_peer] failed: {e}");
            format!("Failed to start Iroh: {e}")
        })?;
    tracing::info!("[start_peer] OK, NodeID: {node_id}");

    Ok(node_id.to_string())
}

/// Get this device's Iroh NodeID (if peer is running).
#[frb(sync)]
pub fn get_peer_id() -> Option<String> {
    atomic_lib::sync::peer::get_node_id().map(|s| s.to_string())
}

/// Announce this device for a drive via pkarr relay.
/// Publishes the Iroh NodeID so other devices can discover and connect.
pub async fn peer_announce(drive_subject: String) -> Result<(), String> {
    if let Some(node_id) = atomic_lib::sync::peer::get_node_id() {
        atomic_lib::discovery::publish_node_id(&drive_subject, node_id)
            .await
            .map_err(|e| format!("Discovery publish failed: {e}"))?;
        tracing::info!("[announce] published NodeID {node_id} via pkarr");
    }

    Ok(())
}

/// What a sync did, in both directions. A count of imports alone cannot tell
/// "sent your workspace" or "already up to date" from "nothing happened" —
/// and those are most of what actually occurs.
#[derive(serde::Serialize, serde::Deserialize)]
pub struct PeerSyncReport {
    pub imported: i32,
    pub pushed: i32,
    pub in_sync: bool,
    pub peer_name: Option<String>,
}

/// Sync the active drive with a specific peer by Iroh NodeID.
/// Call `start_peer()` first.
pub async fn peer_sync(node_id: String) -> Result<String, String> {
    tracing::info!(
        "[peer_sync] called with node_id={}",
        &node_id[..node_id.len().min(16)]
    );
    let store = db()?;
    let drive = store.get_active_drive().ok_or("No active drive")?;
    tracing::info!(
        "[peer_sync] active drive: {}",
        &drive[..drive.len().min(20)]
    );

    let my_id = atomic_lib::sync::peer::get_node_id();
    tracing::info!(
        "[peer_sync] my NodeID: {:?}",
        my_id.map(|s| &s[..s.len().min(16)])
    );

    if my_id.is_none() {
        return Err("Peer not started. Call start_peer() first.".into());
    }

    tracing::info!("[peer_sync] calling sync_drive_with_peer...");
    let outcome =
        atomic_lib::sync::peer::sync_drive_with_peer_outcome(&node_id, &drive, store.as_ref())
            .await
            .map_err(|e: atomic_lib::AtomicError| {
                tracing::error!("[peer_sync] failed: {e}");
                e.to_string()
            })?;
    tracing::info!(
        "[peer_sync] success: imported {}, pushed {}, in_sync {}",
        outcome.count,
        outcome.pushed,
        outcome.in_sync
    );

    serde_json::to_string(&PeerSyncReport {
        imported: outcome.count as i32,
        pushed: outcome.pushed as i32,
        in_sync: outcome.in_sync,
        peer_name: outcome.peer_name,
    })
    .map_err(|e| e.to_string())
}

/// Discover a peer for a drive via pkarr relay and sync. Call `start_peer()` first.
/// Prefer [`sync_connectivity_now`] — tries known peers first, returns clearer errors.
pub async fn peer_discover_sync(drive_subject: String) -> Result<i32, String> {
    let _ = drive_subject;
    let report_json = sync_connectivity_now().await?;
    let report: SyncConnectivityReport =
        serde_json::from_str(&report_json).map_err(|e| e.to_string())?;
    if report.live_peers == 0 && report.imported == 0 && !report.message.is_empty() {
        return Err(report.message);
    }
    Ok(report.imported)
}

// ── 8. Known peers (persisted in DB) ─────────────────────────────────────

/// Get all known peers as JSON: [{"node_id":"...","name":"..."},...]
#[frb(sync)]
pub fn get_known_peers() -> String {
    let Ok(store) = db() else { return "[]".into() };
    let peers = atomic_lib::sync::peer::get_known_peers(store.as_ref());
    serde_json::to_string(&peers).unwrap_or_else(|_| "[]".into())
}

/// Same as [`get_known_peers`] — the name the Dart client calls.
#[frb(sync)]
pub fn get_known_peers_json() -> String {
    get_known_peers()
}

/// Add a peer with optional name.
#[frb(sync)]
pub fn add_known_peer(node_id: String, name: String) {
    let Ok(store) = db() else { return };
    atomic_lib::sync::peer::add_known_peer(store.as_ref(), &node_id, &name);
}

/// Remove a peer by NodeID.
#[frb(sync)]
pub fn remove_known_peer(node_id: String) {
    let Ok(store) = db() else { return };
    atomic_lib::sync::peer::remove_known_peer(store.as_ref(), &node_id);
}

// ── 9. Device name, live peers, watchers ──────────────────────────────────

#[frb(sync)]
pub fn get_device_name() -> Result<String, String> {
    let store = db()?;
    Ok(atomic_lib::sync::peer::get_device_name(store.as_ref()))
}

#[frb(sync)]
pub fn set_device_name(name: String) -> Result<(), String> {
    let store = db()?;
    atomic_lib::sync::peer::set_device_name(store.as_ref(), &name);
    Ok(())
}

#[frb(sync)]
pub fn live_peer_count() -> i32 {
    atomic_lib::sync::peer::live_peer_count() as i32
}

#[frb(sync)]
pub fn live_peer_ids() -> Vec<String> {
    atomic_lib::sync::peer::live_peer_ids()
}

pub async fn wait_for_peer_count_change(current: i32) -> i32 {
    atomic_lib::sync::peer::wait_for_peer_count_change(current as usize).await as i32
}

pub fn poll_sync_events() -> String {
    let events = atomic_lib::sync::peer::poll_sync_events();
    serde_json::to_string(&events).unwrap_or_else(|_| "[]".into())
}

pub async fn wait_for_sync_event() -> String {
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(60),
        atomic_lib::sync::peer::wait_for_sync_event(),
    )
    .await;
    match result {
        Ok(event) => serde_json::to_string(&event).unwrap_or_else(|_| "null".into()),
        Err(_) => "null".into(),
    }
}

pub async fn watch_resource(subject: String) -> Result<String, String> {
    let store = db()?;
    let mut rx = store.subscribe_events();
    let target = atomic_lib::Subject::from_raw(&subject, store.get_base_domain().as_deref())
        .without_params();
    let result = tokio::time::timeout(std::time::Duration::from_secs(60), async {
        loop {
            match rx.recv().await {
                Ok(atomic_lib::DbEvent::Changed { subject, .. }) if subject == target => {
                    return subject.to_string();
                }
                Ok(atomic_lib::DbEvent::Destroyed { subject, .. }) if subject == target => {
                    return format!("!{}", subject);
                }
                Ok(_) => continue,
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(_) => {
                    tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                    rx = store.subscribe_events();
                }
            }
        }
    })
    .await;
    match result {
        Ok(s) => Ok(s),
        Err(_) => Ok("timeout".into()),
    }
}

pub async fn watch_children(parent: String) -> Result<String, String> {
    let store = db()?;
    let mut rx = store.subscribe_events();
    let result = tokio::time::timeout(std::time::Duration::from_secs(60), async {
        loop {
            match rx.recv().await {
                Ok(atomic_lib::DbEvent::Destroyed { subject, .. }) => {
                    return format!("!{}", subject);
                }
                Ok(atomic_lib::DbEvent::Changed { subject, .. }) => {
                    if let Ok(r) = store.get_resource(&subject).await {
                        if let Ok(p) = r.get(atomic_lib::urls::PARENT) {
                            if p.to_string() == parent {
                                return subject.to_string();
                            }
                        }
                    }
                }
                Ok(atomic_lib::DbEvent::QueryMembershipChanged { .. }) => continue,
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(_) => {
                    tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                    rx = store.subscribe_events();
                }
            }
        }
    })
    .await;

    match result {
        Ok(subject) => Ok(subject),
        Err(_) => Ok("timeout".into()),
    }
}
