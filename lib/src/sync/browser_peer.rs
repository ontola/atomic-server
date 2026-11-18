//! Drive-scoped peer ingress for the browser's local node. Transport authentication
//! is mandatory; cache ingest must never be used for untrusted peer frames.
use super::{engine, protocol};
use crate::{
    agents::ForAgent, errors::AtomicResult, loro::AtomicLoroDoc, Db, Resource, Storelike, Subject,
};

pub struct BrowserPeerSession {
    drive: String,
    expected_peer: Option<String>,
    proof_subject: String,
    agent: ForAgent,
    closed: bool,
    pending_blobs: std::collections::HashSet<[u8; 32]>,
}

#[derive(Default, serde::Serialize)]
pub struct BrowserPeerOutput {
    pub frames: Vec<Vec<u8>>,
    pub changed: Vec<String>,
    pub ephemeral: Option<Vec<u8>>,
    /// Reported only after Rust verifies the channel-bound AUTH and drive access.
    #[serde(rename = "peerAgent", skip_serializing_if = "Option::is_none")]
    pub peer_agent: Option<String>,
}

impl BrowserPeerSession {
    pub fn new(
        drive: String,
        expected_peer: Option<String>,
        challenge: String,
    ) -> AtomicResult<Self> {
        if !crate::identifiers::is_resource_id(&drive)
            || drive.contains(['#', '?'])
            || challenge.len() < 32
        {
            return Err(
                "Peer sessions require a canonical drive DID and a fresh channel-bound challenge"
                    .into(),
            );
        }
        Ok(Self {
            proof_subject: format!("{drive}#{challenge}"),
            drive,
            expected_peer,
            agent: ForAgent::Public,
            closed: false,
            pending_blobs: Default::default(),
        })
    }

    fn in_drive(&self, resource: &Resource) -> bool {
        let drive = crate::identifiers::canonicalize_scheme(&self.drive);
        crate::identifiers::canonicalize_scheme(&resource.get_subject().pure_id()) == drive
            || resource.get(crate::urls::DRIVE_PROP).is_ok_and(|value| {
                crate::identifiers::canonicalize_scheme(&value.to_string()) == drive
            })
    }

    /// The resource [bytes] would make of [subject], checked to stay in this
    /// drive. `None` when this device keeps [subject] in another drive: the
    /// two replicas disagree about it, so it is left out and the rest of the
    /// drive still syncs.
    async fn candidate(
        &self,
        db: &Db,
        subject: &str,
        bytes: &[u8],
    ) -> AtomicResult<Option<Resource>> {
        if subject.contains(['#', '?']) {
            return Err("Noncanonical peer subject".into());
        }
        let parsed = Subject::from(subject);
        if parsed.pure_id() != crate::identifiers::canonicalize_scheme(subject) {
            return Err("Noncanonical peer subject".into());
        }
        let subject = parsed.pure_id();
        if let Ok(existing) = db.get_resource(&subject.as_str().into()).await {
            if !self.in_drive(&existing) {
                tracing::warn!(
                    "[browser_peer] skipping {subject}: kept in another drive than {}",
                    self.drive
                );
                return Ok(None);
            }
        }
        let doc = match db.get_loro_snapshot_bytes(&subject) {
            Some(snapshot) => AtomicLoroDoc::from_snapshot(&snapshot)?,
            None => AtomicLoroDoc::new(),
        };
        doc.import_update(bytes)?;
        let mut resource = Resource::new(subject);
        resource.apply_state_doc(doc)?;
        if !self.in_drive(&resource) {
            return Err("Peer frame moves data outside its drive".into());
        }
        Ok(Some(resource))
    }

    pub async fn can_send(&self, db: &Db, subject: &str) -> bool {
        if self.closed || matches!(self.agent, ForAgent::Public) {
            return false;
        }
        let Ok(resource) = db.get_resource(&subject.into()).await else {
            return false;
        };
        self.in_drive(&resource)
            && crate::hierarchy::check_read(db, &resource, &self.agent)
                .await
                .is_ok()
    }

    pub async fn handle(&mut self, db: &Db, frame: &[u8]) -> AtomicResult<BrowserPeerOutput> {
        if self.closed {
            return Err("Peer session closed".into());
        }
        let result = self.handle_inner(db, frame).await;
        if result.is_err() {
            self.closed = true;
        }
        result
    }

    async fn handle_inner(&mut self, db: &Db, frame: &[u8]) -> AtomicResult<BrowserPeerOutput> {
        let (&tag, payload) = frame.split_first().ok_or("Empty peer frame")?;
        let cap = if matches!(self.agent, ForAgent::Public) {
            8192
        } else {
            16 * 1024 * 1024
        };
        if frame.len() > cap {
            return Err("Peer frame exceeds session budget".into());
        }
        let mut out = BrowserPeerOutput::default();
        if tag == protocol::tag::AUTH {
            if !matches!(self.agent, ForAgent::Public) {
                return Err("Peer already authenticated".into());
            }
            let auth: crate::authentication::AuthValues = serde_json::from_slice(payload)?;
            if auth.requested_subject != self.proof_subject {
                return Err("Wrong drive or channel challenge".into());
            }
            if self
                .expected_peer
                .as_ref()
                .is_some_and(|expected| expected != &auth.agent_subject)
            {
                return Err("Unexpected peer identity".into());
            }
            self.agent =
                crate::authentication::get_agent_from_auth_values_and_check(Some(auth), db).await?;
            if let Ok(drive) = db.get_resource(&self.drive.as_str().into()).await {
                crate::hierarchy::check_read(db, &drive, &self.agent).await?;
            } else if self.expected_peer.is_none() {
                return Err("An unknown drive requires an explicitly selected peer".into());
            }
            let mut capabilities = protocol::CAPABILITIES.to_vec();
            if db.kv.replica_identity(&self.drive)?.is_some() {
                capabilities.push(protocol::CAP_BROWSER_STORAGE_RECEIPTS_V1);
            }
            out.peer_agent = Some(self.agent.to_string());
            out.frames
                .push(protocol::encode_auth_ok_with_caps(&capabilities));
            return Ok(out);
        }
        if matches!(self.agent, ForAgent::Public) {
            return Err("Peer AUTH required".into());
        }
        match tag {
            protocol::tag::STORAGE_RECEIPT_REQUEST => {
                let request = protocol::StorageReceiptRequest::decode(payload)
                    .ok_or("Invalid storage receipt request")?;
                if request.drive != self.drive {
                    return Err("Wrong receipt drive".into());
                }
                let subject = Subject::from(request.subject.as_str()).pure_id();
                if request.subject.contains(['#', '?'])
                    || subject != crate::identifiers::canonicalize_scheme(&request.subject)
                {
                    return Err("Noncanonical receipt subject".into());
                }
                let version_bytes = crate::agents::decode_base64(&request.version)?;
                let target = loro::VersionVector::decode(&version_bytes)
                    .map_err(|e| format!("Invalid receipt frontier: {e}"))?;
                if target.is_empty() || target.iter().any(|(_, counter)| *counter <= 0) {
                    return Err("Empty or invalid receipt frontier".into());
                }
                // A request must never acknowledge a removed resource or a
                // resource in another drive. Recheck read access on every probe.
                let _guard = db.subject_locks.lock(&subject).await;
                if super::tombstones::is_tombstoned(db, &subject) {
                    return Ok(out);
                }
                let Ok(resource) = db.get_resource(&subject.as_str().into()).await else {
                    return Ok(out);
                };
                if !self.in_drive(&resource) {
                    return Err("Receipt subject outside session drive".into());
                }
                crate::hierarchy::check_read(db, &resource, &self.agent).await?;
                let covers = || -> AtomicResult<bool> {
                    let Some(snapshot) = db.get_loro_snapshot_bytes(&subject) else {
                        return Ok(false);
                    };
                    let doc = AtomicLoroDoc::from_snapshot(&snapshot)?;
                    // State VV excludes pending operations with missing deps.
                    Ok(doc.doc().state_vv().includes_vv(&target))
                };
                if !covers()? {
                    return Ok(out);
                }
                // This also refuses a read-your-writes batch overlay. A flush
                // must never implicitly commit somebody else's open batch.
                let Some(identity) = db.kv.replica_identity(&self.drive)? else {
                    return Ok(out);
                };
                db.flush()?;
                if !covers()? || db.kv.replica_identity(&self.drive)? != Some(identity.clone()) {
                    return Ok(out);
                }
                let mut frame = vec![protocol::tag::STORAGE_RECEIPT];
                frame.extend(serde_json::to_vec(&serde_json::json!({
                    "nonce": request.nonce,
                    "drive": request.drive,
                    "subject": request.subject,
                    "version": request.version,
                    "replica": identity,
                    "barrier": protocol::STORAGE_RECEIPT_BARRIER,
                }))?);
                out.frames.push(frame);
            }
            protocol::tag::SYNC => {
                let sync = protocol::decode_sync(payload).ok_or("Invalid SYNC")?;
                if sync.drive != self.drive {
                    return Err("Wrong sync drive".into());
                }
                // Unknown local drive has nothing to serve yet. The selected
                // peer's independent SYNC response will bootstrap it.
                if db.get_resource(&self.drive.as_str().into()).await.is_ok() {
                    out.frames = engine::handle_frame(frame, db, &mut self.agent).await;
                    // A mesh neighbor may have the graph before the blob.
                    // Ask every authorized edge again while bytes are missing.
                    let mut requested = 0;
                    for subject in
                        engine::collect_drive_subjects(db, &self.drive.as_str().into()).await
                    {
                        let resource = db.get_resource(&subject.as_str().into()).await?;
                        if crate::hierarchy::check_read(db, &resource, &self.agent)
                            .await
                            .is_err()
                        {
                            continue;
                        }
                        if let Some(hash) = resource.blob_hash() {
                            if !db.has_blob(&hash).await? {
                                self.pending_blobs.insert(hash);
                                out.frames.push(protocol::encode_blob_request(&hash));
                                requested += 1;
                                if requested >= 32 {
                                    break;
                                }
                            }
                        }
                    }
                }
            }
            protocol::tag::SYNC_PUSH => {
                let push = protocol::decode_sync_push(payload).ok_or("Invalid SYNC_PUSH")?;
                if push.drive != self.drive {
                    return Err("Wrong push drive".into());
                }
                // Preflight the entire batch before the shared importer writes.
                let mut skipped = std::collections::HashSet::new();
                for entry in &push.entries {
                    // Other mesh edges may still be sending a delta when a
                    // signed deletion lands. The shared importer ignores it;
                    // do not reconstruct that delta without its deleted base.
                    if super::tombstones::is_tombstoned(db, &entry.subject) {
                        continue;
                    }
                    let Some(candidate) = self
                        .candidate(db, &entry.subject, &entry.loro_bytes)
                        .await?
                    else {
                        skipped.insert(entry.subject.clone());
                        continue;
                    };
                    if entry.subject == self.drive
                        && db.get_resource(&self.drive.as_str().into()).await.is_err()
                    {
                        crate::hierarchy::check_write(db, &candidate, &self.agent).await?;
                    }
                }
                let mut push = push;
                if !skipped.is_empty() {
                    push.entries.retain(|e| !skipped.contains(&e.subject));
                    push.envelopes.retain(|e| !skipped.contains(&e.subject));
                }
                let (_, requests) = engine::import_sync_push(&push, db, &self.agent, false)
                    .await
                    .map_err(|e| e.to_string())?;
                for request in requests {
                    if let Some(hash) = protocol::decode_blob_request(&request[1..]) {
                        self.pending_blobs.insert(hash);
                        out.frames.push(request);
                    }
                }
                out.changed = push
                    .entries
                    .iter()
                    .map(|entry| entry.subject.clone())
                    .collect();
                out.frames.push(protocol::encode_sync_ok(&self.drive));
            }
            protocol::tag::SYNC_DIFF => {
                let diff = protocol::decode_sync_diff(payload).ok_or("Invalid SYNC_DIFF")?;
                if diff.drive != self.drive {
                    return Err("Wrong diff drive".into());
                }
                // Apply signed parents before considering cascaded tombstones.
                for subject in &diff.remove {
                    if let Some(envelope) = diff.remove_commits.get(subject) {
                        self.apply_commit(db, envelope, &mut out).await?;
                    }
                }
                for subject in &diff.remove {
                    if !super::tombstones::is_tombstoned(db, subject) {
                        return Err("Unsigned peer deletion".into());
                    }
                    out.changed.push(subject.clone());
                }
                let mut entries = Vec::new();
                for subject in &diff.pull {
                    // Another mesh edge can delete a resource after its version
                    // vector was advertised. The next reconcile sends the
                    // signed tombstone; a stale pull must not close this edge.
                    if super::tombstones::is_tombstoned(db, subject) {
                        continue;
                    }
                    let resource = db.get_resource(&subject.as_str().into()).await?;
                    if !self.in_drive(&resource) {
                        tracing::warn!(
                            "[browser_peer] not sending {subject}: kept in another drive than {}",
                            self.drive
                        );
                        continue;
                    }
                    crate::hierarchy::check_read(db, &resource, &self.agent).await?;
                    if let Some(bytes) = db.get_loro_snapshot_bytes(subject) {
                        entries.push((subject.clone(), bytes));
                    }
                }
                if !entries.is_empty() {
                    let refs: Vec<_> = entries
                        .iter()
                        .map(|(s, b)| (s.as_str(), b.as_slice()))
                        .collect();
                    let envelopes =
                        crate::envelopes::for_subjects(db, entries.iter().map(|(s, _)| s.as_str()));
                    out.frames
                        .extend(protocol::encode_sync_push_chunks_with_envelopes(
                            &self.drive,
                            &refs,
                            &envelopes,
                        ));
                }
            }
            protocol::tag::COMMIT => {
                let commit = protocol::decode_commit(payload).ok_or("Invalid COMMIT")?;
                self.apply_commit(db, commit.commit_json, &mut out).await?;
                out.frames.push(protocol::encode_commit_ok(
                    commit.request_id,
                    commit.commit_json,
                ));
            }
            protocol::tag::BLOB_REQUEST => {
                let hash = protocol::decode_blob_request(payload).ok_or("Invalid blob request")?;
                let subjects =
                    engine::collect_drive_subjects(db, &self.drive.as_str().into()).await;
                let mut permitted = false;
                for subject in subjects {
                    let resource = db.get_resource(&subject.as_str().into()).await?;
                    if resource.blob_hash() == Some(hash)
                        && crate::hierarchy::check_read(db, &resource, &self.agent)
                            .await
                            .is_ok()
                    {
                        permitted = true;
                        break;
                    }
                }
                if !permitted {
                    return Err("Blob is not readable in this drive".into());
                }
                // A partial replica may not have the bytes yet. The requester
                // retries other edges without tearing down healthy connections.
                if let Some(bytes) = db.get_blob(&hash).await? {
                    out.frames
                        .push(protocol::encode_blob_response(&hash, &bytes));
                }
            }
            protocol::tag::BLOB_RESPONSE => {
                let response =
                    protocol::decode_blob_response(payload).ok_or("Invalid blob response")?;
                if blake3::hash(&response.bytes).as_bytes() != &response.hash {
                    return Err("Corrupt blob response".into());
                }
                let requested = self.pending_blobs.remove(&response.hash);
                // Concurrent edges can answer the same content-addressed request.
                if db.has_blob(&response.hash).await? {
                    return Ok(out);
                }
                if !requested {
                    return Err("Unsolicited blob response".into());
                }
                if !db.sync_policy().admit_drive_write(&self.drive) {
                    return Err("Drive not admitted for sync".into());
                }
                db.take_pending_blob_request(&response.hash);
                db.put_blob(&response.hash, &response.bytes).await?;
            }
            protocol::tag::EPHEMERAL => {
                let message = protocol::decode_ephemeral(payload).ok_or("Invalid EPHEMERAL")?;
                if message.agent != self.agent.to_string() {
                    return Err("Spoofed ephemeral identity".into());
                }
                let resource = db.get_resource(&message.drive.as_str().into()).await?;
                if !self.in_drive(&resource) {
                    return Err("Wrong ephemeral drive".into());
                }
                crate::hierarchy::check_read(db, &resource, &self.agent).await?;
                // DOC edits require write access; cursors/presence require read.
                if message.kind == protocol::ephemeral_kind::DOC {
                    crate::hierarchy::check_write(db, &resource, &self.agent).await?;
                }
                out.ephemeral = Some(frame.to_vec());
            }
            protocol::tag::SYNC_OK | protocol::tag::COMMIT_OK => {}
            _ => return Err("Unsupported browser peer frame".into()),
        }
        Ok(out)
    }

    async fn apply_commit(
        &self,
        db: &Db,
        json: &str,
        out: &mut BrowserPeerOutput,
    ) -> AtomicResult<()> {
        let value: serde_json::Value = serde_json::from_str(json)?;
        let subject = value[crate::urls::SUBJECT]
            .as_str()
            .ok_or("Missing commit subject")?;
        if value[crate::urls::DESTROY].as_bool() == Some(true) {
            // A live COMMIT and a concurrent reconcile can carry the same
            // signed tombstone. Its previously validated signature is a
            // receipt; do not try to read the now-deleted resource again.
            if let Some(previous) = super::tombstones::destroy_envelope(db, subject) {
                let previous: serde_json::Value = serde_json::from_str(&previous)?;
                if previous[crate::urls::SIGNATURE].is_string()
                    && previous[crate::urls::SIGNATURE] == value[crate::urls::SIGNATURE]
                {
                    out.changed.push(subject.into());
                    return Ok(());
                }
            }
            let resource = db.get_resource(&subject.into()).await?;
            if !self.in_drive(&resource) {
                return Err("Wrong deletion drive".into());
            }
        } else {
            let bytes = crate::agents::decode_base64(
                value[crate::urls::LORO_UPDATE]
                    .as_str()
                    .ok_or("Missing Loro update")?,
            )?;
            self.candidate(db, subject, &bytes).await?;
        }
        let is_destroy = value[crate::urls::DESTROY].as_bool() == Some(true);
        match engine::ingest_commit_json(db, json, &engine::CommitIngestOpts::peer()).await {
            // Reconcile re-sends a signed tombstone for a subject that was
            // destroyed and then re-created. The core refuses that replay,
            // which is right, but failing the session makes the link redial
            // and get the same stale destroy again, forever. The resource is
            // alive and unchanged here, so the replay is a settled no-op.
            Err(err) if is_destroy && err.to_string().contains("refusing replay") => Ok(()),
            result => {
                result?;
                out.changed.push(subject.into());
                Ok(())
            }
        }
    }
}

#[cfg(all(test, feature = "db"))]
mod tests {
    use super::*;
    use crate::db::kv_store::{KvIter, KvStore, ReplicaIdentity};
    use crate::db::trees::Tree;

    struct FailingFlush(std::sync::Arc<dyn KvStore>);

    impl KvStore for FailingFlush {
        fn replica_identity(&self, scope: &str) -> AtomicResult<Option<ReplicaIdentity>> {
            self.0.replica_identity(scope)
        }
        fn get(&self, tree: Tree, key: &[u8]) -> AtomicResult<Option<Vec<u8>>> {
            self.0.get(tree, key)
        }
        fn insert(&self, tree: Tree, key: &[u8], val: &[u8]) -> AtomicResult<()> {
            self.0.insert(tree, key, val)
        }
        fn remove(&self, tree: Tree, key: &[u8]) -> AtomicResult<()> {
            self.0.remove(tree, key)
        }
        fn contains_key(&self, tree: Tree, key: &[u8]) -> AtomicResult<bool> {
            self.0.contains_key(tree, key)
        }
        fn scan_prefix(&self, tree: Tree, prefix: &[u8]) -> KvIter {
            self.0.scan_prefix(tree, prefix)
        }
        fn range(&self, tree: Tree, start: Vec<u8>, end: Vec<u8>, reverse: bool) -> KvIter {
            self.0.range(tree, start, end, reverse)
        }
        fn iter_tree(&self, tree: Tree) -> KvIter {
            self.0.iter_tree(tree)
        }
        fn clear_tree(&self, tree: Tree) -> AtomicResult<()> {
            self.0.clear_tree(tree)
        }
        fn apply_batch(&self, operations: &[crate::db::trees::Operation]) -> AtomicResult<()> {
            self.0.apply_batch(operations)
        }
        fn flush(&self) -> AtomicResult<()> {
            Err("injected receipt flush failure".into())
        }
        fn len(&self, tree: Tree) -> AtomicResult<usize> {
            self.0.len(tree)
        }
    }
    async fn fixture() -> (Db, crate::agents::Agent, String, BrowserPeerSession) {
        let db = Db::init_temp(&format!(
            "browser-peer-{}-{}",
            {
                static NEXT: std::sync::atomic::AtomicUsize =
                    std::sync::atomic::AtomicUsize::new(0);
                NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
            },
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
        .await
        .unwrap();
        let (agent, drive) = db.setup("Alice").await.unwrap();
        let session = BrowserPeerSession::new(drive.clone(), None, "a".repeat(64)).unwrap();
        (db, agent, drive, session)
    }
    async fn authenticate(db: &Db, agent: &crate::agents::Agent, session: &mut BrowserPeerSession) {
        let auth = protocol::encode_auth(agent, &session.proof_subject).unwrap();
        let output = session.handle(db, &auth).await.unwrap();
        assert_eq!(output.frames[0][0], protocol::tag::AUTH_OK);
    }

    fn receipt_request(db: &Db, drive: &str) -> Vec<u8> {
        let snapshot = db.get_loro_snapshot_bytes(drive).unwrap();
        let doc = AtomicLoroDoc::from_snapshot(&snapshot).unwrap();
        let version = crate::agents::encode_base64(&doc.doc().state_vv().encode());
        let mut frame = vec![0x56];
        frame.extend(
            serde_json::to_vec(&serde_json::json!({
                "nonce": "a".repeat(64), "drive": drive, "subject": drive, "version": version,
            }))
            .unwrap(),
        );
        frame
    }

    fn receipt_frame(value: serde_json::Value) -> Vec<u8> {
        let mut frame = vec![protocol::tag::STORAGE_RECEIPT_REQUEST];
        frame.extend(serde_json::to_vec(&value).unwrap());
        frame
    }

    #[tokio::test]
    async fn peer_receipt_certifies_only_the_requested_stored_frontier() {
        let (db, agent, drive, mut session) = fixture().await;
        let auth = protocol::encode_auth(&agent, &session.proof_subject).unwrap();
        let authenticated = session.handle(&db, &auth).await.unwrap();
        assert_eq!(authenticated.peer_agent, Some(agent.subject.to_string()));
        assert!(protocol::decode_auth_ok(&authenticated.frames[0][1..])
            .contains(&"browser-storage-receipts-v1".to_string()));
        let request = receipt_request(&db, &drive);
        let output = session.handle(&db, &request).await.unwrap();
        assert_eq!(output.frames.len(), 1);
        assert_eq!(output.frames[0][0], 0x57);
        let receipt: serde_json::Value = serde_json::from_slice(&output.frames[0][1..]).unwrap();
        let target: serde_json::Value = serde_json::from_slice(&request[1..]).unwrap();
        for field in ["nonce", "drive", "subject", "version"] {
            assert_eq!(receipt[field], target[field]);
        }
        assert_eq!(receipt["barrier"], "atomic-redb-flush-v1");
        assert_eq!(receipt["replica"]["storageId"].as_str().unwrap().len(), 64);

        // A local later edit is not present in the receiver's stored snapshot.
        let snapshot = db.get_loro_snapshot_bytes(&drive).unwrap();
        let ahead = AtomicLoroDoc::from_snapshot(&snapshot).unwrap();
        ahead
            .set_property(crate::urls::NAME, &crate::Value::String("Later".into()))
            .unwrap();
        let mut later = target;
        later["version"] = crate::agents::encode_base64(&ahead.doc().state_vv().encode()).into();
        let mut frame = vec![0x56];
        frame.extend(serde_json::to_vec(&later).unwrap());
        assert!(session.handle(&db, &frame).await.unwrap().frames.is_empty());
        db.kv
            .insert(
                Tree::LoroSnapshots,
                drive.as_bytes(),
                &ahead.export_snapshot(),
            )
            .unwrap();
        let confirmed = session.handle(&db, &request).await.unwrap();
        let confirmed: serde_json::Value =
            serde_json::from_slice(&confirmed.frames[0][1..]).unwrap();
        let original: serde_json::Value = serde_json::from_slice(&request[1..]).unwrap();
        assert_eq!(confirmed["version"], original["version"]);
    }

    #[tokio::test]
    async fn peer_receipt_requires_authentication() {
        let (db, _, drive, mut session) = fixture().await;
        assert!(session
            .handle(&db, &receipt_request(&db, &drive))
            .await
            .is_err());
    }

    #[tokio::test]
    async fn peer_receipt_accepts_authorized_http_subjects_in_the_drive() {
        let (db, agent, drive, mut session) = fixture().await;
        authenticate(&db, &agent, &mut session).await;
        let subject = "https://example.com/legacy-resource";
        let mut resource = db.get_resource(&drive.as_str().into()).await.unwrap();
        resource.set_subject(subject.into());
        resource
            .set_unsafe(
                crate::urls::DRIVE_PROP.into(),
                crate::Value::AtomicUrl(drive.clone().into()),
            )
            .unwrap();
        db.add_resource(&resource).await.unwrap();
        let request = receipt_request(&db, subject);
        let mut target: serde_json::Value = serde_json::from_slice(&request[1..]).unwrap();
        target["drive"] = drive.into();
        assert_eq!(
            session
                .handle(&db, &receipt_frame(target))
                .await
                .unwrap()
                .frames
                .len(),
            1
        );
    }

    #[tokio::test]
    async fn peer_receipt_flush_failure_emits_nothing() {
        let (mut db, agent, drive, mut session) = fixture().await;
        authenticate(&db, &agent, &mut session).await;
        let request = receipt_request(&db, &drive);
        db.kv = std::sync::Arc::new(FailingFlush(db.kv.clone()));
        let error = session.handle(&db, &request).await.err().unwrap();
        assert!(error.to_string().contains("injected receipt flush failure"));
    }

    #[tokio::test]
    async fn peer_receipt_never_confirms_an_uncommitted_batch() {
        let (db, agent, drive, mut session) = fixture().await;
        authenticate(&db, &agent, &mut session).await;
        let snapshot = db.get_loro_snapshot_bytes(&drive).unwrap();
        let ahead = AtomicLoroDoc::from_snapshot(&snapshot).unwrap();
        ahead
            .set_property(crate::urls::NAME, &crate::Value::String("Buffered".into()))
            .unwrap();
        db.kv.begin_batch();
        db.kv
            .insert(
                Tree::LoroSnapshots,
                drive.as_bytes(),
                &ahead.export_snapshot(),
            )
            .unwrap();
        let request = receipt_request(&db, &drive);
        assert!(session
            .handle(&db, &request)
            .await
            .unwrap()
            .frames
            .is_empty());
        db.kv.commit_batch().unwrap();
        assert_eq!(session.handle(&db, &request).await.unwrap().frames.len(), 1);
    }

    #[tokio::test]
    async fn peer_receipt_does_not_count_bytes_with_missing_dependencies() {
        let (db, agent, drive, mut session) = fixture().await;
        authenticate(&db, &agent, &mut session).await;
        let original = receipt_request(&db, &drive);
        let snapshot = db.get_loro_snapshot_bytes(&drive).unwrap();
        let ahead = AtomicLoroDoc::from_snapshot(&snapshot).unwrap();
        let baseline = ahead.oplog_vv();
        ahead
            .set_property(
                crate::urls::NAME,
                &crate::Value::String("Pending deps".into()),
            )
            .unwrap();
        let delta = ahead.export_updates_since(&baseline);
        let requested = AtomicLoroDoc::update_range(&delta).unwrap().1;
        // The encoded range names the target, but importing these bytes alone
        // cannot materialize that state. A header/version claim is insufficient.
        assert!(ahead.doc().state_vv().includes_vv(&requested));
        let incomplete = AtomicLoroDoc::from_snapshot(&delta).unwrap();
        assert!(!incomplete.doc().state_vv().includes_vv(&requested));
        db.kv
            .insert(Tree::LoroSnapshots, drive.as_bytes(), &delta)
            .unwrap();
        let mut target: serde_json::Value = serde_json::from_slice(&original[1..]).unwrap();
        target["version"] = crate::agents::encode_base64(&requested.encode()).into();
        assert!(session
            .handle(&db, &receipt_frame(target))
            .await
            .unwrap()
            .frames
            .is_empty());
    }

    #[tokio::test]
    async fn peer_receipt_is_unsupported_by_actual_memory_storage() {
        let db = Db::init_redb(None).await.unwrap();
        db.populate().await.unwrap();
        let (agent, drive) = db.setup("Memory").await.unwrap();
        let mut session = BrowserPeerSession::new(drive.clone(), None, "a".repeat(64)).unwrap();
        let auth = protocol::encode_auth(&agent, &session.proof_subject).unwrap();
        let output = session.handle(&db, &auth).await.unwrap();
        assert!(!protocol::decode_auth_ok(&output.frames[0][1..])
            .contains(&protocol::CAP_BROWSER_STORAGE_RECEIPTS_V1.to_string()));
        assert!(session
            .handle(&db, &receipt_request(&db, &drive))
            .await
            .unwrap()
            .frames
            .is_empty());
    }

    #[tokio::test]
    async fn peer_receipt_omits_missing_and_deleted_subjects() {
        let (db, agent, drive, mut session) = fixture().await;
        authenticate(&db, &agent, &mut session).await;
        let request = receipt_request(&db, &drive);
        let mut target: serde_json::Value = serde_json::from_slice(&request[1..]).unwrap();
        target["subject"] = "atomic:missing-receipt-subject".into();
        assert!(session
            .handle(&db, &receipt_frame(target))
            .await
            .unwrap()
            .frames
            .is_empty());
        super::super::tombstones::record_tombstone(&db, &drive);
        assert!(session
            .handle(&db, &request)
            .await
            .unwrap()
            .frames
            .is_empty());
    }

    #[tokio::test]
    async fn peer_receipt_rejects_wrong_drive_subject_and_malformed_frontiers() {
        let (db, agent, drive, _) = fixture().await;
        let foreign = db.create_drive("Other receipt drive").await.unwrap();
        let request = receipt_request(&db, &drive);
        let original: serde_json::Value = serde_json::from_slice(&request[1..]).unwrap();
        for (field, value) in [
            ("drive", foreign.clone()),
            ("subject", foreign),
            ("nonce", "bad".to_owned()),
            ("version", "not-a-version".to_owned()),
            (
                "version",
                crate::agents::encode_base64(&loro::VersionVector::default().encode()),
            ),
            ("version", "a".repeat(16 * 1024 + 1)),
        ] {
            let mut session = BrowserPeerSession::new(drive.clone(), None, "a".repeat(64)).unwrap();
            authenticate(&db, &agent, &mut session).await;
            let mut changed = original.clone();
            changed[field] = value.into();
            assert!(
                session.handle(&db, &receipt_frame(changed)).await.is_err(),
                "{field}"
            );
        }
    }
    #[tokio::test]
    async fn refuses_pre_auth_and_closes_session() {
        let (db, agent, _, mut session) = fixture().await;
        assert!(session
            .handle(&db, &[protocol::tag::SYNC_OK])
            .await
            .is_err());
        let auth = protocol::encode_auth(&agent, &session.proof_subject).unwrap();
        assert!(session.handle(&db, &auth).await.is_err());
    }
    #[tokio::test]
    async fn refuses_replayed_channel_proof() {
        let (db, agent, drive, mut session) = fixture().await;
        let wrong = protocol::encode_auth(&agent, &format!("{drive}#{}", "b".repeat(64))).unwrap();
        assert!(session.handle(&db, &wrong).await.is_err());
    }
    #[tokio::test]
    async fn refuses_unexpected_identity() {
        let (db, agent, _, mut session) = fixture().await;
        session.expected_peer = Some("did:ad:agent:someone-else".into());
        let auth = protocol::encode_auth(&agent, &session.proof_subject).unwrap();
        assert!(session.handle(&db, &auth).await.is_err());
    }
    #[tokio::test]
    async fn skips_a_subject_kept_in_another_drive_without_writing() {
        let (db, agent, drive, mut session) = fixture().await;
        authenticate(&db, &agent, &mut session).await;
        let foreign = db.create_drive("Other").await.unwrap();
        let before = db
            .kv
            .get(Tree::LoroSnapshots, foreign.as_bytes())
            .unwrap()
            .unwrap();
        // The peer claims the other drive's resource for this drive.
        let doc = AtomicLoroDoc::from_snapshot(&before).unwrap();
        doc.set_property(crate::urls::NAME, &crate::Value::String("Taken".into()))
            .unwrap();
        let bytes = doc.export_snapshot();
        let frames =
            protocol::encode_sync_push_chunks(&drive, &[(foreign.as_str(), bytes.as_slice())]);
        // Left out, and the rest of the drive keeps syncing.
        let output = session.handle(&db, &frames[0]).await.unwrap();
        assert_eq!(output.frames.last().unwrap()[0], protocol::tag::SYNC_OK);
        assert_eq!(
            db.kv
                .get(Tree::LoroSnapshots, foreign.as_bytes())
                .unwrap()
                .unwrap(),
            before
        );
        assert!(!session.closed);
    }
    #[tokio::test]
    async fn accepts_authenticated_same_drive_snapshot() {
        let (db, agent, drive, mut session) = fixture().await;
        authenticate(&db, &agent, &mut session).await;
        let bytes = db
            .kv
            .get(Tree::LoroSnapshots, drive.as_bytes())
            .unwrap()
            .unwrap();
        let frames =
            protocol::encode_sync_push_chunks(&drive, &[(drive.as_str(), bytes.as_slice())]);
        let result = session.handle(&db, &frames[0]).await.unwrap();
        assert_eq!(result.changed, vec![drive]);
        assert_eq!(result.frames[0][0], protocol::tag::SYNC_OK);
    }
    #[tokio::test]
    async fn reader_cannot_push_snapshots() {
        let (db, owner, drive, mut session) = fixture().await;
        let reader = crate::agents::Agent::new(Some("Reader")).unwrap();
        let mut resource = db.get_resource(&drive.as_str().into()).await.unwrap();
        resource
            .set_unsafe(
                crate::urls::READ.into(),
                crate::Value::ResourceArray(vec![
                    owner.subject.to_string().into(),
                    reader.subject.to_string().into(),
                ]),
            )
            .unwrap();
        db.add_resource(&resource).await.unwrap();
        authenticate(&db, &reader, &mut session).await;
        let bytes = db
            .kv
            .get(Tree::LoroSnapshots, drive.as_bytes())
            .unwrap()
            .unwrap();
        let frame =
            protocol::encode_sync_push_chunks(&drive, &[(drive.as_str(), bytes.as_slice())])
                .remove(0);
        assert!(session.handle(&db, &frame).await.is_err());
        assert_eq!(
            db.kv
                .get(Tree::LoroSnapshots, drive.as_bytes())
                .unwrap()
                .unwrap(),
            bytes
        );
    }

    #[tokio::test]
    async fn forged_commit_is_rejected_without_changing_state() {
        let (db, agent, drive, mut session) = fixture().await;
        authenticate(&db, &agent, &mut session).await;
        let bytes = db
            .kv
            .get(Tree::LoroSnapshots, drive.as_bytes())
            .unwrap()
            .unwrap();
        let json = serde_json::json!({
            crate::urls::SUBJECT: drive,
            crate::urls::SIGNER: agent.subject.to_string(),
            crate::urls::LORO_UPDATE: crate::agents::encode_base64(&bytes),
            crate::urls::SIGNATURE: "invalid-signature",
            crate::urls::CREATED_AT: 1,
        })
        .to_string();
        let frame = protocol::encode_commit(1, &json);
        assert!(session.handle(&db, &frame).await.is_err());
        assert_eq!(
            db.kv
                .get(Tree::LoroSnapshots, drive.as_bytes())
                .unwrap()
                .unwrap(),
            bytes
        );
    }

    #[tokio::test]
    async fn outgoing_access_is_rechecked_after_revocation() {
        let (db, owner, drive, mut session) = fixture().await;
        let reader = crate::agents::Agent::new(Some("Reader")).unwrap();
        let mut resource = db.get_resource(&drive.as_str().into()).await.unwrap();
        resource
            .set_unsafe(
                crate::urls::READ.into(),
                crate::Value::ResourceArray(vec![reader.subject.to_string().into()]),
            )
            .unwrap();
        db.add_resource(&resource).await.unwrap();
        authenticate(&db, &reader, &mut session).await;
        assert!(session.can_send(&db, &drive).await);
        resource
            .set_unsafe(
                crate::urls::READ.into(),
                crate::Value::ResourceArray(vec![owner.subject.to_string().into()]),
            )
            .unwrap();
        db.add_resource(&resource).await.unwrap();
        assert!(!session.can_send(&db, &drive).await);
        assert!(session
            .handle(&db, &receipt_request(&db, &drive))
            .await
            .is_err());
    }
    #[tokio::test]
    async fn delayed_mesh_snapshot_does_not_resurrect_a_tombstone() {
        let (db, agent, drive, mut session) = fixture().await;
        authenticate(&db, &agent, &mut session).await;
        let subject = "did:ad:deleted-mesh-child";
        super::super::tombstones::record_tombstone(&db, subject);
        let bytes = db
            .kv
            .get(Tree::LoroSnapshots, drive.as_bytes())
            .unwrap()
            .unwrap();
        let frames = protocol::encode_sync_push_chunks(&drive, &[(subject, bytes.as_slice())]);
        session.handle(&db, &frames[0]).await.unwrap();
        assert!(db
            .kv
            .get(Tree::LoroSnapshots, subject.as_bytes())
            .unwrap()
            .is_none());
        assert!(session.can_send(&db, &drive).await);
    }

    #[tokio::test]
    async fn delayed_mesh_pull_skips_deleted_resources_but_rejects_unknown_ones() {
        let (db, agent, drive, mut session) = fixture().await;
        authenticate(&db, &agent, &mut session).await;
        let deleted = "did:ad:deleted-before-pull".to_string();
        super::super::tombstones::record_tombstone(&db, &deleted);
        let frame = protocol::encode_sync_diff(
            &drive,
            &[deleted, drive.clone()],
            &[],
            &[],
            &Default::default(),
            &Default::default(),
        );
        let output = session.handle(&db, &frame).await.unwrap();
        let push = protocol::decode_sync_push(&output.frames[0][1..]).unwrap();
        assert_eq!(push.entries.len(), 1);
        assert_eq!(push.entries[0].subject, drive);
        assert!(session.can_send(&db, &drive).await);

        let unknown = protocol::encode_sync_diff(
            &drive,
            &["did:ad:never-existed".into()],
            &[],
            &[],
            &Default::default(),
            &Default::default(),
        );
        assert!(session.handle(&db, &unknown).await.is_err());
    }

    #[tokio::test]
    async fn replayed_destroy_of_a_recreated_subject_does_not_fail_the_session() {
        let (db, agent, drive, mut session) = fixture().await;
        authenticate(&db, &agent, &mut session).await;
        let subject = crate::Subject::from_raw(&drive, None);
        let resource = db.get_resource(&subject).await.unwrap();
        let mut builder = crate::commit::CommitBuilder::new(subject.clone());
        builder.destroy(true);
        let json = builder
            .sign(&agent, &db, &resource)
            .await
            .unwrap()
            .into_resource(&db)
            .await
            .unwrap()
            .to_json_ad(None)
            .unwrap();
        let frame = protocol::encode_commit(1, &json);

        let first = session.handle(&db, &frame).await.unwrap();
        assert_eq!(first.changed, vec![drive.clone()]);
        assert!(db.get_resource(&subject).await.is_err());

        // The private drive has a deterministic subject, so a repeat genesis
        // brings back the very same subject after its destroy.
        db.ensure_private_drive().await.unwrap();
        assert!(db.get_resource(&subject).await.is_ok());

        let replay = session.handle(&db, &frame).await.unwrap();
        assert!(replay.changed.is_empty());
        assert!(db.get_resource(&subject).await.is_ok());
    }

    #[tokio::test]
    async fn independent_edges_can_complete_the_same_blob_request() {
        let (db, agent, drive, mut first) = fixture().await;
        let mut second = BrowserPeerSession::new(drive, None, "b".repeat(64)).unwrap();
        authenticate(&db, &agent, &mut first).await;
        authenticate(&db, &agent, &mut second).await;
        let bytes = b"mesh blob";
        let hash = *blake3::hash(bytes).as_bytes();
        first.pending_blobs.insert(hash);
        second.pending_blobs.insert(hash);
        let frame = protocol::encode_blob_response(&hash, bytes);
        assert!(first.handle(&db, &frame).await.unwrap().frames.is_empty());
        assert!(second.handle(&db, &frame).await.unwrap().frames.is_empty());
        assert_eq!(db.get_blob(&hash).await.unwrap().unwrap(), bytes);
    }
}
