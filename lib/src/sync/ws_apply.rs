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

/// Import a remote UPDATE frame into the local store.
pub async fn apply_state_update(store: &Db, subject: &str, state_bytes: &[u8]) -> AtomicResult<()> {
    if state_bytes.is_empty() {
        return Ok(());
    }

    set_importing(true);
    let result = apply_state_update_inner(store, subject, state_bytes).await;
    set_importing(false);
    result
}

async fn apply_state_update_inner(
    store: &Db,
    subject: &str,
    state_bytes: &[u8],
) -> AtomicResult<()> {
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
            Err(_) => match crate::loro::AtomicLoroDoc::from_snapshot(state_bytes) {
                Ok(d) => d,
                Err(_) => return Ok(()),
            },
        }
    } else {
        match crate::loro::AtomicLoroDoc::from_snapshot(state_bytes) {
            Ok(d) => d,
            Err(_) => {
                let d = crate::loro::AtomicLoroDoc::new();
                if d.import_update(state_bytes).is_err() {
                    return Ok(());
                }
                d
            }
        }
    };

    let snapshot = doc.export_snapshot();
    let _ = store.kv.insert(
        crate::db::trees::Tree::LoroSnapshots,
        snapshot_key.as_bytes(),
        &snapshot,
    );

    let subj = crate::Subject::from_raw(subject, store.get_base_domain().as_deref());
    let mut resource = store
        .get_resource(&subj)
        .await
        .unwrap_or_else(|_| crate::Resource::new(subject.to_string()));

    if resource.apply_state_doc(doc).is_ok() {
        let _ = store.add_resource_opts(&resource, false, true, true).await;
    }

    Ok(())
}

/// Remove a resource from the local store (DESTROY frame).
pub async fn apply_destroy(store: &Db, subject: &str) -> AtomicResult<()> {
    if subject.is_empty() {
        return Ok(());
    }

    set_importing(true);
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
    set_importing(false);
    tracing::info!("[ws_apply] deleted {}", &subject[..subject.len().min(20)]);
    Ok(())
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
