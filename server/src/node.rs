use crate::config::Config;
use atomic_lib::sync::policy::AllowlistPolicy;
use atomic_lib::Db;
use serde::{Deserialize, Serialize};
use std::sync::{Arc, RwLock};
use std::{path::Path, time::Duration};

#[derive(Clone)]
pub struct ControlPlaneHeartbeatConfig {
    pub control_plane_url: String,
    pub node_id: String,
    pub iroh_node_id: Option<String>,
    pub http_origin: String,
    pub region: String,
    pub interval: Duration,
    pub store_path: std::path::PathBuf,
    pub uploads_path: std::path::PathBuf,
}

#[derive(Serialize)]
struct NodeHeartbeatRequest {
    id: String,
    iroh_node_id: Option<String>,
    http_origin: Option<String>,
    region: String,
    capacity_bytes: Option<u64>,
    used_bytes: Option<u64>,
    active_drive_count: Option<u64>,
}

#[derive(Deserialize)]
struct NodePolicyResponse {
    #[serde(default)]
    portal_url: Option<String>,
    allowed_drives: Vec<NodePolicyDrive>,
}

/// Whether this server is a managed node (configured to report to a ControlPlane
/// control plane).
pub fn is_managed(config: &Config) -> bool {
    config
        .opts
        .control_plane_url
        .as_deref()
        .map(str::trim)
        .is_some_and(|s| !s.is_empty())
}

#[derive(Deserialize)]
struct NodePolicyDrive {
    drive_subject: String,
    #[serde(default)]
    quota_bytes: Option<u64>,
}

#[derive(Serialize)]
struct NodeUsageRequest<'a> {
    node_id: &'a str,
    drives: Vec<atomic_lib::DriveUsage>,
}

pub fn heartbeat_config(
    config: &Config,
    iroh_node_id: Option<String>,
) -> Option<ControlPlaneHeartbeatConfig> {
    let control_plane_url = config
        .opts
        .control_plane_url
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())?
        .trim_end_matches('/')
        .to_string();

    let node_id = config
        .opts
        .control_plane_node_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToOwned::to_owned)
        .or_else(|| iroh_node_id.clone())
        .unwrap_or_else(|| config.get_origin());

    Some(ControlPlaneHeartbeatConfig {
        control_plane_url,
        node_id,
        iroh_node_id,
        http_origin: config.get_origin(),
        region: config.opts.control_plane_region.clone(),
        interval: Duration::from_secs(config.opts.control_plane_heartbeat_interval.max(5)),
        store_path: config.store_path.clone(),
        uploads_path: config.uploads_path.clone(),
    })
}

pub fn spawn_heartbeat(config: ControlPlaneHeartbeatConfig, store: Db, policy: Arc<AllowlistPolicy>) {
    actix_web::rt::spawn(async move {
        let client = reqwest::Client::new();
        loop {
            if let Err(e) = send_heartbeat(&client, &config, &store).await {
                tracing::warn!("Atomic ControlPlane heartbeat failed: {e}");
            }
            if let Err(e) = send_usage(&client, &config, &store, &policy).await {
                tracing::warn!("Atomic ControlPlane usage report failed: {e}");
            }
            actix_web::rt::time::sleep(config.interval).await;
        }
    });
}

pub fn spawn_policy_poll(
    config: ControlPlaneHeartbeatConfig,
    policy: Arc<AllowlistPolicy>,
    dashboard_url: Arc<RwLock<Option<String>>>,
) {
    actix_web::rt::spawn(async move {
        let client = reqwest::Client::new();
        loop {
            if let Err(e) = refresh_policy(&client, &config, &policy, &dashboard_url).await {
                tracing::warn!("Atomic ControlPlane policy refresh failed: {e}");
            }
            actix_web::rt::time::sleep(config.interval).await;
        }
    });
}

async fn send_heartbeat(
    client: &reqwest::Client,
    config: &ControlPlaneHeartbeatConfig,
    store: &Db,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let used_bytes = path_size(&config.store_path) + path_size(&config.uploads_path);
    let active_drive_count = store
        .list_drives()
        .await
        .map(|drives| drives.len() as u64)
        .ok();

    let body = NodeHeartbeatRequest {
        id: config.node_id.clone(),
        iroh_node_id: config.iroh_node_id.clone(),
        http_origin: Some(config.http_origin.clone()),
        region: config.region.clone(),
        capacity_bytes: None,
        used_bytes: Some(used_bytes),
        active_drive_count,
    };

    let url = format!("{}/api/nodes/heartbeat", config.control_plane_url);
    let response = client.post(url).json(&body).send().await?;
    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        return Err(format!("control plane returned {status}: {text}").into());
    }

    Ok(())
}

async fn refresh_policy(
    client: &reqwest::Client,
    config: &ControlPlaneHeartbeatConfig,
    policy: &AllowlistPolicy,
    dashboard_url: &RwLock<Option<String>>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let node_id = urlencoding::encode(&config.node_id);
    let url = format!("{}/api/node-policy?node_id={node_id}", config.control_plane_url);
    let response = client.get(url).send().await?;

    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        return Err(format!("control plane returned {status}: {text}").into());
    }

    let node_policy: NodePolicyResponse = response.json().await?;
    let drive_count = node_policy.allowed_drives.len();
    if let Ok(mut guard) = dashboard_url.write() {
        *guard = node_policy.portal_url.filter(|s| !s.is_empty());
    }
    policy.set_drive_policies(
        node_policy
            .allowed_drives
            .into_iter()
            .map(|drive| (drive.drive_subject, drive.quota_bytes)),
    );
    tracing::debug!("Atomic ControlPlane policy refreshed: {drive_count} allowed drives");

    Ok(())
}

/// Compute per-drive storage usage and report it to the control plane. Also
/// records the usage locally so the sync engine can enforce quotas.
async fn send_usage(
    client: &reqwest::Client,
    config: &ControlPlaneHeartbeatConfig,
    store: &Db,
    policy: &AllowlistPolicy,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    // Report usage for the drives this node hosts (the control-plane allowlist),
    // which belong to enrolled users — not the node's own agent drives.
    let allowed = policy.allowed_drive_subjects();
    let drives = store.per_drive_usage(&allowed).await?;
    if drives.is_empty() {
        return Ok(());
    }

    // Feed usage back into the admission policy for quota enforcement.
    policy.record_drive_usage(
        drives
            .iter()
            .map(|d| (d.drive_subject.clone(), d.blob_bytes + d.loro_bytes)),
    );

    let body = NodeUsageRequest {
        node_id: &config.node_id,
        drives,
    };
    let url = format!("{}/api/node-usage", config.control_plane_url);
    let response = client.post(url).json(&body).send().await?;
    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        return Err(format!("control plane returned {status}: {text}").into());
    }

    Ok(())
}

fn path_size(path: &Path) -> u64 {
    let Ok(metadata) = std::fs::symlink_metadata(path) else {
        return 0;
    };

    if metadata.file_type().is_symlink() {
        return 0;
    }

    if metadata.is_file() {
        return metadata.len();
    }

    if !metadata.is_dir() {
        return 0;
    }

    let Ok(entries) = std::fs::read_dir(path) else {
        return 0;
    };

    entries
        .filter_map(Result::ok)
        .map(|entry| path_size(&entry.path()))
        .sum()
}
