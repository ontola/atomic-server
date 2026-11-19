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

/// Native transports share proof correlation/storage checks, but own their
/// liveness and wire framing. WebRTC has no entry in the Iroh peer registry.
#[derive(Clone)]
enum ReceiptTransport {
    Iroh,
    WebRtc(Arc<std::sync::atomic::AtomicBool>),
}
impl ReceiptTransport {
    fn current(&self, remote: &str, generation: u64, agent: &ForAgent) -> bool {
        match self {
            Self::Iroh => super::peer::current_receipt_peer(remote, generation, agent),
            Self::WebRtc(live) => live.load(std::sync::atomic::Ordering::Acquire),
        }
    }
    fn locally_live(&self) -> bool {
        match self {
            Self::Iroh => true,
            Self::WebRtc(live) => live.load(std::sync::atomic::Ordering::Acquire),
        }
    }
    fn retire(&self) {
        if let Self::WebRtc(live) = self {
            live.store(false, std::sync::atomic::Ordering::Release);
        }
    }
    fn connection_id(&self, remote: &str, generation: u64) -> String {
        let prefix = match self {
            Self::Iroh => "iroh",
            Self::WebRtc(_) => "webrtc",
        };
        format!("{prefix}:{remote}:{generation}")
    }
    fn frame(&self, frame: Vec<u8>) -> Vec<u8> {
        if matches!(self, Self::WebRtc(_)) {
            return frame;
        }
        let mut framed = Vec::with_capacity(frame.len() + 4);
        framed.extend_from_slice(&(frame.len() as u32).to_be_bytes());
        framed.extend(frame);
        framed
    }
}

#[derive(Clone)]
struct LedgerConnection {
    remote: String,
    transport: ReceiptTransport,
    generation: u64,
    agent_generation: u64,
    local_agent: String,
    peer_agent: ForAgent,
    drive: String,
    source: StorageReceiptReplica,
    replica: Option<StorageReceiptReplica>,
    receipts: VecDeque<IrohReplicaReceipt>,
    attachment_receipts: VecDeque<(protocol::AttachmentReceipt, u64)>,
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
                connection.attachment_receipts.clear();
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
            transport: session.transport.clone(),
            generation: session.generation,
            agent_generation: session.local_generation,
            local_agent: session.local_agent.clone(),
            peer_agent: session.remote_agent.clone(),
            drive: session.drive.clone(),
            source: session.source.clone(),
            replica: None,
            receipts: VecDeque::new(),
            attachment_receipts: VecDeque::new(),
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
                && c.transport.locally_live()
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
            connection.attachment_receipts.clear();
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
                evidence.receipt.request().frontier(),
                old.receipt.request().frontier(),
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
    /// Present on a file-contents receipt, absent on a resource one.
    #[serde(skip_serializing_if = "Option::is_none")]
    manifest: Option<super::attachment_manifest::AttachmentManifest>,
    confirmed_at: u64,
    source: StorageReceiptReplica,
    replica: StorageReceiptReplica,
}

fn ledger_connection_current(db: &Db, c: &LedgerConnection) -> bool {
    db.agent_generation() == c.agent_generation
        && c.transport.current(&c.remote, c.generation, &c.peer_agent)
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
                    manifest: None,
                    confirmed_at: receipt.observed_at,
                    source: receipt.source.clone(),
                    replica: receipt.receipt.replica.clone(),
                });
            }
            if let Some((receipt, at)) = session.attachment_receipts.iter().find(|(receipt, at)| {
                receipt.subject == public
                    && crate::utils::now() >= *at as i64
                    && crate::utils::now().saturating_sub(*at as i64) < 30_000
            }) {
                if let (Ok((_, local)), Ok((_, remote))) = (
                    super::attachment_receipts::derive_manifest(db, &reader, requested).await,
                    super::attachment_receipts::derive_manifest(db, &session.peer_agent, requested)
                        .await,
                ) {
                    if local == receipt.manifest && remote == local {
                        receipts.push(ResourcePeerReceipt {
                            subject: requested.clone(),
                            version: receipt.version.clone(),
                            manifest: Some(local),
                            confirmed_at: *at,
                            source: session.source.clone(),
                            replica: receipt.replica.clone(),
                        });
                    }
                }
            }
        }
        if relevant && ledger_connection_current(db, &session) {
            result.connections.push(ResourcePeerConnection {
                connection_id: session
                    .transport
                    .connection_id(&session.remote, session.generation),
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

/// A receipt request a session keeps in a bounded [`Requests`] queue.
trait Request: Clone + PartialEq {
    /// Retry an unanswered request under a fresh nonce, then cool down. The
    /// alternative drops it, to be asked again once something observes it.
    const RETRIES: bool;
    /// How long a request is outstanding before it is retried or dropped.
    const WAIT: Duration;
    /// How long a completed ask is remembered; forever (bounded) when unset.
    const KEEP_COMPLETED: Option<Duration>;
    fn nonce_mut(&mut self) -> &mut String;
    /// Whether both ask for the same proof, whatever their nonces.
    fn same_ask(&self, other: &Self) -> bool;
}

impl Request for StorageReceiptRequest {
    const RETRIES: bool = true;
    const WAIT: Duration = RETRY_AFTER;
    const KEEP_COMPLETED: Option<Duration> = None;
    fn nonce_mut(&mut self) -> &mut String {
        &mut self.nonce
    }
    fn same_ask(&self, other: &Self) -> bool {
        self.subject == other.subject && self.version == other.version
    }
}

impl Request for protocol::AttachmentReceiptRequest {
    const RETRIES: bool = false;
    const WAIT: Duration = Duration::from_secs(30);
    // Contents proof is re-verified every so often, not just once per version.
    const KEEP_COMPLETED: Option<Duration> = Some(Duration::from_secs(10));
    fn nonce_mut(&mut self) -> &mut String {
        &mut self.nonce
    }
    fn same_ask(&self, other: &Self) -> bool {
        self.subject == other.subject && self.manifest == other.manifest
    }
}

struct Pending<R> {
    request: R,
    sent: Instant,
    attempts: u8,
}
struct Requests<R> {
    closed: bool,
    removal_generation: u64,
    queued: VecDeque<R>,
    pending: VecDeque<Pending<R>>,
    completed: VecDeque<(R, Instant)>,
    cooling: VecDeque<(R, Instant)>,
}

impl<R> Default for Requests<R> {
    fn default() -> Self {
        Self {
            closed: false,
            removal_generation: 0,
            queued: VecDeque::new(),
            pending: VecDeque::new(),
            completed: VecDeque::new(),
            cooling: VecDeque::new(),
        }
    }
}

impl<R: Request> Requests<R> {
    fn sync_removals(&mut self, generation: u64) {
        if self.removal_generation < generation {
            self.removal_generation = generation;
            self.clear();
            self.completed.clear();
            self.cooling.clear();
        }
    }

    fn clear(&mut self) {
        self.queued.clear();
        self.pending.clear();
    }

    fn expire(&mut self) {
        self.cooling.retain(|(_, at)| at.elapsed() < RETRY_COOLDOWN);
        if let Some(keep) = R::KEEP_COMPLETED {
            self.completed.retain(|(_, at)| at.elapsed() < keep);
        }
        if !R::RETRIES {
            self.pending.retain(|p| p.sent.elapsed() < R::WAIT);
        }
    }

    fn enqueue(&mut self, request: R) {
        self.expire();
        if self.closed
            || self.queued.iter().any(|r| r.same_ask(&request))
            || self.pending.iter().any(|p| p.request.same_ask(&request))
            || self.completed.iter().any(|(r, _)| r.same_ask(&request))
            || self.cooling.iter().any(|(r, _)| r.same_ask(&request))
        {
            return;
        }
        if self.queued.len() == MAX_TARGETS {
            self.queued.pop_front();
        }
        self.queued.push_back(request);
    }

    fn next(&mut self, now: Instant) -> Option<R> {
        if self.closed {
            return None;
        }
        self.expire();
        if let Some(index) = self
            .pending
            .iter()
            .position(|p| now.duration_since(p.sent) >= R::WAIT)
        {
            let mut old = self.pending.remove(index)?;
            if old.attempts < MAX_ATTEMPTS {
                // Every retry has a fresh nonce. A delayed older reply cannot
                // consume the new outstanding request.
                *old.request.nonce_mut() = protocol::new_challenge_nonce();
                old.sent = now;
                old.attempts += 1;
                let request = old.request.clone();
                self.pending.push_back(old);
                return Some(request);
            }
            if self.cooling.len() == MAX_TARGETS {
                self.cooling.pop_front();
            }
            self.cooling.push_back((old.request, now));
        }
        if self.pending.len() >= MAX_PENDING {
            return None;
        }
        let request = self.queued.pop_front()?;
        self.pending.push_back(Pending {
            request: request.clone(),
            sent: now,
            attempts: 1,
        });
        Some(request)
    }

    /// The exact outstanding request a reply answers: same nonce and ask.
    fn matching(&self, answered: &R) -> Option<usize> {
        if self.closed {
            return None;
        }
        self.pending
            .iter()
            .position(|p| p.sent.elapsed() < R::WAIT && p.request == *answered)
    }

    fn accept(&mut self, answered: &R) -> bool {
        let Some(index) = self.matching(answered) else {
            return false;
        };
        self.pending.remove(index);
        if self.completed.len() == MAX_TARGETS {
            self.completed.pop_front();
        }
        self.completed.push_back((answered.clone(), Instant::now()));
        true
    }
}

pub(crate) struct ReceiptSession {
    remote: String,
    transport: ReceiptTransport,
    remote_agent: ForAgent,
    drive: String,
    generation: u64,
    local_agent: String,
    local_generation: u64,
    source: StorageReceiptReplica,
    requests: Mutex<Requests<StorageReceiptRequest>>,
    attachment_requests: Mutex<Requests<protocol::AttachmentReceiptRequest>>,
    pub(crate) attachments_enabled: bool,
    pub(crate) attachment_responders: Arc<tokio::sync::Semaphore>,
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
        Self::new_transport(
            db,
            remote,
            remote_agent,
            drive,
            generation,
            local_generation,
            caps,
            ReceiptTransport::Iroh,
        )
    }

    pub(crate) fn new_webrtc(
        db: &Db,
        nonce: String,
        remote_agent: ForAgent,
        drive: &str,
        local_generation: u64,
        caps: &[String],
        live: Arc<std::sync::atomic::AtomicBool>,
    ) -> Option<Arc<Self>> {
        Self::new_transport(
            db,
            nonce,
            remote_agent,
            drive,
            1,
            local_generation,
            caps,
            ReceiptTransport::WebRtc(live),
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn new_transport(
        db: &Db,
        remote: String,
        remote_agent: ForAgent,
        drive: &str,
        generation: u64,
        local_generation: u64,
        caps: &[String],
        transport: ReceiptTransport,
    ) -> Option<Arc<Self>> {
        let capability = match transport {
            ReceiptTransport::Iroh => protocol::CAP_IROH_STORAGE_RECEIPTS_V1,
            ReceiptTransport::WebRtc(_) => protocol::CAP_BROWSER_STORAGE_RECEIPTS_V1,
        };
        if matches!(remote_agent, ForAgent::Public)
            || !caps.iter().any(|c| c == capability)
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
            transport,
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
            attachment_requests: Mutex::new(Requests::default()),
            attachments_enabled: caps
                .iter()
                .any(|cap| cap == protocol::CAP_ATTACHMENT_STORAGE_RECEIPTS_V1),
            attachment_responders: Arc::new(tokio::sync::Semaphore::new(2)),
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
        self.transport.retire();
        let mut requests = self.requests.lock().unwrap();
        requests.closed = true;
        requests.clear();
        let mut attachments = self.attachment_requests.lock().unwrap();
        attachments.closed = true;
        attachments.clear();
        self.ledger
            .lock()
            .unwrap()
            .close(&self.remote, self.generation);
    }

    fn active(&self, db: &Db) -> bool {
        let closed = self.requests.lock().unwrap().closed;
        !closed
            && db.agent_generation() == self.local_generation
            && self
                .transport
                .current(&self.remote, self.generation, &self.remote_agent)
    }

    pub(crate) fn current(&self, db: &Db) -> bool {
        self.attachment_requests
            .lock()
            .unwrap()
            .sync_removals(db.native_removal_generation());
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
        let target = StorageReceiptRequest {
            nonce: protocol::new_challenge_nonce(),
            drive: self.drive.clone(),
            subject: wire_subject(db, subject),
            version: URL_SAFE_NO_PAD.encode(vv.encode()),
        };
        if target.validate() {
            self.requests.lock().unwrap().enqueue(target.clone());
            if self.attachments_enabled {
                let removal = db.native_removal_generation();
                if let Ok((_, manifest)) = super::attachment_receipts::derive_manifest(
                    db,
                    &self.remote_agent,
                    &target.subject,
                )
                .await
                {
                    if !manifest.files.is_empty()
                        && self.current(db)
                        && removal == db.native_removal_generation()
                    {
                        self.attachment_requests.lock().unwrap().enqueue(
                            protocol::AttachmentReceiptRequest {
                                nonce: protocol::new_challenge_nonce(),
                                drive: self.drive.clone(),
                                subject: target.subject,
                                version: target.version,
                                manifest,
                            },
                        );
                    }
                }
            }
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
        let correlated = self
            .requests
            .lock()
            .unwrap()
            .matching(&receipt.request())
            .is_some();
        if !correlated {
            return;
        }
        if !self.current(db) || !self.readable(db, &receipt.subject).await || !self.current(db) {
            return;
        }
        let accepted_generation = {
            let mut requests = self.requests.lock().unwrap();
            requests
                .accept(&receipt.request())
                .then_some(requests.removal_generation)
        };
        if let Some(removal_generation) = accepted_generation {
            let evidence = IrohReplicaReceipt {
                receipt,
                source: self.source.clone(),
                remote_node_id: self.remote.clone(),
                remote_agent: self.remote_agent.to_string(),
                local_agent: self.local_agent.clone(),
                connection_generation: self.generation,
                agent_generation: self.local_generation,
                removal_generation,
                observed_at: crate::utils::now() as u64,
            };
            match &self.transport {
                ReceiptTransport::Iroh => {
                    super::peer::emit_receipt_if_current(db, &self.remote_agent, evidence)
                }
                // Shared internal shape only: never publish a WebRTC event on
                // the public Iroh-specific receipt subscription.
                ReceiptTransport::WebRtc(_) => db.record_private_replica_receipt(evidence),
            }
        }
    }

    pub(crate) async fn receive_attachment(&self, db: &Db, payload: &[u8]) {
        if !self.attachments_enabled {
            return;
        }
        let Some(receipt) = protocol::AttachmentReceipt::decode(payload) else {
            return;
        };
        let answered = receipt.request();
        if self
            .attachment_requests
            .lock()
            .unwrap()
            .matching(&answered)
            .is_none()
        {
            return;
        }
        let removal = db.native_removal_generation();
        let write_generation = db.write_log().generation();
        if !self.current(db) || !self.readable(db, &receipt.subject).await {
            return;
        }
        let Ok((_, manifest)) =
            super::attachment_receipts::derive_manifest(db, &self.remote_agent, &receipt.subject)
                .await
        else {
            return;
        };
        if manifest != receipt.manifest
            || !self.current(db)
            || write_generation != db.write_log().generation()
            || removal != db.native_removal_generation()
        {
            return;
        }
        if !self.attachment_requests.lock().unwrap().accept(&answered) {
            return;
        }
        let mut ledger = self.ledger.lock().unwrap();
        ledger.sync_removals(db.native_removal_generation());
        if ledger.removal_generation != removal {
            return;
        }
        if let Some(connection) = ledger.connections.iter_mut().find(|c| {
            c.remote == self.remote
                && c.transport.locally_live()
                && c.generation == self.generation
                && c.agent_generation == self.local_generation
        }) {
            if connection.replica.as_ref() != Some(&receipt.replica) {
                connection.receipts.clear();
                connection.attachment_receipts.clear();
                connection.replica = Some(receipt.replica.clone());
            }
            connection
                .attachment_receipts
                .retain(|(old, _)| old.subject != receipt.subject);
            if connection.attachment_receipts.len() >= MAX_TARGETS {
                connection.attachment_receipts.pop_front();
            }
            connection
                .attachment_receipts
                .push_back((receipt, crate::utils::now() as u64));
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
                        .attachment_requests
                        .lock()
                        .unwrap()
                        .next(Instant::now());
                    let Some(request) = request else {
                        break;
                    };
                    if !session.current(&db) {
                        break;
                    }
                    if let Some(frame) = request.encode_frame() {
                        let framed = session.transport.frame(frame);
                        if tx.try_send(framed).is_err() {
                            break;
                        }
                    }
                }
                for _ in 0..MAX_PENDING {
                    let request = session.requests.lock().unwrap().next(Instant::now());
                    let Some(request) = request else {
                        break;
                    };
                    if !session.readable(&db, &request.subject).await || !session.current(&db) {
                        continue;
                    }
                    let Some(frame) = request.encode_frame() else {
                        continue;
                    };
                    let framed = session.transport.frame(frame);
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

    fn target(counter: i32) -> StorageReceiptRequest {
        let vv: loro::VersionVector = [(7, counter)].into_iter().collect();
        StorageReceiptRequest {
            nonce: protocol::new_challenge_nonce(),
            drive: "atomic:drive".into(),
            subject: "atomic:receipt-resource".into(),
            version: URL_SAFE_NO_PAD.encode(vv.encode()),
        }
    }

    /// What `receive` does with a decoded reply: validate, then correlate.
    fn accept(queue: &mut Requests<StorageReceiptRequest>, receipt: &StorageReceipt) -> bool {
        receipt.validate() && queue.accept(&receipt.request())
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

    #[test]
    fn attachment_requests_refresh_and_removal_fence() {
        let mut requests = Requests::<protocol::AttachmentReceiptRequest>::default();
        let request = protocol::AttachmentReceiptRequest {
            nonce: "a".repeat(64),
            drive: "atomic:drive".into(),
            subject: "atomic:file".into(),
            version: target(1).version,
            manifest: Default::default(),
        };
        requests.enqueue(request.clone());
        requests.next(Instant::now()).unwrap();
        let receipt = protocol::AttachmentReceipt {
            nonce: request.nonce.clone(),
            drive: request.drive.clone(),
            subject: request.subject.clone(),
            version: request.version.clone(),
            manifest: request.manifest.clone(),
            replica: StorageReceiptReplica {
                storage_id: "b".repeat(64),
                generation: "c".repeat(64),
            },
            barrier: protocol::ATTACHMENT_RECEIPT_BARRIER.into(),
        };
        assert!(requests.accept(&receipt.request()));
        requests.enqueue(request.clone());
        assert!(requests.next(Instant::now()).is_none());
        requests.completed[0].1 = Instant::now() - Duration::from_secs(11);
        let fresh = protocol::AttachmentReceiptRequest {
            nonce: "d".repeat(64),
            ..request
        };
        requests.enqueue(fresh);
        assert!(requests.next(Instant::now()).is_some());
        assert!(
            requests.matching(&receipt.request()).is_none(),
            "old nonce cannot refresh byte proof"
        );
        requests.sync_removals(1);
        assert!(requests.pending.is_empty() && requests.completed.is_empty());
    }

    #[tokio::test]
    async fn attachment_ledger_expires_without_fresh_remote_verification() {
        let (db, drive, _, session) = fixture("native_attachment_expiry").await;
        confirm(&db, &session, &drive).await;
        {
            let mut ledger = db.native_receipt_ledger.lock().unwrap();
            let connection = ledger.connections.front_mut().unwrap();
            let meta = &connection.receipts[0].receipt;
            connection.attachment_receipts.push_back((
                protocol::AttachmentReceipt {
                    nonce: meta.nonce.clone(),
                    drive: meta.drive.clone(),
                    subject: meta.subject.clone(),
                    version: meta.version.clone(),
                    manifest: Default::default(),
                    replica: meta.replica.clone(),
                    barrier: protocol::ATTACHMENT_RECEIPT_BARRIER.into(),
                },
                crate::utils::now() as u64,
            ));
        }
        let contents = |evidence: &ResourcePeerEvidence| {
            evidence.connections[0]
                .receipts
                .iter()
                .filter(|receipt| receipt.manifest.is_some())
                .count()
        };
        assert_eq!(
            contents(&resource_peer_evidence(&db, std::slice::from_ref(&drive)).await),
            1
        );
        db.native_receipt_ledger.lock().unwrap().connections[0].attachment_receipts[0].1 =
            (crate::utils::now() - 30_001) as u64;
        let expired = resource_peer_evidence(&db, &[drive]).await;
        assert_eq!(contents(&expired), 0);
        assert_eq!(
            expired.connections[0].receipts.len(),
            1,
            "metadata evidence remains separate"
        );
        super::super::peer::remove_live_peer(&session.remote, 1);
    }

    async fn confirm(db: &Db, session: &ReceiptSession, subject: &str) {
        session.observe(db, subject).await;
        let request = session
            .requests
            .lock()
            .unwrap()
            .next(Instant::now())
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
            .next(Instant::now())
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
            .next(Instant::now())
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
        let request = fresh.requests.lock().unwrap().next(Instant::now()).unwrap();
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
            .next(Instant::now())
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
        let mut queue = Requests::<StorageReceiptRequest>::default();
        queue.enqueue(target(1));
        let c1 = queue.next(Instant::now()).unwrap();
        queue.enqueue(target(2));
        let c2 = queue.next(Instant::now()).unwrap();
        assert!(accept(&mut queue, &reply(&c1)));
        assert_eq!(queue.pending.len(), 1);
        assert_eq!(queue.pending.front().unwrap().request.version, c2.version);
        assert!(
            !accept(&mut queue, &reply(&c1)),
            "duplicate receipt must not emit twice"
        );
        assert!(accept(&mut queue, &reply(&c2)));
    }

    #[test]
    fn every_echo_field_and_the_barrier_are_correlated() {
        let mut queue = Requests::<StorageReceiptRequest>::default();
        queue.enqueue(target(1));
        let request = queue.next(Instant::now()).unwrap();
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
            assert!(!accept(&mut queue, &receipt), "must refuse changed {field}");
        }
        assert!(accept(&mut queue, &reply(&request)));
    }

    #[test]
    fn expired_nonce_is_rejected_before_scheduler_retry() {
        let mut queue = Requests::<StorageReceiptRequest>::default();
        queue.enqueue(target(1));
        let old = queue.next(Instant::now()).unwrap();
        queue.pending.front_mut().unwrap().sent = Instant::now() - RETRY_AFTER;
        assert!(!accept(&mut queue, &reply(&old)));
        let retried = queue.next(Instant::now()).unwrap();
        assert_ne!(old.nonce, retried.nonce);
        assert!(!accept(&mut queue, &reply(&old)));
        assert!(accept(&mut queue, &reply(&retried)));
    }

    #[test]
    fn retry_exhaustion_cools_down_and_all_queues_stay_bounded() {
        let mut queue = Requests::<StorageReceiptRequest>::default();
        queue.enqueue(target(1));
        queue.next(Instant::now()).unwrap();
        for _ in 1..MAX_ATTEMPTS {
            queue.pending.front_mut().unwrap().sent = Instant::now() - RETRY_AFTER;
            assert!(queue.next(Instant::now()).is_some());
        }
        queue.pending.front_mut().unwrap().sent = Instant::now() - RETRY_AFTER;
        assert!(queue.next(Instant::now()).is_none());
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
            assert!(queue.next(Instant::now()).is_some());
        }
        assert!(queue.next(Instant::now()).is_none());
        assert_eq!(queue.pending.len(), MAX_PENDING);
        queue.closed = true;
        let receipt = reply(&queue.pending.front().unwrap().request);
        assert!(!accept(&mut queue, &receipt));
        assert!(queue.next(Instant::now()).is_none());
    }
}
