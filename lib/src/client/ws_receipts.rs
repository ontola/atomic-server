//! Automatic, best-effort native WebSocket storage evidence. Targets are sampled
//! applied-state frontiers, not a ledger of every save or a retention guarantee.
use super::ws::{WsAuthContext, WsClient, WsMessage};
use crate::{
    agents::ForAgent,
    errors::AtomicResult,
    sync::protocol::{self, StorageReceipt, StorageReceiptReplica, StorageReceiptRequest},
    Db, Storelike,
};
use std::{
    collections::{BTreeMap, VecDeque},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

/// A correlated historical remote barrier. Authentication and different IDs do
/// not establish physical independence. A memory source has no storage identity.
#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerReplicaReceipt {
    pub receipt: StorageReceipt,
    pub source: Option<StorageReceiptReplica>,
    pub server_origin: String,
    pub connection_id: String,
    pub authentication_generation: u64,
    pub authenticated_agent: String,
    pub local_agent: String,
    pub agent_generation: u64,
    pub observed_at: u64,
}

const MAX_TARGETS: usize = 256;
const MAX_PENDING: usize = 4;
const MAX_DRIVES: usize = 32;
const TIMEOUT: Duration = Duration::from_secs(5);
const COOLDOWN: Duration = Duration::from_secs(30);
const MAX_ATTEMPTS: u8 = 3;

#[derive(Clone, Debug, PartialEq, Eq)]
struct Target {
    drive: String,
    subject: String,
    version: String,
}
struct Pending {
    request: StorageReceiptRequest,
    source: Option<StorageReceiptReplica>,
    sent: Instant,
    attempts: u8,
}
#[derive(Default)]
struct Requests {
    queued: VecDeque<(Target, u8)>,
    pending: VecDeque<Pending>,
    settled: VecDeque<(Target, Instant)>,
}
impl Requests {
    fn target(request: &StorageReceiptRequest) -> Target {
        Target {
            drive: request.drive.clone(),
            subject: request.subject.clone(),
            version: request.version.clone(),
        }
    }
    fn enqueue(&mut self, target: Target) {
        self.settled.retain(|(_, at)| at.elapsed() < COOLDOWN);
        if self.queued.len() >= MAX_TARGETS
            || self.queued.iter().any(|(t, _)| *t == target)
            || self
                .pending
                .iter()
                .any(|p| Self::target(&p.request) == target)
            || self.settled.iter().any(|(t, _)| *t == target)
        {
            return;
        }
        self.queued.push_back((target, 0));
    }
    fn settle(&mut self, target: Target) {
        if self.settled.len() >= MAX_TARGETS {
            self.settled.pop_front();
        }
        self.settled.push_back((target, Instant::now()));
    }
    fn expire(&mut self) {
        let mut kept = VecDeque::new();
        while let Some(p) = self.pending.pop_front() {
            if p.sent.elapsed() < TIMEOUT {
                kept.push_back(p);
                continue;
            }
            let target = Self::target(&p.request);
            if p.attempts < MAX_ATTEMPTS && self.queued.len() < MAX_TARGETS {
                self.queued.push_back((target, p.attempts));
            } else {
                self.settle(target);
            }
        }
        self.pending = kept;
    }
    fn matches(&self, receipt: &StorageReceipt) -> Option<usize> {
        if !receipt.validate() {
            return None;
        }
        self.pending.iter().position(|p| {
            p.sent.elapsed() < TIMEOUT
                && p.request.nonce == receipt.nonce
                && p.request.drive == receipt.drive
                && p.request.subject == receipt.subject
                && p.request.version == receipt.version
        })
    }
}

/// Start after successful authentication, follow drives, and close before
/// replacing the connection/account. Dropping this handle also stops its worker.
/// Unsupported peers remain silent; ordinary sync/save results never change.
pub struct WsReceiptSession {
    client: Arc<WsClient>,
    store: Arc<Db>,
    authentication: Option<WsAuthContext>,
    local_agent: String,
    agent_generation: u64,
    closed: AtomicBool,
    requests: Mutex<Requests>,
    drives: Mutex<BTreeMap<String, Inventory>>,
    read_scope: ForAgent,
}
#[derive(Default)]
struct Inventory {
    subjects: Vec<String>,
    cursor: usize,
    refreshed: Option<Instant>,
}

fn encoded_frontier(vv: &loro::VersionVector) -> Option<String> {
    let mut entries: Vec<_> = vv
        .iter()
        .filter(|(_, counter)| **counter > 0)
        .map(|(peer, counter)| (*peer, *counter))
        .collect();
    if entries.is_empty() {
        return None;
    }
    entries.sort_unstable_by_key(|(peer, _)| *peer);
    let normalized: loro::VersionVector = entries.into_iter().collect();
    Some(crate::agents::encode_base64(&normalized.encode()))
}

impl WsReceiptSession {
    pub fn start(client: Arc<WsClient>, store: Arc<Db>) -> Arc<Self> {
        let generation = store.agent_generation();
        let scope = store
            .get_default_agent()
            .map(|a| ForAgent::AgentSubject(a.subject))
            .unwrap_or(ForAgent::Public);
        let session = Self::start_with_read_scope(client, store, scope);
        if session.agent_generation != generation {
            session.close();
        }
        session
    }

    /// Match the export operation's authorization, which may be narrower than
    /// the default agent of a server-side store.
    pub fn start_with_read_scope(
        client: Arc<WsClient>,
        store: Arc<Db>,
        read_scope: ForAgent,
    ) -> Arc<Self> {
        let generation = store.agent_generation();
        let local_agent = store
            .get_default_agent()
            .map(|a| a.subject.to_string())
            .unwrap_or_default();
        let authentication = client.receipt_context();
        let mut events = store.subscribe_events();
        let mut incoming = client.subscribe();
        let session = Arc::new(Self {
            client,
            store,
            authentication,
            local_agent,
            agent_generation: generation,
            closed: AtomicBool::new(false),
            requests: Mutex::new(Requests::default()),
            drives: Mutex::new(BTreeMap::new()),
            read_scope,
        });
        let weak = Arc::downgrade(&session);
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(Duration::from_millis(250));
            let mut drive_cursor = 0usize;
            loop {
                // Never retain the session while idle: dropping its last public
                // handle must release its client/store without a reference cycle.
                tokio::select! {
                    _ = tick.tick() => {
                        let Some(session) = weak.upgrade() else { break; };
                        if !session.is_current() { session.close(); break; }
                        session.scan(&mut drive_cursor).await;
                        session.pump().await;
                    }
                    message = incoming.recv() => {
                        let Some(session) = weak.upgrade() else { break; };
                        if !session.is_current() { session.close(); break; }
                        if let Ok(WsMessage::StorageReceipt(receipt)) = message { session.receive(receipt).await; }
                    }
                    event = events.recv() => {
                        let Some(session) = weak.upgrade() else { break; };
                        if !session.is_current() { session.close(); break; }
                        if let Ok(crate::DbEvent::Changed { subject, .. }) = event { session.observe(&subject.pure_id()).await; session.pump().await; }
                    }
                }
            }
        });
        session
    }

    /// Follow at most 32 drives per collector. Additional drives remain unknown.
    pub fn follow_drive(&self, drive: &str) {
        if self.closed.load(Ordering::Acquire) {
            return;
        }
        let drive = crate::identifiers::canonicalize_scheme(drive);
        let mut drives = self.drives.lock().unwrap();
        if drives.len() < MAX_DRIVES || drives.contains_key(&drive) {
            drives.entry(drive).or_default();
        }
    }
    pub fn close(&self) {
        let mut requests = self.requests.lock().unwrap();
        self.closed.store(true, Ordering::Release);
        *requests = Requests::default();
        self.drives.lock().unwrap().clear();
    }
    pub fn is_current(&self) -> bool {
        !self.closed.load(Ordering::Acquire)
            && !self.local_agent.is_empty()
            && self.authentication.is_some()
            && self.client.receipt_context() == self.authentication
            && self.store.agent_generation() == self.agent_generation
            && self
                .store
                .get_default_agent()
                .is_ok_and(|a| a.subject.as_str() == self.local_agent)
            && self.store.agent_generation() == self.agent_generation
    }
    /// Filter a queued bridge observation against this still-active session.
    pub fn accepts(&self, event: &ServerReplicaReceipt) -> bool {
        self.is_current()
            && event.connection_id == self.client.connection_id()
            && self.authentication.as_ref().is_some_and(|a| {
                a.generation == event.authentication_generation
                    && a.agent == event.authenticated_agent
            })
            && event.agent_generation == self.agent_generation
            && event.local_agent == self.local_agent
            && event.server_origin == self.client.origin()
    }
    /// A bounded opportunity for an observation, independent of replication success.
    pub async fn finish(&self, opportunity: Duration) {
        if self.is_current() {
            tokio::time::sleep(opportunity).await;
        }
        self.close();
    }
    fn source(&self, drive: &str) -> AtomicResult<Option<StorageReceiptReplica>> {
        Ok(self
            .store
            .kv
            .replica_identity(drive)?
            .map(|id| StorageReceiptReplica {
                storage_id: id.storage_id,
                generation: id.generation,
            }))
    }
    async fn eligible(&self, subject: &str, drive: &str) -> bool {
        if !self.is_current() || !self.drives.lock().unwrap().contains_key(drive) {
            return false;
        }
        let Ok(Some(resource)) =
            crate::sync::storage_receipts::stored_resource(&self.store, &subject.into())
        else {
            return false;
        };
        let belongs = resource.get_subject().pure_id() == drive
            || resource
                .get(crate::urls::DRIVE_PROP)
                .is_ok_and(|v| crate::identifiers::canonicalize_scheme(&v.to_string()) == drive);
        belongs
            && crate::hierarchy::check_read(&*self.store, &resource, &self.read_scope)
                .await
                .is_ok()
            && self.is_current()
    }
    async fn observe(&self, subject: &str) {
        let drives: Vec<_> = self.drives.lock().unwrap().keys().cloned().collect();
        for drive in drives {
            if !self.eligible(subject, &drive).await {
                continue;
            }
            let Some(snapshot) = self.store.get_loro_snapshot(&subject.into()) else {
                continue;
            };
            let Ok(doc) = crate::loro::AtomicLoroDoc::from_snapshot(&snapshot) else {
                continue;
            };
            let Some(version) = encoded_frontier(&doc.doc().state_vv()) else {
                continue;
            };
            let target = Target {
                drive,
                subject: subject.into(),
                version,
            };
            let probe = StorageReceiptRequest {
                nonce: "0".repeat(64),
                drive: target.drive.clone(),
                subject: target.subject.clone(),
                version: target.version.clone(),
            };
            if self.is_current() && probe.validate() {
                self.requests.lock().unwrap().enqueue(target);
            }
        }
    }
    async fn scan(&self, drive_cursor: &mut usize) {
        if self.requests.lock().unwrap().queued.len() >= MAX_TARGETS {
            return;
        }
        let (drive, refresh) = {
            let drives = self.drives.lock().unwrap();
            if drives.is_empty() {
                return;
            }
            let (drive, inventory) = drives.iter().nth(*drive_cursor % drives.len()).unwrap();
            (
                drive.clone(),
                inventory
                    .refreshed
                    .is_none_or(|at| at.elapsed() >= COOLDOWN),
            )
        };
        *drive_cursor = drive_cursor.wrapping_add(1);
        if refresh {
            let mut subjects: Vec<_> =
                crate::sync::engine::collect_drive_subjects(&self.store, &drive.as_str().into())
                    .await
                    .into_iter()
                    .collect();
            subjects.sort();
            if let Some(inventory) = self.drives.lock().unwrap().get_mut(&drive) {
                inventory.subjects = subjects;
                inventory.cursor %= inventory.subjects.len().max(1);
                inventory.refreshed = Some(Instant::now());
            }
        }
        for _ in 0..8 {
            if self.requests.lock().unwrap().queued.len() >= MAX_TARGETS {
                break;
            }
            let subject = {
                let mut drives = self.drives.lock().unwrap();
                let Some(inventory) = drives.get_mut(&drive) else {
                    return;
                };
                if inventory.subjects.is_empty() {
                    return;
                }
                let subject =
                    inventory.subjects[inventory.cursor % inventory.subjects.len()].clone();
                inventory.cursor = (inventory.cursor + 1) % inventory.subjects.len();
                subject
            };
            self.observe(&subject).await;
        }
    }
    async fn pump(&self) {
        if !self.is_current() {
            return;
        }
        self.requests.lock().unwrap().expire();
        for _ in 0..MAX_PENDING {
            let next = {
                let mut requests = self.requests.lock().unwrap();
                if requests.pending.len() >= MAX_PENDING {
                    break;
                }
                requests.queued.pop_front()
            };
            let Some((target, attempts)) = next else {
                break;
            };
            if !self.eligible(&target.subject, &target.drive).await {
                self.requests.lock().unwrap().settle(target);
                continue;
            }
            let Ok(source) = self.source(&target.drive) else {
                continue;
            };
            let request = StorageReceiptRequest {
                nonce: protocol::new_challenge_nonce(),
                drive: target.drive,
                subject: target.subject,
                version: target.version,
            };
            let Some(frame) = request.encode_frame() else {
                continue;
            };
            if !self.is_current() {
                return;
            }
            let sent = self
                .client
                .with_receipt_context(self.authentication.as_ref().unwrap(), || {
                    let mut requests = self.requests.lock().unwrap();
                    if self.closed.load(Ordering::Acquire) {
                        return false;
                    }
                    self.store
                        .with_server_receipt_agent(self.agent_generation, &self.local_agent, || {
                            requests.pending.push_back(Pending {
                                request: request.clone(),
                                source,
                                sent: Instant::now(),
                                attempts: attempts + 1,
                            });
                            if self.client.try_send_receipt_unchecked(frame) {
                                true
                            } else {
                                requests.pending.pop_back();
                                requests
                                    .queued
                                    .push_front((Requests::target(&request), attempts));
                                false
                            }
                        })
                        .unwrap_or(false)
                })
                .unwrap_or(false);
            if !sent {
                break;
            }
        }
    }
    async fn receive(&self, receipt: StorageReceipt) {
        // Correlate before any DB/ACL read, including attacker-controlled URLs.
        if !self.is_current() || self.requests.lock().unwrap().matches(&receipt).is_none() {
            return;
        }
        if !self.eligible(&receipt.subject, &receipt.drive).await || !self.is_current() {
            return;
        }
        let Ok(source) = self.source(&receipt.drive) else {
            return;
        };
        let auth = self.authentication.as_ref().unwrap();
        self.client.with_receipt_context(auth, || {
            if self.closed.load(Ordering::Acquire) {
                return;
            }
            let mut requests = self.requests.lock().unwrap();
            if self.closed.load(Ordering::Acquire) {
                return;
            }
            let Some(index) = requests.matches(&receipt) else {
                return;
            };
            if requests.pending[index].source != source {
                return;
            }
            let pending = requests.pending.remove(index).unwrap();
            requests.settle(Requests::target(&pending.request));
            self.store
                .emit_server_replica_receipt(ServerReplicaReceipt {
                    receipt,
                    source,
                    server_origin: self.client.origin().into(),
                    connection_id: self.client.connection_id().into(),
                    authentication_generation: auth.generation,
                    authenticated_agent: auth.agent.clone(),
                    local_agent: self.local_agent.clone(),
                    agent_generation: self.agent_generation,
                    observed_at: crate::utils::now() as u64,
                });
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio_tungstenite::tungstenite::Message;

    async fn fixture() -> (
        Arc<WsReceiptSession>,
        tokio::sync::mpsc::Receiver<Message>,
        tokio::sync::watch::Sender<bool>,
        String,
    ) {
        let db = Arc::new(Db::init_redb(None).await.unwrap());
        let (agent, drive) = db.setup("Receipt tests").await.unwrap();
        let (client, outgoing, closed) =
            WsClient::receipt_test_client(agent.subject.as_str(), true);
        let session = Arc::new(WsReceiptSession {
            authentication: client.receipt_context(),
            client,
            store: db.clone(),
            local_agent: agent.subject.to_string(),
            agent_generation: db.agent_generation(),
            closed: AtomicBool::new(false),
            requests: Mutex::new(Requests::default()),
            drives: Mutex::new(BTreeMap::new()),
            read_scope: ForAgent::AgentSubject(agent.subject),
        });
        session.follow_drive(&drive);
        (session, outgoing, closed, drive)
    }
    fn response(request: &StorageReceiptRequest) -> StorageReceipt {
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
    async fn probe(
        session: &WsReceiptSession,
        outgoing: &mut tokio::sync::mpsc::Receiver<Message>,
        subject: &str,
    ) -> StorageReceiptRequest {
        session.observe(subject).await;
        session.pump().await;
        let Message::Binary(frame) = outgoing.try_recv().expect("automatic probe") else {
            panic!("binary probe");
        };
        assert_eq!(frame[0], protocol::tag::STORAGE_RECEIPT_REQUEST);
        StorageReceiptRequest::decode(&frame[1..]).unwrap()
    }

    #[tokio::test]
    async fn exact_response_publishes_once_with_memory_source_and_historical_target() {
        let (session, mut outgoing, _closed, drive) = fixture().await;
        let mut events = session.store.subscribe_server_replica_receipts();
        let request = probe(&session, &mut outgoing, &drive).await;
        let mut resource = session
            .store
            .get_resource(&drive.as_str().into())
            .await
            .unwrap();
        resource
            .set_unsafe(
                crate::urls::NAME.into(),
                crate::Value::String("Later edit".into()),
            )
            .unwrap();
        resource.save_locally(&*session.store).await.unwrap();
        let receipt = response(&request);
        session.receive(receipt.clone()).await;
        let event = events.try_recv().expect("correlated historical receipt");
        assert!(event.source.is_none());
        assert_eq!(event.receipt.version, request.version);
        assert!(session.accepts(&event));
        session.receive(receipt).await;
        assert!(events.try_recv().is_err());
        session.close();
        assert!(!session.accepts(&event));
    }

    #[tokio::test]
    async fn wrong_tuple_malformed_expired_and_unsolicited_never_read_state_or_publish() {
        let (session, mut outgoing, _closed, drive) = fixture().await;
        let mut events = session.store.subscribe_server_replica_receipts();
        let request = probe(&session, &mut outgoing, &drive).await;
        let original = response(&request);
        let mut invalid = Vec::new();
        let mut r = original.clone();
        r.nonce = "c".repeat(64);
        invalid.push(r);
        let mut r = original.clone();
        r.drive = "https://wrong.example/drive".into();
        invalid.push(r);
        let mut r = original.clone();
        r.subject = "http://127.0.0.1:1/must-not-fetch".into();
        invalid.push(r);
        let mut r = original.clone();
        r.version = encoded_frontier(&[(5, 99)].into_iter().collect()).unwrap();
        invalid.push(r);
        let mut r = original.clone();
        r.barrier = "legacy-ack".into();
        invalid.push(r);
        let mut r = original.clone();
        r.replica.storage_id = "invalid".into();
        invalid.push(r);
        session.store.reset_fetch_counters();
        for receipt in invalid {
            session.receive(receipt).await;
        }
        session.requests.lock().unwrap().pending[0].sent = Instant::now() - TIMEOUT;
        session.receive(original).await;
        assert_eq!(session.store.get_resource_call_count(), 0);
        assert_eq!(session.store.get_resource_shallow_call_count(), 0);
        assert!(events.try_recv().is_err());
    }

    #[tokio::test]
    async fn unknown_targets_and_narrow_public_export_never_probe() {
        let (mut session, mut outgoing, _closed, drive) = fixture().await;
        session.store.reset_fetch_counters();
        session.observe("http://127.0.0.1:1/missing").await;
        assert_eq!(session.store.get_resource_call_count(), 0);
        assert!(session.requests.lock().unwrap().queued.is_empty());
        Arc::get_mut(&mut session).unwrap().read_scope = ForAgent::Public;
        session.observe(&drive).await;
        session.pump().await;
        assert!(outgoing.try_recv().is_err());
    }

    #[tokio::test]
    async fn account_away_and_back_disconnect_raw_auth_and_close_invalidate_pending() {
        for mode in 0..4 {
            let (session, mut outgoing, closed, drive) = fixture().await;
            let mut events = session.store.subscribe_server_replica_receipts();
            let request = probe(&session, &mut outgoing, &drive).await;
            match mode {
                0 => {
                    let agent = session.store.get_default_agent().unwrap();
                    session.store.clear_default_agent();
                    session.store.set_default_agent(agent);
                }
                1 => {
                    closed.send(true).unwrap();
                }
                2 => {
                    session
                        .client
                        .send_binary(vec![protocol::tag::AUTH])
                        .await
                        .unwrap();
                }
                _ => session.close(),
            }
            assert!(!session.is_current());
            session.receive(response(&request)).await;
            assert!(events.try_recv().is_err());
        }
    }

    #[tokio::test]
    async fn unsupported_authenticated_peer_is_silent() {
        let (mut session, mut outgoing, _closed, drive) = fixture().await;
        let (client, _, _hold_closed) = WsClient::receipt_test_client(&session.local_agent, false);
        Arc::get_mut(&mut session).unwrap().client = client;
        assert!(!session.is_current());
        session.observe(&drive).await;
        session.pump().await;
        assert!(outgoing.try_recv().is_err());
    }

    #[tokio::test]
    async fn pending_window_is_four_and_source_changes_cannot_relabel_a_reply() {
        let (session, mut outgoing, _closed, drive) = fixture().await;
        for n in 0..10 {
            let subject = session
                .store
                .create_resource(
                    "https://atomicdata.dev/classes/Folder",
                    &drive,
                    &format!("window-{n}"),
                    None,
                )
                .await
                .unwrap();
            session.observe(&subject).await;
        }
        session.pump().await;
        assert_eq!(session.requests.lock().unwrap().pending.len(), MAX_PENDING);
        assert_eq!(session.requests.lock().unwrap().queued.len(), 6);
        session.pump().await;
        let mut sent = 0;
        while outgoing.try_recv().is_ok() {
            sent += 1;
        }
        assert_eq!(sent, MAX_PENDING);
        let mut events = session.store.subscribe_server_replica_receipts();
        let receipt = {
            let mut requests = session.requests.lock().unwrap();
            requests.pending[0].source = Some(StorageReceiptReplica {
                storage_id: "a".repeat(64),
                generation: "b".repeat(64),
            });
            response(&requests.pending[0].request)
        };
        session.receive(receipt).await;
        assert!(events.try_recv().is_err());
        assert_eq!(session.requests.lock().unwrap().pending.len(), MAX_PENDING);
    }

    #[tokio::test]
    async fn clones_share_epoch_but_independent_account_handles_have_private_receipt_channels() {
        let (session, mut outgoing, _closed, drive) = fixture().await;
        let mut original_events = session.store.subscribe_server_replica_receipts();
        let separate = session
            .store
            .with_own_agent(Some(session.store.get_default_agent().unwrap()));
        let mut separate_events = separate.subscribe_server_replica_receipts();
        let request = probe(&session, &mut outgoing, &drive).await;
        session.receive(response(&request)).await;
        let event = original_events.try_recv().unwrap();
        assert!(separate_events.try_recv().is_err());
        separate.clear_default_agent();
        assert!(session.accepts(&event));
        let clone = (*session.store).clone();
        clone.clear_default_agent();
        assert!(!session.accepts(&event));
    }

    #[test]
    fn bounded_retries_rotate_behind_fresh_work_and_stop_after_three() {
        let mut requests = Requests::default();
        for n in 0..300 {
            requests.enqueue(Target {
                drive: "drive".into(),
                subject: n.to_string(),
                version: "vv".into(),
            });
        }
        assert_eq!(requests.queued.len(), MAX_TARGETS);
        let (first, _) = requests.queued.pop_front().unwrap();
        let request = StorageReceiptRequest {
            nonce: "a".repeat(64),
            drive: first.drive.clone(),
            subject: first.subject.clone(),
            version: first.version.clone(),
        };
        requests.pending.push_back(Pending {
            request: request.clone(),
            source: None,
            sent: Instant::now() - TIMEOUT,
            attempts: 1,
        });
        requests.expire();
        assert_eq!(requests.queued.back().unwrap(), &(first.clone(), 1));
        assert_ne!(requests.queued.front().unwrap().0, first);
        requests.queued.pop_back();
        requests.pending.push_back(Pending {
            request,
            source: None,
            sent: Instant::now() - TIMEOUT,
            attempts: MAX_ATTEMPTS,
        });
        requests.expire();
        requests.enqueue(first.clone());
        assert!(!requests.queued.iter().any(|(target, _)| target == &first));
        requests.settled.back_mut().unwrap().1 = Instant::now() - COOLDOWN;
        requests.enqueue(first.clone());
        assert_eq!(requests.queued.back().unwrap().0, first);
    }

    #[test]
    fn frontiers_are_positive_and_stable_across_peer_insertion_order() {
        let a: loro::VersionVector = [(2, 0), (3, 4), (1, 8)].into_iter().collect();
        let b: loro::VersionVector = [(1, 8), (3, 4)].into_iter().collect();
        assert_eq!(encoded_frontier(&a), encoded_frontier(&b));
        assert!(encoded_frontier(&loro::VersionVector::default()).is_none());
        let request = StorageReceiptRequest {
            nonce: "a".repeat(64),
            drive: "https://example.com/drive".into(),
            subject: "https://example.com/drive".into(),
            version: encoded_frontier(&a).unwrap(),
        };
        assert!(request.validate());
        assert_eq!(request.frontier().unwrap().len(), 2);
    }

    #[tokio::test]
    async fn inventory_above_queue_bound_eventually_visits_every_resource_without_skipping() {
        let (session, _outgoing, _closed, drive) = fixture().await;
        let mut expected = std::collections::BTreeSet::new();
        for i in 0..300 {
            let subject = session
                .store
                .create_resource(
                    "https://atomicdata.dev/classes/Folder",
                    &drive,
                    &format!("resource-{i}"),
                    None,
                )
                .await
                .unwrap();
            expected.insert(subject);
        }
        let mut cursor = 0;
        for _ in 0..40 {
            session.scan(&mut cursor).await;
        }
        assert_eq!(session.requests.lock().unwrap().queued.len(), MAX_TARGETS);
        let paused = session.drives.lock().unwrap()[&drive].cursor;
        session.scan(&mut cursor).await;
        assert_eq!(session.drives.lock().unwrap()[&drive].cursor, paused);
        let refreshed = session.drives.lock().unwrap()[&drive].refreshed;
        let mut seen = std::collections::BTreeSet::new();
        for _ in 0..80 {
            {
                let mut requests = session.requests.lock().unwrap();
                while let Some((target, _)) = requests.queued.pop_front() {
                    seen.insert(target.subject);
                }
            }
            session.scan(&mut cursor).await;
        }
        assert!(expected.is_subset(&seen));
        assert_eq!(session.drives.lock().unwrap()[&drive].refreshed, refreshed);
    }
}
