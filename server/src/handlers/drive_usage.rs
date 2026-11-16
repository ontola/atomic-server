use crate::{
    appstate::AppState,
    errors::AtomicServerResult,
    helpers::{get_client_agent_for_signed_url, NO_STORE},
};
use actix_web::{http::header, web, HttpRequest, HttpResponse};
use atomic_lib::{agents::ForAgent, errors::AtomicError, sync::peer, Storelike, Subject};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Deserialize)]
pub struct DriveUsageParams {
    pub subject: String,
    /// Read only peer confirmation dates when polling the Sync page.
    #[serde(default, rename = "peerFullSyncsOnly")]
    pub peer_full_syncs_only: bool,
}

/// The wire shape the sync page reads (`fetchNodeDriveUsage`) — camelCase, so
/// it deliberately does not reuse `atomic_lib::DriveUsage`, whose snake_case
/// field names are the separate control-plane usage-report contract.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DriveUsageResponse {
    name: Option<String>,
    resource_count: u64,
    blob_bytes: u64,
    loro_bytes: u64,
    /// Whether this node currently admits the drive under its sync policy. On
    /// a managed node that is "the control plane has the drive on its
    /// allowlist"; on a self-hosted node it is whether the node hosts the
    /// drive (an open node hosts everything). Data can outlive enrollment, so
    /// `resourceCount > 0` alone does not say this. Over-quota still counts as
    /// enrolled: the drive is hosted, just full.
    enrolled: bool,
    /// Display name of the account that manages this drive, as the payer chose
    /// it. Only present when the drive is enrolled and the node was told one.
    #[serde(skip_serializing_if = "Option::is_none")]
    managed_by: Option<String>,
    /// Last confirmation for this drive, indexed by peer node ID.
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    peer_full_syncs: BTreeMap<String, i64>,
}

/// Longest manager label we pass on, in characters.
const MAX_MANAGER_LABEL_CHARS: usize = 80;

/// Trim and cap a label from the policy; empty becomes `None`.
fn clean_manager_label(label: Option<String>) -> Option<String> {
    let trimmed = label?
        .trim()
        .chars()
        .take(MAX_MANAGER_LABEL_CHARS)
        .collect::<String>();
    let trimmed = trimmed.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

/// Authenticates the caller and enforces read access on the drive itself (raw
/// fetch + check, not the extender path — these are read-only stats, not a
/// resource render).
///
/// These endpoints report on drives hosted on this node. A drive hosted
/// elsewhere (the sync page asks about every drive it knows) answers 404
/// *before* `get_resource`, which would otherwise fetch the caller-supplied
/// external URL over HTTP: an outbound request per call, and an upstream 401
/// that surfaced as a 500 in Sentry.
async fn check_drive_readable(
    appstate: &AppState,
    req: &HttpRequest,
    subject: &str,
) -> AtomicServerResult<ForAgent> {
    let store = &appstate.store;
    let for_agent = get_client_agent_for_signed_url(req, appstate).await?;

    if !Subject::from_raw(subject, store.get_base_domain().as_deref()).is_local() {
        return Err(AtomicError::not_found(format!(
            "This drive is not hosted on this node: {subject}"
        ))
        .into());
    }

    let drive = store.get_resource(&Subject::from(subject)).await?;
    atomic_lib::hierarchy::check_read(store, &drive, &for_agent).await?;
    Ok(for_agent)
}

/// `GET /drive-usage?subject=<drive>` — per-drive storage for the sync page.
/// Signed callers with read access also receive the last full sync reported
/// by each peer. `peerFullSyncsOnly=true` reads those dates without computing
/// the storage breakdown.
#[tracing::instrument(skip_all)]
pub async fn handle_drive_usage(
    appstate: web::Data<AppState>,
    params: web::Query<DriveUsageParams>,
    req: HttpRequest,
) -> AtomicServerResult<HttpResponse> {
    let store = &appstate.store;
    let subject = params.subject.clone();

    let for_agent = check_drive_readable(&appstate, &req, &subject).await?;
    let peer_full_syncs = match for_agent {
        ForAgent::Public => BTreeMap::new(),
        _ => peer::last_confirmed_full_syncs(store, &subject),
    };
    let mut response = HttpResponse::Ok();

    if params.peer_full_syncs_only || !peer_full_syncs.is_empty() {
        response.insert_header((header::CACHE_CONTROL, NO_STORE));
    }

    if params.peer_full_syncs_only {
        return Ok(response.json(serde_json::json!({ "peerFullSyncs": peer_full_syncs })));
    }

    let usage = store
        .per_drive_usage(std::slice::from_ref(&subject))
        .await?;
    let row = usage
        .into_iter()
        .next()
        .ok_or_else(|| format!("No usage found for drive {subject}"))?;

    // `drive_is_allowed`, not `admit_decision`: the latter starts a bootstrap
    // grace clock for unknown drives, and a stat must not change state.
    let enrolled = store.sync_policy().drive_is_allowed(&subject);

    let managed_by = if enrolled {
        clean_manager_label(store.sync_policy().drive_manager_label(&subject))
    } else {
        None
    };

    Ok(response.json(DriveUsageResponse {
        enrolled,
        managed_by,
        name: row.name,
        resource_count: row.resource_count,
        blob_bytes: row.blob_bytes,
        loro_bytes: row.loro_bytes,
        peer_full_syncs,
    }))
}

/// `GET /drive-usage/breakdown?subject=<drive>` — every resource in the drive
/// with its history (Loro) and file (blob) bytes, so a client can draw a size
/// map of where the space goes. Same auth and read check as `/drive-usage`.
#[tracing::instrument(skip_all)]
pub async fn handle_drive_usage_breakdown(
    appstate: web::Data<AppState>,
    params: web::Query<DriveUsageParams>,
    req: HttpRequest,
) -> AtomicServerResult<HttpResponse> {
    let store = &appstate.store;
    let subject = params.subject.clone();

    check_drive_readable(&appstate, &req, &subject).await?;

    let rows = store.drive_usage_breakdown(&subject).await?;

    Ok(HttpResponse::Ok().json(serde_json::json!({
        "driveSubject": subject,
        "resources": rows.iter().map(|r| serde_json::json!({
            "subject": r.subject,
            "name": r.name,
            "parent": r.parent,
            "isA": r.is_a,
            "loroBytes": r.loro_bytes,
            "blobBytes": r.blob_bytes,
        })).collect::<Vec<_>>(),
    })))
}

#[cfg(test)]
mod tests {
    use super::clean_manager_label;

    #[test]
    fn manager_label_is_trimmed_and_capped() {
        assert_eq!(clean_manager_label(None), None);
        assert_eq!(clean_manager_label(Some("   ".into())), None);
        assert_eq!(
            clean_manager_label(Some("  Acme  ".into())).as_deref(),
            Some("Acme")
        );
        let long = "é".repeat(200);
        assert_eq!(clean_manager_label(Some(long)).unwrap().chars().count(), 80);
    }
}
