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

    let pack = Pack::new(entries, Vec::new());
    if pack.is_empty() {
        return Ok(None);
    }

    let resources = pack.entries.len();
    let tombstones = pack.tombstones.len();
    let sealed = envelope::seal(key, ObjectKind::Pack, &pack.encode()?)?;
    let object_key = segment_key(drive_pseudonym, device_pubkey, segment);
    vault.put(&object_key, &sealed)?;

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
            summary.resources_restored += 1;
        }

        for subject_str in pack.tombstones {
            crate::sync::tombstones::record_tombstone(store, &subject_str);
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
