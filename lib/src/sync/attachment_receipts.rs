//! Resource-scoped byte evidence, derived only from stored applied state.
use super::{
    attachment_manifest::{valid_hash, AttachmentFile, AttachmentManifest, MAX_ATTACHMENT_FILES},
    storage_receipts::stored_resource,
};
use crate::{
    agents::ForAgent, errors::AtomicResult, loro::AtomicLoroDoc, urls, Db, Resource, Storelike,
    Subject, Value,
};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::Serialize;
use std::collections::VecDeque;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceAttachmentEvidence {
    pub subject: String,
    pub state: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub manifest: Option<AttachmentManifest>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub confirmed_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub replica: Option<crate::db::kv_store::ReplicaIdentity>,
}

#[derive(Default)]
pub struct AttachmentCache {
    entries: VecDeque<(u64, u64, String, i64)>,
    active: usize,
}

struct VerificationGuard(std::sync::Arc<std::sync::Mutex<AttachmentCache>>);
impl Drop for VerificationGuard {
    fn drop(&mut self) {
        if let Ok(mut cache) = self.0.lock() {
            cache.active = cache.active.saturating_sub(1);
        }
    }
}

fn public_subject(db: &Db, subject: &Subject) -> String {
    let subject = db.normalize_subject(subject);
    subject.resolve(&db.get_base_domain().unwrap_or_default())
}

pub(crate) fn file_manifest(
    db: &Db,
    resource: &Resource,
    required: bool,
) -> AtomicResult<Option<AttachmentFile>> {
    let is_file = resource.get(urls::IS_A).is_ok_and(|value| match value {
        Value::ResourceArray(classes) => classes
            .iter()
            .any(|class| class.to_string().as_str() == urls::FILE),
        _ => false,
    });
    let blob = resource.get(urls::BLOB).ok();
    let chunks = resource.get(urls::CHUNKS).ok();
    if !is_file && blob.is_none() && chunks.is_none() {
        return if required {
            Err("Attachment is not a File".into())
        } else {
            Ok(None)
        };
    }
    let internal = resource
        .get(urls::INTERNAL_ID)
        .ok()
        .map(ToString::to_string);
    if internal.as_ref().is_some_and(|hash| !valid_hash(hash)) {
        return Err("Invalid file hash".into());
    }
    let mut ordered = Vec::new();
    if let Some(chunks) = chunks {
        let Value::ResourceArray(chunks) = chunks else {
            return Err("Invalid file chunks".into());
        };
        if chunks.is_empty() || chunks.len() > super::attachment_manifest::MAX_ATTACHMENT_CHUNKS {
            return Err("Invalid file chunk count".into());
        }
        for chunk in chunks {
            let crate::values::SubResource::Subject(chunk) = chunk else {
                return Err("Nested chunks unsupported".into());
            };
            let hash = Subject::from(chunk.to_string().as_str())
                .blob_hash()
                .ok_or("Invalid chunk reference")?;
            ordered.push(hex::encode(hash));
        }
    }
    let blob_hash = blob
        .map(|value| {
            Subject::from(value.to_string().as_str())
                .blob_hash()
                .map(hex::encode)
                .ok_or("Invalid blob reference")
        })
        .transpose()?;
    let hash = if ordered.is_empty() {
        blob_hash
            .clone()
            .or(internal.clone())
            .ok_or("File content hash missing")?
    } else {
        internal.clone().ok_or("Chunked file whole hash missing")?
    };
    if internal.as_ref().is_some_and(|value| value != &hash)
        || blob_hash.as_ref().is_some_and(|value| value != &hash)
    {
        return Err("Inconsistent file hashes".into());
    }
    Ok(Some(AttachmentFile {
        subject: public_subject(db, resource.get_subject()),
        hash,
        chunks: ordered,
    }))
}

/// Local-only manifest and applied VV. Every referenced file must be locally
/// present and readable; unsupported or malformed references fail closed.
pub async fn derive_manifest(
    db: &Db,
    agent: &ForAgent,
    raw: &str,
) -> AtomicResult<(String, AttachmentManifest)> {
    let subject = db.normalize_subject(&Subject::from(raw));
    if super::tombstones::is_tombstoned(db, &subject.pure_id()) {
        return Err("Removed attachment root".into());
    }
    let root = stored_resource(db, &subject)?.ok_or("Attachment root not stored")?;
    crate::hierarchy::check_read(db, &root, agent).await?;
    let snapshot = db
        .get_loro_snapshot(&subject)
        .ok_or("Attachment snapshot missing")?;
    let doc = AtomicLoroDoc::from_snapshot(&snapshot)?;
    let version = STANDARD.encode(doc.doc().state_vv().encode());
    let mut files = Vec::new();
    if let Some(file) = file_manifest(db, &root, false)? {
        files.push(file);
    }
    if let Ok(attachments) = root.get(urls::ATTACHMENTS) {
        let Value::ResourceArray(attachments) = attachments else {
            return Err("Invalid attachment references".into());
        };
        if attachments.len() > MAX_ATTACHMENT_FILES {
            return Err("Too many attachments".into());
        }
        for reference in attachments {
            let crate::values::SubResource::Subject(reference) = reference else {
                return Err("Nested attachments unsupported".into());
            };
            let subject = db.normalize_subject(&Subject::from(reference.to_string().as_str()));
            if super::tombstones::is_tombstoned(db, &subject.pure_id()) {
                return Err("Removed attachment".into());
            }
            let file = stored_resource(db, &subject)?.ok_or("Attachment not stored")?;
            crate::hierarchy::check_read(db, &file, agent).await?;
            files.push(file_manifest(db, &file, true)?.ok_or("Attachment is not a file")?);
        }
    }
    files.sort_by(|a, b| a.subject.cmp(&b.subject));
    files.dedup_by(|a, b| a == b);
    let manifest = AttachmentManifest { files };
    if !manifest.validate() {
        return Err("Invalid attachment manifest".into());
    }
    Ok((version, manifest))
}

async fn verify_bytes(
    db: &Db,
    manifest: &AttachmentManifest,
    total: &mut usize,
    started: i64,
) -> AtomicResult<bool> {
    for file in &manifest.files {
        let mut whole = blake3::Hasher::new();
        let hashes = if file.chunks.is_empty() {
            std::slice::from_ref(&file.hash)
        } else {
            &file.chunks
        };
        for hash in hashes {
            if crate::utils::now().saturating_sub(started) > 10_000 {
                return Ok(false);
            }
            let key = hex::decode(hash).map_err(|error| error.to_string())?;
            let Some(size) = db.blob_size(&key).await? else {
                return Ok(false);
            };
            if size > 64 * 1024 * 1024 || (*total as u64).saturating_add(size) > 512 * 1024 * 1024 {
                return Ok(false);
            }
            let Some(bytes) = db
                .get_blob(&hex::decode(hash).map_err(|error| error.to_string())?)
                .await?
            else {
                return Ok(false);
            };
            *total = total.saturating_add(bytes.len());
            // Bound work and memory admission. Larger files remain unconfirmed.
            if *total > 512 * 1024 * 1024 || blake3::hash(&bytes).to_hex().as_str() != hash {
                return Ok(false);
            }
            whole.update(&bytes);
        }
        if whole.finalize().to_hex().as_str() != file.hash {
            return Ok(false);
        }
    }
    Ok(true)
}

/// Trusted private-cache entry point, like local resource/blob reads. Browser
/// workers do not carry a default signing agent. Never use this at a remote
/// boundary: HTTP and peers must supply their authenticated agent below.
pub async fn local_resource_attachment_evidence(
    db: &Db,
    subjects: &[String],
) -> AtomicResult<Vec<ResourceAttachmentEvidence>> {
    resource_attachment_evidence(db, &ForAgent::Sudo, subjects).await
}

pub async fn resource_attachment_evidence(
    db: &Db,
    agent: &ForAgent,
    subjects: &[String],
) -> AtomicResult<Vec<ResourceAttachmentEvidence>> {
    if subjects.len() > 128 {
        return Err("Too many attachment evidence subjects".into());
    }
    let admitted = db.attachment_cache.lock().ok().is_some_and(|mut cache| {
        if cache.active >= 2 {
            false
        } else {
            cache.active += 1;
            true
        }
    });
    let _guard = admitted.then(|| VerificationGuard(db.attachment_cache.clone()));
    let mut rows = Vec::with_capacity(subjects.len());
    let mut total = 0usize;
    let started = crate::utils::now();
    for subject in subjects {
        let mut row = ResourceAttachmentEvidence {
            subject: subject.clone(),
            state: "unknown",
            version: None,
            manifest: None,
            confirmed_at: None,
            replica: None,
        };
        if !admitted || crate::utils::now().saturating_sub(started) > 10_000 {
            rows.push(row);
            continue;
        }
        let generation = db.write_log().generation();
        let blob_generation = db.write_log().blob_generation();
        if let Ok((version, manifest)) = derive_manifest(db, agent, subject).await {
            row.version = Some(version);
            row.manifest = Some(manifest.clone());
            // Remote storage supplies its own verified-object contract; a
            // metadata KV barrier alone never certifies external file bytes.
            {
                let keys = manifest
                    .files
                    .iter()
                    .flat_map(|file| {
                        if file.chunks.is_empty() {
                            std::slice::from_ref(&file.hash)
                        } else {
                            &file.chunks
                        }
                    })
                    .map(hex::decode)
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(|error| error.to_string())?;
                let remote_token = if let Some(backend) = &db.blob_backend {
                    backend.durable_token(&keys).await?
                } else {
                    Some("local-kv".into())
                };
                if remote_token.is_none() {
                    rows.push(row);
                    continue;
                }
                let drive =
                    stored_resource(db, &db.normalize_subject(&Subject::from(subject.as_str())))?
                        .and_then(|r| r.get(urls::DRIVE_PROP).ok().map(ToString::to_string))
                        .unwrap_or_else(|| subject.clone());
                if let (Some(blob_generation), Some(identity)) =
                    (blob_generation, db.kv.replica_identity(&drive)?)
                {
                    let key = serde_json::to_string(&(&manifest, &identity, &remote_token))?;
                    let cached = db.attachment_cache.lock().ok().and_then(|cache| {
                        cache
                            .entries
                            .iter()
                            .find(|entry| entry.1 == blob_generation && entry.2 == key)
                            .map(|entry| entry.3)
                    });
                    let checked = cached.is_some()
                        || verify_bytes(db, &manifest, &mut total, started)
                            .await
                            .unwrap_or(false);
                    if checked {
                        db.flush()?;
                        let remote_stable = if let Some(backend) = &db.blob_backend {
                            backend.durable_token(&keys).await? == remote_token
                        } else {
                            true
                        };
                        if remote_stable
                            && db.write_log().generation() == generation
                            && db.write_log().blob_generation() == Some(blob_generation)
                            && db.kv.replica_identity(&drive)? == Some(identity.clone())
                        {
                            let at = cached.unwrap_or_else(crate::utils::now);
                            row.state = "confirmed";
                            row.confirmed_at = Some(at);
                            row.replica = Some(identity);
                            if cached.is_none() {
                                if let Ok(mut cache) = db.attachment_cache.lock() {
                                    if cache.entries.len() >= 128 {
                                        cache.entries.pop_front();
                                    }
                                    cache
                                        .entries
                                        .push_back((generation, blob_generation, key, at));
                                }
                            }
                        }
                    }
                }
            }
        }
        rows.push(row);
    }
    Ok(rows)
}

/// Capability-gated responder. The caller owns authenticated transport scope.
pub async fn produce_receipt(
    db: &Db,
    agent: &ForAgent,
    drive: &str,
    request: &super::protocol::AttachmentReceiptRequest,
) -> AtomicResult<Option<super::protocol::AttachmentReceipt>> {
    if !request.validate() || request.drive != drive || matches!(agent, ForAgent::Public) {
        return Err("Invalid attachment receipt scope".into());
    }
    if db.blob_backend.is_some() {
        return Ok(None);
    }
    let generation = db.write_log().generation();
    let blob_generation = db.write_log().blob_generation();
    let Some(metadata) =
        super::storage_receipts::produce_receipt(db, agent, drive, &request.metadata()).await?
    else {
        return Ok(None);
    };
    let rows =
        resource_attachment_evidence(db, agent, std::slice::from_ref(&request.subject)).await?;
    if rows.first().is_none_or(|row| {
        row.state != "confirmed" || row.manifest.as_ref() != Some(&request.manifest)
    }) || db.write_log().generation() != generation
        || db.write_log().blob_generation() != blob_generation
    {
        return Ok(None);
    }
    Ok(Some(super::protocol::AttachmentReceipt {
        nonce: request.nonce.clone(),
        drive: request.drive.clone(),
        subject: request.subject.clone(),
        version: request.version.clone(),
        manifest: request.manifest.clone(),
        replica: metadata.replica,
        barrier: super::protocol::ATTACHMENT_RECEIPT_BARRIER.into(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::trees::Tree;

    async fn fixture() -> (Db, String, ForAgent) {
        let db = Db::init_temp(&format!(
            "attachment-proof-{}",
            super::super::protocol::new_challenge_nonce()
        ))
        .await
        .unwrap();
        let (owner, drive) = db.setup("Attachment owner").await.unwrap();
        (db, drive, ForAgent::from(&owner))
    }
    async fn file(db: &Db, drive: &str, bytes: &[u8], chunks: Option<Vec<Value>>) -> String {
        let hash = blake3::hash(bytes).to_hex().to_string();
        let mut props = vec![
            (urls::INTERNAL_ID, Value::String(hash.clone())),
            (
                urls::DOWNLOAD_URL,
                Value::AtomicUrl(format!("https://localhost/download/{hash}").into()),
            ),
        ];
        if let Some(chunks) = chunks {
            props.push((
                urls::CHUNKS,
                Value::ResourceArray(
                    chunks
                        .into_iter()
                        .map(|v| crate::values::SubResource::Subject(v.to_string().as_str().into()))
                        .collect(),
                ),
            ));
        } else {
            props.push((
                urls::BLOB,
                Value::AtomicUrl(format!("atomic:blob:{hash}").into()),
            ));
        }
        db.create_resource(urls::FILE, drive, "proof.txt", Some(props))
            .await
            .unwrap()
    }
    async fn evidence(db: &Db, agent: &ForAgent, subject: &str) -> ResourceAttachmentEvidence {
        resource_attachment_evidence(db, agent, &[subject.into()])
            .await
            .unwrap()
            .remove(0)
    }

    #[tokio::test]
    async fn attachment_private_browser_cache_without_default_agent() {
        let (db, drive, _) = fixture().await;
        let first = b"private first chunk";
        let second = b"private second chunk";
        let first_hash = blake3::hash(first);
        let second_hash = blake3::hash(second);
        let bytes = [first.as_slice(), second.as_slice()].concat();
        let subject = file(
            &db,
            &drive,
            &bytes,
            Some(vec![
                Value::AtomicUrl(format!("atomic:blob:{first_hash}").into()),
                Value::AtomicUrl(format!("atomic:blob:{second_hash}").into()),
            ]),
        )
        .await;
        db.put_blob(first_hash.as_bytes(), first).await.unwrap();
        db.put_blob(second_hash.as_bytes(), second).await.unwrap();
        db.clear_default_agent();
        assert!(db.get_default_agent().is_err());
        assert_eq!(
            evidence(&db, &ForAgent::Public, &subject).await.state,
            "unknown",
            "remote anonymous readers remain unauthorized"
        );
        let rows = local_resource_attachment_evidence(&db, std::slice::from_ref(&subject))
            .await
            .unwrap();
        assert_eq!(rows[0].state, "confirmed");
        let inventory = crate::vault::sync::vault_attachment_manifests(&db, &drive.as_str().into())
            .await
            .unwrap();
        assert!(inventory
            .iter()
            .any(|row| row.subject == subject && Some(&row.manifest) == rows[0].manifest.as_ref()));
        let whole = blake3::hash(&bytes);
        assert!(db.get_blob(whole.as_bytes()).await.unwrap().is_none());
        assert_eq!(
            crate::vault::sync::read_verified_blob(&db, whole.to_hex().as_ref())
                .await
                .unwrap(),
            Some(bytes)
        );
        let hashes = crate::vault::sync::drive_file_hashes(&db, &drive.as_str().into()).await;
        assert!(
            hashes.contains(&first_hash.to_hex().to_string())
                && hashes.contains(&second_hash.to_hex().to_string())
                && hashes.contains(&whole.to_hex().to_string())
        );
    }

    #[tokio::test]
    async fn attachment_bytes_missing_corrupt_cached_delete_and_empty() {
        let (db, drive, agent) = fixture().await;
        let bytes = b"real file contents";
        let subject = file(&db, &drive, bytes, None).await;
        let hash = blake3::hash(bytes);
        assert_eq!(evidence(&db, &agent, &subject).await.state, "unknown");
        db.put_blob(hash.as_bytes(), bytes).await.unwrap();
        assert_eq!(evidence(&db, &agent, &subject).await.state, "confirmed");
        // Raw WASM/KV writes are also visible to the proof cache fence.
        db.kv
            .insert(Tree::Blobs, hash.as_bytes(), b"fake file contents")
            .unwrap();
        assert_eq!(evidence(&db, &agent, &subject).await.state, "unknown");
        db.put_blob(hash.as_bytes(), bytes).await.unwrap();
        assert_eq!(evidence(&db, &agent, &subject).await.state, "confirmed");
        db.blob_store().delete(hash.as_bytes()).await.unwrap();
        assert_eq!(evidence(&db, &agent, &subject).await.state, "unknown");
        let empty = file(&db, &drive, b"", None).await;
        db.put_blob(blake3::hash(b"").as_bytes(), b"")
            .await
            .unwrap();
        assert_eq!(evidence(&db, &agent, &empty).await.state, "confirmed");
        db.begin_batch();
        assert_eq!(evidence(&db, &agent, &empty).await.state, "unknown");
        db.commit_batch().unwrap();
    }

    #[tokio::test]
    async fn attachment_chunks_require_each_hash_and_ordered_whole() {
        let (db, drive, agent) = fixture().await;
        let first = b"part one";
        let second = b"part two";
        let first_hash = blake3::hash(first);
        let second_hash = blake3::hash(second);
        let chunks = || {
            vec![
                Value::AtomicUrl(format!("atomic:blob:{first_hash}").into()),
                Value::AtomicUrl(format!("atomic:blob:{second_hash}").into()),
            ]
        };
        let all = [first.as_slice(), second.as_slice()].concat();
        let subject = file(&db, &drive, &all, Some(chunks())).await;
        db.put_blob(first_hash.as_bytes(), first).await.unwrap();
        assert_eq!(evidence(&db, &agent, &subject).await.state, "unknown");
        db.put_blob(second_hash.as_bytes(), second).await.unwrap();
        assert_eq!(evidence(&db, &agent, &subject).await.state, "confirmed");
        let mut reversed = chunks();
        reversed.reverse();
        let wrong = file(&db, &drive, &all, Some(reversed)).await;
        assert_eq!(evidence(&db, &agent, &wrong).await.state, "unknown");
    }

    #[tokio::test]
    async fn attachment_direct_refs_and_child_edit_are_in_manifest() {
        let (db, drive, agent) = fixture().await;
        let subject = file(&db, &drive, b"old", None).await;
        db.put_blob(blake3::hash(b"old").as_bytes(), b"old")
            .await
            .unwrap();
        let root = db
            .create_resource(
                urls::FOLDER,
                &drive,
                "with attachment",
                Some(vec![(
                    urls::ATTACHMENTS,
                    Value::ResourceArray(vec![crate::values::SubResource::Subject(
                        subject.as_str().into(),
                    )]),
                )]),
            )
            .await
            .unwrap();
        let before = evidence(&db, &agent, &root).await;
        assert_eq!(before.state, "confirmed");
        let mut child = db.get_resource(&subject.as_str().into()).await.unwrap();
        let new_hash = blake3::hash(b"new").to_hex().to_string();
        child
            .set(
                urls::INTERNAL_ID.into(),
                Value::String(new_hash.clone()),
                &db,
            )
            .await
            .unwrap();
        child
            .set(
                urls::BLOB.into(),
                Value::AtomicUrl(format!("atomic:blob:{new_hash}").into()),
                &db,
            )
            .await
            .unwrap();
        child.save(&db).await.unwrap();
        let after = evidence(&db, &agent, &root).await;
        assert_eq!(after.version, before.version);
        assert_ne!(after.manifest, before.manifest);
        assert_eq!(after.state, "unknown");
        let stranger = crate::agents::Agent::new(Some("stranger")).unwrap();
        assert!(evidence(&db, &ForAgent::from(&stranger), &root)
            .await
            .manifest
            .is_none());
    }

    #[tokio::test]
    async fn attachment_wire_requires_manifest_and_bound_nonce() {
        let (db, drive, agent) = fixture().await;
        let subject = file(&db, &drive, b"wire", None).await;
        db.put_blob(blake3::hash(b"wire").as_bytes(), b"wire")
            .await
            .unwrap();
        let row = evidence(&db, &agent, &subject).await;
        let mut request = super::super::protocol::AttachmentReceiptRequest {
            nonce: "a".repeat(64),
            drive,
            subject,
            version: row.version.unwrap(),
            manifest: row.manifest.unwrap(),
        };
        let receipt = produce_receipt(&db, &agent, &request.drive, &request)
            .await
            .unwrap()
            .unwrap();
        let frame = receipt.encode_frame().unwrap();
        assert_eq!(frame[0], 0x59);
        assert_eq!(
            super::super::protocol::AttachmentReceipt::decode(&frame[1..]),
            Some(receipt)
        );
        request.manifest.files[0].hash = "b".repeat(64);
        assert!(produce_receipt(&db, &agent, &request.drive, &request)
            .await
            .unwrap()
            .is_none());
        request.nonce = "invalid".into();
        assert!(request.encode_frame().is_none());
    }
}
