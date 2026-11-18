//! Local evidence of server acknowledgements. Private metadata, never resources
//! or vault export data. Scope is both signing identity and destination origin.
use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use super::trees::{Method, Operation, Tree};
use crate::{errors::AtomicResult, Db, Storelike, Subject};

const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResourceSyncScope {
    pub agent: String,
    pub server_url: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SerializedServerReceipt {
    pub subject: String,
    pub version: BTreeMap<String, u64>,
    pub confirmed_at: u64,
}

pub struct ResourceSyncEvidence {
    pub subject: String,
    pub snapshot: Option<Vec<u8>>,
    pub server_receipt: Option<SerializedServerReceipt>,
}

/// Cloud Vault identity. Paths distinguish separately hosted API endpoints.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VaultSyncScope {
    pub managed_account: String,
    pub agent: String,
    pub portal_url: String,
    pub drive: String,
    pub drive_pseudonym: String,
    pub key_epoch: u32,
}

pub type SerializedVaultReceipt = SerializedServerReceipt;

pub struct ResourceVaultEvidence {
    pub subject: String,
    pub snapshot: Option<Vec<u8>>,
    pub vault_receipt: Option<SerializedVaultReceipt>,
}

impl VaultSyncScope {
    fn canonical(&self) -> AtomicResult<Self> {
        let url = url::Url::parse(&self.portal_url)?;
        if !matches!(url.scheme(), "http" | "https")
            || [
                &self.managed_account,
                &self.agent,
                &self.drive,
                &self.drive_pseudonym,
            ]
            .iter()
            .any(|value| value.trim().is_empty() || value.contains('\0'))
        {
            return Err("Invalid vault sync scope".into());
        }
        Ok(Self {
            managed_account: self.managed_account.clone(),
            agent: Subject::from(self.agent.as_str()).pure_id(),
            portal_url: format!(
                "{}{}",
                url.origin().ascii_serialization(),
                url.path().trim_end_matches('/')
            ),
            drive: Subject::from(self.drive.as_str()).pure_id(),
            drive_pseudonym: self.drive_pseudonym.clone(),
            key_epoch: self.key_epoch,
        })
    }
}

fn vault_key(subject: &str, scope: &VaultSyncScope) -> Vec<u8> {
    let mut key = subject_prefix(subject);
    // A leading NUL cannot collide with the nonempty server-scope agent.
    key.extend_from_slice(b"\0vault-v1\0");
    // Struct field order is fixed; the scope is canonical before serialization.
    key.extend_from_slice(&serde_json::to_vec(scope).expect("string scope serializes"));
    key
}

impl ResourceSyncScope {
    fn canonical(&self) -> AtomicResult<Self> {
        let url = url::Url::parse(&self.server_url)?;
        if !matches!(url.scheme(), "http" | "https")
            || self.agent.is_empty()
            || self.agent.contains('\0')
        {
            return Err("Invalid resource sync scope".into());
        }
        Ok(Self {
            agent: Subject::from(self.agent.as_str()).pure_id(),
            server_url: url.origin().ascii_serialization(),
        })
    }
}

impl SerializedServerReceipt {
    fn valid(&self) -> bool {
        !self.subject.is_empty()
            && !self.subject.contains('\0')
            && self.confirmed_at <= MAX_SAFE_INTEGER
            && self.version.iter().all(|(peer, counter)| {
                peer.parse::<u64>().is_ok_and(|id| id.to_string() == *peer)
                    && *counter <= i32::MAX as u64
            })
    }
}

fn subject_prefix(subject: &str) -> Vec<u8> {
    let mut key = subject.as_bytes().to_vec();
    key.push(0);
    key
}

fn key(subject: &str, scope: &ResourceSyncScope) -> Vec<u8> {
    let mut key = subject_prefix(subject);
    key.extend_from_slice(scope.agent.as_bytes());
    key.push(0);
    key.extend_from_slice(scope.server_url.as_bytes());
    key
}

fn vault_generation_key(scope: &VaultSyncScope) -> Vec<u8> {
    let mut key = b"\0vault-generation-v1\0".to_vec();
    key.extend_from_slice(&serde_json::to_vec(scope).expect("string scope serializes"));
    key
}

/// Read only while holding sync_receipts_gate. Corruption must never reset a fence.
fn vault_generation(db: &Db, scope: &VaultSyncScope) -> AtomicResult<u64> {
    let Some(bytes) = db
        .kv
        .get(Tree::SyncReceipts, &vault_generation_key(scope))?
    else {
        return Ok(0);
    };
    let generation: u64 = serde_json::from_slice(&bytes)?;
    if generation > MAX_SAFE_INTEGER {
        return Err("Invalid vault receipt generation".into());
    }
    Ok(generation)
}

/// Called while the receipt gate is held, so receipt writes cannot race a
/// resource deletion. The caller applies these in the resource's own batch.
pub(super) fn remove_ops(db: &Db, subject: &str) -> AtomicResult<Vec<Operation>> {
    db.kv
        .scan_prefix(Tree::SyncReceipts, &subject_prefix(subject))
        .map(|row| {
            row.map(|(key, _)| Operation {
                tree: Tree::SyncReceipts,
                method: Method::Delete,
                key,
                val: None,
            })
        })
        .collect()
}

impl Db {
    /// Capture a durable, per-scope fence before exporting a backup. Clears
    /// rotate it so delayed writes from another tab cannot resurrect proof.
    pub fn get_resource_vault_generation(&self, scope: &VaultSyncScope) -> AtomicResult<u64> {
        let scope = scope.canonical()?;
        let _guard = self
            .sync_receipts_gate
            .lock()
            .map_err(|_| "sync receipt lock poisoned")?;
        let generation = vault_generation(self, &scope)?;
        self.flush()?;
        Ok(generation)
    }

    /// Forget known backups after a confirmed vault disable. Other accounts,
    /// portals, drives and key epochs retain their independent evidence.
    pub fn clear_resource_vault_receipts(&self, scope: &VaultSyncScope) -> AtomicResult<()> {
        let scope = scope.canonical()?;
        let suffix = vault_key("", &scope);
        let _guard = self
            .sync_receipts_gate
            .lock()
            .map_err(|_| "sync receipt lock poisoned")?;
        let mut ops = Vec::new();
        for row in self.kv.iter_tree(Tree::SyncReceipts) {
            let (key, _) = row?;
            if key.ends_with(&suffix) {
                ops.push(Operation {
                    tree: Tree::SyncReceipts,
                    method: Method::Delete,
                    key,
                    val: None,
                });
            }
        }
        let generation = vault_generation(self, &scope)?;
        if generation >= MAX_SAFE_INTEGER {
            return Err("Vault receipt generation exhausted".into());
        }
        ops.push(Operation {
            tree: Tree::SyncReceipts,
            method: Method::Insert,
            key: vault_generation_key(&scope),
            val: Some(serde_json::to_vec(&(generation + 1))?),
        });
        self.kv.apply_batch(&ops)?;
        self.flush()
    }

    /// Reads actual stored bytes, then crosses the durability barrier before
    /// exposing them as evidence. A normal cached resource read is no proof.
    pub fn get_resource_sync_evidence(
        &self,
        subjects: &[String],
        scope: Option<&ResourceSyncScope>,
    ) -> AtomicResult<Vec<ResourceSyncEvidence>> {
        let scope = scope.map(ResourceSyncScope::canonical).transpose()?;
        let _guard = self
            .sync_receipts_gate
            .lock()
            .map_err(|_| "sync receipt lock poisoned")?;
        let mut evidence = Vec::with_capacity(subjects.len());
        for subject in subjects {
            let canonical = self
                .normalize_subject(&Subject::from_raw(
                    subject,
                    self.get_base_domain().as_deref(),
                ))
                .pure_id();
            let snapshot = if self
                .kv
                .contains_key(Tree::Resources, canonical.as_bytes())?
            {
                self.kv.get(Tree::LoroSnapshots, canonical.as_bytes())?
            } else {
                None
            };
            let server_receipt = if snapshot.is_some() {
                if let Some(scope) = &scope {
                    self.kv
                        .get(Tree::SyncReceipts, &key(&canonical, scope))?
                        .and_then(|bytes| {
                            serde_json::from_slice::<SerializedServerReceipt>(&bytes).ok()
                        })
                        .filter(|row| row.valid() && row.subject == canonical)
                } else {
                    None
                }
            } else {
                None
            };
            // Internal storage IDs (e.g. internal:/item) are not public IDs.
            // Return the requested spelling for correlation, only after checking
            // the receipt against its canonical storage key above.
            let server_receipt = server_receipt.map(|mut row| {
                row.subject = subject.clone();
                row
            });
            evidence.push(ResourceSyncEvidence {
                subject: subject.clone(),
                snapshot,
                server_receipt,
            });
        }
        self.flush()?;
        Ok(evidence)
    }

    /// Merge acknowledgements while exclusively owning the database receipt
    /// gate. Browser tabs route through the one elected Db owner; Db clones
    /// share this gate. Concurrent smaller vectors can never erase coverage.
    pub fn put_resource_sync_receipts(
        &self,
        scope: &ResourceSyncScope,
        receipts: &[SerializedServerReceipt],
    ) -> AtomicResult<()> {
        let scope = scope.canonical()?;
        if receipts.iter().any(|row| !row.valid()) {
            return Err("Invalid resource sync receipt".into());
        }
        let _guard = self
            .sync_receipts_gate
            .lock()
            .map_err(|_| "sync receipt lock poisoned")?;
        let mut merged = BTreeMap::<Vec<u8>, SerializedServerReceipt>::new();
        for receipt in receipts {
            let subject = self
                .normalize_subject(&Subject::from_raw(
                    &receipt.subject,
                    self.get_base_domain().as_deref(),
                ))
                .pure_id();
            // A delayed server response must not resurrect evidence after delete.
            if !self.kv.contains_key(Tree::Resources, subject.as_bytes())?
                || !self
                    .kv
                    .contains_key(Tree::LoroSnapshots, subject.as_bytes())?
            {
                continue;
            }
            let key = key(&subject, &scope);
            let mut incoming = receipt.clone();
            incoming.subject = subject.clone();
            let previous = merged.remove(&key).or(self
                .kv
                .get(Tree::SyncReceipts, &key)?
                .and_then(|bytes| serde_json::from_slice::<SerializedServerReceipt>(&bytes).ok())
                .filter(|row| row.valid() && row.subject == subject));
            if let Some(previous) = previous {
                incoming.confirmed_at = incoming.confirmed_at.max(previous.confirmed_at);
                for (peer, counter) in previous.version {
                    let current = incoming.version.entry(peer).or_default();
                    *current = (*current).max(counter);
                }
            }
            merged.insert(key, incoming);
        }
        let ops = merged
            .into_iter()
            .map(|(key, receipt)| {
                Ok(Operation {
                    tree: Tree::SyncReceipts,
                    method: Method::Insert,
                    key,
                    val: Some(serde_json::to_vec(&receipt)?),
                })
            })
            .collect::<AtomicResult<Vec<_>>>()?;
        self.kv.apply_batch(&ops)?;
        self.flush()
    }
    /// Reads actual stored bytes, then crosses the durability barrier before
    /// exposing them as evidence. A normal cached resource read is no proof.
    pub fn get_resource_vault_evidence(
        &self,
        subjects: &[String],
        scope: &VaultSyncScope,
    ) -> AtomicResult<Vec<ResourceVaultEvidence>> {
        let scope = scope.canonical()?;
        let _guard = self
            .sync_receipts_gate
            .lock()
            .map_err(|_| "sync receipt lock poisoned")?;
        let mut evidence = Vec::with_capacity(subjects.len());
        for subject in subjects {
            let canonical = self
                .normalize_subject(&Subject::from_raw(
                    subject,
                    self.get_base_domain().as_deref(),
                ))
                .pure_id();
            let snapshot = if self
                .kv
                .contains_key(Tree::Resources, canonical.as_bytes())?
            {
                self.kv.get(Tree::LoroSnapshots, canonical.as_bytes())?
            } else {
                None
            };
            let vault_receipt = if snapshot.is_some() {
                self.kv
                    .get(Tree::SyncReceipts, &vault_key(&canonical, &scope))?
                    .and_then(|bytes| serde_json::from_slice::<SerializedVaultReceipt>(&bytes).ok())
                    .filter(|row| row.valid() && row.subject == canonical)
            } else {
                None
            };
            // Internal storage IDs (e.g. internal:/item) are not public IDs.
            // Return the requested spelling for correlation, only after checking
            // the receipt against its canonical storage key above.
            let vault_receipt = vault_receipt.map(|mut row| {
                row.subject = subject.clone();
                row
            });
            evidence.push(ResourceVaultEvidence {
                subject: subject.clone(),
                snapshot,
                vault_receipt,
            });
        }
        self.flush()?;
        Ok(evidence)
    }

    /// Merge acknowledgements while exclusively owning the database receipt
    /// gate. Browser tabs route through the one elected Db owner; Db clones
    /// share this gate. Concurrent smaller vectors can never erase coverage.
    pub fn put_resource_vault_receipts(
        &self,
        scope: &VaultSyncScope,
        receipts: &[SerializedVaultReceipt],
        generation: u64,
    ) -> AtomicResult<bool> {
        let scope = scope.canonical()?;
        if receipts.iter().any(|row| !row.valid()) {
            return Err("Invalid resource sync receipt".into());
        }
        let _guard = self
            .sync_receipts_gate
            .lock()
            .map_err(|_| "sync receipt lock poisoned")?;
        if generation > MAX_SAFE_INTEGER || generation != vault_generation(self, &scope)? {
            return Ok(false);
        }
        let mut merged = BTreeMap::<Vec<u8>, SerializedVaultReceipt>::new();
        for receipt in receipts {
            let subject = self
                .normalize_subject(&Subject::from_raw(
                    &receipt.subject,
                    self.get_base_domain().as_deref(),
                ))
                .pure_id();
            // A delayed server response must not resurrect evidence after delete.
            if !self.kv.contains_key(Tree::Resources, subject.as_bytes())?
                || !self
                    .kv
                    .contains_key(Tree::LoroSnapshots, subject.as_bytes())?
            {
                continue;
            }
            let key = vault_key(&subject, &scope);
            let mut incoming = receipt.clone();
            incoming.subject = subject.clone();
            let previous = merged.remove(&key).or(self
                .kv
                .get(Tree::SyncReceipts, &key)?
                .and_then(|bytes| serde_json::from_slice::<SerializedVaultReceipt>(&bytes).ok())
                .filter(|row| row.valid() && row.subject == subject));
            if let Some(previous) = previous {
                incoming.confirmed_at = incoming.confirmed_at.max(previous.confirmed_at);
                for (peer, counter) in previous.version {
                    let current = incoming.version.entry(peer).or_default();
                    *current = (*current).max(counter);
                }
            }
            merged.insert(key, incoming);
        }
        let ops = merged
            .into_iter()
            .map(|(key, receipt)| {
                Ok(Operation {
                    tree: Tree::SyncReceipts,
                    method: Method::Insert,
                    key,
                    val: Some(serde_json::to_vec(&receipt)?),
                })
            })
            .collect::<AtomicResult<Vec<_>>>()?;
        self.kv.apply_batch(&ops)?;
        self.flush()?;
        Ok(true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    fn store() -> Db {
        Db::from_kv(
            Default::default(),
            Arc::new(super::super::redb_store::RedbStore::new_memory().unwrap()),
            None,
        )
    }
    fn scope() -> ResourceSyncScope {
        ResourceSyncScope {
            agent: "did:ad:alice".into(),
            server_url: "https://example.com/path".into(),
        }
    }
    fn seed(db: &Db, subject: &str) {
        db.kv
            .insert(Tree::Resources, subject.as_bytes(), b"row")
            .unwrap();
        db.kv
            .insert(
                Tree::LoroSnapshots,
                subject.as_bytes(),
                b"actual stored snapshot",
            )
            .unwrap();
    }
    fn receipt(peer: &str, counter: u64, time: u64) -> SerializedServerReceipt {
        SerializedServerReceipt {
            subject: "did:ad:resource".into(),
            version: BTreeMap::from([(peer.into(), counter)]),
            confirmed_at: time,
        }
    }

    fn vault_scope() -> VaultSyncScope {
        VaultSyncScope {
            managed_account: "alice@example.test".into(),
            agent: "atomic:alice".into(),
            portal_url: "https://portal.example/api/".into(),
            drive: "did:ad:drive".into(),
            drive_pseudonym: "pseudonym".into(),
            key_epoch: 1,
        }
    }

    #[test]
    fn vault_receipts_merge_and_isolate_every_scope_dimension() {
        let db = store();
        seed(&db, "atomic:resource");
        let scope = vault_scope();
        db.put_resource_vault_receipts(&scope, &[receipt("1", 7, 10)], 0)
            .unwrap();
        db.put_resource_vault_receipts(&scope, &[receipt("1", 2, 8), receipt("2", 4, 12)], 0)
            .unwrap();
        let subjects = vec!["atomic:resource".into()];
        let evidence = db.get_resource_vault_evidence(&subjects, &scope).unwrap();
        assert_eq!(
            evidence[0].vault_receipt.as_ref().unwrap().version,
            BTreeMap::from([("1".into(), 7), ("2".into(), 4)])
        );
        let mut normalized = scope.clone();
        normalized.portal_url.pop();
        normalized.drive = "atomic:drive".into();
        assert!(db
            .get_resource_vault_evidence(&subjects, &normalized)
            .unwrap()[0]
            .vault_receipt
            .is_some());
        for field in 0..6 {
            let mut different = scope.clone();
            match field {
                0 => different.managed_account = "bob@example.test".into(),
                1 => different.agent = "atomic:bob".into(),
                2 => different.portal_url = "https://portal.example/other-api".into(),
                3 => different.drive = "atomic:other-drive".into(),
                4 => different.drive_pseudonym = "other".into(),
                _ => different.key_epoch += 1,
            }
            assert!(db
                .get_resource_vault_evidence(&subjects, &different)
                .unwrap()[0]
                .vault_receipt
                .is_none());
        }
        assert!(db
            .get_resource_sync_evidence(&subjects, Some(&super::tests::scope()))
            .unwrap()[0]
            .server_receipt
            .is_none());
    }

    #[test]
    fn vault_receipts_survive_reopen_and_delete_with_server_receipts() {
        let path =
            std::env::temp_dir().join(format!("atomic-vault-receipts-{}.redb", ulid::Ulid::new()));
        let open = || {
            Db::from_kv(
                Default::default(),
                Arc::new(super::super::redb_store::RedbStore::new_file(&path).unwrap()),
                Some("https://self.example".into()),
            )
        };
        let subject = "https://self.example/item";
        {
            let db = open();
            seed(&db, "internal:/item");
            let row = SerializedServerReceipt {
                subject: subject.into(),
                version: BTreeMap::from([("1".into(), 7)]),
                confirmed_at: 10,
            };
            db.put_resource_vault_receipts(&vault_scope(), std::slice::from_ref(&row), 0)
                .unwrap();
            db.put_resource_sync_receipts(&scope(), &[row]).unwrap();
        }
        {
            let db = open();
            let rows = db
                .get_resource_vault_evidence(&[subject.into()], &vault_scope())
                .unwrap();
            assert_eq!(rows[0].vault_receipt.as_ref().unwrap().subject, subject);
            assert!(rows[0].snapshot.is_some());
            let mut ops = vec![
                Operation::remove_resource("internal:/item"),
                Operation::remove_loro_snapshot("internal:/item"),
            ];
            db.apply_transaction(&mut ops).unwrap();
            db.flush().unwrap();
            db.put_resource_vault_receipts(
                &vault_scope(),
                &[SerializedServerReceipt {
                    subject: subject.into(),
                    version: BTreeMap::from([("1".into(), 9)]),
                    confirmed_at: 12,
                }],
                0,
            )
            .unwrap();
            assert_eq!(db.kv.len(Tree::SyncReceipts).unwrap(), 0);
        }
        {
            let db = open();
            assert!(db
                .get_resource_vault_evidence(&[subject.into()], &vault_scope())
                .unwrap()[0]
                .vault_receipt
                .is_none());
        }
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn vault_generation_fences_late_writes_across_reopen_and_repeated_clear() {
        let path = std::env::temp_dir().join(format!(
            "atomic-vault-generation-{}.redb",
            ulid::Ulid::new()
        ));
        let open = || {
            Db::from_kv(
                Default::default(),
                Arc::new(super::super::redb_store::RedbStore::new_file(&path).unwrap()),
                None,
            )
        };
        let scope = vault_scope();
        {
            let db = open();
            seed(&db, "atomic:resource");
            assert_eq!(db.get_resource_vault_generation(&scope).unwrap(), 0);
            assert!(db
                .put_resource_vault_receipts(&scope, &[receipt("1", 7, 10)], 0)
                .unwrap());
            db.clear_resource_vault_receipts(&scope).unwrap();
        }
        {
            let db = open();
            assert_eq!(db.get_resource_vault_generation(&scope).unwrap(), 1);
            assert!(!db
                .put_resource_vault_receipts(&scope, &[receipt("1", 8, 11)], 0)
                .unwrap());
            assert!(db
                .get_resource_vault_evidence(&["atomic:resource".into()], &scope)
                .unwrap()[0]
                .vault_receipt
                .is_none());
            // A handoff may replay clear. Extra invalidation is conservative:
            // a newly captured generation can become stale, never vice versa.
            db.clear_resource_vault_receipts(&scope).unwrap();
            assert!(!db
                .put_resource_vault_receipts(&scope, &[receipt("1", 8, 11)], 1)
                .unwrap());
            assert!(db
                .put_resource_vault_receipts(&scope, &[receipt("1", 9, 12)], 2)
                .unwrap());
            let mut other = scope.clone();
            other.key_epoch += 1;
            assert_eq!(db.get_resource_vault_generation(&other).unwrap(), 0);
        }
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn malformed_vault_generation_does_not_reset_the_fence() {
        let db = store();
        seed(&db, "atomic:resource");
        let scope = vault_scope();
        db.kv
            .insert(
                Tree::SyncReceipts,
                &vault_generation_key(&scope.canonical().unwrap()),
                b"bad generation",
            )
            .unwrap();
        assert!(db.get_resource_vault_generation(&scope).is_err());
        assert!(db
            .put_resource_vault_receipts(&scope, &[receipt("1", 7, 10)], 0)
            .is_err());
        assert!(db.clear_resource_vault_receipts(&scope).is_err());
    }

    #[test]
    fn disabling_a_vault_clears_only_its_scope() {
        let db = store();
        seed(&db, "atomic:resource");
        let scope = vault_scope();
        let mut other = scope.clone();
        other.key_epoch += 1;
        db.put_resource_vault_receipts(&scope, &[receipt("1", 7, 10)], 0)
            .unwrap();
        db.put_resource_vault_receipts(&other, &[receipt("1", 7, 10)], 0)
            .unwrap();
        db.put_resource_sync_receipts(&super::tests::scope(), &[receipt("1", 7, 10)])
            .unwrap();
        db.clear_resource_vault_receipts(&scope).unwrap();
        let subjects = vec!["atomic:resource".into()];
        assert!(
            db.get_resource_vault_evidence(&subjects, &scope).unwrap()[0]
                .vault_receipt
                .is_none()
        );
        assert!(
            db.get_resource_vault_evidence(&subjects, &other).unwrap()[0]
                .vault_receipt
                .is_some()
        );
        assert!(db
            .get_resource_sync_evidence(&subjects, Some(&super::tests::scope()))
            .unwrap()[0]
            .server_receipt
            .is_some());
    }

    #[test]
    fn vault_receipts_fail_closed_for_corruption_and_bad_scope() {
        let db = store();
        seed(&db, "atomic:resource");
        let scope = vault_scope();
        db.kv
            .insert(
                Tree::SyncReceipts,
                &vault_key("atomic:resource", &scope.canonical().unwrap()),
                br#"{"subject":"atomic:resource","version":{"x":1},"confirmedAt":10}"#,
            )
            .unwrap();
        assert!(db
            .get_resource_vault_evidence(&["atomic:resource".into()], &scope)
            .unwrap()[0]
            .vault_receipt
            .is_none());
        let mut bad = scope;
        bad.portal_url = "file:///private".into();
        assert!(db
            .get_resource_vault_evidence(&["atomic:resource".into()], &bad)
            .is_err());
        assert!(db
            .put_resource_vault_receipts(&vault_scope(), &[receipt("bad", 1, 10)], 0)
            .is_err());
    }

    #[test]
    fn http_evidence_keeps_public_subjects_while_storage_uses_internal_ids() {
        let db = store().clone_with_url("https://self.example".into());
        let subject = "https://self.example/item";
        let canonical = db
            .normalize_subject(&Subject::from_raw(subject, db.get_base_domain().as_deref()))
            .pure_id();
        assert_eq!(canonical, "internal:/item");
        seed(&db, &canonical);
        let receipt = SerializedServerReceipt {
            subject: subject.into(),
            version: BTreeMap::from([("1".into(), 7)]),
            confirmed_at: 10,
        };
        db.put_resource_sync_receipts(&scope(), &[receipt]).unwrap();
        let rows = db
            .get_resource_sync_evidence(&[subject.into()], Some(&scope()))
            .unwrap();
        assert_eq!(rows[0].subject, subject);
        assert_eq!(rows[0].server_receipt.as_ref().unwrap().subject, subject);
        assert!(rows[0].snapshot.is_some());
    }

    #[test]
    fn receipts_and_snapshot_survive_database_reopen() {
        let path =
            std::env::temp_dir().join(format!("atomic-sync-receipts-{}.redb", ulid::Ulid::new()));
        let open = || {
            Db::from_kv(
                Default::default(),
                Arc::new(super::super::redb_store::RedbStore::new_file(&path).unwrap()),
                None,
            )
        };
        {
            let db = open();
            seed(&db, "atomic:resource");
            db.put_resource_sync_receipts(&scope(), &[receipt("1", 7, 10)])
                .unwrap();
        }
        {
            let db = open();
            let rows = db
                .get_resource_sync_evidence(&["atomic:resource".into()], Some(&scope()))
                .unwrap();
            assert_eq!(
                rows[0].snapshot.as_deref(),
                Some(b"actual stored snapshot".as_slice())
            );
            assert_eq!(rows[0].server_receipt.as_ref().unwrap().version["1"], 7);
            let mut ops = vec![
                Operation::remove_resource("atomic:resource"),
                Operation::remove_loro_snapshot("atomic:resource"),
            ];
            db.apply_transaction(&mut ops).unwrap();
            db.flush().unwrap();
        }
        {
            let db = open();
            assert_eq!(db.kv.len(Tree::SyncReceipts).unwrap(), 0);
        }
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn merges_coverage_and_isolates_scopes() {
        let db = store();
        seed(&db, "atomic:resource");
        db.put_resource_sync_receipts(&scope(), &[receipt("1", 7, 10)])
            .unwrap();
        let clone = db.clone();
        clone
            .put_resource_sync_receipts(&scope(), &[receipt("1", 2, 8), receipt("2", 4, 12)])
            .unwrap();
        let subjects = vec!["did:ad:resource".into()];
        let result = db
            .get_resource_sync_evidence(&subjects, Some(&scope()))
            .unwrap();
        assert_eq!(
            result[0].snapshot.as_deref(),
            Some(b"actual stored snapshot".as_slice())
        );
        let row = result[0].server_receipt.as_ref().unwrap();
        assert_eq!(
            row.version,
            BTreeMap::from([("1".into(), 7), ("2".into(), 4)])
        );
        assert_eq!(row.confirmed_at, 12);
        assert!(db.get_resource_sync_evidence(&subjects, None).unwrap()[0]
            .server_receipt
            .is_none());
        let mut different = scope();
        different.agent = "atomic:bob".into();
        assert!(db
            .get_resource_sync_evidence(&subjects, Some(&different))
            .unwrap()[0]
            .server_receipt
            .is_none());
        different = scope();
        different.server_url = "https://other.example".into();
        assert!(db
            .get_resource_sync_evidence(&subjects, Some(&different))
            .unwrap()[0]
            .server_receipt
            .is_none());
    }

    #[test]
    fn deletion_atomically_cleans_every_scope_and_late_writes_are_ignored() {
        let db = store();
        seed(&db, "atomic:resource");
        seed(&db, "atomic:resource-other");
        let mut other = scope();
        other.agent = "atomic:bob".into();
        for scope in [scope(), other] {
            db.put_resource_sync_receipts(&scope, &[receipt("1", 7, 10)])
                .unwrap();
        }
        let mut ops = vec![
            Operation::remove_resource("atomic:resource"),
            Operation::remove_loro_snapshot("atomic:resource"),
        ];
        db.apply_transaction(&mut ops).unwrap();
        assert_eq!(db.kv.len(Tree::SyncReceipts).unwrap(), 0);
        db.put_resource_sync_receipts(&scope(), &[receipt("1", 9, 11)])
            .unwrap();
        assert_eq!(db.kv.len(Tree::SyncReceipts).unwrap(), 0);
        assert!(db
            .get_resource_sync_evidence(&["atomic:resource".into()], Some(&scope()))
            .unwrap()[0]
            .snapshot
            .is_none());
        assert!(db
            .kv
            .contains_key(Tree::Resources, b"atomic:resource-other")
            .unwrap());
    }

    #[test]
    fn rejects_malformed_rows_and_missing_snapshots() {
        let db = store();
        seed(&db, "atomic:resource");
        for bad in [
            receipt("no-peer", 1, 10),
            receipt("01", 1, 10),
            receipt("1", i32::MAX as u64 + 1, 10),
            receipt("1", 1, MAX_SAFE_INTEGER + 1),
        ] {
            assert!(db.put_resource_sync_receipts(&scope(), &[bad]).is_err());
        }
        let canonical_scope = scope().canonical().unwrap();
        for malformed in [
            b"not JSON".as_slice(),
            br#"{"subject":"atomic:resource","version":{"1":7},"confirmedAt":10,"schema":2}"#
                .as_slice(),
        ] {
            db.kv
                .insert(
                    Tree::SyncReceipts,
                    &key("atomic:resource", &canonical_scope),
                    malformed,
                )
                .unwrap();
            assert!(db
                .get_resource_sync_evidence(&["atomic:resource".into()], Some(&scope()))
                .unwrap()[0]
                .server_receipt
                .is_none());
        }

        db.kv
            .insert(
                Tree::SyncReceipts,
                &key("atomic:resource", &canonical_scope),
                br#"{"subject":"atomic:resource","version":{"1":-1},"confirmedAt":10}"#,
            )
            .unwrap();
        assert!(db
            .get_resource_sync_evidence(&["atomic:resource".into()], Some(&scope()))
            .unwrap()[0]
            .server_receipt
            .is_none());
        db.kv
            .remove(Tree::LoroSnapshots, b"atomic:resource")
            .unwrap();
        db.put_resource_sync_receipts(&scope(), &[receipt("1", 9, 10)])
            .unwrap();
        assert!(db
            .get_resource_sync_evidence(&["atomic:resource".into()], Some(&scope()))
            .unwrap()[0]
            .snapshot
            .is_none());
    }

    #[tokio::test]
    async fn actual_remove_resource_cleans_receipts() {
        let db = store();
        let resource = crate::Resource::new("atomic:resource".into());
        let mut ops = Vec::new();
        db.add_resource_tx(&resource, &mut ops).unwrap();
        db.apply_transaction(&mut ops).unwrap();
        db.kv
            .insert(Tree::LoroSnapshots, b"atomic:resource", b"snapshot")
            .unwrap();
        db.put_resource_sync_receipts(&scope(), &[receipt("1", 7, 10)])
            .unwrap();
        db.remove_resource(resource.get_subject()).await.unwrap();
        assert_eq!(db.kv.len(Tree::SyncReceipts).unwrap(), 0);
        assert!(!db
            .kv
            .contains_key(Tree::LoroSnapshots, b"atomic:resource")
            .unwrap());
    }

    #[test]
    fn concurrent_tabs_do_not_lose_acknowledgements() {
        let db = store();
        seed(&db, "atomic:resource");
        std::thread::scope(|threads| {
            for peer in 1..=12 {
                let db = db.clone();
                threads.spawn(move || {
                    db.put_resource_sync_receipts(
                        &scope(),
                        &[receipt(&peer.to_string(), peer, peer)],
                    )
                    .unwrap();
                });
            }
        });
        let rows = db
            .get_resource_sync_evidence(&["atomic:resource".into()], Some(&scope()))
            .unwrap();
        assert_eq!(rows[0].server_receipt.as_ref().unwrap().version.len(), 12);
    }
}
