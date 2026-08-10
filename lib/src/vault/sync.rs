//! Backup and restore — Phase 1 of
//! `atomic-saas/planning/CLOUD_VAULT_ARCHITECTURE.md`.
//!
//! `export_vault_delta` walks a drive, exports each resource's Loro history as
//! an *update*, packs them, and seals the pack. `import_vault_batch` opens
//! packs and merges them into a `Db`.
//!
//! Restore is order-independent and idempotent, and that is a property of Loro
//! rather than of this code: ops are deduplicated by `(peerId, counter)`, so
//! importing the same pack twice, or importing lanes from several devices in
//! any order, converges on the same state. That is what makes per-device lanes
//! safe without a shared manifest or compare-and-swap.

use super::dek::DriveVaultKey;
use super::envelope::{self, ObjectKind};
use super::pack::{Pack, PackEntry};
use super::store::VaultObjectStore;
use crate::db::Db;
use crate::errors::AtomicResult;
use crate::resources::Resource;
use crate::storelike::Storelike;
use crate::Subject;

/// Local record of what a lane's last pack contained.
///
/// Not uploaded and not part of the format — purely this device's memory of
/// what it has already backed up. It exists so a deletion can be *detected*:
/// a subject that was in the last pack and is gone from this walk was removed,
/// and a backup that cannot express that would restore data its owner deleted.
///
/// This is also the seed of the Phase 2 incremental cursor. When per-resource
/// version vectors land they live in the same place, for the same reason —
/// `CLOUD_VAULT_ARCHITECTURE.md` decision 2: incremental cursors live in each
/// device's local Db, never in shared metadata.
fn lane_state_key(drive_pseudonym: &str, device_pubkey: &str) -> Vec<u8> {
    format!("vault-lane:{drive_pseudonym}:{device_pubkey}").into_bytes()
}

/// Where a not-yet-uploaded export parks its subject list.
///
/// Sealing and *storing* are two steps for a hosted vault: the client seals
/// locally and something else pushes the bytes at object storage afterwards.
/// Recording the lane as backed up at seal time would mean a failed upload
/// still advanced the bookkeeping, and the next pass would compute deletions
/// against a segment that does not exist in the vault. So the export writes
/// here, and [`commit_lane_state`] promotes it once the upload is confirmed.
fn pending_lane_state_key(drive_pseudonym: &str, device_pubkey: &str, segment: u32) -> Vec<u8> {
    format!("vault-lane-pending:{drive_pseudonym}:{device_pubkey}:{segment}").into_bytes()
}

fn read_lane_state(store: &Db, drive_pseudonym: &str, device_pubkey: &str) -> Vec<String> {
    store
        .kv
        .get(
            crate::db::trees::Tree::PluginMeta,
            &lane_state_key(drive_pseudonym, device_pubkey),
        )
        .ok()
        .flatten()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

fn write_lane_state(store: &Db, drive_pseudonym: &str, device_pubkey: &str, subjects: &[String]) {
    if let Ok(bytes) = serde_json::to_vec(subjects) {
        let _ = store.kv.insert(
            crate::db::trees::Tree::PluginMeta,
            &lane_state_key(drive_pseudonym, device_pubkey),
            &bytes,
        );
    }
}

/// Promote a parked export to this lane's committed state.
///
/// Call once the segment is durably in the vault. Until then the previous
/// state stands, so a failed upload is retried against the same view of what
/// has been backed up rather than one that assumed success.
///
/// A no-op when nothing was parked for that segment, so a caller that
/// double-confirms does no harm.
pub fn commit_lane_state(
    store: &Db,
    drive_pseudonym: &str,
    device_pubkey: &str,
    segment: u32,
) -> AtomicResult<()> {
    let pending_key = pending_lane_state_key(drive_pseudonym, device_pubkey, segment);
    let Some(bytes) = store
        .kv
        .get(crate::db::trees::Tree::PluginMeta, &pending_key)
        .ok()
        .flatten()
    else {
        return Ok(());
    };

    let subjects: Vec<String> =
        serde_json::from_slice(&bytes).map_err(|e| format!("malformed pending lane state: {e}"))?;
    write_lane_state(store, drive_pseudonym, device_pubkey, &subjects);
    let _ = store
        .kv
        .remove(crate::db::trees::Tree::PluginMeta, &pending_key);
    Ok(())
}

/// Every object for a drive, across every device lane.
///
/// Restore must span lanes: each device appends only to its own, so importing
/// one lane's prefix would silently drop every other device's history.
pub fn drive_prefix(drive_pseudonym: &str) -> String {
    format!("vault/{drive_pseudonym}/")
}

/// Where a device's lane objects live for a drive.
pub fn lane_prefix(drive_pseudonym: &str, device_pubkey: &str) -> String {
    format!("vault/{drive_pseudonym}/lanes/{device_pubkey}/")
}

/// The object key for one segment of one device's lane.
///
/// Zero-padded to six digits so lexical ordering matches numeric ordering —
/// both S3 listing and the filesystem store sort lexically, and `seg-10` must
/// not sort before `seg-2`.
pub fn segment_key(drive_pseudonym: &str, device_pubkey: &str, segment: u32) -> String {
    format!(
        "{}seg-{segment:06}.pack",
        lane_prefix(drive_pseudonym, device_pubkey)
    )
}

/// Outcome of one backup pass.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BackupSummary {
    pub object_key: String,
    pub resources: usize,
    pub tombstones: usize,
    pub sealed_bytes: usize,
}

/// Outcome of one restore pass.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct RestoreSummary {
    pub packs_read: usize,
    pub resources_restored: usize,
    pub tombstones_applied: usize,
}

/// Export a drive's history into one sealed pack and write it to `vault`.
///
/// Every resource's full oplog is exported here. Incremental export against a
/// per-device cursor is Phase 2; the format does not change when it arrives,
/// because `export_updates_since` already produces updates rather than
/// snapshots — only the version vector passed to it does.
///
/// Returns `None` when the drive has nothing to back up, so callers can skip
/// uploading an empty object.
pub async fn export_vault_delta(
    store: &Db,
    drive: &Subject,
    key: &DriveVaultKey,
    vault: &dyn VaultObjectStore,
    drive_pseudonym: &str,
    device_pubkey: &str,
    segment: u32,
) -> AtomicResult<Option<BackupSummary>> {
    let subjects = crate::sync::engine::collect_drive_subjects(store, drive).await;

    let mut entries = Vec::new();
    for subject_str in &subjects {
        let subject = Subject::from_raw(subject_str, None);

        // A subject the drive walk found but the store cannot produce is not
        // fatal: the walk reads an index, and a resource deleted between the
        // two is an ordinary race rather than a corrupt drive.
        let Ok(resource) = store.get_resource(&subject).await else {
            continue;
        };

        let doc = resource.build_state_doc()?;
        // Against an empty version vector this is the full oplog — still a
        // stream of updates, not a snapshot.
        let update = doc.export_updates_since(&Default::default());
        if update.is_empty() {
            continue;
        }
        entries.push(PackEntry {
            subject: subject_str.clone(),
            update,
        });
    }

    // Stable order so two backups of an unchanged drive produce identical
    // plaintext. The sealed bytes still differ (fresh nonce per seal), but a
    // deterministic plaintext keeps the format debuggable and makes a
    // content-addressed layer possible later.
    entries.sort_by(|a, b| a.subject.cmp(&b.subject));

    // Anything this lane backed up before and cannot see now was deleted.
    // Without this the deletion is simply absent from the vault: the resource
    // still lives in an earlier segment's pack, and a restore brings it back.
    // Restoring data its owner deleted is the one failure a backup must not
    // have.
    //
    // Only subjects with a local tombstone are claimed. A subject that merely
    // vanished from the walk could be a transient read failure or an
    // authorization change, and a tombstone we invent would *delete real data*
    // on restore — far worse than carrying a stale resource for another cycle.
    let present: std::collections::HashSet<&String> = entries.iter().map(|e| &e.subject).collect();
    let tombstones: Vec<String> = read_lane_state(store, drive_pseudonym, device_pubkey)
        .into_iter()
        .filter(|subject| {
            !present.contains(subject) && crate::sync::tombstones::is_tombstoned(store, subject)
        })
        .collect();

    let exported: Vec<String> = entries.iter().map(|e| e.subject.clone()).collect();

    let pack = Pack::new(entries, tombstones);
    if pack.is_empty() {
        return Ok(None);
    }

    let resources = pack.entries.len();
    let tombstones = pack.tombstones.len();
    let sealed = envelope::seal(key, ObjectKind::Pack, &pack.encode()?)?;
    let object_key = segment_key(drive_pseudonym, device_pubkey, segment);
    vault.put(&object_key, &sealed)?;

    // Parked, not committed. `vault.put` above may be a staging buffer whose
    // real upload happens elsewhere and can still fail; only
    // `commit_lane_state` — called once the object is durably stored — makes
    // this lane's progress official.
    if let Ok(bytes) = serde_json::to_vec(&exported) {
        let _ = store.kv.insert(
            crate::db::trees::Tree::PluginMeta,
            &pending_lane_state_key(drive_pseudonym, device_pubkey, segment),
            &bytes,
        );
    }

    Ok(Some(BackupSummary {
        object_key,
        resources,
        tombstones,
        sealed_bytes: sealed.len(),
    }))
}

/// Open every pack under `prefix` and merge it into `store`.
///
/// Safe to run against a populated store as well as an empty one: Loro merges
/// rather than overwrites, so a restore over a partially-synced device
/// converges instead of clobbering local edits.
pub async fn import_vault_batch(
    store: &Db,
    key: &DriveVaultKey,
    vault: &dyn VaultObjectStore,
    prefix: &str,
) -> AtomicResult<RestoreSummary> {
    let mut summary = RestoreSummary::default();

    // Sorted by the store contract, so segments replay in the order written.
    for object_key in vault.list(prefix)? {
        let sealed = vault.get(&object_key)?;
        let (header, plaintext) = envelope::open(key, &sealed)?;
        if header.kind != ObjectKind::Pack {
            continue;
        }
        let pack = Pack::decode(&plaintext)?;
        summary.packs_read += 1;

        for entry in pack.entries {
            let subject = Subject::from_raw(&entry.subject, None);

            // Merge into whatever is already here rather than replacing it.
            // An existing resource contributes its history; a missing one
            // starts from an empty doc.
            let mut resource = match store.get_resource(&subject).await {
                Ok(existing) => existing,
                Err(_) => Resource::new(entry.subject.clone()),
            };
            let doc = resource.build_state_doc()?;
            doc.import_update(&entry.update)?;
            resource.apply_state_doc(doc)?;

            // Validation off: a restore replays history that was already
            // validated when it was written. Re-imposing today's required-props
            // rules on old data would make a schema change retroactively
            // unrestorable, which is precisely when a backup matters most.
            store
                .add_resource_opts(&resource, false, true, true)
                .await?;

            // A subject this device had destroyed is being re-created by the
            // backup. Leaving the tombstone in place would keep `is_tombstoned`
            // suppressing it from every future bulk sync, so the restored
            // resource would exist locally and never reach another replica —
            // the same stale-invariant bug `clear_tombstone` exists for (F11).
            // Segments replay in order, so a later tombstone still wins.
            crate::sync::tombstones::clear_tombstone(store, &entry.subject);
            summary.resources_restored += 1;
        }

        for subject_str in pack.tombstones {
            // `remove_resource` rather than a bare `record_tombstone`: the
            // marker alone leaves the resource's data and index entries in
            // place, so an earlier segment's oplog would restore a deleted
            // resource and the tombstone would only stop it propagating. A
            // delete must actually delete. `remove_resource` recurses into
            // children and records tombstones for everything it removes.
            let subject = Subject::from_raw(&subject_str, None);
            match store.remove_resource(&subject).await {
                Ok(()) => {}
                // Already absent is the normal case when restoring into an
                // empty store: the tombstone still has to be recorded so a
                // later bulk sync does not pull the resource back from a peer.
                Err(_) => crate::sync::tombstones::record_tombstone(store, &subject_str),
            }
            summary.tombstones_applied += 1;
        }
    }

    Ok(summary)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::store::MemoryVaultStore;

    const PSEUDONYM: &str = "testpseudonym";
    const DEVICE: &str = "testdevice";

    fn key() -> DriveVaultKey {
        DriveVaultKey::from_bytes([5u8; 32], 1)
    }

    #[test]
    fn segment_keys_sort_in_replay_order() {
        let mut keys = vec![
            segment_key(PSEUDONYM, DEVICE, 10),
            segment_key(PSEUDONYM, DEVICE, 2),
            segment_key(PSEUDONYM, DEVICE, 1),
        ];
        keys.sort();
        assert_eq!(
            keys,
            vec![
                segment_key(PSEUDONYM, DEVICE, 1),
                segment_key(PSEUDONYM, DEVICE, 2),
                segment_key(PSEUDONYM, DEVICE, 10),
            ],
            "lexical order must match segment order, or replay applies packs backwards"
        );
    }

    /// Golden vectors for the S3 key layout, shared with the control plane.
    ///
    /// The layout is implemented **twice**: here, and in atomic-saas's
    /// `build_object_key`, which decides the key a presigned URL points at.
    /// `planning/encrypted-vault-format.md` is the source of truth for both. A
    /// matching test lives in that repo
    /// (`object_keys_match_the_published_format_spec`) asserting these exact
    /// strings.
    ///
    /// Nothing at compile time couples the two — that repo is closed and this
    /// one is MIT, so no shared fixture crate is possible. If either side
    /// drifts, a client uploads to keys the control plane never issued and
    /// nothing notices until a restore comes up short. Changing a string here
    /// means changing it there and in the spec, in the same change.
    #[test]
    fn segment_key_matches_the_published_format() {
        let device = "0303030303030303030303030303030303030303030303030303030303030303";
        let key = segment_key("testpseudonym", device, 1);
        assert_eq!(
            key,
            "vault/testpseudonym/lanes/0303030303030303030303030303030303030303030303030303030303030303/seg-000001.pack",
            "atomic-saas build_object_key must produce this byte-for-byte"
        );

        // Six-digit zero padding is load-bearing: both S3 listing and the
        // filesystem store sort lexically, and seg-10 ordering before seg-2
        // would replay a lane's history backwards.
        assert!(
            key < segment_key("testpseudonym", device, 10),
            "lexical order must match segment order"
        );
    }

    #[test]
    fn segment_keys_live_under_the_device_lane() {
        let k = segment_key(PSEUDONYM, DEVICE, 1);
        assert_eq!(k, "vault/testpseudonym/lanes/testdevice/seg-000001.pack");
        assert!(k.starts_with(&lane_prefix(PSEUDONYM, DEVICE)));
    }

    /// A sealed pack must not leak the subjects it carries: subject visibility
    /// is exactly what the privacy budget promises to hide.
    #[test]
    fn sealed_packs_do_not_reveal_subjects() {
        let pack = Pack::new(
            vec![PackEntry {
                subject: "did:ad:drive/secret-resource".into(),
                update: vec![1, 2, 3],
            }],
            vec![],
        );
        let sealed = envelope::seal(&key(), ObjectKind::Pack, &pack.encode().unwrap()).unwrap();
        let needle = b"secret-resource";
        assert!(
            !sealed.windows(needle.len()).any(|w| w == needle),
            "subject leaked into the sealed pack"
        );
    }

    const FOLDER: &str = "https://atomicdata.dev/classes/Folder";

    /// Read a drive's resources as `(subject, propvals-debug)` pairs, for
    /// comparing two stores. Compares the *materialized projection*, not the
    /// CRDT bytes: a restore that reproduced the oplog but not the derived
    /// state would still be a broken restore from the user's point of view.
    async fn drive_contents(store: &Db, drive: &Subject) -> Vec<(String, String)> {
        let mut out = Vec::new();
        for subject_str in crate::sync::engine::collect_drive_subjects(store, drive).await {
            let subject = Subject::from_raw(&subject_str, None);
            if let Ok(resource) = store.get_resource(&subject).await {
                let mut props: Vec<String> = resource
                    .get_propvals()
                    .iter()
                    .filter(|(k, _)| k.as_str() != crate::urls::LORO_UPDATE)
                    .map(|(k, v)| format!("{k}={v}"))
                    .collect();
                props.sort();
                out.push((subject_str, props.join("|")));
            }
        }
        out.sort();
        out
    }

    /// The whole point of the feature, headless: make changes, back them up,
    /// lose the device entirely, restore into an empty store, and get the same
    /// drive back. This is the "clear browser storage and sign in again" flow
    /// with the browser and the network taken out of the picture.
    #[tokio::test]
    async fn a_wiped_store_is_restored_from_the_vault() {
        let source = Db::init_temp("vault_round_trip_source").await.unwrap();
        let (_agent, drive) = source.setup("alice").await.unwrap();
        for i in 0..3 {
            source
                .create_resource(FOLDER, &drive, &format!("note-{i}"), None)
                .await
                .unwrap();
        }
        let drive_subject = Subject::from_raw(&drive, source.get_base_domain().as_deref());
        let before = drive_contents(&source, &drive_subject).await;
        assert!(
            before.len() >= 4,
            "expected a drive plus children: {before:?}"
        );

        let key = key();
        let vault = MemoryVaultStore::new();
        let backup =
            export_vault_delta(&source, &drive_subject, &key, &vault, PSEUDONYM, DEVICE, 1)
                .await
                .unwrap()
                .expect("a populated drive must produce a pack");
        assert_eq!(backup.resources, before.len());

        // The device is gone: a brand new store, sharing nothing with the old.
        let restored = Db::init_temp("vault_round_trip_restored").await.unwrap();
        let result = import_vault_batch(&restored, &key, &vault, &lane_prefix(PSEUDONYM, DEVICE))
            .await
            .unwrap();
        assert_eq!(result.packs_read, 1);
        assert_eq!(result.resources_restored, before.len());

        let after = drive_contents(&restored, &drive_subject).await;
        assert_eq!(after, before, "restored drive must match the original");
    }

    /// The bug a backup must not have: a resource deleted after an earlier
    /// segment was written must stay deleted through a wipe-and-restore.
    ///
    /// Before deletions were exported, segment 1 still held the resource's full
    /// oplog and a restore brought it back — the vault silently undoing its
    /// owner's delete.
    #[tokio::test]
    async fn a_deleted_resource_does_not_come_back_after_restore() {
        let source = Db::init_temp("vault_delete_source").await.unwrap();
        let (_agent, drive) = source.setup("alice").await.unwrap();
        let keep = source
            .create_resource(FOLDER, &drive, "keep", None)
            .await
            .unwrap();
        let doomed = source
            .create_resource(FOLDER, &drive, "doomed", None)
            .await
            .unwrap();
        let drive_subject = Subject::from_raw(&drive, source.get_base_domain().as_deref());
        let key = key();
        let vault = MemoryVaultStore::new();

        // Segment 1: both resources are backed up.
        export_vault_delta(&source, &drive_subject, &key, &vault, PSEUDONYM, DEVICE, 1)
            .await
            .unwrap()
            .expect("first pack");
        commit_lane_state(&source, PSEUDONYM, DEVICE, 1).unwrap();

        // The user deletes one, then a later backup runs.
        let doomed_subject = Subject::from_raw(&doomed, source.get_base_domain().as_deref());
        source.remove_resource(&doomed_subject).await.unwrap();
        let second =
            export_vault_delta(&source, &drive_subject, &key, &vault, PSEUDONYM, DEVICE, 2)
                .await
                .unwrap()
                .expect("second pack carries the deletion");
        assert_eq!(
            second.tombstones, 1,
            "the deletion must reach the vault, not just the local store"
        );

        // Restore everything into a fresh store.
        let restored = Db::init_temp("vault_delete_restored").await.unwrap();
        import_vault_batch(&restored, &key, &vault, &lane_prefix(PSEUDONYM, DEVICE))
            .await
            .unwrap();

        let subjects = crate::sync::engine::collect_drive_subjects(&restored, &drive_subject).await;
        assert!(
            subjects.contains(&Subject::from_raw(&keep, None).pure_id()),
            "the kept resource must survive: {subjects:?}"
        );
        assert!(
            !subjects.contains(&doomed_subject.pure_id()),
            "the deleted resource must not be resurrected: {subjects:?}"
        );
    }

    /// A restore that re-creates a locally-destroyed subject must lift its
    /// tombstone, or `is_tombstoned` keeps suppressing it from every future
    /// bulk sync and the resource never reaches another replica (F11).
    #[tokio::test]
    async fn restoring_a_locally_destroyed_subject_clears_its_tombstone() {
        let source = Db::init_temp("vault_clear_tombstone_source").await.unwrap();
        let (_agent, drive) = source.setup("alice").await.unwrap();
        let note = source
            .create_resource(FOLDER, &drive, "note", None)
            .await
            .unwrap();
        let drive_subject = Subject::from_raw(&drive, source.get_base_domain().as_deref());
        let key = key();
        let vault = MemoryVaultStore::new();
        export_vault_delta(&source, &drive_subject, &key, &vault, PSEUDONYM, DEVICE, 1)
            .await
            .unwrap()
            .unwrap();

        // A second device destroyed the same subject locally.
        let restored = Db::init_temp("vault_clear_tombstone_restored")
            .await
            .unwrap();
        crate::sync::tombstones::record_tombstone(&restored, &note);
        assert!(crate::sync::tombstones::is_tombstoned(&restored, &note));

        import_vault_batch(&restored, &key, &vault, &lane_prefix(PSEUDONYM, DEVICE))
            .await
            .unwrap();

        assert!(
            !crate::sync::tombstones::is_tombstoned(&restored, &note),
            "a subject the backup re-created must not stay tombstoned"
        );
    }

    /// A seal whose upload never happened must not advance the lane. Otherwise
    /// the next pass computes deletions against a segment that is not in the
    /// vault, and the delete is reported against nothing.
    #[tokio::test]
    async fn an_uncommitted_export_does_not_advance_the_lane() {
        let source = Db::init_temp("vault_uncommitted_export").await.unwrap();
        let (_agent, drive) = source.setup("alice").await.unwrap();
        let doomed = source
            .create_resource(FOLDER, &drive, "doomed", None)
            .await
            .unwrap();
        let drive_subject = Subject::from_raw(&drive, source.get_base_domain().as_deref());
        let key = key();
        let vault = MemoryVaultStore::new();

        // Sealed but never confirmed — the upload failed.
        export_vault_delta(&source, &drive_subject, &key, &vault, PSEUDONYM, DEVICE, 1)
            .await
            .unwrap()
            .unwrap();

        source
            .remove_resource(&Subject::from_raw(
                &doomed,
                source.get_base_domain().as_deref(),
            ))
            .await
            .unwrap();

        let second =
            export_vault_delta(&source, &drive_subject, &key, &vault, PSEUDONYM, DEVICE, 2)
                .await
                .unwrap()
                .expect("still exports the surviving resources");
        assert_eq!(
            second.tombstones, 0,
            "nothing was ever backed up, so nothing can be reported deleted"
        );
    }

    /// Each device appends only to its own lane, so a restore that used one
    /// lane's prefix would silently drop every other device's history.
    #[tokio::test]
    async fn restore_spans_every_device_lane() {
        let source = Db::init_temp("vault_multi_lane_source").await.unwrap();
        let (_agent, drive) = source.setup("alice").await.unwrap();
        source
            .create_resource(FOLDER, &drive, "note", None)
            .await
            .unwrap();
        let drive_subject = Subject::from_raw(&drive, source.get_base_domain().as_deref());
        let key = key();
        let vault = MemoryVaultStore::new();

        // The same drive backed up from two different devices.
        let other_device = "ff".repeat(32);
        export_vault_delta(&source, &drive_subject, &key, &vault, PSEUDONYM, DEVICE, 1)
            .await
            .unwrap()
            .unwrap();
        export_vault_delta(
            &source,
            &drive_subject,
            &key,
            &vault,
            PSEUDONYM,
            &other_device,
            1,
        )
        .await
        .unwrap()
        .unwrap();

        let restored = Db::init_temp("vault_multi_lane_restored").await.unwrap();
        let summary = import_vault_batch(&restored, &key, &vault, &drive_prefix(PSEUDONYM))
            .await
            .unwrap();
        assert_eq!(
            summary.packs_read, 2,
            "the drive prefix must reach both lanes"
        );

        // A lane prefix reaches only one, which is the bug this guards.
        let one_lane = Db::init_temp("vault_multi_lane_one").await.unwrap();
        let partial = import_vault_batch(&one_lane, &key, &vault, &lane_prefix(PSEUDONYM, DEVICE))
            .await
            .unwrap();
        assert_eq!(partial.packs_read, 1);
    }

    /// A subject that disappears without a tombstone is not claimed as deleted.
    /// Inventing a tombstone would delete real data on restore — a far worse
    /// failure than carrying a stale resource for another cycle.
    #[tokio::test]
    async fn a_vanished_but_untombstoned_subject_is_not_reported_deleted() {
        let source = Db::init_temp("vault_no_false_tombstone").await.unwrap();
        let (_agent, drive) = source.setup("alice").await.unwrap();
        source
            .create_resource(FOLDER, &drive, "note", None)
            .await
            .unwrap();
        let drive_subject = Subject::from_raw(&drive, source.get_base_domain().as_deref());
        let key = key();
        let vault = MemoryVaultStore::new();
        export_vault_delta(&source, &drive_subject, &key, &vault, PSEUDONYM, DEVICE, 1)
            .await
            .unwrap()
            .unwrap();
        commit_lane_state(&source, PSEUDONYM, DEVICE, 1).unwrap();

        // Same drive, nothing deleted: a second pass must claim no deletions.
        let second =
            export_vault_delta(&source, &drive_subject, &key, &vault, PSEUDONYM, DEVICE, 2)
                .await
                .unwrap()
                .expect("unchanged drive still exports its oplog in Phase 1");
        assert_eq!(second.tombstones, 0);
    }

    /// Restores get retried, and lanes from several devices overlap by design.
    /// Importing the same pack twice must converge rather than duplicate —
    /// Loro dedups by `(peerId, counter)`, and this pins that we rely on it.
    #[tokio::test]
    async fn importing_the_same_pack_twice_is_idempotent() {
        let source = Db::init_temp("vault_idempotent_source").await.unwrap();
        let (_agent, drive) = source.setup("alice").await.unwrap();
        source
            .create_resource(FOLDER, &drive, "note", None)
            .await
            .unwrap();
        let drive_subject = Subject::from_raw(&drive, source.get_base_domain().as_deref());
        let before = drive_contents(&source, &drive_subject).await;

        let key = key();
        let vault = MemoryVaultStore::new();
        export_vault_delta(&source, &drive_subject, &key, &vault, PSEUDONYM, DEVICE, 1)
            .await
            .unwrap()
            .unwrap();

        let restored = Db::init_temp("vault_idempotent_restored").await.unwrap();
        let prefix = lane_prefix(PSEUDONYM, DEVICE);
        import_vault_batch(&restored, &key, &vault, &prefix)
            .await
            .unwrap();
        let once = drive_contents(&restored, &drive_subject).await;
        import_vault_batch(&restored, &key, &vault, &prefix)
            .await
            .unwrap();
        let twice = drive_contents(&restored, &drive_subject).await;

        assert_eq!(once, before);
        assert_eq!(twice, once, "a second import must not change the result");
    }

    /// The blind-vault claim in one assertion: whoever holds the objects
    /// without the drive key gets nothing back.
    #[tokio::test]
    async fn a_restore_without_the_right_key_fails() {
        let source = Db::init_temp("vault_wrong_key_source").await.unwrap();
        let (_agent, drive) = source.setup("alice").await.unwrap();
        source
            .create_resource(FOLDER, &drive, "note", None)
            .await
            .unwrap();
        let drive_subject = Subject::from_raw(&drive, source.get_base_domain().as_deref());

        let vault = MemoryVaultStore::new();
        export_vault_delta(
            &source,
            &drive_subject,
            &key(),
            &vault,
            PSEUDONYM,
            DEVICE,
            1,
        )
        .await
        .unwrap()
        .unwrap();

        let restored = Db::init_temp("vault_wrong_key_restored").await.unwrap();
        let attacker = DriveVaultKey::from_bytes([0xFF; 32], 1);
        let err = import_vault_batch(
            &restored,
            &attacker,
            &vault,
            &lane_prefix(PSEUDONYM, DEVICE),
        )
        .await
        .unwrap_err()
        .to_string();
        assert!(err.contains("decrypt"), "{err}");
    }

    /// An untouched drive should not produce an object every backup tick.
    #[tokio::test]
    async fn an_empty_drive_produces_no_object() {
        let store = Db::init_temp("vault_empty_drive").await.unwrap();
        let unknown = Subject::from_raw("did:ad:nonexistentdrive", None);
        let vault = MemoryVaultStore::new();
        let out = export_vault_delta(&store, &unknown, &key(), &vault, PSEUDONYM, DEVICE, 1)
            .await
            .unwrap();
        assert!(out.is_none(), "nothing to back up should mean no object");
        assert!(vault.is_empty());
    }

    #[test]
    fn a_pack_round_trips_through_a_store() {
        let vault = MemoryVaultStore::new();
        let pack = Pack::new(
            vec![PackEntry {
                subject: "s".into(),
                update: vec![9, 9, 9],
            }],
            vec!["gone".into()],
        );
        let sealed = envelope::seal(&key(), ObjectKind::Pack, &pack.encode().unwrap()).unwrap();
        let object_key = segment_key(PSEUDONYM, DEVICE, 1);
        vault.put(&object_key, &sealed).unwrap();

        let fetched = vault.get(&object_key).unwrap();
        let (_, plaintext) = envelope::open(&key(), &fetched).unwrap();
        assert_eq!(Pack::decode(&plaintext).unwrap(), pack);
    }
}
