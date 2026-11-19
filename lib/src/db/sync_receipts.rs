//! Local evidence of destination acknowledgements (server or Cloud Vault),
//! one store keyed by (destination scope, subject). Private metadata, never
//! resources or vault export data. Scope is both signing identity and
//! destination origin.
use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use super::trees::{Method, Operation, Tree};
use crate::{
    errors::AtomicResult, sync::attachment_manifest::AttachmentManifest, Db, Storelike, Subject,
};

const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResourceSyncScope {
    pub agent: String,
    pub server_url: String,
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

/// The destination a receipt is addressed to.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ReceiptScope {
    Server(ResourceSyncScope),
    Vault(VaultSyncScope),
}

/// One stored receipt. With a `manifest` it proves file contents, without one
/// it proves the resource's own document.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SerializedReceipt {
    pub subject: String,
    #[serde(default)]
    pub version: BTreeMap<String, u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub manifest: Option<AttachmentManifest>,
    pub confirmed_at: u64,
}

pub struct ResourceReceipts {
    pub subject: String,
    pub snapshot: Option<Vec<u8>>,
    pub receipts: Vec<SerializedReceipt>,
}

impl SerializedReceipt {
    fn valid(&self) -> bool {
        !self.subject.is_empty()
            && !self.subject.contains('\0')
            && self.confirmed_at <= MAX_SAFE_INTEGER
            && self.version.iter().all(|(peer, counter)| {
                peer.parse::<u64>().is_ok_and(|id| id.to_string() == *peer)
                    && *counter <= i32::MAX as u64
            })
            && self.manifest.as_ref().is_none_or(|m| m.validate())
    }
}

impl ReceiptScope {
    fn canonical(&self) -> AtomicResult<Self> {
        Ok(match self {
            Self::Server(scope) => {
                let url = url::Url::parse(&scope.server_url)?;
                if !matches!(url.scheme(), "http" | "https")
                    || scope.agent.is_empty()
                    || scope.agent.contains('\0')
                {
                    return Err("Invalid resource sync scope".into());
                }
                Self::Server(ResourceSyncScope {
                    agent: Subject::from(scope.agent.as_str()).pure_id(),
                    server_url: url.origin().ascii_serialization(),
                })
            }
            Self::Vault(scope) => Self::Vault(scope.canonical()?),
        })
    }

    /// Storage key of a subject's row. A server's document rows keep the
    /// original `subject\0agent\0origin` layout and every other row a tagged
    /// scope, so rows stored before the stores merged stay readable.
    fn key(&self, subject: &str, contents: bool) -> Vec<u8> {
        let mut key = subject_prefix(subject);
        let (tag, json) = match (self, contents) {
            (Self::Server(scope), false) => {
                key.extend_from_slice(scope.agent.as_bytes());
                key.push(0);
                key.extend_from_slice(scope.server_url.as_bytes());
                return key;
            }
            // A leading NUL cannot collide with the nonempty server-scope agent.
            (Self::Server(scope), true) => ("server-attachments-v1", serde_json::to_vec(scope)),
            (Self::Vault(scope), false) => ("vault-v1", serde_json::to_vec(scope)),
            (Self::Vault(scope), true) => ("vault-attachments-v1", serde_json::to_vec(scope)),
        };
        key.extend_from_slice(format!("\0{tag}\0").as_bytes());
        // Struct field order is fixed; the scope is canonical before serialization.
        key.extend_from_slice(&json.expect("string scope serializes"));
        key
    }
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

fn subject_prefix(subject: &str) -> Vec<u8> {
    let mut key = subject.as_bytes().to_vec();
    key.push(0);
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
    fn receipt_gate(&self) -> AtomicResult<std::sync::MutexGuard<'_, ()>> {
        Ok(self
            .sync_receipts_gate
            .lock()
            .map_err(|_| "sync receipt lock poisoned")?)
    }

    fn stored_receipt(&self, key: &[u8], subject: &str) -> AtomicResult<Option<SerializedReceipt>> {
        Ok(self
            .kv
            .get(Tree::SyncReceipts, key)?
            .and_then(|bytes| serde_json::from_slice::<SerializedReceipt>(&bytes).ok())
            .filter(|row| row.valid() && row.subject == subject))
    }

    /// Reads actual stored bytes, then crosses the durability barrier before
    /// exposing them as evidence. A normal cached resource read is no proof.
    /// Without a scope only the stored snapshot is reported.
    pub fn get_resource_receipts(
        &self,
        subjects: &[String],
        scope: Option<&ReceiptScope>,
    ) -> AtomicResult<Vec<ResourceReceipts>> {
        let scope = scope.map(ReceiptScope::canonical).transpose()?;
        let _guard = self.receipt_gate()?;
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
            let mut receipts = Vec::new();
            if let (Some(scope), Some(_)) = (&scope, &snapshot) {
                for contents in [false, true] {
                    // Internal storage IDs (e.g. internal:/item) are not public IDs.
                    // Return the requested spelling for correlation, only after
                    // checking the receipt against its canonical storage key.
                    receipts.extend(
                        self.stored_receipt(&scope.key(&canonical, contents), &canonical)?
                            .filter(|row| row.manifest.is_some() == contents)
                            .map(|row| SerializedReceipt {
                                subject: subject.clone(),
                                ..row
                            }),
                    );
                }
            }
            evidence.push(ResourceReceipts {
                subject: subject.clone(),
                snapshot,
                receipts,
            });
        }
        self.flush()?;
        Ok(evidence)
    }

    /// Merge acknowledgements while exclusively owning the database receipt
    /// gate. Browser tabs route through the one elected Db owner; Db clones
    /// share this gate. Concurrent smaller vectors can never erase coverage.
    /// A Vault write carries the generation captured before its export and
    /// returns false when a clear has rotated it since.
    pub fn put_resource_receipts(
        &self,
        scope: &ReceiptScope,
        receipts: &[SerializedReceipt],
        generation: Option<u64>,
    ) -> AtomicResult<bool> {
        let scope = scope.canonical()?;
        if receipts.iter().any(|row| !row.valid()) {
            return Err("Invalid resource sync receipt".into());
        }
        let _guard = self.receipt_gate()?;
        if let ReceiptScope::Vault(vault) = &scope {
            let generation = generation.ok_or("Vault receipts need a generation")?;
            if generation > MAX_SAFE_INTEGER || generation != vault_generation(self, vault)? {
                return Ok(false);
            }
        }
        let mut merged = BTreeMap::<Vec<u8>, SerializedReceipt>::new();
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
            let key = scope.key(&subject, receipt.manifest.is_some());
            let mut incoming = receipt.clone();
            incoming.subject = subject.clone();
            let previous = match merged.remove(&key) {
                Some(row) => Some(row),
                None => self.stored_receipt(&key, &subject)?,
            };
            if let Some(previous) = previous {
                if incoming.manifest.is_some() {
                    // Contents proof is replaced, never merged, unless older.
                    if previous.confirmed_at > incoming.confirmed_at {
                        incoming = previous;
                    }
                } else {
                    incoming.confirmed_at = incoming.confirmed_at.max(previous.confirmed_at);
                    for (peer, counter) in previous.version {
                        let current = incoming.version.entry(peer).or_default();
                        *current = (*current).max(counter);
                    }
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

    /// Capture a durable, per-scope fence before exporting a backup. Clears
    /// rotate it so delayed writes from another tab cannot resurrect proof.
    pub fn get_resource_vault_generation(&self, scope: &VaultSyncScope) -> AtomicResult<u64> {
        let scope = scope.canonical()?;
        let _guard = self.receipt_gate()?;
        let generation = vault_generation(self, &scope)?;
        self.flush()?;
        Ok(generation)
    }

    /// Forget known backups after a confirmed vault disable. Other accounts,
    /// portals, drives and key epochs retain their independent evidence.
    pub fn clear_resource_vault_receipts(&self, scope: &VaultSyncScope) -> AtomicResult<()> {
        let scope = scope.canonical()?;
        let destination = ReceiptScope::Vault(scope.clone());
        let suffixes = [destination.key("", false), destination.key("", true)];
        let _guard = self.receipt_gate()?;
        let mut ops = Vec::new();
        for row in self.kv.iter_tree(Tree::SyncReceipts) {
            let (key, _) = row?;
            if suffixes.iter().any(|suffix| key.ends_with(suffix)) {
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
    fn open_file(path: &std::path::Path, url: Option<&str>) -> Db {
        Db::from_kv(
            Default::default(),
            Arc::new(super::super::redb_store::RedbStore::new_file(path).unwrap()),
            url.map(Into::into),
        )
    }
    fn temp(name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!("atomic-{name}-{}.redb", ulid::Ulid::new()))
    }
    fn scope() -> ResourceSyncScope {
        ResourceSyncScope {
            agent: "did:ad:alice".into(),
            server_url: "https://example.com/path".into(),
        }
    }
    fn server() -> ReceiptScope {
        ReceiptScope::Server(scope())
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
    fn vault(scope: &VaultSyncScope) -> ReceiptScope {
        ReceiptScope::Vault(scope.clone())
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
    fn receipt(peer: &str, counter: u64, time: u64) -> SerializedReceipt {
        SerializedReceipt {
            subject: "did:ad:resource".into(),
            version: BTreeMap::from([(peer.into(), counter)]),
            manifest: None,
            confirmed_at: time,
        }
    }
    fn contents(time: u64) -> SerializedReceipt {
        SerializedReceipt {
            subject: "atomic:resource".into(),
            version: BTreeMap::new(),
            manifest: Some(AttachmentManifest {
                files: vec![crate::sync::attachment_manifest::AttachmentFile {
                    subject: "atomic:file".into(),
                    hash: "a".repeat(64),
                    chunks: vec![],
                }],
            }),
            confirmed_at: time,
        }
    }
    fn put(db: &Db, scope: &ReceiptScope, rows: &[SerializedReceipt], generation: u64) -> bool {
        let generation = matches!(scope, ReceiptScope::Vault(_)).then_some(generation);
        db.put_resource_receipts(scope, rows, generation).unwrap()
    }
    fn read(db: &Db, subject: &str, scope: &ReceiptScope) -> ResourceReceipts {
        db.get_resource_receipts(&[subject.into()], Some(scope))
            .unwrap()
            .remove(0)
    }
    /// Every receipt kind the destination holds for the seeded resource.
    fn held(db: &Db, scope: &ReceiptScope) -> Vec<SerializedReceipt> {
        read(db, "atomic:resource", scope).receipts
    }

    #[test]
    fn contents_receipts_scope_generation_and_delete() {
        let db = store();
        let scope = vault_scope();
        seed(&db, "atomic:resource");
        let proof = contents(42);
        assert!(put(&db, &vault(&scope), std::slice::from_ref(&proof), 0));
        // A contents receipt is stored next to, not over, the document one.
        assert!(put(&db, &vault(&scope), &[receipt("1", 7, 10)], 0));
        assert_eq!(held(&db, &vault(&scope)).len(), 2);
        let mut other = scope.clone();
        other.key_epoch += 1;
        assert!(held(&db, &vault(&other)).is_empty());
        // Older contents proof never replaces newer.
        assert!(put(&db, &vault(&scope), &[contents(7)], 0));
        let stored: Vec<_> = held(&db, &vault(&scope))
            .into_iter()
            .filter(|row| row.manifest.is_some())
            .collect();
        assert_eq!(stored[0].confirmed_at, 42);
        db.clear_resource_vault_receipts(&scope).unwrap();
        assert!(!put(&db, &vault(&scope), std::slice::from_ref(&proof), 0));
        assert!(held(&db, &vault(&scope)).is_empty());
        assert!(put(&db, &vault(&scope), std::slice::from_ref(&proof), 1));
        db.kv
            .apply_batch(&remove_ops(&db, "atomic:resource").unwrap())
            .unwrap();
        assert!(held(&db, &vault(&scope)).is_empty());
    }

    #[test]
    fn rows_stored_before_the_stores_merged_stay_readable() {
        let db = store();
        seed(&db, "atomic:resource");
        let scope = vault_scope();
        let canonical = vault(&scope).canonical().unwrap();
        let ReceiptScope::Vault(canonical_vault) = &canonical else {
            unreachable!()
        };
        let json = serde_json::to_vec(canonical_vault).unwrap();
        // The three layouts the separate stores wrote, byte for byte.
        let server_key = b"atomic:resource\0atomic:alice\0https://example.com".to_vec();
        assert_eq!(
            server_key,
            server().canonical().unwrap().key("atomic:resource", false)
        );
        let mut vault_key = b"atomic:resource\0\0vault-v1\0".to_vec();
        let mut files_key = b"atomic:resource\0\0vault-attachments-v1\0".to_vec();
        vault_key.extend_from_slice(&json);
        files_key.extend_from_slice(&json);
        let doc = br#"{"subject":"atomic:resource","version":{"1":7},"confirmedAt":10}"#;
        let files = format!(
            r#"{{"subject":"atomic:resource","manifest":{},"confirmedAt":11}}"#,
            serde_json::to_string(&contents(0).manifest).unwrap()
        );
        for (key, value) in [
            (&server_key, doc.as_slice()),
            (&vault_key, doc.as_slice()),
            (&files_key, files.as_bytes()),
        ] {
            db.kv.insert(Tree::SyncReceipts, key, value).unwrap();
        }
        assert_eq!(held(&db, &server())[0].version["1"], 7);
        let rows = held(&db, &vault(&scope));
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].version["1"], 7);
        assert_eq!(rows[1].confirmed_at, 11);
        assert!(rows[1].manifest.is_some());
    }

    #[test]
    fn vault_receipts_merge_and_isolate_every_scope_dimension() {
        let db = store();
        seed(&db, "atomic:resource");
        let scope = vault_scope();
        put(&db, &vault(&scope), &[receipt("1", 7, 10)], 0);
        put(
            &db,
            &vault(&scope),
            &[receipt("1", 2, 8), receipt("2", 4, 12)],
            0,
        );
        assert_eq!(
            held(&db, &vault(&scope))[0].version,
            BTreeMap::from([("1".into(), 7), ("2".into(), 4)])
        );
        let mut normalized = scope.clone();
        normalized.portal_url.pop();
        normalized.drive = "atomic:drive".into();
        assert_eq!(held(&db, &vault(&normalized)).len(), 1);
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
            assert!(held(&db, &vault(&different)).is_empty());
        }
        assert!(held(&db, &server()).is_empty());
    }

    #[test]
    fn vault_receipts_survive_reopen_and_delete_with_server_receipts() {
        let path = temp("vault-receipts");
        let subject = "https://self.example/item";
        let row = SerializedReceipt {
            subject: subject.into(),
            version: BTreeMap::from([("1".into(), 7)]),
            manifest: None,
            confirmed_at: 10,
        };
        {
            let db = open_file(&path, Some("https://self.example"));
            seed(&db, "internal:/item");
            put(&db, &vault(&vault_scope()), std::slice::from_ref(&row), 0);
            put(&db, &server(), std::slice::from_ref(&row), 0);
        }
        {
            let db = open_file(&path, Some("https://self.example"));
            let rows = read(&db, subject, &vault(&vault_scope()));
            assert_eq!(rows.receipts[0].subject, subject);
            assert!(rows.snapshot.is_some());
            let mut ops = vec![
                Operation::remove_resource("internal:/item"),
                Operation::remove_loro_snapshot("internal:/item"),
            ];
            db.apply_transaction(&mut ops).unwrap();
            db.flush().unwrap();
            put(&db, &vault(&vault_scope()), &[row], 0);
            assert_eq!(db.kv.len(Tree::SyncReceipts).unwrap(), 0);
        }
        {
            let db = open_file(&path, Some("https://self.example"));
            assert!(read(&db, subject, &vault(&vault_scope()))
                .receipts
                .is_empty());
        }
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn vault_generation_fences_late_writes_across_reopen_and_repeated_clear() {
        let path = temp("vault-generation");
        let scope = vault_scope();
        {
            let db = open_file(&path, None);
            seed(&db, "atomic:resource");
            assert_eq!(db.get_resource_vault_generation(&scope).unwrap(), 0);
            assert!(put(&db, &vault(&scope), &[receipt("1", 7, 10)], 0));
            db.clear_resource_vault_receipts(&scope).unwrap();
        }
        {
            let db = open_file(&path, None);
            assert_eq!(db.get_resource_vault_generation(&scope).unwrap(), 1);
            assert!(!put(&db, &vault(&scope), &[receipt("1", 8, 11)], 0));
            assert!(held(&db, &vault(&scope)).is_empty());
            // A handoff may replay clear. Extra invalidation is conservative:
            // a newly captured generation can become stale, never vice versa.
            db.clear_resource_vault_receipts(&scope).unwrap();
            assert!(!put(&db, &vault(&scope), &[receipt("1", 8, 11)], 1));
            assert!(put(&db, &vault(&scope), &[receipt("1", 9, 12)], 2));
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
            .put_resource_receipts(&vault(&scope), &[receipt("1", 7, 10)], Some(0))
            .is_err());
        assert!(db.clear_resource_vault_receipts(&scope).is_err());
        // A vault write cannot be made without a captured generation.
        assert!(db
            .put_resource_receipts(&vault(&vault_scope()), &[], None)
            .is_err());
    }

    #[test]
    fn disabling_a_vault_clears_only_its_scope() {
        let db = store();
        seed(&db, "atomic:resource");
        let scope = vault_scope();
        let mut other = scope.clone();
        other.key_epoch += 1;
        for destination in [vault(&scope), vault(&other), server()] {
            put(&db, &destination, &[receipt("1", 7, 10)], 0);
        }
        put(&db, &vault(&scope), &[contents(11)], 0);
        db.clear_resource_vault_receipts(&scope).unwrap();
        assert!(held(&db, &vault(&scope)).is_empty());
        assert!(!held(&db, &vault(&other)).is_empty());
        assert!(!held(&db, &server()).is_empty());
    }

    #[test]
    fn vault_receipts_fail_closed_for_corruption_and_bad_scope() {
        let db = store();
        seed(&db, "atomic:resource");
        let scope = vault_scope();
        db.kv
            .insert(
                Tree::SyncReceipts,
                &vault(&scope)
                    .canonical()
                    .unwrap()
                    .key("atomic:resource", false),
                br#"{"subject":"atomic:resource","version":{"x":1},"confirmedAt":10}"#,
            )
            .unwrap();
        assert!(held(&db, &vault(&scope)).is_empty());
        let mut bad = scope;
        bad.portal_url = "file:///private".into();
        assert!(db
            .get_resource_receipts(&["atomic:resource".into()], Some(&vault(&bad)))
            .is_err());
        assert!(db
            .put_resource_receipts(&vault(&vault_scope()), &[receipt("bad", 1, 10)], Some(0))
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
        let receipt = SerializedReceipt {
            subject: subject.into(),
            ..receipt("1", 7, 10)
        };
        put(&db, &server(), &[receipt], 0);
        let rows = read(&db, subject, &server());
        assert_eq!(rows.subject, subject);
        assert_eq!(rows.receipts[0].subject, subject);
        assert!(rows.snapshot.is_some());
    }

    #[test]
    fn receipts_and_snapshot_survive_database_reopen() {
        let path = temp("sync-receipts");
        {
            let db = open_file(&path, None);
            seed(&db, "atomic:resource");
            put(&db, &server(), &[receipt("1", 7, 10)], 0);
        }
        {
            let db = open_file(&path, None);
            let rows = read(&db, "atomic:resource", &server());
            assert_eq!(
                rows.snapshot.as_deref(),
                Some(b"actual stored snapshot".as_slice())
            );
            assert_eq!(rows.receipts[0].version["1"], 7);
            let mut ops = vec![
                Operation::remove_resource("atomic:resource"),
                Operation::remove_loro_snapshot("atomic:resource"),
            ];
            db.apply_transaction(&mut ops).unwrap();
            db.flush().unwrap();
        }
        {
            let db = open_file(&path, None);
            assert_eq!(db.kv.len(Tree::SyncReceipts).unwrap(), 0);
        }
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn merges_coverage_and_isolates_scopes() {
        let db = store();
        seed(&db, "atomic:resource");
        put(&db, &server(), &[receipt("1", 7, 10)], 0);
        put(
            &db.clone(),
            &server(),
            &[receipt("1", 2, 8), receipt("2", 4, 12)],
            0,
        );
        let subjects = vec!["did:ad:resource".into()];
        let result = db
            .get_resource_receipts(&subjects, Some(&server()))
            .unwrap();
        assert_eq!(
            result[0].snapshot.as_deref(),
            Some(b"actual stored snapshot".as_slice())
        );
        let row = &result[0].receipts[0];
        assert_eq!(
            row.version,
            BTreeMap::from([("1".into(), 7), ("2".into(), 4)])
        );
        assert_eq!(row.confirmed_at, 12);
        assert!(db.get_resource_receipts(&subjects, None).unwrap()[0]
            .receipts
            .is_empty());
        let mut different = scope();
        different.agent = "atomic:bob".into();
        assert!(held(&db, &ReceiptScope::Server(different)).is_empty());
        different = scope();
        different.server_url = "https://other.example".into();
        assert!(held(&db, &ReceiptScope::Server(different)).is_empty());
    }

    #[test]
    fn deletion_atomically_cleans_every_scope_and_late_writes_are_ignored() {
        let db = store();
        seed(&db, "atomic:resource");
        seed(&db, "atomic:resource-other");
        let mut other = scope();
        other.agent = "atomic:bob".into();
        for scope in [server(), ReceiptScope::Server(other)] {
            put(&db, &scope, &[receipt("1", 7, 10)], 0);
        }
        let mut ops = vec![
            Operation::remove_resource("atomic:resource"),
            Operation::remove_loro_snapshot("atomic:resource"),
        ];
        db.apply_transaction(&mut ops).unwrap();
        assert_eq!(db.kv.len(Tree::SyncReceipts).unwrap(), 0);
        put(&db, &server(), &[receipt("1", 9, 11)], 0);
        assert_eq!(db.kv.len(Tree::SyncReceipts).unwrap(), 0);
        assert!(read(&db, "atomic:resource", &server()).snapshot.is_none());
        assert!(db
            .kv
            .contains_key(Tree::Resources, b"atomic:resource-other")
            .unwrap());
    }

    #[test]
    fn rejects_malformed_rows_and_missing_snapshots() {
        let db = store();
        seed(&db, "atomic:resource");
        let mut bad_manifest = contents(1);
        bad_manifest.manifest.as_mut().unwrap().files[0].hash = "short".into();
        for bad in [
            receipt("no-peer", 1, 10),
            receipt("01", 1, 10),
            receipt("1", i32::MAX as u64 + 1, 10),
            receipt("1", 1, MAX_SAFE_INTEGER + 1),
            bad_manifest,
        ] {
            assert!(db.put_resource_receipts(&server(), &[bad], None).is_err());
        }
        let key = server().canonical().unwrap().key("atomic:resource", false);
        for malformed in [
            b"not JSON".as_slice(),
            br#"{"subject":"atomic:resource","version":{"1":7},"confirmedAt":10,"schema":2}"#
                .as_slice(),
            br#"{"subject":"atomic:resource","version":{"1":-1},"confirmedAt":10}"#.as_slice(),
        ] {
            db.kv.insert(Tree::SyncReceipts, &key, malformed).unwrap();
            assert!(held(&db, &server()).is_empty());
        }
        db.kv
            .remove(Tree::LoroSnapshots, b"atomic:resource")
            .unwrap();
        put(&db, &server(), &[receipt("1", 9, 10)], 0);
        assert!(read(&db, "atomic:resource", &server()).snapshot.is_none());
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
        put(&db, &server(), &[receipt("1", 7, 10)], 0);
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
                    put(&db, &server(), &[receipt(&peer.to_string(), peer, peer)], 0);
                });
            }
        });
        assert_eq!(held(&db, &server())[0].version.len(), 12);
    }
}
