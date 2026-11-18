//! Shared, transport-independent production of authenticated storage receipts.
use super::protocol::{
    StorageReceipt, StorageReceiptReplica, StorageReceiptRequest, STORAGE_RECEIPT_BARRIER,
};
use crate::{agents::ForAgent, errors::AtomicResult, loro::AtomicLoroDoc, Db, Resource, Subject};

/// Read only locally stored, applied CRDT state. Generic `get_resource` may
/// fetch an unknown HTTP subject, including after a separate existence check.
/// Missing rows, snapshots, or applied state cannot support receipt evidence.
pub(crate) fn stored_resource(db: &Db, subject: &Subject) -> AtomicResult<Option<Resource>> {
    let Ok(mut resource) = db.get_resource_shallow(subject) else {
        return Ok(None);
    };
    let Some(snapshot) = db.get_loro_snapshot(subject) else {
        return Ok(None);
    };
    let doc = AtomicLoroDoc::from_snapshot(&snapshot)?;
    if doc.doc().state_vv().is_empty() {
        return Ok(None);
    }
    let lenses = db.lenses();
    let lenses = (!lenses.is_empty()).then_some(&*lenses);
    resource.apply_state_doc_with_lenses(doc, snapshot, lenses)?;
    Ok(Some(resource))
}

fn in_drive(resource: &Resource, drive: &str) -> bool {
    let drive = crate::identifiers::canonicalize_scheme(drive);
    crate::identifiers::canonicalize_scheme(&resource.get_subject().pure_id()) == drive
        || resource
            .get(crate::urls::DRIVE_PROP)
            .is_ok_and(|value| crate::identifiers::canonicalize_scheme(&value.to_string()) == drive)
}

/// Certify only a requested frontier already covered by the resource's applied
/// state. Memory backends, pending dependency bytes, missing/deleted resources,
/// and open batch overlays cannot yield a receipt. Transport authentication and
/// exact pending-request correlation remain the session's responsibility.
pub async fn produce_receipt(
    db: &Db,
    agent: &ForAgent,
    bound_drive: &str,
    request: &StorageReceiptRequest,
) -> AtomicResult<Option<StorageReceipt>> {
    if matches!(agent, ForAgent::Public) {
        return Err("Peer AUTH required".into());
    }
    if !request.validate() {
        return Err("Invalid storage receipt request".into());
    }
    if request.drive != bound_drive {
        return Err("Wrong receipt drive".into());
    }
    let target = request.frontier().ok_or("Invalid receipt frontier")?;
    let subject = crate::Subject::from(request.subject.as_str()).pure_id();
    let _guard = db.subject_locks.lock(&subject).await;
    if super::tombstones::is_tombstoned(db, &subject) {
        return Ok(None);
    }
    let Some(resource) = stored_resource(db, &subject.as_str().into())? else {
        return Ok(None);
    };
    if !in_drive(&resource, bound_drive) {
        return Err("Receipt subject outside session drive".into());
    }
    crate::hierarchy::check_read(db, &resource, agent).await?;
    let covers = || -> AtomicResult<bool> {
        let Some(snapshot) = db.get_loro_snapshot_bytes(&subject) else {
            return Ok(false);
        };
        let doc = AtomicLoroDoc::from_snapshot(&snapshot)?;
        Ok(doc.doc().state_vv().includes_vv(&target))
    };
    if !covers()? {
        return Ok(None);
    }
    // Identity lookup refuses read-your-writes batches: flushing must not
    // implicitly commit another writer's still-open overlay.
    let Some(identity) = db.kv.replica_identity(bound_drive)? else {
        return Ok(None);
    };
    db.flush()?;
    if !covers()? || db.kv.replica_identity(bound_drive)? != Some(identity.clone()) {
        return Ok(None);
    }
    // Parent ACLs can change independently of this subject's lock.
    crate::hierarchy::check_read(db, &resource, agent).await?;
    let receipt = StorageReceipt {
        nonce: request.nonce.clone(),
        drive: request.drive.clone(),
        subject: request.subject.clone(),
        version: request.version.clone(),
        replica: StorageReceiptReplica {
            storage_id: identity.storage_id,
            generation: identity.generation,
        },
        barrier: STORAGE_RECEIPT_BARRIER.to_owned(),
    };
    if !receipt.validate() {
        return Err("Invalid storage receipt identity".into());
    }
    Ok(Some(receipt))
}
