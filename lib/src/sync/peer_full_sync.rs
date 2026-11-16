//! An Iroh peer can confirm a complete, durable copy of one drive.

use std::collections::{BTreeMap, HashMap, HashSet};

use crate::{agents::ForAgent, db::trees::Tree, urls, Db, Resource, Storelike, Subject, Value};

use super::{engine, peer::normalize_node_id, protocol};

const RECEIPT_PREFIX: &[u8] = b"_iroh_full_sync_v1/";

pub(super) fn peer_capabilities() -> Vec<&'static str> {
    let mut caps = protocol::CAPABILITIES.to_vec();
    caps.push(protocol::CAP_PEER_FULL_SYNC);
    caps
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub(super) struct FullSyncCheck {
    pub drive: String,
    nonce: String,
    pub hash: String,
}

impl FullSyncCheck {
    pub(super) fn new(drive: String, hash: String) -> Self {
        Self {
            drive,
            nonce: hex::encode(rand::random::<[u8; 16]>()),
            hash,
        }
    }

    pub(super) fn encode(&self, tag: u8) -> Vec<u8> {
        let mut frame = vec![tag];
        frame.extend(serde_json::to_vec(self).expect("serializing a full sync check"));
        frame
    }

    pub(super) fn decode(payload: &[u8]) -> Option<Self> {
        if payload.len() > 8192 {
            return None;
        }
        let check: Self = serde_json::from_slice(payload).ok()?;
        let is_hex = |s: &str, len| s.len() == len && s.bytes().all(|c| c.is_ascii_hexdigit());
        (is_hex(&check.nonce, 32) && is_hex(&check.hash, 64) && !check.drive.is_empty())
            .then_some(check)
    }
}

pub(super) fn normalized_drive(store: &Db, drive: &str) -> String {
    Subject::from_raw(drive, store.get_base_domain().as_deref()).pure_id()
}

fn receipt_prefix(store: &Db, drive: &str) -> Vec<u8> {
    let drive = normalized_drive(store, drive);
    let mut prefix = RECEIPT_PREFIX.to_vec();
    prefix.extend_from_slice(blake3::hash(drive.as_bytes()).as_bytes());
    prefix
}

pub(super) fn record_full_sync(
    store: &Db,
    peer: &str,
    drive: &str,
) -> crate::errors::AtomicResult<()> {
    let mut key = receipt_prefix(store, drive);
    key.extend_from_slice(normalize_node_id(peer).as_bytes());
    store
        .kv
        .insert(Tree::PluginMeta, &key, &crate::utils::now().to_be_bytes())?;
    store.flush()
}

pub fn last_confirmed_full_syncs(store: &Db, drive: &str) -> BTreeMap<String, i64> {
    let prefix = receipt_prefix(store, drive);
    store
        .kv
        .scan_prefix(Tree::PluginMeta, &prefix)
        .filter_map(|row| {
            let (key, value) = row.ok()?;
            let peer = std::str::from_utf8(key.get(prefix.len()..)?).ok()?;
            Some((peer.to_owned(), i64::from_be_bytes(value.try_into().ok()?)))
        })
        .collect()
}

/// Work only from persistent resource rows, and require read permission for
/// every resource in the drive before disclosing its hash or attesting to it.
async fn drive_state(
    store: &Db,
    drive: &str,
    agent: &ForAgent,
    wire: engine::WireScheme,
) -> Option<(String, Vec<Resource>, u64)> {
    if !matches!(agent, ForAgent::AgentSubject(_)) {
        return None;
    }
    let generation = store.write_log().generation();
    let root = Subject::from_raw(drive, store.get_base_domain().as_deref());
    let subjects = engine::collect_drive_subjects(store, &root).await;
    let vectors = engine::build_drive_vvs(store, &subjects);
    if vectors.len() != subjects.len() {
        return None;
    }

    let mut resources = Vec::with_capacity(subjects.len());
    for id in &subjects {
        let propvals = store.get_propvals(id).ok()?;
        let resource = Resource::from_propvals(
            propvals,
            Subject::from_raw(id, store.get_base_domain().as_deref()),
        );
        crate::hierarchy::check_read(store, &resource, agent)
            .await
            .ok()?;
        resources.push(resource);
    }

    let wire_vectors: HashMap<_, _> = vectors
        .into_iter()
        .map(|(subject, version)| (wire.subject(&subject), version))
        .collect();
    let hash = engine::compute_drive_hash_v2(&wire_vectors);
    (store.write_log().generation() == generation).then_some((hash, resources, generation))
}

pub(super) async fn make_check(
    store: &Db,
    drive: &str,
    agent: &ForAgent,
    wire: engine::WireScheme,
) -> Option<(FullSyncCheck, u64)> {
    let (hash, _, generation) = drive_state(store, drive, agent, wire).await?;
    Some((FullSyncCheck::new(wire.subject(drive), hash), generation))
}

pub(super) async fn matching_generation(
    store: &Db,
    check: &FullSyncCheck,
    agent: &ForAgent,
    wire: engine::WireScheme,
    generation: u64,
) -> Option<u64> {
    if store.write_log().generation() == generation {
        return Some(generation);
    }
    // Other drives and system resources can change during a proof. Only a
    // change to this authenticated drive invalidates the matching digest.
    let (hash, _, current_generation) = drive_state(store, &check.drive, agent, wire).await?;
    (hash == check.hash).then_some(current_generation)
}

pub(super) async fn confirm_check(
    store: &Db,
    check: &FullSyncCheck,
    agent: &ForAgent,
    wire: engine::WireScheme,
) -> Option<Vec<u8>> {
    let (hash, resources, generation) = drive_state(store, &check.drive, agent, wire).await?;
    if hash != check.hash || !verify_drive_files(store, &resources).await {
        return None;
    }
    matching_generation(store, check, agent, wire, generation).await?;
    store.flush().ok()?;
    Some(check.encode(protocol::tag::FULL_SYNC_CONFIRMED))
}

async fn verify_drive_files(store: &Db, resources: &[Resource]) -> bool {
    let contained: HashSet<_> = resources
        .iter()
        .map(|resource| resource.get_subject_enum().pure_id())
        .collect();
    for resource in resources {
        if let Ok(attachments) = resource.get(urls::ATTACHMENTS) {
            let Some(attachments) = attachments.to_reference_index_strings() else {
                return false;
            };
            if attachments
                .iter()
                .any(|attachment| !contained.contains(&normalized_drive(store, attachment)))
            {
                return false;
            }
        }
        if !verify_file(store, resource).await {
            return false;
        }
    }
    true
}

fn internal_hash(resource: &Resource) -> Option<[u8; 32]> {
    hex::decode(resource.get(urls::INTERNAL_ID).ok()?.to_string())
        .ok()?
        .try_into()
        .ok()
}

async fn verify_file(store: &Db, resource: &Resource) -> bool {
    if let Ok(chunks) = resource.get(urls::CHUNKS) {
        let Value::ResourceArray(chunks) = chunks else {
            return false;
        };
        if !chunks.is_empty() {
            let mut digest = blake3::Hasher::new();
            for chunk in chunks {
                let Some(hash) = Subject::from(chunk.to_string()).blob_hash() else {
                    return false;
                };
                let Ok(Some(bytes)) = store.get_blob(&hash).await else {
                    return false;
                };
                if blake3::hash(&bytes).as_bytes() != &hash {
                    return false;
                }
                digest.update(&bytes);
            }
            return internal_hash(resource).as_ref() == Some(digest.finalize().as_bytes());
        }
    }
    let hash = if resource.get(urls::BLOB).is_ok() {
        resource.blob_hash()
    } else if resource.has_class(urls::FILE) || resource.get(urls::DOWNLOAD_URL).is_ok() {
        internal_hash(resource)
    } else {
        return true;
    };
    let Some(hash) = hash else {
        return false;
    };
    if (resource.has_class(urls::FILE) || resource.get(urls::DOWNLOAD_URL).is_ok())
        && resource.get(urls::INTERNAL_ID).is_ok()
        && internal_hash(resource) != Some(hash)
    {
        return false;
    }
    matches!(
        store.get_blob(&hash).await,
        Ok(Some(bytes)) if blake3::hash(&bytes).as_bytes() == &hash
    )
}

#[cfg(test)]
mod tests {
    use crate::{identifiers::blob_subject, values::SubResource};

    use super::*;

    #[tokio::test]
    async fn receipts_belong_to_one_normalized_drive_and_peer() {
        let store = Db::init_temp("peer_full_sync_scoped").await.unwrap();
        let peer = "a".repeat(64);
        record_full_sync(&store, &format!("atomic:node:{peer}"), "did:ad:one").unwrap();

        let first = last_confirmed_full_syncs(&store, "atomic:one");
        assert_eq!(first.len(), 1);
        assert!(first[&peer] > 0);
        assert!(last_confirmed_full_syncs(&store, "atomic:two").is_empty());
    }

    #[tokio::test]
    async fn a_chunked_file_requires_each_matching_blob_and_the_whole_file_hash() {
        let store = Db::init_temp("peer_full_sync_chunks").await.unwrap();
        let parts = [b"one".as_slice(), b"two".as_slice()];
        let mut file = Resource::new("atomic:test".into());
        let whole = blake3::hash(&parts.concat());
        file.set_unsafe(urls::INTERNAL_ID.into(), Value::String(whole.to_string()))
            .unwrap();
        file.set_unsafe(
            urls::CHUNKS.into(),
            Value::ResourceArray(
                parts
                    .iter()
                    .map(|part| {
                        SubResource::Subject(blob_subject(&blake3::hash(part).to_string()).into())
                    })
                    .collect(),
            ),
        )
        .unwrap();

        store
            .put_blob(blake3::hash(parts[0]).as_bytes(), parts[0])
            .await
            .unwrap();
        assert!(!verify_file(&store, &file).await);

        let last = blake3::hash(parts[1]);
        store.put_blob(last.as_bytes(), parts[1]).await.unwrap();
        assert!(verify_file(&store, &file).await);

        store
            .kv
            .insert(Tree::Blobs, last.as_bytes(), b"bad data")
            .unwrap();
        assert!(!verify_file(&store, &file).await);
    }
}
