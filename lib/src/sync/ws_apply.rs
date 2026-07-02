//! Apply WebSocket v2 frames (UPDATE, DESTROY, COMMIT) to a local [`Db`].
//! UPDATE payloads carry opaque versioned state bytes (CRDT snapshot/delta).
//!
//! Shared by Iroh live sync (`peer.rs`) and native WS sync sessions.

use std::sync::atomic::{AtomicBool, Ordering};

use crate::{
    commit::{Commit, CommitOpts},
    db::Db,
    errors::AtomicResult,
    parse::parse_json_ad_commit_resource,
    Storelike,
};

static IMPORTING: AtomicBool = AtomicBool::new(false);

/// True while applying remote data (suppresses live-sync echo).
pub fn is_importing() -> bool {
    IMPORTING.load(Ordering::Relaxed)
}

fn set_importing(v: bool) {
    IMPORTING.store(v, Ordering::Relaxed);
}

/// Import a remote UPDATE frame into the local store. Trusted callers only —
/// merges and persists unconditionally, with no admission check. Live-sync
/// transports that receive data from a peer whose write rights aren't already
/// established (i.e. Iroh's live loop) must use [`resolve_update`] +
/// [`persist_update`] instead, so a check can run before anything is written.
pub async fn apply_state_update(store: &Db, subject: &str, state_bytes: &[u8]) -> AtomicResult<()> {
    set_importing(true);
    let result = async {
        if let Some(resolved) = resolve_update(store, subject, state_bytes).await {
            persist_update(store, subject, resolved).await?;
        }
        Ok(())
    }
    .await;
    set_importing(false);
    result
}

/// A merged-in-memory UPDATE, not yet persisted. Lets the caller resolve the
/// target drive and run an admission check before any bytes are written.
pub struct ResolvedUpdate {
    snapshot: Vec<u8>,
    resource: crate::Resource,
    pub drive_subject: String,
}

/// Merge `state_bytes` into the subject's existing (or a fresh) Loro doc and
/// materialize the resulting resource — entirely in memory, no persistence.
/// Returns `None` when there's nothing meaningful to apply: an empty payload,
/// bytes that don't decode against either an existing or a fresh doc, or a
/// merged doc that fails to materialize into resource propvals. The last case
/// is a deliberate tightening vs. the old unconditional-persist behavior: if
/// we can't derive a resource (and therefore can't resolve its drive), we
/// can't run an admission check, so we don't persist — fail closed, not open.
pub async fn resolve_update(store: &Db, subject: &str, state_bytes: &[u8]) -> Option<ResolvedUpdate> {
    if state_bytes.is_empty() {
        return None;
    }

    let snapshot_key =
        crate::Subject::from_raw(subject, store.get_base_domain().as_deref()).pure_id();
    let doc = if let Ok(Some(existing)) = store.kv.get(
        crate::db::trees::Tree::LoroSnapshots,
        snapshot_key.as_bytes(),
    ) {
        match crate::loro::AtomicLoroDoc::from_snapshot(&existing) {
            Ok(d) => {
                if let Err(e) = d.import_update(state_bytes) {
                    tracing::warn!(
                        "[ws_apply] import_update failed for {}: {e}",
                        &subject[..subject.len().min(20)]
                    );
                }
                d
            }
            Err(_) => crate::loro::AtomicLoroDoc::from_snapshot(state_bytes).ok()?,
        }
    } else {
        match crate::loro::AtomicLoroDoc::from_snapshot(state_bytes) {
            Ok(d) => d,
            Err(_) => {
                let d = crate::loro::AtomicLoroDoc::new();
                if d.import_update(state_bytes).is_err() {
                    return None;
                }
                d
            }
        }
    };

    // export_snapshot only borrows, so we can still move `doc` into
    // apply_state_doc afterwards.
    let snapshot = doc.export_snapshot();

    let subj = crate::Subject::from_raw(subject, store.get_base_domain().as_deref());
    // Base off any existing stored resource (same as the pre-refactor
    // fetch-then-apply order), so its existing propvals — notably a
    // previously-stamped `drive` — are preserved when the incoming delta
    // doesn't re-assert them.
    let mut resource = store
        .get_resource(&subj)
        .await
        .unwrap_or_else(|_| crate::Resource::new(subject.to_string()));
    if resource.apply_state_doc(doc).is_err() {
        return None;
    }

    let drive_subject = resource
        .get(crate::urls::DRIVE_PROP)
        .map(|v| v.to_string())
        .unwrap_or_else(|_| resource.get_subject().to_string());

    Some(ResolvedUpdate {
        snapshot,
        resource,
        drive_subject,
    })
}

/// Persist a previously [`resolve_update`]d write. Call only after an
/// admission check on `resolved.drive_subject` has passed.
pub async fn persist_update(
    store: &Db,
    subject: &str,
    resolved: ResolvedUpdate,
) -> AtomicResult<()> {
    let snapshot_key =
        crate::Subject::from_raw(subject, store.get_base_domain().as_deref()).pure_id();
    let _ = store.kv.insert(
        crate::db::trees::Tree::LoroSnapshots,
        snapshot_key.as_bytes(),
        &resolved.snapshot,
    );
    let _ = store
        .add_resource_opts(&resolved.resource, false, true, true)
        .await;
    Ok(())
}

/// Remove a resource from the local store (DESTROY frame). Trusted callers
/// only — no admission check. Live-sync transports that receive DESTROY from
/// a peer whose write rights aren't already established must use
/// [`resolve_destroy`] instead, so a check can run before deleting anything.
pub async fn apply_destroy(store: &Db, subject: &str) -> AtomicResult<()> {
    if subject.is_empty() {
        return Ok(());
    }

    set_importing(true);
    let result = apply_destroy_unchecked(store, subject).await;
    set_importing(false);
    result
}

async fn apply_destroy_unchecked(store: &Db, subject: &str) -> AtomicResult<()> {
    let subj = crate::Subject::from_raw(subject, store.get_base_domain().as_deref());
    // `remove_resource` deletes the resource, its Loro snapshot (keyed by
    // `pure_id()`) and records a tombstone. The previous explicit
    // `kv.remove(LoroSnapshots, subject.as_bytes())` here was mis-keyed by the
    // raw subject and missed snapshots for `?drive=`-suffixed subjects.
    let _ = store.remove_resource(&subj).await;
    // Tombstone again unconditionally: a DESTROY for a subject we never
    // stored makes `remove_resource` error out before it records one, and we
    // still must not resurrect it on the next bulk sync. `record_tombstone`
    // is idempotent.
    crate::sync::tombstones::record_tombstone(store, subject);
    tracing::info!("[ws_apply] deleted {}", &subject[..subject.len().min(20)]);
    Ok(())
}

/// The drive an existing resource belongs to, resolved for an admission check
/// before a DESTROY is applied. `None` when the resource doesn't exist
/// locally — there's nothing to check rights against, and applying the
/// tombstone for a subject we never stored is already a harmless no-op (see
/// [`apply_destroy`]), so callers should apply it unconditionally in that case.
pub async fn resolve_destroy_drive(store: &Db, subject: &str) -> Option<String> {
    let subj = crate::Subject::from_raw(subject, store.get_base_domain().as_deref());
    let resource = store.get_resource(&subj).await.ok()?;
    Some(
        resource
            .get(crate::urls::DRIVE_PROP)
            .map(|v| v.to_string())
            .unwrap_or_else(|_| resource.get_subject().to_string()),
    )
}

/// Apply a DESTROY after the caller has already run its own admission check
/// (or determined via [`resolve_destroy_drive`] returning `None` that there's
/// nothing to check).
pub async fn apply_destroy_checked(store: &Db, subject: &str) -> AtomicResult<()> {
    if subject.is_empty() {
        return Ok(());
    }
    set_importing(true);
    let result = apply_destroy_unchecked(store, subject).await;
    set_importing(false);
    result
}

/// Apply a JSON-AD commit received over WS (legacy text `COMMIT` or after fetch).
pub async fn apply_commit_json(store: &Db, body: &str) -> AtomicResult<()> {
    set_importing(true);
    let result = async {
        let resource = parse_json_ad_commit_resource(body, store).await?;
        let commit = Commit::from_resource(resource)?;
        let opts = CommitOpts {
            validate_signature: true,
            validate_timestamp: false,
            validate_previous_commit: false,
            validate_rights: false,
            update_index: true,
            ..CommitOpts::no_validations_no_index()
        };
        store.apply_commit(commit, &opts).await?;
        Ok::<(), crate::AtomicError>(())
    }
    .await;
    set_importing(false);
    result
}
