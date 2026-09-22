//! Apply WebSocket v2 frames (UPDATE, DESTROY, COMMIT) to a local [`Db`].
//! UPDATE payloads carry opaque versioned state bytes (CRDT snapshot/delta).
//!
//! Shared by Iroh live sync (`peer.rs`) and native WS sync sessions.

use std::future::Future;

use crate::{db::Db, errors::AtomicResult, Storelike};

/// What an import in progress knows about where its data came from.
#[derive(Clone, Debug, Default)]
struct ImportScope {
    /// The peer the data arrived from, when the transport can name one.
    source: Option<String>,
}

tokio::task_local! {
    /// The import the current task is applying, if any.
    ///
    /// A task-local rather than a process-wide flag (security audit C16):
    /// every peer connection runs its own read loop, and with one global
    /// `AtomicBool` the first connection to finish cleared the flag while a
    /// second was still mid-import, and one connection's peer id was stamped
    /// on writes made for another. The scope now travels with the task that
    /// does the import, so concurrent connections cannot observe each other.
    static IMPORT_SCOPE: ImportScope;
}

/// Run `f` as an import from `source` (the peer id, when the transport knows
/// one). Inside it, [`is_importing`] is true and [`current_import_source`]
/// returns `source`, for this task only.
///
/// The write that emits `DbEvent::Changed` reads the source synchronously,
/// while the import is still on the stack, so the event carries the peer it
/// came from. That is what makes echo suppression deterministic: a flag the
/// live push loop checks when it eventually processes the event cannot work,
/// because the push loop is a separate task consuming a broadcast channel and
/// may not be scheduled until after the import has finished. Two idle nodes
/// then trade the same snapshot forever (see `peer.rs`'s live read loop).
pub async fn import_scope<F: Future>(source: Option<String>, f: F) -> F::Output {
    IMPORT_SCOPE.scope(ImportScope { source }, f).await
}

/// True while the current task is applying remote data (see [`import_scope`]).
pub fn is_importing() -> bool {
    IMPORT_SCOPE.try_with(|_| ()).is_ok()
}

/// The peer id to attribute a write made by the current task to, for echo
/// suppression. `None` outside an import, or inside one from a transport
/// that names no peer.
pub fn current_import_source() -> Option<String> {
    IMPORT_SCOPE.try_with(|s| s.source.clone()).ok().flatten()
}

/// Import a remote UPDATE frame into the local store. Trusted callers only —
/// merges and persists unconditionally, with no admission check. Live-sync
/// transports that receive data from a peer whose write rights aren't already
/// established (i.e. Iroh's live loop) must use [`resolve_update`] +
/// [`persist_update`] instead, so a check can run before anything is written.
pub async fn apply_state_update(store: &Db, subject: &str, state_bytes: &[u8]) -> AtomicResult<()> {
    import_scope(None, async {
        if let Some(resolved) = resolve_update(store, subject, state_bytes).await {
            persist_update(store, subject, resolved).await?;
        }
        Ok(())
    })
    .await
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
pub async fn resolve_update(
    store: &Db,
    subject: &str,
    state_bytes: &[u8],
) -> Option<ResolvedUpdate> {
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
    let existing = store.get_resource(&subj).await.ok();

    // The authoritative drive_subject MUST NOT be read from the resource
    // after merging the incoming delta — `DRIVE_PROP` is an ordinary,
    // last-write-wins property like any other, so a malicious peer could
    // assert it in their payload to make an existing, protected resource get
    // checked against a drive of their choosing (their own, or one that
    // doesn't exist locally to hit the bootstrap carve-out), bypassing the
    // real drive's admission/ACL entirely. Same class of bug as the
    // IS_A: [Agent] spoof fixed in commit.rs (`7ae8bcc1`).
    // For a new subject, leave the drive unset here: resolve via PARENT below,
    // rather than trusting a directly asserted DRIVE_PROP on the payload.
    // Admission/ACL checks still apply to the resolved drive; without a locally
    // resolving parent, the subject itself is treated as the drive root.
    let drive_subject = existing.as_ref().map(|existing| {
        // Existing subject: its already-stored drive is authoritative,
        // captured BEFORE the incoming delta is merged. Never re-derived
        // from post-merge state.
        existing
            .get(crate::urls::DRIVE_PROP)
            .map(|v| v.to_string())
            .unwrap_or_else(|_| existing.get_subject().to_string())
    });

    let mut resource = existing.unwrap_or_else(|| crate::Resource::new(subject.to_string()));
    if resource.apply_state_doc(doc).is_err() {
        return None;
    }

    let drive_subject = match drive_subject {
        Some(d) => d,
        None => {
            // Genuinely new subjects must not trust a directly-asserted
            // DRIVE_PROP in the payload. Resolve through PARENT instead
            // (mirrors commit.rs's safety net). A lied-about PARENT cannot
            // escalate: admission and ACLs then check the claimed drive, and
            // an attacker gains nothing by pointing at a drive they do not
            // control. No parent (or no local parent) makes this a drive root,
            // so it falls back to its own subject.
            let mut resolved = resource.get_subject().to_string();
            if let Ok(parent_val) = resource.get(crate::urls::PARENT) {
                let parent_subject = crate::Subject::from(parent_val.to_string());
                if let Ok(parent_res) = store.get_resource(&parent_subject).await {
                    resolved = parent_res
                        .get(crate::urls::DRIVE_PROP)
                        .map(|v| v.to_string())
                        .unwrap_or_else(|_| parent_subject.to_string());
                }
            }
            resolved
        }
    };

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

    // Exclusive for the same reason `apply_commit` is: persistence replaces
    // the stored snapshot, so a concurrent commit must not be clobbered.
    let _subject_guard = store.subject_locks.lock(&snapshot_key).await;

    // `resolved` was built from a read taken before the lock, so re-merge it
    // into whatever is stored *now*. Safe to do here — unlike a commit, a sync
    // apply only ever adds a peer's operations, so union is the correct
    // outcome. Re-importing already-known operations is a Loro no-op.
    let doc = match store.kv.get(
        crate::db::trees::Tree::LoroSnapshots,
        snapshot_key.as_bytes(),
    )? {
        Some(current) => {
            let doc = crate::loro::AtomicLoroDoc::from_snapshot(&current)?;
            doc.import_update(&resolved.snapshot)?;
            doc
        }
        None => crate::loro::AtomicLoroDoc::from_snapshot(&resolved.snapshot)?,
    };
    let mut resource = resolved.resource;
    resource.apply_state_doc(doc)?;
    // Projection, indexes and snapshot must commit together. Do not acknowledge
    // a snapshot whose searchable resource failed to persist.
    store.persist_replicated_resource(&resource).await
}

/// Remove a resource from the local store (a `DESTROY` frame or a
/// `SYNC_DIFF.remove[]` entry). No admission check runs here: the caller
/// either trusts the source (a mobile replica applying what its hub relayed)
/// or has already run one — the peer transport resolves the drive with
/// [`resolve_destroy_drive`] and checks admission before calling this. Until
/// 2026-09 those two callers went through two identically-bodied functions
/// (`apply_destroy` and `apply_destroy_checked`) that differed in name only.
pub async fn apply_destroy(store: &Db, subject: &str) -> AtomicResult<()> {
    if subject.is_empty() {
        return Ok(());
    }

    import_scope(None, apply_destroy_unchecked(store, subject)).await
}

async fn apply_destroy_unchecked(store: &Db, subject: &str) -> AtomicResult<()> {
    let subj = crate::Subject::from_raw(subject, store.get_base_domain().as_deref());

    // F10 (planning/unified-sync.md): checked BEFORE calling `remove_resource`,
    // and independently of its result. The previous `existed =
    // remove_resource(..).is_ok()` conflated "never existed" with "existed,
    // but the delete transaction failed" (e.g. a transient KV error) — both
    // read as `existed == false`, so a real, still-present resource whose
    // deletion merely failed would be misclassified as unknown and skip its
    // tombstone, leaving it able to resurrect on the next bulk sync.
    let existed = store.get_resource(&subj).await.is_ok();

    // A bulk-sync `SYNC_DIFF.remove[]` entry is peer-supplied; the admission
    // check upstream is per drive, so nothing verified the sender had any
    // relationship to this particular subject. Recording a tombstone for a subject this node has NEVER
    // heard of (never stored, never already tombstoned) isn't a "harmless
    // no-op": it permanently poisons that subject name against future
    // legitimate creation/import (`import_sync_push` and friends skip
    // anything `is_tombstoned`) for a deletion that never happened here. Only
    // record one for a subject we actually have prior history with — either
    // we just deleted it (`existed`) or we already knew about it (a previous,
    // presumably legitimate, tombstone). `record_tombstone` is idempotent, so
    // re-recording an existing tombstone is harmless.
    if !existed && !crate::sync::tombstones::is_tombstoned(store, subject) {
        tracing::warn!(
            "[ws_apply] ignoring DESTROY for locally-unknown subject {} (F10: not recording a phantom tombstone)",
            &subject[..subject.len().min(20)]
        );

        return Ok(());
    }

    // `remove_resource` deletes the resource, its Loro snapshot (keyed by
    // `pure_id()`) and records a tombstone for it and any cascade-deleted
    // children. Best-effort here: even if it errors (e.g. a racing delete
    // already removed it), we still (re-)record the tombstone below so a
    // known-and-tombstoned subject can't lose that protection just because
    // the removal call itself failed.
    let _ = store.remove_resource(&subj).await;

    crate::sync::tombstones::record_tombstone(store, subject);
    tracing::info!("[ws_apply] deleted {}", &subject[..subject.len().min(20)]);
    Ok(())
}

/// The drive an existing resource belongs to, resolved for an admission check
/// before a DESTROY is applied. `None` when the resource doesn't exist
/// locally — there's nothing to check rights against, and (since F10)
/// applying the tombstone for a subject we never stored is now a real no-op
/// (see [`apply_destroy`]), so callers should apply it unconditionally in
/// that case.
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

#[cfg(test)]
mod resolve_update_drive_spoof_tests {
    use super::*;
    use crate::loro::AtomicLoroDoc;
    use crate::values::Value;

    /// Regression coverage for F2 (planning/unified-sync.md): `resolve_update`
    /// used to read `drive_subject` from the resource AFTER merging the
    /// incoming delta, so a malicious peer could assert `DRIVE_PROP` in their
    /// payload and get an EXISTING, protected resource checked against a
    /// drive of their choosing instead of its real one.
    #[tokio::test]
    async fn existing_resource_ignores_spoofed_drive_in_payload() {
        let db = Db::init_temp("resolve_update_spoof_existing")
            .await
            .unwrap();
        let (_alice, real_drive) = db.setup("Alice").await.unwrap();

        let doc_subject = db
            .create_resource(
                "https://atomicdata.dev/classes/Folder",
                &real_drive,
                "Alice's doc",
                None,
            )
            .await
            .unwrap();

        // Sanity: the resource really did get stamped with the real drive.
        let stored = db.get_resource(&doc_subject.as_str().into()).await.unwrap();
        assert_eq!(
            stored.get(crate::urls::DRIVE_PROP).unwrap().to_string(),
            real_drive
        );

        // Attacker's payload: NOT a fresh, unrelated doc (Loro won't merge
        // properties from an unrelated op history into the resource's real
        // container) — a continuing delta built from the resource's ACTUAL
        // current snapshot, exactly what a peer already synced to this
        // resource (a real attack precondition) would legitimately have.
        let snapshot_key =
            crate::Subject::from_raw(&doc_subject, db.get_base_domain().as_deref()).pure_id();
        let real_snapshot = db
            .kv
            .get(
                crate::db::trees::Tree::LoroSnapshots,
                snapshot_key.as_bytes(),
            )
            .unwrap()
            .expect("resource should have a stored Loro snapshot");
        let spoofed_drive = "https://attacker.example/not-your-drive";
        let malicious = AtomicLoroDoc::from_snapshot(&real_snapshot).unwrap();
        malicious
            .set_property(
                crate::urls::DRIVE_PROP,
                &Value::AtomicUrl(spoofed_drive.to_string().into()),
            )
            .unwrap();
        let malicious_bytes = malicious.export_snapshot();

        let resolved = resolve_update(&db, &doc_subject, &malicious_bytes)
            .await
            .expect("a well-formed snapshot should still resolve");

        assert_eq!(
            resolved.drive_subject, real_drive,
            "the existing resource's real drive must win over a spoofed payload assertion"
        );
        assert_ne!(resolved.drive_subject, spoofed_drive);
    }

    /// Companion: a genuinely new subject with no local parent resolves to
    /// its own subject (drive-root fallback) rather than trusting a directly
    /// asserted DRIVE_PROP with no supporting PARENT.
    #[tokio::test]
    async fn new_subject_with_no_resolvable_parent_falls_back_to_own_subject() {
        let db = Db::init_temp("resolve_update_new_subject_no_parent")
            .await
            .unwrap();
        let _ = db.setup("Alice").await.unwrap();

        let new_subject = "https://example.test/brand-new-resource";
        let spoofed_drive = "https://attacker.example/not-your-drive";
        let malicious = AtomicLoroDoc::new();
        malicious
            .set_property(
                crate::urls::DRIVE_PROP,
                &Value::AtomicUrl(spoofed_drive.to_string().into()),
            )
            .unwrap();
        let malicious_bytes = malicious.export_snapshot();

        let resolved = resolve_update(&db, new_subject, &malicious_bytes)
            .await
            .expect("a well-formed snapshot should still resolve");

        assert_eq!(
            resolved.drive_subject, new_subject,
            "no parent to borrow a drive from — must fall back to its own subject, not the payload's claimed drive"
        );
        assert_ne!(resolved.drive_subject, spoofed_drive);
    }
}

#[cfg(test)]
mod destroy_phantom_tombstone_tests {
    use super::*;
    use crate::sync::tombstones;

    /// F10 (planning/unified-sync.md): a DESTROY for a subject this node has
    /// never heard of must NOT record a tombstone — otherwise a single
    /// unauthenticated bulk-sync `SYNC_DIFF.remove[]` entry for an arbitrary,
    /// never-locally-known subject permanently poisons that subject name
    /// against future legitimate creation/import.
    #[tokio::test]
    async fn destroy_of_unknown_subject_does_not_record_tombstone() {
        let db = Db::init_temp("ws_apply_f10_unknown_subject").await.unwrap();
        let _ = db.setup("Alice").await.unwrap();

        let unknown_subject = "https://example.test/never-existed-here";
        assert!(!tombstones::is_tombstoned(&db, unknown_subject));

        apply_destroy(&db, unknown_subject).await.unwrap();

        assert!(
            !tombstones::is_tombstoned(&db, unknown_subject),
            "F10: DESTROY for a locally-unknown subject must not record a phantom tombstone"
        );
    }

    /// Companion: a DESTROY for a subject we actually had (and just deleted)
    /// still correctly records a tombstone — F10 only tightens the
    /// never-seen-it-before case, it must not break legitimate deletions.
    #[tokio::test]
    async fn destroy_of_known_subject_still_records_tombstone() {
        let db = Db::init_temp("ws_apply_f10_known_subject").await.unwrap();
        let (_alice, drive) = db.setup("Alice").await.unwrap();

        let subject = db
            .create_resource(
                "https://atomicdata.dev/classes/Folder",
                &drive,
                "Alice's doc",
                None,
            )
            .await
            .unwrap();

        apply_destroy(&db, &subject).await.unwrap();

        assert!(
            tombstones::is_tombstoned(&db, &subject),
            "a DESTROY for a subject we actually knew about must still record a tombstone"
        );
    }

    /// Companion: a DESTROY for a subject that's ALREADY tombstoned (e.g. a
    /// duplicate/retried remove entry) is idempotent — the tombstone stays.
    #[tokio::test]
    async fn destroy_of_already_tombstoned_subject_stays_tombstoned() {
        let db = Db::init_temp("ws_apply_f10_already_tombstoned")
            .await
            .unwrap();
        let _ = db.setup("Alice").await.unwrap();

        let subject = "https://example.test/already-gone";
        tombstones::record_tombstone(&db, subject);
        assert!(tombstones::is_tombstoned(&db, subject));

        apply_destroy(&db, subject).await.unwrap();

        assert!(tombstones::is_tombstoned(&db, subject));
    }
}

#[cfg(test)]
mod import_scope_tests {
    use super::*;
    use crate::loro::AtomicLoroDoc;
    use crate::values::Value;

    /// Security audit C16: the import flag and the import source were
    /// process-global, so two peer connections importing at the same time
    /// observed each other: the first to finish cleared the flag for the
    /// second, and a write made for peer A could be stamped with peer B's id.
    /// The scope is per task now; two imports that interleave at every await
    /// each see only their own source, and the task outside sees none.
    #[tokio::test]
    async fn concurrent_imports_do_not_observe_each_other() {
        async fn import_from(peer: &str) -> Vec<Option<String>> {
            import_scope(Some(peer.to_string()), async move {
                let mut seen = Vec::new();
                for _ in 0..8 {
                    // Hand control to the other import between reads, so the
                    // reads below are taken while the other task is mid-import.
                    tokio::task::yield_now().await;
                    assert!(is_importing(), "inside the scope of {peer}");
                    seen.push(current_import_source());
                }
                seen
            })
            .await
        }

        assert!(!is_importing(), "no import is running in this task");
        assert_eq!(current_import_source(), None);

        let a = tokio::spawn(import_from("peer-a"));
        let b = tokio::spawn(import_from("peer-b"));
        let (a, b) = (a.await.unwrap(), b.await.unwrap());

        assert!(a.iter().all(|s| s.as_deref() == Some("peer-a")), "{a:?}");
        assert!(b.iter().all(|s| s.as_deref() == Some("peer-b")), "{b:?}");
        assert!(
            !is_importing(),
            "finishing an import leaves this task alone"
        );
        assert_eq!(current_import_source(), None);
    }

    /// The scope reaches the write: two interleaved imports of two subjects
    /// each emit a `DbEvent::Changed` attributed to their own peer, which is
    /// what the live push loop uses to skip exactly the peer an update came
    /// from.
    #[tokio::test]
    async fn concurrent_imports_stamp_their_own_source_on_the_event() {
        let db = Db::init_temp("import_scope_two_peers").await.unwrap();
        let (_alice, drive) = db.setup("Alice").await.unwrap();
        let mut events = db.subscribe_events();

        let mut imports = Vec::new();
        for (peer, subject) in [
            ("peer-a", "did:ad:import-scope-a"),
            ("peer-b", "did:ad:import-scope-b"),
        ] {
            let doc = AtomicLoroDoc::new();
            doc.set_property(crate::urls::PARENT, &Value::AtomicUrl(drive.clone().into()))
                .unwrap();
            doc.set_property(crate::urls::NAME, &Value::String(format!("from {peer}")))
                .unwrap();
            let bytes = doc.export_snapshot();
            let db = db.clone();
            imports.push(tokio::spawn(import_scope(
                Some(peer.to_string()),
                async move {
                    tokio::task::yield_now().await;
                    let resolved = resolve_update(&db, subject, &bytes).await.unwrap();
                    tokio::task::yield_now().await;
                    persist_update(&db, subject, resolved).await.unwrap();
                },
            )));
        }
        for import in imports {
            import.await.unwrap();
        }

        let mut attributed = std::collections::HashMap::new();
        while let Ok(event) = events.try_recv() {
            if let crate::DbEvent::Changed {
                subject, source_id, ..
            } = event
            {
                attributed.insert(subject.pure_id(), source_id);
            }
        }
        assert_eq!(
            attributed.get("did:ad:import-scope-a"),
            Some(&Some("peer-a".to_string()))
        );
        assert_eq!(
            attributed.get("did:ad:import-scope-b"),
            Some(&Some("peer-b".to_string()))
        );
    }
}
