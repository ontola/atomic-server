use atomic_lib::Storelike;
use flutter_rust_bridge::frb;

mod state;
mod types;

use state::{db, err, set_db, CANVAS_CLASS, CANVAS_STROKE_DATA};
pub use types::{AgentInfo, CanvasListItem, SetupResult, VersionMetadata};

/// Local-first Atomic Data SDK for Flutter.
///
/// API groups:
///   1. Database  — open_db()
///   2. Agent     — setup(), load_agent(), get_active_agent(), clear_agent()
///   3. Drive     — create_drive(), list_drives(), get_active_drive(), set_active_drive()
///   4. Resource  — create_resource(), set_property(), get_property()
///   5. Canvas    — create_canvas(), save/load/list/delete/rename
///   6. History   — warm_resource_history(), get_resource_history(), get_resource_at_version()
///   7. Peer      — start_peer(), get_peer_id(), peer_announce(), peer_sync(), peer_discover_sync()
///
/// Networking (group 7) is explicit and opt-in. Nothing in groups 1-6 touches the network.

// ── 1. Database ────────────────────────────────────────────────────────────

/// Open a local database. Call once on app start.
pub async fn open_db(path: String) -> Result<(), String> {
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

/// List drives belonging to the current agent, with names.
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

pub async fn create_resource(parent_subject: String, name: String) -> Result<String, String> {
    db()?
        .create_resource(atomic_lib::urls::CLASS, &parent_subject, &name, None)
        .await
        .map_err(err)
}

pub async fn set_property(subject: String, property: String, value: String) -> Result<(), String> {
    let store = db()?;
    let mut resource = store
        .get_resource(&subject.as_str().into())
        .await
        .map_err(err)?;
    resource.set_unsafe(property, atomic_lib::Value::String(value));
    store.add_resource(&resource).await.map_err(err)
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

// ── 5. Canvas CRUD ─────────────────────────────────────────────────────────

/// Create a new canvas. Uses the active drive as parent.
pub async fn create_canvas(name: String) -> Result<String, String> {
    let store = db()?;
    let parent = store
        .get_active_drive()
        .ok_or("No drive set. Call setup() first.")?;
    store
        .create_resource(
            CANVAS_CLASS,
            &parent,
            &name,
            Some(vec![(
                CANVAS_STROKE_DATA,
                atomic_lib::Value::JsonArray(vec![]),
            )]),
        )
        .await
        .map_err(err)
}

/// Per-canvas mutex that also caches the live Resource (with its Loro doc + UndoManager).
/// The Resource stays in memory so undo history survives across FFI calls.
/// Auto-invalidates when the DB broadcasts a change for a cached subject.
static CANVAS_CACHE: std::sync::Mutex<
    Option<
        std::collections::HashMap<
            String,
            std::sync::Arc<tokio::sync::Mutex<Option<atomic_lib::Resource>>>,
        >,
    >,
> = std::sync::Mutex::new(None);

/// Whether the cache listener is running.
static CACHE_LISTENER_STARTED: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

/// Start a background task that invalidates cached resources when the DB changes.
fn ensure_cache_listener() {
    if CACHE_LISTENER_STARTED.swap(true, std::sync::atomic::Ordering::Relaxed) {
        return;
    }
    let Ok(store) = db() else { return };
    let mut rx = store.subscribe_events();
    tokio::spawn(async move {
        loop {
            let subject = match rx.recv().await {
                Ok(atomic_lib::DbEvent::Changed { subject, .. }) => subject,
                Ok(atomic_lib::DbEvent::Destroyed { subject }) => subject,
                Ok(atomic_lib::DbEvent::QueryMembershipChanged { .. }) => continue,
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(_) => {
                    tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                    if let Ok(s) = db() {
                        rx = s.subscribe_events();
                    }
                    continue;
                }
            };
            // Only invalidate if the change came from a remote peer (not our own writes)
            if atomic_lib::sync::peer::is_importing() {
                let key = subject.to_string();
                let mut cache = CANVAS_CACHE.lock().unwrap();
                if let Some(map) = cache.as_mut() {
                    if map.remove(&key).is_some() {
                        tracing::debug!("[canvas_cache] invalidated {}", &key[..key.len().min(20)]);
                    }
                }
            }
        }
    });
}

fn canvas_entry(subject: &str) -> std::sync::Arc<tokio::sync::Mutex<Option<atomic_lib::Resource>>> {
    let mut cache = CANVAS_CACHE.lock().unwrap();
    let map = cache.get_or_insert_with(std::collections::HashMap::new);
    map.entry(subject.to_string())
        .or_insert_with(|| std::sync::Arc::new(tokio::sync::Mutex::new(None)))
        .clone()
}

/// Get or load the cached canvas resource. Initializes Loro + UndoManager.
async fn get_canvas(
    subject: &str,
) -> Result<tokio::sync::OwnedMutexGuard<Option<atomic_lib::Resource>>, String> {
    ensure_cache_listener();
    let entry = canvas_entry(subject);
    let mut guard = entry.lock_owned().await;
    if guard.is_none() {
        let store = db()?;
        let mut resource = store.get_resource(&subject.into()).await.map_err(err)?;
        resource.init_loro().map_err(err)?;
        resource.init_undo();
        *guard = Some(resource);
    }
    Ok(guard)
}

/// Push a single stroke to a canvas. CRDT-friendly — appends to the LoroList
/// instead of replacing it. Strokes from different devices merge cleanly.
pub async fn push_stroke(subject: String, stroke_json: String) -> Result<(), String> {
    let store = db()?;
    let item: serde_json::Value =
        serde_json::from_str(&stroke_json).map_err(|e| format!("Invalid stroke JSON: {e}"))?;

    let mut guard = get_canvas(&subject).await?;
    let resource = guard.as_mut().unwrap();
    resource
        .push_list_item(CANVAS_STROKE_DATA, item)
        .map_err(err)?;
    resource.save_locally(store.as_ref()).await.map_err(err)?;

    Ok(())
}

/// Load strokes JSON from a canvas. Reads directly from DB — fast, no Loro init.
pub async fn load_canvas_strokes(subject: String) -> Result<String, String> {
    let store = db()?;
    let resource = store
        .get_resource(&subject.as_str().into())
        .await
        .map_err(err)?;
    let result = match resource.get(CANVAS_STROKE_DATA) {
        Ok(atomic_lib::Value::JsonArray(arr)) => {
            serde_json::to_string(arr).unwrap_or_else(|_| "[]".into())
        }
        Ok(v) => v.to_string(),
        _ => "[]".into(),
    };
    Ok(result)
}

/// List all canvases in the active drive.
/// Uses the query index (not a full scan) so results include synced resources.
pub async fn list_canvases() -> Result<Vec<CanvasListItem>, String> {
    let store = db()?;
    let drive = store.get_active_drive().ok_or("No active drive")?;

    let query = atomic_lib::storelike::Query::new_prop_val(atomic_lib::urls::PARENT, &drive);
    let result = store.query(&query).await.map_err(err)?;

    let mut items = Vec::new();
    for subject in &result.subjects {
        if let Ok(r) = store.get_resource(&subject.as_str().into()).await {
            // Filter by canvas class
            if let Ok(is_a) = r.get(atomic_lib::urls::IS_A) {
                if !is_a.to_string().contains(CANVAS_CLASS) {
                    continue;
                }
            } else {
                continue;
            }
            items.push(CanvasListItem {
                subject: r.get_subject().to_string(),
                name: r
                    .get(atomic_lib::urls::NAME)
                    .map(|v| v.to_string())
                    .unwrap_or_default(),
            });
        }
    }
    // Sort by name descending — names contain creation timestamps (e.g. "Canvas 1776357218794")
    items.sort_by(|a, b| b.name.cmp(&a.name));
    Ok(items)
}

/// Delete a canvas.
pub async fn delete_canvas(subject: String) -> Result<(), String> {
    tracing::info!("[delete_canvas] {}", &subject[..subject.len().min(30)]);
    let store = db()?;
    // Create a signed destroy commit so deletion syncs to peers
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
    store.apply_commit(commit, &opts).await.map_err(err)?;
    Ok(())
}

/// Rename a canvas.
pub async fn rename_canvas(subject: String, name: String) -> Result<(), String> {
    let store = db()?;
    let mut resource = store
        .get_resource(&subject.as_str().into())
        .await
        .map_err(err)?;
    resource.set_unsafe(
        atomic_lib::urls::NAME.into(),
        atomic_lib::Value::String(name),
    );
    resource.save_locally(store.as_ref()).await.map_err(err)?;
    Ok(())
}

/// Delete a single stroke by index. CRDT-friendly — records a Loro delete op.
pub async fn delete_stroke(subject: String, index: i32) -> Result<(), String> {
    let store = db()?;
    let mut guard = get_canvas(&subject).await?;
    let resource = guard.as_mut().unwrap();
    resource
        .delete_list_item(CANVAS_STROKE_DATA, index as usize)
        .map_err(err)?;
    resource.save_locally(store.as_ref()).await.map_err(err)?;
    Ok(())
}

/// Undo the last Loro operation on a canvas. Returns the new stroke count.
pub async fn undo_canvas(subject: String) -> Result<i32, String> {
    let store = db()?;
    let mut guard = get_canvas(&subject).await?;
    let resource = guard.as_mut().unwrap();
    if resource.undo().map_err(err)? {
        resource.save_locally(store.as_ref()).await.map_err(err)?;
    }
    let count = match resource.get(CANVAS_STROKE_DATA) {
        Ok(atomic_lib::Value::JsonArray(arr)) => arr.len() as i32,
        _ => 0,
    };
    Ok(count)
}

/// Redo the last undone Loro operation on a canvas. Returns the new stroke count.
pub async fn redo_canvas(subject: String) -> Result<i32, String> {
    let store = db()?;
    let mut guard = get_canvas(&subject).await?;
    let resource = guard.as_mut().unwrap();
    if resource.redo().map_err(err)? {
        resource.save_locally(store.as_ref()).await.map_err(err)?;
    }
    let count = match resource.get(CANVAS_STROKE_DATA) {
        Ok(atomic_lib::Value::JsonArray(arr)) => arr.len() as i32,
        _ => 0,
    };
    Ok(count)
}

// ── 6. History ─────────────────────────────────────────────────────────────

/// Ensure the Loro doc is loaded for history operations.
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

/// Get canvas strokes at a specific historical version.
pub async fn get_resource_at_version(
    subject: String,
    version_id: Vec<u8>,
) -> Result<String, String> {
    let store = db()?;
    let mut resource = store
        .get_resource(&subject.as_str().into())
        .await
        .map_err(err)?;
    resource.warm_history().map_err(|e| e.to_string())?;
    let version = atomic_lib::loro::VersionID::from_bytes(version_id);
    let detached = resource.view_at(&version).map_err(|e| e.to_string())?;
    Ok(detached
        .get(CANVAS_STROKE_DATA)
        .map(|v| v.to_string())
        .unwrap_or_else(|_| "[]".into()))
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

/// Sync the active drive with a specific peer by Iroh NodeID.
/// Call `start_peer()` first.
pub async fn peer_sync(node_id: String) -> Result<i32, String> {
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
    let count = atomic_lib::sync::peer::sync_drive_with_peer(&node_id, &drive, store.as_ref())
        .await
        .map_err(|e: atomic_lib::AtomicError| {
            tracing::error!("[peer_sync] failed: {e}");
            e.to_string()
        })?;
    tracing::info!("[peer_sync] success: {count} resources");
    Ok(count as i32)
}

/// Discover a peer for a drive via pkarr relay and sync. Call `start_peer()` first.
/// Pkarr resolves drive_did → [NodeID]. Iroh's discovery_n0 handles the addressing.
pub async fn peer_discover_sync(drive_subject: String) -> Result<i32, String> {
    let store = db()?;

    let my_node_id = atomic_lib::sync::peer::get_node_id()
        .ok_or("Peer not started. Call start_peer() first.")?
        .to_string();

    // Resolve peer's NodeID via pkarr (drive_did → NodeID mapping)
    let node_id =
        atomic_lib::discovery::resolve_node_id_filtered(&drive_subject, Some(&my_node_id))
            .await
            .map_err(|e| {
                format!(
                    "No peers found for drive {}...: {}",
                    &drive_subject[..drive_subject.len().min(16)],
                    e
                )
            })?;

    tracing::info!(
        "[discover_sync] resolved peer {} (my ID: {}), connecting via Iroh...",
        &node_id[..node_id.len().min(16)],
        &my_node_id[..my_node_id.len().min(16)],
    );

    // Connect and sync — Iroh's discovery_n0 resolves NodeID → relay/addresses
    let count =
        atomic_lib::sync::peer::sync_drive_with_peer(&node_id, &drive_subject, store.as_ref())
            .await
            .map_err(|e: atomic_lib::AtomicError| {
                format!(
                    "Iroh connection to {} failed (my ID: {}): {}",
                    &node_id[..node_id.len().min(16)],
                    &my_node_id[..my_node_id.len().min(16)],
                    e
                )
            })?;
    Ok(count as i32)
}

// ── 8. Known peers (persisted in DB) ─────────────────────────────────────

/// Get all known peers as JSON: [{"node_id":"...","name":"..."},...]
#[frb(sync)]
pub fn get_known_peers() -> String {
    let Ok(store) = db() else { return "[]".into() };
    let peers = atomic_lib::sync::peer::get_known_peers(store.as_ref());
    serde_json::to_string(&peers).unwrap_or_else(|_| "[]".into())
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

// ── Legacy stubs (kept for frb_generated.rs compatibility) ─────────────────
// These will be removed when FRB codegen is regenerated.

// Legacy stubs — kept only because frb_generated.rs references them.
// Remove after FRB codegen is regenerated.

/// Legacy bridge — repurposed as the sync entry point until FRB codegen runs.
/// `server_url` is the command: "start_peer", "announce", "get_peer_id", or an Iroh NodeID to sync with.
/// `agent_secret` is unused (kept for bridge signature compatibility).
pub async fn connect(server_url: String, _agent_secret: String) -> Result<String, String> {
    let cmd = server_url.trim();
    tracing::info!("[connect bridge] cmd={cmd}");

    if cmd == "start_peer" {
        return start_peer().await;
    }

    if cmd == "get_peer_id" {
        return Ok(get_peer_id().unwrap_or_default());
    }

    if cmd == "get_device_name" {
        let store = db()?;
        return Ok(atomic_lib::sync::peer::get_device_name(store.as_ref()));
    }

    if let Some(name) = cmd.strip_prefix("set_device_name:") {
        let store = db()?;
        atomic_lib::sync::peer::set_device_name(store.as_ref(), name);
        return Ok("ok".into());
    }

    if cmd == "live_peer_count" {
        let count = atomic_lib::sync::peer::live_peer_count();
        return Ok(count.to_string());
    }

    if cmd == "live_peer_ids" {
        let ids = atomic_lib::sync::peer::live_peer_ids();
        return Ok(serde_json::to_string(&ids).unwrap_or("[]".into()));
    }

    if let Some(subject) = cmd.strip_prefix("watch_resource:") {
        let store = db()?;
        let mut rx = store.subscribe_events();
        let target = atomic_lib::Subject::from_raw(subject, store.get_base_domain().as_deref())
            .without_params();
        let result = tokio::time::timeout(std::time::Duration::from_secs(60), async {
            loop {
                match rx.recv().await {
                    Ok(atomic_lib::DbEvent::Changed { subject, .. }) if subject == target => {
                        return subject.to_string();
                    }
                    Ok(atomic_lib::DbEvent::Destroyed { subject }) if subject == target => {
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
        return match result {
            Ok(s) => Ok(s),
            Err(_) => Ok("timeout".into()),
        };
    }

    if cmd == "announce" {
        let drive = db()?.get_active_drive().ok_or("No active drive")?;
        peer_announce(drive).await?;
        return Ok("announced".into());
    }

    if cmd.starts_with("discover_sync") {
        let drive = db()?.get_active_drive().ok_or("No active drive")?;
        let count = peer_discover_sync(drive).await?;
        return Ok(format!("{count}"));
    }

    if let Some(parent) = cmd.strip_prefix("watch_children:") {
        let store = db()?;
        let mut rx = store.subscribe_events();
        let parent_str = parent.to_string();

        let result = tokio::time::timeout(std::time::Duration::from_secs(60), async {
            loop {
                match rx.recv().await {
                    Ok(atomic_lib::DbEvent::Destroyed { subject }) => {
                        return format!("!{}", subject);
                    }
                    Ok(atomic_lib::DbEvent::Changed { subject, .. }) => {
                        if let Ok(r) = store.get_resource(&subject).await {
                            if let Ok(p) = r.get(atomic_lib::urls::PARENT) {
                                if p.to_string() == parent_str {
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

        return match result {
            Ok(subject) => Ok(subject),
            Err(_) => Ok("timeout".into()),
        };
    }

    if let Some(rest) = cmd.strip_prefix("set_strokes:") {
        // Clear and replace all strokes. Format: "set_strokes:<subject>:<json_array>"
        let after_prefix = if rest.starts_with("did:ad:") {
            rest.find("==:")
                .map(|i| i + 2)
                .or_else(|| rest.find(":{").or_else(|| rest.find(":[")))
                .unwrap_or(rest.len())
        } else {
            rest.find(':').unwrap_or(rest.len())
        };
        let subject = &rest[..after_prefix];
        let strokes_json = if after_prefix < rest.len() {
            &rest[after_prefix + 1..]
        } else {
            "[]"
        };

        let store = db()?;
        let mut guard = get_canvas(subject).await?;
        let resource = guard.as_mut().unwrap();
        let arr: Vec<serde_json::Value> =
            serde_json::from_str(strokes_json).map_err(|e| format!("Invalid strokes JSON: {e}"))?;
        resource.clear_json_array(CANVAS_STROKE_DATA).map_err(err)?;
        for item in &arr {
            resource
                .push_list_item(CANVAS_STROKE_DATA, item.clone())
                .map_err(err)?;
        }
        resource.save_locally(store.as_ref()).await.map_err(err)?;
        return Ok("ok".into());
    }

    if cmd == "poll_sync_events" {
        let events = atomic_lib::sync::peer::poll_sync_events();
        return Ok(serde_json::to_string(&events).unwrap_or("[]".into()));
    }

    if cmd == "wait_for_sync_event" {
        // Block until the next sync event arrives (60s timeout)
        let result = tokio::time::timeout(
            std::time::Duration::from_secs(60),
            atomic_lib::sync::peer::wait_for_sync_event(),
        )
        .await;
        return match result {
            Ok(event) => Ok(serde_json::to_string(&event).unwrap_or("null".into())),
            Err(_) => Ok("null".into()),
        };
    }

    if cmd.starts_with("wait_for_peer_count_change:") {
        let current: usize = cmd
            .strip_prefix("wait_for_peer_count_change:")
            .and_then(|s| s.parse().ok())
            .unwrap_or(0);
        // Block until the live peer count changes (60s timeout)
        let result = tokio::time::timeout(
            std::time::Duration::from_secs(60),
            atomic_lib::sync::peer::wait_for_peer_count_change(current),
        )
        .await;
        return match result {
            Ok(new_count) => Ok(new_count.to_string()),
            Err(_) => Ok(current.to_string()),
        };
    }

    if cmd == "get_known_peers" {
        return Ok(get_known_peers());
    }

    if let Some(rest) = cmd.strip_prefix("add_known_peer:") {
        // Format: "add_known_peer:<nodeId>" or "add_known_peer:<nodeId>:<name>"
        let (node_id, name) = if let Some(idx) = rest.find(':') {
            (&rest[..idx], &rest[idx + 1..])
        } else {
            (rest, "")
        };
        add_known_peer(node_id.to_string(), name.to_string());
        return Ok("ok".into());
    }

    if let Some(node_id) = cmd.strip_prefix("remove_known_peer:") {
        remove_known_peer(node_id.to_string());
        return Ok("ok".into());
    }

    if let Some(rest) = cmd.strip_prefix("push_stroke:") {
        let after_prefix = if rest.starts_with("did:ad:") {
            rest.find("==:")
                .map(|i| i + 2)
                .or_else(|| rest.find(":{"))
                .unwrap_or(rest.len())
        } else {
            rest.find(':').unwrap_or(rest.len())
        };
        let subject = &rest[..after_prefix];
        let stroke_json = if after_prefix < rest.len() {
            &rest[after_prefix + 1..]
        } else {
            "{}"
        };
        push_stroke(subject.to_string(), stroke_json.to_string()).await?;
        return Ok("ok".into());
    }

    // Default: treat as Iroh NodeID, strip prefixes
    let node_id = cmd
        .strip_prefix("did:ad:node:")
        .or_else(|| cmd.strip_prefix("iroh:"))
        .unwrap_or(cmd);
    let count = peer_sync(node_id.to_string()).await?;
    Ok(format!("Synced {count} resources"))
}

#[frb(sync)]
pub fn set_drive(subject: String) {
    if let Ok(store) = db() {
        let _ = store.set_active_drive(&subject);
    }
}

#[frb(sync)]
pub fn get_drive() -> Option<String> {
    db().ok()?.get_active_drive()
}
