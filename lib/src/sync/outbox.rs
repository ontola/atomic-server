//! The durable outbox: local writes that have not reached a hub yet.
//!
//! Port of the browser's `local-outbox.ts` (`planning/unified-sync.md`
//! "Outbox modernization" item 6, `planning/serverless-p2p.md` P2) so a
//! Rust binding gets the same guarantees the web app has: an edit made
//! offline survives an app kill, is signed once per subject when a
//! connection exists, backs off on failure and is parked, still visible,
//! when the hub says it can never succeed by retrying.
//!
//! Sign-at-drain shape: the outbox tracks **dirty subjects**, not signed
//! commits. A local commit marks its subject dirty and records the Loro
//! version the hub is known to hold (`base_version`); the drain exports
//! everything since that version from the stored snapshot, signs ONE commit
//! per subject per pass and sends it as a `COMMIT` frame. Two things are
//! stored verbatim instead of re-derived: a genesis envelope (its signature
//! is the subject, so it cannot be re-signed) and a destroy envelope.
//!
//! Entries live in [`Tree::Outbox`] under the signing agent, so a second
//! identity on the same device never drains the first one's writes.

use crate::commit::{CommitBuilder, CommitResponse};
use crate::db::trees::{Method, Operation, Tree};
use crate::errors::AtomicResult;
use crate::loro::AtomicLoroDoc;
use crate::sync::protocol::{classify_commit_error, error_code};
use crate::{Db, Storelike};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

/// Consecutive failures a blocking-classified refusal must reach before the
/// entry is parked. A `401` under sign-at-drain is often transient: a child
/// races ahead of its parent's genesis ack. The backoff sums to well over a
/// minute by the eighth attempt, past any ordering race.
pub const BLOCK_AFTER_FAILURES: u32 = 8;

const BACKOFF_BASE_MS: i64 = 1_000;
const BACKOFF_MAX_MS: i64 = 30_000;

/// Exponential backoff before a failed entry is attempted again: 1s, 2s, 4s
/// … capped at 30s. Zero for an entry that never failed.
pub fn backoff_ms(failures: u32) -> i64 {
    if failures == 0 {
        return 0;
    }
    let shift = (failures - 1).min(20);
    (BACKOFF_BASE_MS << shift).min(BACKOFF_MAX_MS)
}

/// One dirty subject.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OutboxEntry {
    /// The subject's pure id.
    pub subject: String,
    /// When the subject first went dirty since its last successful drain.
    pub enqueued_at: i64,
    /// Bumped on every [`Outbox::mark_dirty`], so a drain can tell whether a
    /// subject was edited again while its commit was in flight.
    #[serde(default)]
    pub generation: u64,
    /// Encoded Loro `VersionVector` of the last state the hub holds. The
    /// drain exports everything after it. `None` sends the whole snapshot.
    #[serde(default)]
    pub base_version: Option<Vec<u8>>,
    /// A pre-signed commit sent verbatim before any delta: the genesis of a
    /// new resource, or a destroy. Cleared once acknowledged.
    #[serde(default)]
    pub envelope_json: Option<String>,
    /// The envelope is a destroy: nothing follows it and the entry is
    /// removed once it is acknowledged.
    #[serde(default)]
    pub destroy: bool,
    /// Consecutive failed attempts; drives [`backoff_ms`]. Reset on success
    /// and on a fresh local edit.
    #[serde(default)]
    pub failures: u32,
    #[serde(default)]
    pub last_attempt_at: Option<i64>,
    #[serde(default)]
    pub last_error: Option<String>,
    /// Parked after a refusal retrying cannot fix. Stays visible; skipped by
    /// the drain until a fresh local edit re-arms it.
    #[serde(default)]
    pub blocked: bool,
}

/// Why a hub refused a commit, as the `ERROR` frame carries it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommitRefused {
    /// One of [`error_code`], or `UNKNOWN` when the hub did not classify.
    pub code: u16,
    pub message: String,
}

impl CommitRefused {
    /// A refusal from a message alone, classified the way the hub would.
    pub fn from_message(message: impl Into<String>) -> Self {
        let message = message.into();
        Self {
            code: classify_commit_error(&message),
            message,
        }
    }

    fn effective_code(&self) -> u16 {
        if self.code == error_code::UNKNOWN {
            classify_commit_error(&self.message)
        } else {
            self.code
        }
    }

    /// The write can never succeed: drop it.
    pub fn is_terminal(&self) -> bool {
        matches!(
            self.effective_code(),
            error_code::GENESIS_COLLISION
                | error_code::MISSING_REQUIRED_PROPERTY
                | error_code::IMMUTABLE_COMMIT
        )
    }

    /// Retrying cannot help but the write is not necessarily lost: park it.
    pub fn is_blocking(&self) -> bool {
        matches!(
            self.effective_code(),
            error_code::UNAUTHORIZED_WRITE
                | error_code::MISSING_CLASS
                | error_code::SYNC_REJECTED
                | error_code::INVALID_SIGNATURE
                | error_code::CAUSALITY_CONFLICT
        )
    }
}

impl std::fmt::Display for CommitRefused {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "COMMIT refused (code {}): {}", self.code, self.message)
    }
}

/// Where a drain sends its commits: anything that can deliver one `COMMIT`
/// frame and report the matching `COMMIT_OK` or `ERROR`. The WebSocket
/// client implements it; tests use the in-process [`ChannelTransport`].
///
/// [`ChannelTransport`]: crate::sync::transport::ChannelTransport
pub trait CommitTransport: Send {
    /// Deliver `commit_json` under `request_id`; `Ok` carries the commit id
    /// the hub stored it under.
    fn post_commit(
        &mut self,
        request_id: u16,
        commit_json: &str,
    ) -> impl std::future::Future<Output = Result<String, CommitRefused>> + Send;
}

/// What one drain pass did.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct DrainReport {
    /// Commits the hub acknowledged (a genesis and its delta count twice).
    pub sent: usize,
    /// Entries left dirty for a later pass (transient failure or backoff).
    pub deferred: usize,
    /// Entries parked this pass.
    pub blocked: usize,
    /// Entries dropped this pass because the hub said they can never apply.
    pub dropped: usize,
    /// Entries still in the outbox after the pass, blocked ones included.
    pub remaining: usize,
}

/// Handle on the outbox of the store's default agent.
#[derive(Clone)]
pub struct Outbox {
    db: Db,
}

impl Outbox {
    pub fn new(db: Db) -> Self {
        Self { db }
    }

    fn agent_prefix(&self) -> AtomicResult<Vec<u8>> {
        let agent = self.db.get_default_agent()?;
        let mut key = agent.subject.pure_id().into_bytes();
        key.push(0);
        Ok(key)
    }

    fn key(&self, subject: &str) -> AtomicResult<Vec<u8>> {
        let mut key = self.agent_prefix()?;
        key.extend_from_slice(pure(subject).as_bytes());
        Ok(key)
    }

    fn get(&self, subject: &str) -> AtomicResult<Option<OutboxEntry>> {
        let key = self.key(subject)?;
        Ok(self
            .db
            .kv
            .get(Tree::Outbox, &key)?
            .and_then(|bytes| serde_json::from_slice(&bytes).ok()))
    }

    fn put(&self, entry: &OutboxEntry) -> AtomicResult<()> {
        let key = self.key(&entry.subject)?;
        let value = serde_json::to_vec(entry)?;
        self.db.kv.apply_batch(&[Operation {
            tree: Tree::Outbox,
            method: Method::Insert,
            key,
            val: Some(value),
        }])
    }

    /// Forget a subject's entry, acknowledged or not.
    pub fn clear(&self, subject: &str) -> AtomicResult<()> {
        let key = self.key(subject)?;
        self.db.kv.apply_batch(&[Operation {
            tree: Tree::Outbox,
            method: Method::Delete,
            key,
            val: None,
        }])
    }

    /// Every entry of the default agent, oldest first.
    pub fn entries(&self) -> AtomicResult<Vec<OutboxEntry>> {
        let prefix = self.agent_prefix()?;
        let mut entries: Vec<OutboxEntry> = self
            .db
            .kv
            .scan_prefix(Tree::Outbox, &prefix)
            .filter_map(|row| row.ok())
            .filter_map(|(_, v)| serde_json::from_slice(&v).ok())
            .collect();
        entries.sort_by_key(|e| e.enqueued_at);
        Ok(entries)
    }

    /// Subjects with an entry, blocked ones included. A bulk reconcile must
    /// not push these: the drain is their only writer.
    pub fn pending_subjects(&self) -> AtomicResult<HashSet<String>> {
        Ok(self.entries()?.into_iter().map(|e| e.subject).collect())
    }

    pub fn has_pending(&self, subject: &str) -> bool {
        self.get(subject).ok().flatten().is_some()
    }

    /// Record a commit this device just applied locally, signed by the
    /// default agent. Commits by anyone else (a peer's, a hub's) are ignored:
    /// they are not this device's to deliver.
    ///
    /// A genesis or destroy keeps its signed envelope to send verbatim; any
    /// other commit only moves the dirty bit, and the drain re-exports the
    /// accumulated delta. A fresh edit re-arms a blocked entry.
    pub async fn mark_dirty(&self, response: &CommitResponse) -> AtomicResult<bool> {
        let agent = self.db.get_default_agent()?;
        let commit = &response.commit;
        if commit.signer.pure_id() != agent.subject.pure_id() || commit.signature.is_none() {
            return Ok(false);
        }
        let subject = commit.subject.pure_id();
        let now = crate::utils::now();
        let is_genesis = commit.is_genesis == Some(true);
        let is_destroy = commit.destroy == Some(true);

        let mut entry = self.get(&subject)?.unwrap_or_else(|| OutboxEntry {
            subject: subject.clone(),
            enqueued_at: now,
            generation: 0,
            // The hub holds everything before this commit's ops.
            base_version: commit
                .loro_update
                .as_deref()
                .and_then(|u| AtomicLoroDoc::update_range(u).ok())
                .map(|(start, _)| start.encode()),
            envelope_json: None,
            destroy: false,
            failures: 0,
            last_attempt_at: None,
            last_error: None,
            blocked: false,
        });

        if is_genesis || is_destroy {
            let json = crate::client::commit_to_wire_json(commit, &self.db).await?;
            entry.envelope_json = Some(json);
            entry.destroy = is_destroy;
            if is_genesis {
                // The genesis envelope carries its own ops; the delta the
                // drain signs afterwards starts where they end.
                entry.base_version = commit
                    .loro_update
                    .as_deref()
                    .and_then(|u| AtomicLoroDoc::update_range(u).ok())
                    .map(|(_, end)| end.encode());
            }
        }

        entry.generation = entry.generation.wrapping_add(1);
        entry.blocked = false;
        entry.failures = 0;
        entry.last_error = None;
        self.put(&entry)?;
        Ok(true)
    }

    /// Ordering tier: agents first (a child's rights walk needs its signer),
    /// then drive roots, then everything else by depth, so a child's genesis
    /// never reaches the hub before its parent's.
    async fn tier(&self, subject: &str) -> (u8, u32) {
        if crate::identifiers::is_agent_id(subject) {
            return (0, 0);
        }
        let mut depth = 0u32;
        let mut current = subject.to_string();
        while depth < 20 {
            let Ok(resource) = self.db.get_resource(&current.as_str().into()).await else {
                break;
            };
            let Ok(parent) = resource.get(crate::urls::PARENT) else {
                break;
            };
            let parent = parent.to_string();
            if pure(&parent) == pure(&current) {
                break;
            }
            depth += 1;
            current = parent;
        }
        if depth == 0 {
            // No parent chain: a drive root (or an orphan, which also has
            // nothing to wait for).
            return (1, 0);
        }
        (2, depth)
    }

    /// Attempt every entry that is neither blocked nor backing off, in
    /// dependency order, one subject at a time. Never returns `Err` for a
    /// refused commit; those become entry state. `Err` means the store or
    /// the transport itself failed and the pass stopped.
    pub async fn drain<T: CommitTransport>(&self, transport: &mut T) -> AtomicResult<DrainReport> {
        let now = crate::utils::now();
        let mut candidates = Vec::new();
        for entry in self.entries()? {
            if entry.blocked {
                continue;
            }
            if let Some(last) = entry.last_attempt_at {
                if last + backoff_ms(entry.failures) > now {
                    continue;
                }
            }
            let tier = self.tier(&entry.subject).await;
            candidates.push((tier, entry));
        }
        candidates.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.enqueued_at.cmp(&b.1.enqueued_at)));

        let mut report = DrainReport::default();
        let mut request_id: u16 = 1;
        for (_, entry) in candidates {
            match self
                .drain_subject(entry, transport, &mut request_id)
                .await?
            {
                SubjectOutcome::Sent(n) => report.sent += n,
                SubjectOutcome::Deferred => report.deferred += 1,
                SubjectOutcome::Blocked => report.blocked += 1,
                SubjectOutcome::Dropped => report.dropped += 1,
            }
        }
        report.remaining = self.entries()?.len();
        Ok(report)
    }

    async fn drain_subject<T: CommitTransport>(
        &self,
        mut entry: OutboxEntry,
        transport: &mut T,
        request_id: &mut u16,
    ) -> AtomicResult<SubjectOutcome> {
        let subject = entry.subject.clone();
        let mut sent = 0usize;

        // Step 1: the pre-signed envelope (genesis or destroy), verbatim.
        if let Some(json) = entry.envelope_json.clone() {
            let rid = next_id(request_id);
            match transport.post_commit(rid, &json).await {
                Ok(_) => {
                    sent += 1;
                    if entry.destroy {
                        self.clear(&subject)?;
                        return Ok(SubjectOutcome::Sent(sent));
                    }
                    entry.envelope_json = None;
                    entry.failures = 0;
                    entry.last_error = None;
                    self.put(&entry)?;
                }
                Err(refused) => return self.record_refusal(entry, refused),
            }
        }

        // Step 2: everything the local doc gained past what the hub holds.
        let Some(snapshot) = self.db.kv.get(Tree::LoroSnapshots, subject.as_bytes())? else {
            // Nothing stored to send (destroyed locally without an envelope,
            // or never persisted): the entry has no content.
            self.clear(&subject)?;
            return Ok(SubjectOutcome::Sent(sent));
        };
        let doc = AtomicLoroDoc::from_snapshot(&snapshot)?;
        let export_vv = doc.oplog_vv();
        let delta = match entry.base_version.as_deref() {
            Some(bytes) => {
                let base = loro::VersionVector::decode(bytes)
                    .map_err(|e| format!("outbox base version undecodable: {e}"))?;
                doc.export_updates_since(&base)
            }
            None => doc.export_snapshot(),
        };
        let generation_at_export = self.get(&subject)?.map(|e| e.generation);
        if delta.is_empty() {
            self.clear(&subject)?;
            return Ok(SubjectOutcome::Sent(sent));
        }

        let agent = self.db.get_default_agent()?;
        let resource = self.db.get_resource(&subject.as_str().into()).await?;
        let mut builder = CommitBuilder::new(resource.get_subject().clone());
        builder.set_loro_update(delta);
        let commit = builder.sign(&agent, &self.db, &resource).await?;
        let json = crate::client::commit_to_wire_json(&commit, &self.db).await?;

        let rid = next_id(request_id);
        match transport.post_commit(rid, &json).await {
            Ok(_) => {
                sent += 1;
                // Edited again while the commit was in flight: keep the
                // entry, but only for what came after this export.
                let current = self.get(&subject)?;
                match current {
                    Some(latest) if Some(latest.generation) != generation_at_export => {
                        let mut kept = latest;
                        kept.base_version = Some(export_vv.encode());
                        kept.envelope_json = None;
                        kept.failures = 0;
                        kept.last_error = None;
                        self.put(&kept)?;
                    }
                    _ => self.clear(&subject)?,
                }
                Ok(SubjectOutcome::Sent(sent))
            }
            Err(refused) => self.record_refusal(entry, refused),
        }
    }

    fn record_refusal(
        &self,
        mut entry: OutboxEntry,
        refused: CommitRefused,
    ) -> AtomicResult<SubjectOutcome> {
        if refused.is_terminal() {
            tracing::warn!(
                "outbox: dropping {}: {refused}",
                &entry.subject[..entry.subject.len().min(30)]
            );
            self.clear(&entry.subject)?;
            return Ok(SubjectOutcome::Dropped);
        }
        entry.failures += 1;
        entry.last_attempt_at = Some(crate::utils::now());
        entry.last_error = Some(refused.message.clone());
        if refused.is_blocking() && entry.failures >= BLOCK_AFTER_FAILURES {
            entry.blocked = true;
            self.put(&entry)?;
            tracing::warn!(
                "outbox: parked {} after {} refusals: {refused}",
                &entry.subject[..entry.subject.len().min(30)],
                entry.failures
            );
            return Ok(SubjectOutcome::Blocked);
        }
        self.put(&entry)?;
        Ok(SubjectOutcome::Deferred)
    }
}

enum SubjectOutcome {
    Sent(usize),
    Deferred,
    Blocked,
    Dropped,
}

fn next_id(request_id: &mut u16) -> u16 {
    let id = *request_id;
    *request_id = request_id.wrapping_add(1).max(1);
    id
}

fn pure(subject: &str) -> String {
    crate::Subject::from_raw(subject, None).pure_id()
}

/// A request/response transport is a commit transport: send the frame,
/// read until the matching `COMMIT_OK` or `ERROR`. Other frames the
/// responder may send in between (an `UPDATE` echo) are skipped.
impl CommitTransport for crate::sync::transport::ChannelTransport {
    async fn post_commit(
        &mut self,
        request_id: u16,
        commit_json: &str,
    ) -> Result<String, CommitRefused> {
        use crate::sync::protocol::{self, tag};
        use crate::sync::transport::AtomicTransport;

        self.send(protocol::encode_commit(request_id, commit_json))
            .await
            .map_err(|e| CommitRefused {
                code: error_code::UNKNOWN,
                message: format!("transport: {e}"),
            })?;
        loop {
            let frame = match self.recv().await {
                Ok(Some(frame)) => frame,
                Ok(None) => {
                    return Err(CommitRefused {
                        code: error_code::UNKNOWN,
                        message: "transport closed before COMMIT_OK".into(),
                    })
                }
                Err(e) => {
                    return Err(CommitRefused {
                        code: error_code::UNKNOWN,
                        message: format!("transport: {e}"),
                    })
                }
            };
            match frame.first() {
                Some(&tag::COMMIT_OK) => {
                    if let Some(ok) = protocol::decode_commit_ok(&frame[1..]) {
                        if ok.request_id == request_id {
                            return Ok(ok.commit_id);
                        }
                    }
                }
                Some(&tag::ERROR) => {
                    if let Some(err) = protocol::decode_error(&frame[1..]) {
                        if err.request_id == request_id {
                            return Err(CommitRefused {
                                code: err.code,
                                message: err.message,
                            });
                        }
                    }
                }
                _ => {}
            }
        }
    }
}

#[cfg(all(test, feature = "db-redb"))]
mod tests {
    use super::*;
    use crate::sync::session::SyncSession;
    use crate::sync::transport::ChannelTransport;
    use crate::{urls, Resource, Value};

    /// A hub that already holds the device's agent and drive, as it does
    /// once the drive was synced there once.
    async fn hub_for(device: &Db, drive: &str) -> Db {
        let hub = Db::init_temp(&format!("outbox_hub_{}", crate::utils::random_string(6)))
            .await
            .unwrap();
        hub.setup("Hub").await.unwrap();
        let agent = device.get_default_agent().unwrap();
        let agent_resource = device.get_resource(&agent.subject).await.unwrap();
        hub.add_resource_opts(&agent_resource, false, true, true)
            .await
            .unwrap();
        let drive_resource = device.get_resource(&drive.into()).await.unwrap();
        hub.add_resource_opts(&drive_resource, false, true, true)
            .await
            .unwrap();
        hub
    }

    /// Serve `hub` on one end of an in-process pipe; the other end is the
    /// device's transport.
    fn serve(hub: Db) -> ChannelTransport {
        let (device_end, mut hub_end) = ChannelTransport::pair();
        tokio::spawn(async move {
            let mut session = SyncSession::new(hub);
            let _ = session.serve(&mut hub_end).await;
        });
        device_end
    }

    async fn create_and_edit(device: &Db, drive: &str) -> (String, CommitResponse) {
        let subject = device
            .create_resource(urls::FOLDER, drive, "note", None)
            .await
            .unwrap();
        let mut resource = device.get_resource(&subject.as_str().into()).await.unwrap();
        resource
            .set(
                urls::NAME.into(),
                Value::String("edited offline".into()),
                device,
            )
            .await
            .unwrap();
        let response = resource.save_locally(device).await.unwrap();
        (subject, response)
    }

    /// `create_resource` and `save_locally` are the local write paths; the
    /// binding records each with `mark_dirty`.
    async fn record_all(outbox: &Outbox, device: &Db, subject: &str) {
        for envelope in crate::envelopes::envelopes(device, subject) {
            let resource = crate::parse::parse_json_ad_commit_resource(&envelope.json, device)
                .await
                .unwrap();
            let commit = crate::commit::Commit::from_resource(resource).unwrap();
            let response = CommitResponse {
                commit,
                commit_resource: Resource::new("x".into()),
                resource_new: None,
                resource_old: None,
                add_atoms: vec![],
                remove_atoms: vec![],
                changed_props: Default::default(),
                source_id: None,
                broadcast_update: None,
            };
            outbox.mark_dirty(&response).await.unwrap();
        }
    }

    #[tokio::test]
    async fn offline_create_and_edit_reach_the_hub_in_one_pass() {
        let device = Db::init_temp("outbox_device_create").await.unwrap();
        device.set_envelope_retention(crate::envelopes::EnvelopeRetention::All);
        let (_agent, drive) = device.setup("Alice").await.unwrap();
        let hub = hub_for(&device, &drive).await;

        let outbox = Outbox::new(device.clone());
        let (subject, edit) = create_and_edit(&device, &drive).await;
        // The genesis went through create_resource, the edit through
        // save_locally; both are the binding's job to record.
        record_all(&outbox, &device, &subject).await;
        assert!(outbox.mark_dirty(&edit).await.unwrap());
        let entry = outbox.get(&subject).unwrap().expect("entry");
        assert!(entry.envelope_json.is_some(), "genesis kept verbatim");
        assert!(entry.base_version.is_some());
        assert!(outbox.has_pending(&subject));

        let mut transport = serve(hub.clone());
        let report = outbox.drain(&mut transport).await.unwrap();
        assert_eq!(report.sent, 2, "genesis then one delta: {report:?}");
        assert_eq!(report.remaining, 0, "{report:?}");
        assert!(!outbox.has_pending(&subject));

        let on_hub = hub.get_resource(&subject.as_str().into()).await.unwrap();
        assert_eq!(
            on_hub.get(urls::NAME).unwrap().to_string(),
            "edited offline",
            "the delta signed at drain time carried the offline edit"
        );
    }

    #[tokio::test]
    async fn entries_survive_a_reopen() {
        let dir = std::env::temp_dir().join(format!(
            "atomic-outbox-reopen-{}-{}",
            std::process::id(),
            crate::utils::random_string(6)
        ));
        let uploads = dir.join("uploads");
        std::fs::create_dir_all(&uploads).unwrap();
        let device = Db::init_redb_file(&dir, Some("https://localhost".into()), &uploads)
            .await
            .unwrap();
        let agent = device.create_agent(None).await.unwrap();
        device.set_default_agent(agent.clone());
        device.populate().await.unwrap();
        let drive = device.create_drive("Offline").await.unwrap();
        let (subject, edit) = create_and_edit(&device, &drive).await;
        Outbox::new(device.clone()).mark_dirty(&edit).await.unwrap();
        drop(device);

        let reopened = Db::init_redb_file(&dir, Some("https://localhost".into()), &uploads)
            .await
            .unwrap();
        reopened.set_default_agent(agent);
        let entries = Outbox::new(reopened).entries().unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].subject, pure(&subject));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn outboxes_are_scoped_to_the_signing_agent() {
        let device = Db::init_temp("outbox_scope").await.unwrap();
        let (alice, drive) = device.setup("Alice").await.unwrap();
        let (_subject, edit) = create_and_edit(&device, &drive).await;
        let outbox = Outbox::new(device.clone());
        outbox.mark_dirty(&edit).await.unwrap();
        assert_eq!(outbox.entries().unwrap().len(), 1);

        let bob = device.create_agent(Some("Bob")).await.unwrap();
        device.set_default_agent(bob);
        assert!(
            outbox.entries().unwrap().is_empty(),
            "Bob must not see Alice's queue"
        );
        assert!(
            !outbox.mark_dirty(&edit).await.unwrap(),
            "a commit signed by someone else is not Bob's to deliver"
        );
        device.set_default_agent(alice);
        assert_eq!(outbox.entries().unwrap().len(), 1);
    }

    struct Refusing(CommitRefused);
    impl CommitTransport for Refusing {
        async fn post_commit(&mut self, _: u16, _: &str) -> Result<String, CommitRefused> {
            Err(self.0.clone())
        }
    }

    #[test]
    fn causality_conflict_is_blocking_not_terminal() {
        let refusal = CommitRefused::from_message(
            "Commit's Loro update produced no state changes — its writes were silently dropped",
        );
        assert_eq!(refusal.code, error_code::CAUSALITY_CONFLICT);
        assert!(refusal.is_blocking());
        assert!(!refusal.is_terminal());
    }

    #[tokio::test]
    async fn unauthorized_backs_off_then_parks_and_a_fresh_edit_rearms() {
        let device = Db::init_temp("outbox_block").await.unwrap();
        let (_alice, drive) = device.setup("Alice").await.unwrap();
        let (subject, edit) = create_and_edit(&device, &drive).await;
        let outbox = Outbox::new(device.clone());
        outbox.mark_dirty(&edit).await.unwrap();

        let mut transport = Refusing(CommitRefused {
            code: error_code::UNAUTHORIZED_WRITE,
            message: "No write right".into(),
        });
        let report = outbox.drain(&mut transport).await.unwrap();
        assert_eq!(report.deferred, 1, "{report:?}");
        let entry = outbox.get(&subject).unwrap().unwrap();
        assert_eq!(entry.failures, 1);
        assert!(!entry.blocked);
        assert_eq!(entry.last_error.as_deref(), Some("No write right"));

        // Within the backoff window the entry is not attempted again.
        let report = outbox.drain(&mut transport).await.unwrap();
        assert_eq!(report.deferred, 0, "{report:?}");
        assert_eq!(outbox.get(&subject).unwrap().unwrap().failures, 1);

        // Past enough failures a blocking refusal parks the entry.
        for _ in 1..BLOCK_AFTER_FAILURES {
            let mut e = outbox.get(&subject).unwrap().unwrap();
            e.last_attempt_at = Some(0);
            outbox.put(&e).unwrap();
            outbox.drain(&mut transport).await.unwrap();
        }
        let entry = outbox.get(&subject).unwrap().unwrap();
        assert!(entry.blocked, "{entry:?}");
        assert_eq!(entry.failures, BLOCK_AFTER_FAILURES);
        assert!(outbox.has_pending(&subject), "parked entries stay visible");

        // A fresh local edit re-arms it.
        outbox.mark_dirty(&edit).await.unwrap();
        let entry = outbox.get(&subject).unwrap().unwrap();
        assert!(!entry.blocked);
        assert_eq!(entry.failures, 0);
    }

    #[tokio::test]
    async fn terminal_refusal_drops_the_entry() {
        let device = Db::init_temp("outbox_terminal").await.unwrap();
        let (_alice, drive) = device.setup("Alice").await.unwrap();
        let (subject, edit) = create_and_edit(&device, &drive).await;
        let outbox = Outbox::new(device.clone());
        outbox.mark_dirty(&edit).await.unwrap();
        let mut transport = Refusing(CommitRefused::from_message(
            "is_genesis: true, but the resource already exists",
        ));
        let report = outbox.drain(&mut transport).await.unwrap();
        assert_eq!(report.dropped, 1, "{report:?}");
        assert!(!outbox.has_pending(&subject));
    }

    #[test]
    fn backoff_doubles_and_caps() {
        assert_eq!(backoff_ms(0), 0);
        assert_eq!(backoff_ms(1), 1_000);
        assert_eq!(backoff_ms(2), 2_000);
        assert_eq!(backoff_ms(5), 16_000);
        assert_eq!(backoff_ms(6), 30_000);
        assert_eq!(backoff_ms(40), 30_000);
    }

    #[tokio::test]
    async fn drain_order_puts_parents_before_children() {
        let device = Db::init_temp("outbox_order").await.unwrap();
        let (_alice, drive) = device.setup("Alice").await.unwrap();
        let outbox = Outbox::new(device.clone());
        let folder = device
            .create_resource(urls::FOLDER, &drive, "folder", None)
            .await
            .unwrap();
        let child = device
            .create_resource(urls::FOLDER, &folder, "child", None)
            .await
            .unwrap();
        // Record the child first so enqueue order alone would be wrong.
        record_all(&outbox, &device, &child).await;
        record_all(&outbox, &device, &folder).await;
        let tiers = (
            outbox.tier(&pure(&drive)).await,
            outbox.tier(&pure(&folder)).await,
            outbox.tier(&pure(&child)).await,
        );
        assert!(tiers.0 < tiers.1 && tiers.1 < tiers.2, "{tiers:?}");
        assert_eq!(outbox.tier("did:ad:agent:x").await, (0, 0));
    }
}
