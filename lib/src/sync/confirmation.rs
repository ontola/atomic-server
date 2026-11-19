//! Strict attachment-reference parsing for drive confirmation.
//!
//! Chunked files are reconstructed from their ordered chunks, not from their
//! whole-file internalId. Otherwise both a blob DID and internalId, when
//! present, must name available bytes. Never scan arbitrary text for hashes.

use crate::{errors::AtomicResult, urls, Resource, Subject, Value};

/// The content-addressed objects needed to reconstruct this resource's files.
/// A malformed attachment reference is an error, never an empty inventory.
pub fn attachment_hashes(resource: &Resource) -> AtomicResult<Vec<[u8; 32]>> {
    if let Ok(chunks) = resource.get(urls::CHUNKS) {
        let Value::ResourceArray(chunks) = chunks else {
            return Err("Invalid chunk list".into());
        };
        if !chunks.is_empty() {
            return chunks
                .iter()
                .map(|chunk| {
                    Subject::from_raw(&chunk.to_string(), None)
                        .blob_hash()
                        .ok_or_else(|| "Invalid chunk reference".into())
                })
                .collect();
        }
    }

    let mut hashes = Vec::new();
    if let Ok(blob) = resource.get(urls::BLOB) {
        hashes.push(
            Subject::from_raw(&blob.to_string(), None)
                .blob_hash()
                .ok_or("Invalid blob reference")?,
        );
    }
    if let Ok(internal_id) = resource.get(urls::INTERNAL_ID) {
        let bytes =
            hex::decode(internal_id.to_string()).map_err(|_| "Invalid internalId blob hash")?;
        let hash: [u8; 32] = bytes
            .try_into()
            .map_err(|_| "Invalid internalId blob hash")?;
        if !hashes.contains(&hash) {
            hashes.push(hash);
        }
    }
    if hashes.is_empty() && resource.has_class(urls::FILE) {
        return Err("File has no supported local bytes".into());
    }
    Ok(hashes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::resources::PropVals;

    fn resource(properties: Vec<(&str, Value)>) -> Resource {
        let props: PropVals = properties.into_iter().map(|(k, v)| (k.into(), v)).collect();
        Resource::from_propvals(props, "atomic:test".into())
    }

    #[test]
    fn chunk_references_override_whole_file_id() {
        let a = Subject::from_blob_hash(&[1; 32]);
        let b = Subject::from_blob_hash(&[2; 32]);
        let file = resource(vec![
            (urls::CHUNKS, Value::ResourceArray(vec![a.into(), b.into()])),
            (urls::INTERNAL_ID, Value::String(hex::encode([3; 32]))),
        ]);
        assert_eq!(attachment_hashes(&file).unwrap(), vec![[1; 32], [2; 32]]);
    }

    #[test]
    fn unchunked_blob_and_internal_id_are_checked() {
        let file = resource(vec![
            (
                urls::BLOB,
                Value::AtomicUrl(Subject::from_blob_hash(&[1; 32])),
            ),
            (urls::INTERNAL_ID, Value::String(hex::encode([1; 32]))),
        ]);
        assert_eq!(attachment_hashes(&file).unwrap(), vec![[1; 32]]);
    }

    #[test]
    fn file_without_backing_bytes_is_not_confirmed() {
        let file = resource(vec![(
            urls::IS_A,
            Value::ResourceArray(vec![urls::FILE.into()]),
        )]);
        assert!(attachment_hashes(&file).is_err());
    }

    #[test]
    fn malformed_references_fail_closed() {
        for (property, value) in [
            (urls::CHUNKS, Value::String("invalid".into())),
            (urls::BLOB, Value::String("invalid".into())),
            (urls::INTERNAL_ID, Value::String("invalid".into())),
        ] {
            assert!(attachment_hashes(&resource(vec![(property, value)])).is_err());
        }
    }
}

use super::engine::{compute_drive_hash_v2, WireScheme};
use crate::{
    agents::{Agent, ForAgent},
    atoms::Atom,
    db::{encoding::decode_propvals, trees::Tree, Db},
    loro::AtomicLoroDoc,
    storelike::{Query, QueryResult},
    Storelike,
};
use async_trait::async_trait;
use std::collections::{HashMap, HashSet};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};

type StoredResource = (Resource, Option<Vec<u8>>);

/// A strict, local-only view used by the rights walker. It cannot fetch a
/// missing ancestor; any such lookup makes the whole proof inconclusive.
struct LocalView<'a> {
    db: &'a Db,
    resources: Mutex<HashMap<String, StoredResource>>,
    failed: AtomicBool,
}

impl LocalView<'_> {
    fn read(&self, subject: &Subject) -> AtomicResult<StoredResource> {
        let subject = self.db.normalize_subject(subject);
        if !subject.is_local() {
            return Err("External rights subject".into());
        }
        let key = WireScheme::CANONICAL.subject(&subject.pure_id());
        if let Some(found) = self
            .resources
            .lock()
            .map_err(|_| "Cache lock poisoned")?
            .get(&key)
            .cloned()
        {
            return Ok(found);
        }
        let row = self
            .db
            .kv
            .get(Tree::Resources, key.as_bytes())?
            .ok_or("Missing local resource")?;
        let mut resource = Resource::from_propvals(decode_propvals(&row)?, subject);
        let snapshot = self.db.kv.get(Tree::LoroSnapshots, key.as_bytes())?;
        if let Some(bytes) = &snapshot {
            let doc = AtomicLoroDoc::from_snapshot(bytes)?;
            resource.apply_state_doc_with_snapshot(doc, bytes.clone())?;
        }
        self.resources
            .lock()
            .map_err(|_| "Cache lock poisoned")?
            .insert(key, (resource.clone(), snapshot.clone()));
        Ok((resource, snapshot))
    }
}

#[cfg_attr(target_arch = "wasm32", async_trait(?Send))]
#[cfg_attr(not(target_arch = "wasm32"), async_trait)]
impl Storelike for LocalView<'_> {
    async fn add_resource_opts(&self, _: &Resource, _: bool, _: bool, _: bool) -> AtomicResult<()> {
        Err("read-only".into())
    }
    fn all_resources(&self, _: bool) -> Box<dyn Iterator<Item = Resource> + Send> {
        Box::new(std::iter::empty())
    }

    async fn add_atoms(&self, _: Vec<Atom>) -> AtomicResult<()> {
        Err("read-only".into())
    }
    fn add_drive_mapping(&self, _: &str, _: &Value) -> AtomicResult<()> {
        Err("read-only".into())
    }
    fn remove_drive_mapping(&self, _: &str) -> AtomicResult<()> {
        Err("read-only".into())
    }
    fn get_base_domain(&self) -> Option<String> {
        self.db.get_base_domain()
    }
    fn normalize_subject(&self, subject: &Subject) -> Subject {
        self.db.normalize_subject(subject)
    }
    fn get_default_agent(&self) -> AtomicResult<Agent> {
        self.db.get_default_agent()
    }
    async fn get_resource(&self, subject: &Subject) -> AtomicResult<Resource> {
        self.read(subject)
            .map(|(resource, _)| resource)
            .inspect_err(|_| {
                self.failed.store(true, Ordering::Relaxed);
            })
    }
    async fn remove_resource(&self, _: &Subject) -> AtomicResult<()> {
        Err("read-only".into())
    }
    async fn query(&self, _: &Query) -> AtomicResult<QueryResult> {
        Err("read-only".into())
    }
    fn set_default_agent(&self, _: Agent) {}
}

/// A fresh proof from stored rows; never use the cached sync-probe hash.
/// Errors (including concurrent writes) leave the caller unconfirmed.
pub async fn confirm_drive(
    db: &Db,
    drive: &Subject,
    agent: &ForAgent,
    expected: &str,
) -> AtomicResult<(String, bool, u64)> {
    let before = db
        .write_log()
        .confirmation_token()
        .ok_or("Write in progress")?;
    let canonical = WireScheme::CANONICAL;
    let drive_key = canonical.subject(&db.normalize_subject(drive).pure_id());
    let view = LocalView {
        db,
        resources: Mutex::new(HashMap::new()),
        failed: AtomicBool::new(false),
    };
    let root = view.read(drive)?.0;
    crate::hierarchy::check_read(&view, &root, agent).await?;
    if view.failed.load(Ordering::Relaxed) {
        return Err("Incomplete rights walk".into());
    }
    let mut members = HashSet::from([drive_key.clone()]);
    if drive.is_did() {
        let mut queue = vec![drive_key.clone()];
        while let Some(parent) = queue.pop() {
            let parent_subject = Subject::from_raw(&parent, db.get_base_domain().as_deref());
            for child in crate::db::prop_val_sub_index::strict_children(db, &parent_subject)? {
                let key = canonical.subject(&db.normalize_subject(&child).pure_id());
                let resource = view.read(&child)?.0;
                let actual = resource.get(urls::PARENT)?;
                let actual_key = canonical.subject(
                    &db.normalize_subject(&Subject::from(actual.to_string()))
                        .pure_id(),
                );
                if actual_key != parent {
                    return Err("Stale parent index".into());
                }
                if members.insert(key.clone()) {
                    queue.push(key);
                }
            }
        }
    } else {
        let prefix = drive_key.as_bytes().to_vec();
        let mut end = prefix.clone();
        while end.last() == Some(&0xff) {
            end.pop();
        }
        let Some(last) = end.last_mut() else {
            return Err("Invalid drive prefix".into());
        };
        *last += 1;
        let mut start = prefix;
        loop {
            let page = db.kv.range_page(Tree::Resources, start, end.clone(), 512)?;
            let Some((last, _)) = page.last() else { break };
            start = last.clone();
            start.push(0);
            let full = page.len() == 512;
            for (key, _) in page {
                let raw = String::from_utf8(key).map_err(|_| "Invalid stored subject")?;
                let subject = Subject::from_raw(&raw, db.get_base_domain().as_deref());
                if !subject.is_commit_did() {
                    members.insert(canonical.subject(&subject.pure_id()));
                }
            }
            if !full {
                break;
            }
        }
    }
    let mut vectors = HashMap::new();
    let mut blobs = HashSet::new();
    for subject in members {
        let (resource, snapshot) = view.read(&Subject::from(subject.clone()))?;
        let allowed = crate::hierarchy::check_read(&view, &resource, agent).await;
        if view.failed.load(Ordering::Relaxed) {
            return Err("Incomplete rights walk".into());
        }
        if let Err(e) = allowed {
            if e.error_type == crate::errors::AtomicErrorType::UnauthorizedError {
                continue;
            }
            return Err(e);
        }
        let snapshot = snapshot.ok_or("Missing resource snapshot")?;
        vectors.insert(subject, AtomicLoroDoc::vv_map_from_snapshot(&snapshot)?);
        blobs.extend(attachment_hashes(&resource)?);
    }
    let hash = compute_drive_hash_v2(&vectors);
    if hash != expected {
        return Ok((hash, false, 0));
    }
    let mut complete = true;
    for blob in &blobs {
        if !db.verified_blob(blob).await? {
            complete = false;
        }
    }
    db.flush()?;
    if db.write_log().confirmation_token() != Some(before) {
        return Err("Concurrent write during confirmation".into());
    }
    Ok((
        hash.clone(),
        complete && hash == expected,
        blobs.len() as u64,
    ))
}

#[cfg(test)]
mod proof_tests {
    use super::*;

    #[tokio::test]
    async fn private_drive_cannot_be_proved_for_public_caller() {
        let db = Db::init_temp("confirmation_private").await.unwrap();
        let (_agent, drive) = db.setup("Alice").await.unwrap();
        let drive: Subject = drive.as_str().into();
        let err = confirm_drive(&db, &drive, &ForAgent::Public, "")
            .await
            .unwrap_err();
        assert_eq!(
            err.error_type,
            crate::errors::AtomicErrorType::UnauthorizedError
        );
    }

    #[tokio::test]
    async fn chunked_file_requires_each_chunk_but_not_whole_file_blob() {
        let db = Db::init_temp("confirmation_chunks").await.unwrap();
        let (_agent, drive) = db.setup("Alice").await.unwrap();
        let first = b"first chunk";
        let second = b"second chunk";
        let a = blake3::hash(first);
        let b = blake3::hash(second);
        db.create_resource(
            urls::FILE,
            &drive,
            "chunked",
            Some(vec![
                (
                    urls::CHUNKS,
                    Value::ResourceArray(vec![
                        Subject::from_blob_hash(a.as_bytes()).into(),
                        Subject::from_blob_hash(b.as_bytes()).into(),
                    ]),
                ),
                (urls::INTERNAL_ID, Value::String(hex::encode([3; 32]))),
            ]),
        )
        .await
        .unwrap();
        let drive: Subject = drive.as_str().into();
        let (hash, _, _) = confirm_drive(&db, &drive, &ForAgent::Sudo, "")
            .await
            .unwrap();
        db.put_blob(a.as_bytes(), first).await.unwrap();
        assert!(
            !confirm_drive(&db, &drive, &ForAgent::Sudo, &hash)
                .await
                .unwrap()
                .1
        );
        db.put_blob(b.as_bytes(), second).await.unwrap();
        let (_, confirmed, checked) = confirm_drive(&db, &drive, &ForAgent::Sudo, &hash)
            .await
            .unwrap();
        assert!(confirmed);
        assert_eq!(checked, 2);
    }

    #[tokio::test]
    async fn missing_and_corrupt_blob_cannot_confirm_matching_metadata() {
        let db = Db::init_temp("confirmation_missing_blob").await.unwrap();
        let (_agent, drive) = db.setup("Alice").await.unwrap();
        let bytes = b"attachment bytes";
        let hash = blake3::hash(bytes);
        db.create_resource(
            urls::FILE,
            &drive,
            "attachment",
            Some(vec![
                (
                    urls::BLOB,
                    Value::AtomicUrl(Subject::from_blob_hash(hash.as_bytes())),
                ),
                (urls::INTERNAL_ID, Value::String(hash.to_hex().to_string())),
            ]),
        )
        .await
        .unwrap();
        let drive: Subject = drive.as_str().into();
        let (metadata_hash, _, count) = confirm_drive(&db, &drive, &ForAgent::Sudo, "")
            .await
            .unwrap();
        assert_eq!(count, 0);
        assert!(
            !confirm_drive(&db, &drive, &ForAgent::Sudo, &metadata_hash)
                .await
                .unwrap()
                .1
        );
        db.put_blob(hash.as_bytes(), b"corrupt").await.unwrap();
        assert!(
            !confirm_drive(&db, &drive, &ForAgent::Sudo, &metadata_hash)
                .await
                .unwrap()
                .1
        );
        db.put_blob(hash.as_bytes(), bytes).await.unwrap();
        // An unrelated corrupt row must not be loaded into this drive proof.
        for index in 0..1000 {
            db.kv
                .insert(
                    Tree::Resources,
                    format!("atomic:unrelated{index:04}").as_bytes(),
                    b"corrupt",
                )
                .unwrap();
        }
        assert!(
            confirm_drive(&db, &drive, &ForAgent::Sudo, &metadata_hash)
                .await
                .unwrap()
                .1
        );
    }
}
