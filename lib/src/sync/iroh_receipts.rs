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
    pub observed_at: u64,
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
    queued: VecDeque<Target>,
    pending: VecDeque<Pending>,
    completed: VecDeque<Target>,
    cooling: VecDeque<(Target, Instant)>,
}

impl Requests {
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
        let drive = crate::identifiers::canonicalize_scheme(drive);
        let source = db.kv.replica_identity(&drive).ok()??;
        if db.agent_generation() != local_generation {
            return None;
        }
        Some(Arc::new(Self {
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
        }))
    }

    pub(crate) fn invalidate(&self) {
        let mut requests = self.requests.lock().unwrap();
        requests.closed = true;
        requests.queued.clear();
        requests.pending.clear();
    }

    fn active(&self, db: &Db) -> bool {
        !self.requests.lock().unwrap().closed
            && db.agent_generation() == self.local_generation
            && super::peer::current_receipt_peer(&self.remote, self.generation, &self.remote_agent)
    }

    pub(crate) fn current(&self, db: &Db) -> bool {
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
        let same_drive = resource.get_subject().pure_id() == self.drive
            || resource.get(crate::urls::DRIVE_PROP).is_ok_and(|v| {
                crate::identifiers::canonicalize_scheme(&v.to_string()) == self.drive
            });
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
        let Some(snapshot) = db.get_loro_snapshot_bytes(subject) else {
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
            subject: subject.into(),
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
        if self.requests.lock().unwrap().accept(&receipt) {
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
