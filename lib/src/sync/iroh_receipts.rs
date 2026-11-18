//! Best-effort, connection-scoped resource storage evidence over native Iroh.
//! Targets are observed stored state frontiers, not acknowledgements of every
//! save. Neither a receipt nor a distinct node id proves physical independence.

use super::protocol::{self, StorageReceipt, StorageReceiptReplica, StorageReceiptRequest};
use crate::{agents::ForAgent, loro::AtomicLoroDoc, Db, Storelike};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use std::{
    collections::VecDeque,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

/// Correlated historical evidence emitted by this store's native peer session.
/// Subscribe before connecting. The bounded channel has no replay or ledger;
/// lagging subscribers must treat missed observations as unknown.
#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IrohReplicaReceipt {
    pub receipt: StorageReceipt,
    pub source: StorageReceiptReplica,
    pub remote_node_id: String,
    pub remote_agent: String,
    pub local_agent: String,
    pub connection_generation: u64,
    pub agent_generation: u64,
    pub removal_generation: u64,
    pub observed_at: u64,
}

/// Wire spelling is public even when this node stores same-origin HTTP keys internally.
pub(crate) fn wire_subject(db: &Db, subject: &str) -> String {
    let subject = db.normalize_subject(&subject.into());
    crate::identifiers::canonicalize_scheme(
        &subject.resolve(
            &db.get_base_domain()
                .unwrap_or_else(|| "http://localhost".into()),
        ),
    )
}

#[derive(Clone)]
struct LedgerConnection {
    remote: String,
    generation: u64,
    agent_generation: u64,
    local_agent: String,
    peer_agent: ForAgent,
    drive: String,
    source: StorageReceiptReplica,
    replica: Option<StorageReceiptReplica>,
    receipts: VecDeque<IrohReplicaReceipt>,
}

/// Ephemeral process-local state. Never exported as resource data or persisted.
#[derive(Default)]
pub(crate) struct NativeReceiptLedger {
    removal_generation: u64,
    connections: VecDeque<LedgerConnection>,
}

impl NativeReceiptLedger {
    pub(crate) fn sync_removals(&mut self, generation: u64) {
        if self.removal_generation < generation {
            self.removal_generation = generation;
            for connection in &mut self.connections {
                connection.receipts.clear();
                connection.replica = None;
            }
        }
    }

    fn open(&mut self, session: &ReceiptSession) {
        self.connections.retain(|c| c.remote != session.remote);
        if self.connections.len() >= 32 {
            self.connections.pop_front();
        }
        self.connections.push_back(LedgerConnection {
            remote: session.remote.clone(),
            generation: session.generation,
            agent_generation: session.local_generation,
            local_agent: session.local_agent.clone(),
            peer_agent: session.remote_agent.clone(),
            drive: session.drive.clone(),
            source: session.source.clone(),
            replica: None,
            receipts: VecDeque::new(),
        });
    }

    fn close(&mut self, remote: &str, generation: u64) {
        self.connections
            .retain(|c| c.remote != remote || c.generation != generation);
    }

    pub(crate) fn clear(&mut self) {
        self.connections.clear();
    }

    pub(crate) fn record(&mut self, evidence: &IrohReplicaReceipt) {
        let Some(connection) = self.connections.iter_mut().find(|c| {
            c.remote == evidence.remote_node_id
                && c.generation == evidence.connection_generation
                && c.agent_generation == evidence.agent_generation
                && c.local_agent == evidence.local_agent
                && c.peer_agent.to_string() == evidence.remote_agent
                && c.drive == evidence.receipt.drive
                && c.source == evidence.source
        }) else {
            return;
        };
        if connection.replica.as_ref() != Some(&evidence.receipt.replica) {
            connection.receipts.clear();
            connection.replica = Some(evidence.receipt.replica.clone());
        }
        let mut evidence = evidence.clone();
        if let Some(index) = connection
            .receipts
            .iter()
            .position(|r| r.receipt.subject == evidence.receipt.subject)
        {
            let old = connection.receipts.remove(index).unwrap();
            if let (Some(mut vv), Some(previous)) = (
                protocol::StorageReceiptRequest {
                    nonce: evidence.receipt.nonce.clone(),
                    drive: evidence.receipt.drive.clone(),
                    subject: evidence.receipt.subject.clone(),
                    version: evidence.receipt.version.clone(),
                }
                .frontier(),
                protocol::StorageReceiptRequest {
                    nonce: old.receipt.nonce,
                    drive: old.receipt.drive,
                    subject: old.receipt.subject,
                    version: old.receipt.version,
                }
                .frontier(),
            ) {
                vv.merge(&previous);
                let merged = URL_SAFE_NO_PAD.encode(vv.encode());
                // Keep the bridge's per-vector bound even for disjoint observed
                // frontiers. Forgetting older coverage is conservative.
                if merged.len() <= 16 * 1024 {
                    evidence.receipt.version = merged;
                    evidence.observed_at = evidence.observed_at.max(old.observed_at);
                }
            }
        }
        if connection.receipts.len() >= MAX_TARGETS {
            connection.receipts.pop_front();
        }
        connection.receipts.push_back(evidence);
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourcePeerEvidence {
    agent: String,
    agent_generation: String,
    connections: Vec<ResourcePeerConnection>,
}
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ResourcePeerConnection {
    connection_id: String,
    drive: String,
    peer_agent: String,
    receipts: Vec<ResourcePeerReceipt>,
}
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ResourcePeerReceipt {
    subject: String,
    version: String,
    confirmed_at: u64,
    source: StorageReceiptReplica,
    replica: StorageReceiptReplica,
}

fn ledger_connection_current(db: &Db, c: &LedgerConnection) -> bool {
    db.agent_generation() == c.agent_generation
        && super::peer::current_receipt_peer(&c.remote, c.generation, &c.peer_agent)
        && db
            .kv
            .replica_identity(&c.drive)
            .ok()
            .flatten()
            .is_some_and(|id| {
                id.storage_id == c.source.storage_id && id.generation == c.source.generation
            })
        && db
            .native_receipt_ledger
            .lock()
            .unwrap()
            .connections
            .iter()
            .any(|live| {
                live.remote == c.remote
                    && live.generation == c.generation
                    && live.agent_generation == c.agent_generation
                    && live.replica == c.replica
            })
}

/// Read already-observed evidence only. No network request or persistence receipt
/// is produced here. A caller replaces evidence for its requested subjects.
pub async fn resource_peer_evidence(db: &Db, subjects: &[String]) -> ResourcePeerEvidence {
    let removal_generation = db.native_removal_generation();
    let write_generation = db.write_log().generation();
    let generation = db.agent_generation();
    let agent = db.get_default_agent().ok();
    let mut result = ResourcePeerEvidence {
        agent: agent
            .as_ref()
            .map(|a| a.subject.to_string())
            .unwrap_or_default(),
        agent_generation: generation.to_string(),
        connections: Vec::new(),
    };
    let Some(agent) = agent else {
        return result;
    };
    let reader = ForAgent::AgentSubject(agent.subject);
    let sessions = {
        let mut ledger = db.native_receipt_ledger.lock().unwrap();
        ledger.sync_removals(removal_generation);
        ledger.connections.clone()
    };
    for session in sessions {
        if session.local_agent != result.agent
            || session.agent_generation != generation
            || !ledger_connection_current(db, &session)
        {
            continue;
        }
        let mut receipts = Vec::new();
        let mut relevant = false;
        for requested in subjects.iter().take(128) {
            let subject = db.normalize_subject(&requested.as_str().into());
            if super::tombstones::is_tombstoned(db, &subject.pure_id()) {
                continue;
            }
            let Ok(Some(resource)) = super::storage_receipts::stored_resource(db, &subject) else {
                continue;
            };
            if !super::storage_receipts::in_drive(db, &resource, &session.drive)
                || crate::hierarchy::check_read(db, &resource, &reader)
                    .await
                    .is_err()
                || crate::hierarchy::check_read(db, &resource, &session.peer_agent)
                    .await
                    .is_err()
            {
                continue;
            }
            relevant = true;
            let public = wire_subject(db, &subject.pure_id());
            if let Some(receipt) = session
                .receipts
                .iter()
                .find(|r| r.receipt.subject == public)
            {
                receipts.push(ResourcePeerReceipt {
                    subject: requested.clone(),
                    version: receipt.receipt.version.clone(),
                    confirmed_at: receipt.observed_at,
                    source: receipt.source.clone(),
                    replica: receipt.receipt.replica.clone(),
                });
            }
        }
        if relevant && ledger_connection_current(db, &session) {
            result.connections.push(ResourcePeerConnection {
                connection_id: format!("iroh:{}:{}", session.remote, session.generation),
                drive: session.drive.clone(),
                peer_agent: session.peer_agent.to_string(),
                receipts,
            });
        }
    }
    // Any row/snapshot mutation during asynchronous ACL checks (including a
    // parent ACL, deletion or move) invalidates this diagnostic snapshot.
    if db.write_log().generation() != write_generation
        || db.native_removal_generation() != removal_generation
    {
        result.connections.clear();
    }
    if db.agent_generation() != generation {
        result.agent = db
            .get_default_agent()
            .ok()
            .map(|a| a.subject.to_string())
            .unwrap_or_default();
        result.agent_generation = db.agent_generation().to_string();
        result.connections.clear();
    }
    result
}

const MAX_TARGETS: usize = 256;
const MAX_PENDING: usize = 8;
const RETRY_AFTER: Duration = Duration::from_secs(2);
const MAX_ATTEMPTS: u8 = 4;
const RETRY_COOLDOWN: Duration = Duration::from_secs(30);

#[derive(Clone, PartialEq, Eq)]
struct Target {
    subject: String,
    version: String,
}
struct Pending {
    request: StorageReceiptRequest,
    sent: Instant,
    attempts: u8,
}
#[derive(Default)]
struct Requests {
    closed: bool,
    removal_generation: u64,
    queued: VecDeque<Target>,
    pending: VecDeque<Pending>,
    completed: VecDeque<Target>,
    cooling: VecDeque<(Target, Instant)>,
}

impl Requests {
    fn sync_removals(&mut self, generation: u64) {
        if self.removal_generation < generation {
            self.removal_generation = generation;
            self.queued.clear();
            self.pending.clear();
            self.completed.clear();
            self.cooling.clear();
        }
    }

    fn enqueue(&mut self, target: Target) {
        self.cooling.retain(|(_, at)| at.elapsed() < RETRY_COOLDOWN);
        if self.closed
            || self.queued.contains(&target)
            || self.completed.contains(&target)
            || self.cooling.iter().any(|(t, _)| t == &target)
            || self
                .pending
                .iter()
                .any(|p| p.request.subject == target.subject && p.request.version == target.version)
        {
            return;
        }
        if self.queued.len() == MAX_TARGETS {
            self.queued.pop_front();
        }
        self.queued.push_back(target);
    }

    fn next(&mut self, drive: &str, now: Instant) -> Option<StorageReceiptRequest> {
        if self.closed {
            return None;
        }
        if let Some(index) = self
            .pending
            .iter()
            .position(|p| now.duration_since(p.sent) >= RETRY_AFTER)
        {
            let mut old = self.pending.remove(index)?;
            if old.attempts < MAX_ATTEMPTS {
                // Every retry has a fresh nonce. A delayed older reply cannot
                // consume the new outstanding request.
                old.request.nonce = protocol::new_challenge_nonce();
                old.sent = now;
                old.attempts += 1;
                let request = old.request.clone();
                self.pending.push_back(old);
                return Some(request);
            }
            if self.cooling.len() == MAX_TARGETS {
                self.cooling.pop_front();
            }
            self.cooling.push_back((
                Target {
                    subject: old.request.subject,
                    version: old.request.version,
                },
                now,
            ));
        }
        if self.pending.len() >= MAX_PENDING {
            return None;
        }
        let target = self.queued.pop_front()?;
        let request = StorageReceiptRequest {
            nonce: protocol::new_challenge_nonce(),
            drive: drive.into(),
            subject: target.subject,
            version: target.version,
        };
        self.pending.push_back(Pending {
            request: request.clone(),
            sent: now,
            attempts: 1,
        });
        Some(request)
    }

    fn matching(&self, receipt: &StorageReceipt) -> Option<usize> {
        if self.closed || !receipt.validate() {
            return None;
        }
        self.pending.iter().position(|p| {
            p.sent.elapsed() < RETRY_AFTER
                && p.request.nonce == receipt.nonce
                && p.request.drive == receipt.drive
                && p.request.subject == receipt.subject
                && p.request.version == receipt.version
        })
    }

    fn accept(&mut self, receipt: &StorageReceipt) -> bool {
        let Some(index) = self.matching(receipt) else {
            return false;
        };
        self.pending.remove(index);
        if self.completed.len() == MAX_TARGETS {
            self.completed.pop_front();
        }
        self.completed.push_back(Target {
            subject: receipt.subject.clone(),
            version: receipt.version.clone(),
        });
        true
    }
}

pub(crate) struct ReceiptSession {
    remote: String,
    remote_agent: ForAgent,
    drive: String,
    generation: u64,
    local_agent: String,
    local_generation: u64,
    source: StorageReceiptReplica,
    requests: Mutex<Requests>,
    ledger: Arc<Mutex<NativeReceiptLedger>>,
}

impl ReceiptSession {
    pub(crate) fn new(
        db: &Db,
        remote: String,
        remote_agent: ForAgent,
        drive: &str,
        generation: u64,
        local_generation: u64,
        caps: &[String],
    ) -> Option<Arc<Self>> {
        if matches!(remote_agent, ForAgent::Public)
            || !caps
                .iter()
                .any(|c| c == protocol::CAP_IROH_STORAGE_RECEIPTS_V1)
            || db.agent_generation() != local_generation
        {
            return None;
        }
        let local_agent = db.get_default_agent().ok()?.subject.to_string();
        let drive = wire_subject(db, drive);
        let source = db.kv.replica_identity(&drive).ok()??;
        if db.agent_generation() != local_generation {
            return None;
        }
        let session = Arc::new(Self {
            remote,
            remote_agent,
            drive,
            generation,
            local_agent,
            local_generation,
            source: StorageReceiptReplica {
                storage_id: source.storage_id,
                generation: source.generation,
            },
            requests: Mutex::new(Requests::default()),
            ledger: db.native_receipt_ledger.clone(),
        });
        {
            let mut ledger = session.ledger.lock().unwrap();
            ledger.sync_removals(db.native_removal_generation());
            ledger.open(&session);
        }
        Some(session)
    }

    pub(crate) fn invalidate(&self) {
        let mut requests = self.requests.lock().unwrap();
        requests.closed = true;
        requests.queued.clear();
        requests.pending.clear();
        self.ledger
            .lock()
            .unwrap()
            .close(&self.remote, self.generation);
    }

    fn active(&self, db: &Db) -> bool {
        let closed = self.requests.lock().unwrap().closed;
        !closed
            && db.agent_generation() == self.local_generation
            && super::peer::current_receipt_peer(&self.remote, self.generation, &self.remote_agent)
    }

    pub(crate) fn current(&self, db: &Db) -> bool {
        self.requests
            .lock()
            .unwrap()
            .sync_removals(db.native_removal_generation());
        if !self.active(db) {
            return false;
        }
        let Some(id) = db.kv.replica_identity(&self.drive).ok().flatten() else {
            // An open write batch temporarily suppresses identity. It is not
            // a database reset and must not retire a healthy live session.
            return false;
        };
        if id.storage_id != self.source.storage_id || id.generation != self.source.generation {
            self.invalidate();
            return false;
        }
        self.active(db)
    }

    async fn readable(&self, db: &Db, subject: &str) -> bool {
        let Ok(Some(resource)) = super::storage_receipts::stored_resource(db, &subject.into())
        else {
            return false;
        };
        let same_drive = super::storage_receipts::in_drive(db, &resource, &self.drive);
        same_drive
            && crate::hierarchy::check_read(db, &resource, &self.remote_agent)
                .await
                .is_ok()
    }

    async fn observe(&self, db: &Db, subject: &str) {
        if !self.current(db)
            || !self.readable(db, subject).await
            || super::tombstones::is_tombstoned(db, subject)
        {
            return;
        }
        let stored_subject = db.normalize_subject(&subject.into()).pure_id();
        let Some(snapshot) = db.get_loro_snapshot_bytes(&stored_subject) else {
            return;
        };
        let Ok(doc) = AtomicLoroDoc::from_snapshot(&snapshot) else {
            return;
        };
        let vv: loro::VersionVector = doc
            .doc()
            .state_vv()
            .iter()
            .filter(|(_, counter)| **counter > 0)
            .map(|(peer, counter)| (*peer, *counter))
            .collect();
        if vv.is_empty() || !self.current(db) {
            return;
        }
        let target = Target {
            subject: wire_subject(db, subject),
            version: URL_SAFE_NO_PAD.encode(vv.encode()),
        };
        let checked = StorageReceiptRequest {
            nonce: "0".repeat(64),
            drive: self.drive.clone(),
            subject: target.subject.clone(),
            version: target.version.clone(),
        };
        if checked.validate() {
            self.requests.lock().unwrap().enqueue(target);
        }
    }

    pub(crate) async fn receive(&self, db: &Db, payload: &[u8]) {
        let Some(receipt) = StorageReceipt::decode(payload) else {
            return;
        };
        // Check the exact outstanding tuple before any resource lookup. An
        // unsolicited reply must not get to resolve its attacker-chosen URL.
        // Release the lock before the asynchronous ACL check; accept() repeats
        // correlation and expiry afterward, when a retry may have superseded it.
        let correlated = self.requests.lock().unwrap().matching(&receipt).is_some();
        if !correlated {
            return;
        }
        if !self.current(db) || !self.readable(db, &receipt.subject).await || !self.current(db) {
            return;
        }
        let accepted_generation = {
            let mut requests = self.requests.lock().unwrap();
            requests
                .accept(&receipt)
                .then_some(requests.removal_generation)
        };
        if let Some(removal_generation) = accepted_generation {
            super::peer::emit_receipt_if_current(
                db,
                &self.remote_agent,
                IrohReplicaReceipt {
                    receipt,
                    source: self.source.clone(),
                    remote_node_id: self.remote.clone(),
                    remote_agent: self.remote_agent.to_string(),
                    local_agent: self.local_agent.clone(),
                    connection_generation: self.generation,
                    agent_generation: self.local_generation,
                    removal_generation,
                    observed_at: crate::utils::now() as u64,
                },
            );
        }
    }

    pub(crate) fn start(self: &Arc<Self>, db: Db, tx: tokio::sync::mpsc::Sender<Vec<u8>>) {
        // Subscribe before the first inventory so an edit during seeding is
        // still observed. Periodic inventory recovers from broadcast lag.
        let mut events = db.subscribe_events();
        let session = self.clone();
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(Duration::from_millis(250));
            let mut last_scan = Instant::now() - Duration::from_secs(2);
            let mut cursor = 0usize;
            let mut inventory: Vec<String> = Vec::new();
            let mut last_inventory = Instant::now() - Duration::from_secs(30);
            loop {
                tokio::select! {
                    _ = tick.tick() => {},
                    event = events.recv() => {
                        if let Ok(crate::DbEvent::Changed { subject, .. }) = event {
                            session.observe(&db, &subject.pure_id()).await;
                        }
                    }
                }
                if !session.active(&db) {
                    session.invalidate();
                    break;
                }
                if !session.current(&db) {
                    continue;
                }
                if last_scan.elapsed() >= Duration::from_secs(1) {
                    if last_inventory.elapsed() >= Duration::from_secs(30) {
                        let drive = crate::Subject::from(session.drive.as_str());
                        inventory = super::engine::collect_drive_subjects(&db, &drive)
                            .await
                            .into_iter()
                            .collect();
                        inventory.sort();
                        last_inventory = Instant::now();
                    }
                    let subjects = &inventory;
                    // Fair bounded work per pass, including drives with more
                    // resources than the pending request budget.
                    for i in 0..subjects.len().min(32) {
                        session
                            .observe(&db, &subjects[(cursor + i) % subjects.len()])
                            .await;
                    }
                    cursor = if subjects.is_empty() {
                        0
                    } else {
                        (cursor + 32) % subjects.len()
                    };
                    last_scan = Instant::now();
                }
                for _ in 0..MAX_PENDING {
                    let request = session
                        .requests
                        .lock()
                        .unwrap()
                        .next(&session.drive, Instant::now());
                    let Some(request) = request else {
                        break;
                    };
                    if !session.readable(&db, &request.subject).await || !session.current(&db) {
                        continue;
                    }
                    let Some(frame) = request.encode_frame() else {
                        continue;
                    };
                    let mut framed = Vec::with_capacity(frame.len() + 4);
                    framed.extend_from_slice(&(frame.len() as u32).to_be_bytes());
                    framed.extend(frame);
                    // Dropping a request on backpressure is safe: it remains
                    // pending and can be retried. Never spawn unbounded sends.
                    if tx.try_send(framed).is_err() {
                        break;
                    }
                }
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn target(counter: i32) -> Target {
        let vv: loro::VersionVector = [(7, counter)].into_iter().collect();
        Target {
            subject: "atomic:receipt-resource".into(),
            version: URL_SAFE_NO_PAD.encode(vv.encode()),
        }
    }

    fn reply(request: &StorageReceiptRequest) -> StorageReceipt {
        StorageReceipt {
            nonce: request.nonce.clone(),
            drive: request.drive.clone(),
            subject: request.subject.clone(),
            version: request.version.clone(),
            replica: StorageReceiptReplica {
                storage_id: "a".repeat(64),
                generation: "b".repeat(64),
            },
            barrier: protocol::STORAGE_RECEIPT_BARRIER.into(),
        }
    }

    async fn fixture(name: &str) -> (Db, String, ForAgent, Arc<ReceiptSession>) {
        let db = Db::init_temp(name).await.unwrap();
        let (agent, drive) = db.setup("Receipt owner").await.unwrap();
        let agent = ForAgent::AgentSubject(agent.subject);
        super::super::peer::receipt_peer_for_test(name, 1, agent.clone());
        let session = ReceiptSession::new(
            &db,
            name.into(),
            agent.clone(),
            &drive,
            1,
            db.agent_generation(),
            &[protocol::CAP_IROH_STORAGE_RECEIPTS_V1.into()],
        )
        .unwrap();
        (db, drive, agent, session)
    }

    async fn confirm(db: &Db, session: &ReceiptSession, subject: &str) {
        session.observe(db, subject).await;
        let request = session
            .requests
            .lock()
            .unwrap()
            .next(&session.drive, Instant::now())
            .unwrap();
        session
            .receive(db, &serde_json::to_vec(&reply(&request)).unwrap())
            .await;
    }

    #[tokio::test]
    async fn native_ledger_recovers_preexisting_proof_and_isolates_account_views() {
        let (db, drive, _, session) = fixture("native_ledger_late_reader").await;
        confirm(&db, &session, &drive).await;
        let queried = resource_peer_evidence(&db, std::slice::from_ref(&drive)).await;
        assert_eq!(queried.connections.len(), 1);
        assert_eq!(queried.connections[0].receipts.len(), 1);
        assert_eq!(queried.connections[0].receipts[0].subject, drive);
        let other = db.with_own_agent(Some(db.get_default_agent().unwrap()));
        assert!(resource_peer_evidence(&other, std::slice::from_ref(&drive))
            .await
            .connections
            .is_empty());
        assert_eq!(
            db.native_receipt_ledger.lock().unwrap().connections.len(),
            1
        );
        session.invalidate();
        assert!(resource_peer_evidence(&db, &[drive])
            .await
            .connections
            .is_empty());
        super::super::peer::remove_live_peer(&session.remote, 1);
    }

    #[tokio::test]
    async fn native_ledger_http_subjects_use_public_wire_and_requested_output() {
        let (db, drive, _, session) = fixture("native_ledger_http").await;
        let subject = "https://localhost/native-receipt";
        let mut resource = db.get_resource(&drive.as_str().into()).await.unwrap();
        resource.set_subject(subject.into());
        resource
            .set_unsafe(
                crate::urls::DRIVE_PROP.into(),
                crate::Value::AtomicUrl(drive.clone().into()),
            )
            .unwrap();
        db.add_resource(&resource).await.unwrap();
        let stored = db.normalize_subject(&subject.into()).pure_id();
        assert!(stored.starts_with("internal:"));
        confirm(&db, &session, &stored).await;
        let queried = resource_peer_evidence(&db, &[subject.into()]).await;
        assert_eq!(queried.connections[0].receipts[0].subject, subject);
        db.remove_resource(&stored.as_str().into()).await.unwrap();
        assert!(resource_peer_evidence(&db, &[subject.into()])
            .await
            .connections
            .is_empty());
        super::super::peer::remove_live_peer(&session.remote, 1);
    }

    async fn lifecycle_resource(db: &Db, drive: &str) -> crate::Resource {
        let mut resource = db.get_resource(&drive.into()).await.unwrap();
        resource.set_subject("https://localhost/native-lifecycle".into());
        resource
            .set_unsafe(
                crate::urls::DRIVE_PROP.into(),
                crate::Value::AtomicUrl(drive.into()),
            )
            .unwrap();
        db.add_resource(&resource).await.unwrap();
        db.get_resource(resource.get_subject()).await.unwrap()
    }

    async fn restore_identical(
        db: &Db,
        resource: &crate::Resource,
        snapshot: &[u8],
        version: &loro::VersionVector,
    ) {
        db.persist_replicated_resource_with_snapshot(resource, snapshot.to_vec())
            .await
            .unwrap();
        let key = db.normalize_subject(resource.get_subject()).pure_id();
        super::super::tombstones::clear_tombstone(db, &key);
        let snapshot = db.get_loro_snapshot(resource.get_subject()).unwrap();
        assert_eq!(
            &AtomicLoroDoc::from_snapshot(&snapshot)
                .unwrap()
                .doc()
                .state_vv(),
            version
        );
    }

    #[tokio::test]
    async fn native_removal_through_account_view_resets_completed_identical_version() {
        let (db, drive, _, session) = fixture("native_removal_completed").await;
        let resource = lifecycle_resource(&db, &drive).await;
        let subject = wire_subject(&db, resource.get_subject().as_str());
        let key = db.normalize_subject(resource.get_subject()).pure_id();
        let snapshot = db.get_loro_snapshot(resource.get_subject()).unwrap();
        let vv = AtomicLoroDoc::from_snapshot(&snapshot)
            .unwrap()
            .doc()
            .state_vv();
        confirm(&db, &session, &subject).await;
        assert_eq!(
            resource_peer_evidence(&db, std::slice::from_ref(&subject))
                .await
                .connections[0]
                .receipts
                .len(),
            1
        );
        let own_view = db.with_own_agent(Some(db.get_default_agent().unwrap()));
        let before = db.native_removal_generation();
        own_view
            .remove_resource(&key.as_str().into())
            .await
            .unwrap();
        assert!(db.native_removal_generation() > before);
        restore_identical(&db, &resource, &snapshot, &vv).await;
        assert!(resource_peer_evidence(&db, std::slice::from_ref(&subject))
            .await
            .connections[0]
            .receipts
            .is_empty());
        // The completed target must have been forgotten, so this exact VV can
        // produce a new request and only that response restores confirmation.
        confirm(&db, &session, &subject).await;
        assert_eq!(
            resource_peer_evidence(&db, &[subject]).await.connections[0]
                .receipts
                .len(),
            1
        );
        // An older query/current() call resuming later must not roll back the
        // epoch and erase evidence already obtained in the new lifecycle.
        db.native_receipt_ledger
            .lock()
            .unwrap()
            .sync_removals(before);
        session.requests.lock().unwrap().sync_removals(before);
        assert_eq!(session.requests.lock().unwrap().completed.len(), 1);
        assert_eq!(
            db.native_receipt_ledger.lock().unwrap().connections[0]
                .receipts
                .len(),
            1
        );
        super::super::peer::remove_live_peer(&session.remote, 1);
    }

    #[tokio::test]
    async fn native_removal_rejects_pending_and_already_accepted_late_receipts() {
        let (db, drive, _, session) = fixture("native_removal_pending").await;
        let resource = lifecycle_resource(&db, &drive).await;
        let subject = wire_subject(&db, resource.get_subject().as_str());
        let key = db.normalize_subject(resource.get_subject()).pure_id();
        let snapshot = db.get_loro_snapshot(resource.get_subject()).unwrap();
        let vv = AtomicLoroDoc::from_snapshot(&snapshot)
            .unwrap()
            .doc()
            .state_vv();
        session.observe(&db, &subject).await;
        let pending = session
            .requests
            .lock()
            .unwrap()
            .next(&session.drive, Instant::now())
            .unwrap();
        db.remove_resource(&key.as_str().into()).await.unwrap();
        restore_identical(&db, &resource, &snapshot, &vv).await;
        session
            .receive(&db, &serde_json::to_vec(&reply(&pending)).unwrap())
            .await;
        assert!(resource_peer_evidence(&db, std::slice::from_ref(&subject))
            .await
            .connections[0]
            .receipts
            .is_empty());
        confirm(&db, &session, &subject).await;
        let accepted = db.native_receipt_ledger.lock().unwrap().connections[0].receipts[0].clone();
        // A direct tombstone (without a row-delete transaction) is also a
        // lifecycle boundary. Publication accepted earlier cannot cross it.
        super::super::tombstones::record_tombstone(&db, &key);
        super::super::tombstones::clear_tombstone(&db, &key);
        let mut events = db.subscribe_replica_receipts();
        db.emit_replica_receipt(accepted);
        assert!(matches!(
            events.try_recv(),
            Err(tokio::sync::broadcast::error::TryRecvError::Empty)
        ));
        assert!(resource_peer_evidence(&db, std::slice::from_ref(&subject))
            .await
            .connections[0]
            .receipts
            .is_empty());
        confirm(&db, &session, &subject).await;
        assert_eq!(
            resource_peer_evidence(&db, &[subject]).await.connections[0]
                .receipts
                .len(),
            1
        );
        super::super::peer::remove_live_peer(&session.remote, 1);
    }

    #[tokio::test]
    async fn native_ledger_bounds_and_monotonic_versions() {
        let (db, drive, agent, session) = fixture("native_ledger_bounds").await;
        confirm(&db, &session, &drive).await;
        let mut event = db.native_receipt_ledger.lock().unwrap().connections[0].receipts[0].clone();
        let first: loro::VersionVector = [(7, 5)].into_iter().collect();
        event.receipt.version = URL_SAFE_NO_PAD.encode(first.encode());
        db.emit_replica_receipt(event.clone());
        let second: loro::VersionVector = [(7, 2), (9, 3)].into_iter().collect();
        event.receipt.version = URL_SAFE_NO_PAD.encode(second.encode());
        db.emit_replica_receipt(event.clone());
        let result = resource_peer_evidence(&db, std::slice::from_ref(&drive)).await;
        let bytes =
            crate::agents::decode_base64(&result.connections[0].receipts[0].version).unwrap();
        let merged = loro::VersionVector::decode(&bytes).unwrap();
        assert!(merged.includes_vv(&first));
        assert!(merged.includes_vv(&second));
        for n in 0..300 {
            event.receipt.subject = format!("atomic:bounded-{n}");
            db.emit_replica_receipt(event.clone());
        }
        assert_eq!(
            db.native_receipt_ledger.lock().unwrap().connections[0]
                .receipts
                .len(),
            MAX_TARGETS
        );
        for n in 0..40 {
            ReceiptSession::new(
                &db,
                format!("bounded-{n}"),
                agent.clone(),
                &drive,
                n,
                db.agent_generation(),
                &[protocol::CAP_IROH_STORAGE_RECEIPTS_V1.into()],
            )
            .unwrap();
        }
        assert_eq!(
            db.native_receipt_ledger.lock().unwrap().connections.len(),
            32
        );
        super::super::peer::remove_live_peer(&session.remote, 1);
    }

    #[tokio::test]
    async fn native_ledger_replacement_and_identity_change_clear_old_evidence() {
        let (db, drive, agent, session) = fixture("native_ledger_replace").await;
        confirm(&db, &session, &drive).await;
        let mut event = db.native_receipt_ledger.lock().unwrap().connections[0].receipts[0].clone();
        event.receipt.subject = "atomic:other".into();
        event.receipt.replica.generation = "c".repeat(64);
        db.emit_replica_receipt(event);
        assert!(resource_peer_evidence(&db, std::slice::from_ref(&drive))
            .await
            .connections[0]
            .receipts
            .is_empty());
        super::super::peer::receipt_peer_for_test(&session.remote, 2, agent.clone());
        let replacement = ReceiptSession::new(
            &db,
            session.remote.clone(),
            agent,
            &drive,
            2,
            db.agent_generation(),
            &[protocol::CAP_IROH_STORAGE_RECEIPTS_V1.into()],
        )
        .unwrap();
        session.invalidate();
        let queried = resource_peer_evidence(&db, std::slice::from_ref(&drive)).await;
        assert_eq!(queried.connections.len(), 1);
        assert!(queried.connections[0].connection_id.ends_with(":2"));
        assert!(queried.connections[0].receipts.is_empty());
        confirm(&db, &replacement, &drive).await;
        db.clear_default_agent();
        let queried = resource_peer_evidence(&db, &[drive]).await;
        assert!(queried.agent.is_empty());
        assert!(queried.connections.is_empty());
        super::super::peer::remove_live_peer(&session.remote, 2);
    }

    #[tokio::test]
    async fn iroh_receipts_require_capability_identity_and_persistent_source() {
        let (db, drive, agent, session) = fixture("iroh_receipt_capability").await;
        assert!(session.current(&db));
        assert!(ReceiptSession::new(
            &db,
            session.remote.clone(),
            agent.clone(),
            &drive,
            1,
            db.agent_generation(),
            &[]
        )
        .is_none());
        assert!(ReceiptSession::new(
            &db,
            session.remote.clone(),
            ForAgent::Public,
            &drive,
            1,
            db.agent_generation(),
            &[protocol::CAP_IROH_STORAGE_RECEIPTS_V1.into()]
        )
        .is_none());
        let memory = Db::init_redb(None).await.unwrap();
        memory.set_default_agent(db.get_default_agent().unwrap());
        assert!(ReceiptSession::new(
            &memory,
            session.remote.clone(),
            agent,
            &drive,
            1,
            memory.agent_generation(),
            &[protocol::CAP_IROH_STORAGE_RECEIPTS_V1.into()]
        )
        .is_none());
        super::super::peer::remove_live_peer(&session.remote, 1);
    }

    #[tokio::test]
    async fn iroh_receipts_fence_agent_away_back_and_connection_replacement() {
        let (db, drive, agent, session) = fixture("iroh_receipt_fences").await;
        let mut events = db.subscribe_replica_receipts();
        session.observe(&db, &drive).await;
        let request = session
            .requests
            .lock()
            .unwrap()
            .next(&drive, Instant::now())
            .unwrap();
        let receipt = serde_json::to_vec(&reply(&request)).unwrap();
        let owner = db.get_default_agent().unwrap();
        db.clear_default_agent();
        db.set_default_agent(owner);
        session.receive(&db, &receipt).await;
        assert!(
            events.try_recv().is_err(),
            "restoring the same agent must not restore old evidence"
        );
        let fresh = ReceiptSession::new(
            &db,
            session.remote.clone(),
            agent.clone(),
            &drive,
            1,
            db.agent_generation(),
            &[protocol::CAP_IROH_STORAGE_RECEIPTS_V1.into()],
        )
        .unwrap();
        fresh.observe(&db, &drive).await;
        let request = fresh
            .requests
            .lock()
            .unwrap()
            .next(&drive, Instant::now())
            .unwrap();
        super::super::peer::receipt_peer_for_test(&session.remote, 2, agent);
        fresh
            .receive(&db, &serde_json::to_vec(&reply(&request)).unwrap())
            .await;
        assert!(
            events.try_recv().is_err(),
            "a replaced read loop cannot emit"
        );
        super::super::peer::remove_live_peer(&session.remote, 2);
    }

    #[tokio::test]
    async fn iroh_receipts_restrict_drive_and_invalidate_late_auth() {
        let (db, drive, _, session) = fixture("iroh_receipt_drive").await;
        let other = db.create_drive("Other drive").await.unwrap();
        session.observe(&db, &other).await;
        assert!(session.requests.lock().unwrap().queued.is_empty());
        session.observe(&db, &drive).await;
        let request = session
            .requests
            .lock()
            .unwrap()
            .next(&drive, Instant::now())
            .unwrap();
        let mut events = db.subscribe_replica_receipts();
        session.invalidate();
        session
            .receive(&db, &serde_json::to_vec(&reply(&request)).unwrap())
            .await;
        assert!(events.try_recv().is_err());
        super::super::peer::remove_live_peer(&session.remote, 1);
    }

    #[tokio::test]
    async fn iroh_receipts_pause_for_open_batch_then_resume() {
        let (db, _, _, session) = fixture("iroh_receipt_batch").await;
        db.begin_batch();
        assert!(!session.current(&db));
        assert!(
            session.active(&db),
            "temporary batch must not retire session"
        );
        db.commit_batch().unwrap();
        assert!(session.current(&db));
        super::super::peer::remove_live_peer(&session.remote, 1);
    }

    #[tokio::test]
    async fn iroh_receipts_reject_uncorrelated_reply_before_any_resource_read() {
        let (db, drive, _, session) = fixture("iroh_receipt_uncorrelated_read").await;
        let request = StorageReceiptRequest {
            nonce: "c".repeat(64),
            drive: drive.clone(),
            subject: drive,
            version: target(1).version,
        };
        // Even a stored, readable subject must not be consulted for a reply
        // that answers no outstanding request.
        db.reset_fetch_counters();
        session
            .receive(&db, &serde_json::to_vec(&reply(&request)).unwrap())
            .await;
        super::super::peer::remove_live_peer(&session.remote, 1);
        assert_eq!(
            db.get_resource_call_count(),
            0,
            "correlation must precede resource resolution and ACL checks"
        );
        assert_eq!(
            db.get_resource_shallow_call_count(),
            0,
            "correlation must precede even local subject lookup"
        );
    }

    #[tokio::test]
    async fn iroh_receipts_do_not_fetch_unstored_http_subjects() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let subject = format!("http://{}/not-stored", listener.local_addr().unwrap());
        let accepted = Arc::new(AtomicUsize::new(0));
        let counter = accepted.clone();
        let responder = tokio::spawn(async move {
            loop {
                let (mut socket, _) = listener.accept().await.unwrap();
                counter.fetch_add(1, Ordering::SeqCst);
                let mut request = [0u8; 4096];
                let _ = socket.read(&mut request).await;
                let _ = socket
                    .write_all(
                        b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                    )
                    .await;
            }
        });
        let (db, drive, _, session) = fixture("iroh_receipt_unstored_http").await;
        let request = StorageReceiptRequest {
            nonce: "c".repeat(64),
            drive,
            subject: subject.clone(),
            version: target(1).version,
        };
        session
            .receive(&db, &serde_json::to_vec(&reply(&request)).unwrap())
            .await;
        // The scheduler also uses this read gate. A previously observed HTTP
        // subject can disappear while a legitimate probe remains outstanding.
        assert!(!session.readable(&db, &subject).await);
        responder.abort();
        super::super::peer::remove_live_peer(&session.remote, 1);
        assert_eq!(
            accepted.load(Ordering::SeqCst),
            0,
            "receipt handling must never fetch absent HTTP subjects"
        );
        assert!(!db.has_stored_resource(&subject.as_str().into()));
    }

    #[test]
    fn delayed_c1_receipt_does_not_acknowledge_queued_c2() {
        let mut queue = Requests::default();
        queue.enqueue(target(1));
        let c1 = queue.next("atomic:drive", Instant::now()).unwrap();
        queue.enqueue(target(2));
        let c2 = queue.next("atomic:drive", Instant::now()).unwrap();
        assert!(queue.accept(&reply(&c1)));
        assert_eq!(queue.pending.len(), 1);
        assert_eq!(queue.pending.front().unwrap().request.version, c2.version);
        assert!(
            !queue.accept(&reply(&c1)),
            "duplicate receipt must not emit twice"
        );
        assert!(queue.accept(&reply(&c2)));
    }

    #[test]
    fn every_echo_field_and_the_barrier_are_correlated() {
        let mut queue = Requests::default();
        queue.enqueue(target(1));
        let request = queue.next("atomic:drive", Instant::now()).unwrap();
        for field in [
            "nonce",
            "drive",
            "subject",
            "version",
            "barrier",
            "storageId",
        ] {
            let mut receipt = reply(&request);
            match field {
                "nonce" => receipt.nonce = "c".repeat(64),
                "drive" => receipt.drive = "atomic:another-drive".into(),
                "subject" => receipt.subject = "atomic:another-resource".into(),
                "version" => receipt.version = target(2).version,
                "barrier" => receipt.barrier = "pretend-persisted".into(),
                _ => receipt.replica.storage_id = "not-an-identity".into(),
            }
            assert!(!queue.accept(&receipt), "must refuse changed {field}");
        }
        assert!(queue.accept(&reply(&request)));
    }

    #[test]
    fn expired_nonce_is_rejected_before_scheduler_retry() {
        let mut queue = Requests::default();
        queue.enqueue(target(1));
        let old = queue.next("atomic:drive", Instant::now()).unwrap();
        queue.pending.front_mut().unwrap().sent = Instant::now() - RETRY_AFTER;
        assert!(!queue.accept(&reply(&old)));
        let retried = queue.next("atomic:drive", Instant::now()).unwrap();
        assert_ne!(old.nonce, retried.nonce);
        assert!(!queue.accept(&reply(&old)));
        assert!(queue.accept(&reply(&retried)));
    }

    #[test]
    fn retry_exhaustion_cools_down_and_all_queues_stay_bounded() {
        let mut queue = Requests::default();
        queue.enqueue(target(1));
        queue.next("atomic:drive", Instant::now()).unwrap();
        for _ in 1..MAX_ATTEMPTS {
            queue.pending.front_mut().unwrap().sent = Instant::now() - RETRY_AFTER;
            assert!(queue.next("atomic:drive", Instant::now()).is_some());
        }
        queue.pending.front_mut().unwrap().sent = Instant::now() - RETRY_AFTER;
        assert!(queue.next("atomic:drive", Instant::now()).is_none());
        queue.enqueue(target(1));
        assert!(
            queue.queued.is_empty(),
            "periodic inventory must respect cooldown"
        );
        for i in 2..=(MAX_TARGETS as i32 + 20) {
            queue.enqueue(target(i));
        }
        assert_eq!(queue.queued.len(), MAX_TARGETS);
        for _ in 0..MAX_PENDING {
            assert!(queue.next("atomic:drive", Instant::now()).is_some());
        }
        assert!(queue.next("atomic:drive", Instant::now()).is_none());
        assert_eq!(queue.pending.len(), MAX_PENDING);
        queue.closed = true;
        let receipt = reply(&queue.pending.front().unwrap().request);
        assert!(!queue.accept(&receipt));
        assert!(queue.next("atomic:drive", Instant::now()).is_none());
    }
}
