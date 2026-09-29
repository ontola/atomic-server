//! The delivery queue (#1719): enqueue, send, retry, dead letters, the
//! restart, the daily cap, per-host concurrency, idempotency, holding and
//! dropping, and host-side signatures. First against the queue alone (a fake
//! installation, a loopback stub or a scripted transport), then through the
//! app with the inbox fixture's `POST /deliver` at `--plugin-routes
//! read-write`.

use std::{
    collections::{HashMap, VecDeque},
    sync::{Arc, Mutex},
};

use actix_web::{http::header, test as actix_test, web, App};
use atomic_lib::{db::app_agent::AppAgentKey, urls, Db, Storelike, Value};
use serde_json::{json, Value as Json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use super::{
    http_signatures::{self, Message, PublicKey},
    manifest::Manifest,
    route_delivery::{
        self, backoff, DeliveryQueue, EgressTransport, Job, JobState, Outgoing, QueueHost,
        RegistryHost, Sent, Standing, Transport, MAX_ATTEMPTS,
    },
    route_keys,
    route_registry::slug,
    test_fixture::{fixture_with_args, genesis, inbox_release, install_release_with, Fixture},
};

const INSTALLATION: &str = "did:ad:deliveryInstallation";
/// 2027-01-15T08:00:00Z: a fixed clock, well inside a UTC day.
const NOW: i64 = 1_800_000_000_000 - 1_800_000_000_000 % 86_400_000 + 8 * 3_600_000;
const DAY_MS: i64 = 86_400_000;

// -- a receiver on loopback ---------------------------------------------------------

#[derive(Clone, Debug)]
struct Received {
    method: String,
    path: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

impl Received {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(n, _)| n == name)
            .map(|(_, v)| v.as_str())
    }
}

type Inbox = Arc<Mutex<Vec<Received>>>;

/// An HTTP/1.1 receiver on `127.0.0.1` that records every request and
/// answers with the next of `statuses` (then `202`). Returns its origin.
async fn stub(statuses: Vec<u16>) -> (String, Inbox) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let received: Inbox = Default::default();
    let statuses = Arc::new(Mutex::new(VecDeque::from(statuses)));
    let log = received.clone();
    tokio::spawn(async move {
        loop {
            let Ok((mut socket, _)) = listener.accept().await else {
                return;
            };
            let log = log.clone();
            let statuses = statuses.clone();
            tokio::spawn(async move {
                let mut buf = Vec::new();
                let mut chunk = [0u8; 4096];
                let head_end = loop {
                    let n = socket.read(&mut chunk).await.unwrap_or(0);
                    if n == 0 {
                        return;
                    }
                    buf.extend_from_slice(&chunk[..n]);
                    if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                        break i;
                    }
                };
                let head = String::from_utf8_lossy(&buf[..head_end]).to_string();
                let mut lines = head.split("\r\n");
                let mut start = lines.next().unwrap_or_default().split(' ');
                let method = start.next().unwrap_or_default().to_string();
                let path = start.next().unwrap_or_default().to_string();
                let headers: Vec<(String, String)> = lines
                    .filter_map(|l| l.split_once(':'))
                    .map(|(n, v)| (n.trim().to_ascii_lowercase(), v.trim().to_string()))
                    .collect();
                let length: usize = headers
                    .iter()
                    .find(|(n, _)| n == "content-length")
                    .and_then(|(_, v)| v.parse().ok())
                    .unwrap_or(0);
                let mut body = buf[head_end + 4..].to_vec();
                while body.len() < length {
                    let n = socket.read(&mut chunk).await.unwrap_or(0);
                    if n == 0 {
                        break;
                    }
                    body.extend_from_slice(&chunk[..n]);
                }
                log.lock().unwrap().push(Received {
                    method,
                    path,
                    headers,
                    body,
                });
                let status = statuses.lock().unwrap().pop_front().unwrap_or(202);
                let _ = socket
                    .write_all(
                        format!(
                            "HTTP/1.1 {status} Stub\r\ncontent-length: 0\r\nconnection: close\r\n\r\n"
                        )
                        .as_bytes(),
                    )
                    .await;
            });
        }
    });
    (origin, received)
}

// -- a fake installation and a scripted transport -----------------------------------

struct FakeHost {
    standing: Mutex<HashMap<String, Standing>>,
    manifest: Manifest,
}

impl FakeHost {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            standing: Default::default(),
            manifest: manifest(),
        })
    }

    fn set(&self, installation: &str, standing: Standing) {
        self.standing
            .lock()
            .unwrap()
            .insert(installation.to_string(), standing);
    }
}

#[async_trait::async_trait]
impl QueueHost for FakeHost {
    async fn standing(&self, installation: &str) -> Standing {
        *self
            .standing
            .lock()
            .unwrap()
            .get(installation)
            .unwrap_or(&Standing::Active)
    }

    async fn manifest(&self, _: &str) -> Option<Manifest> {
        Some(self.manifest.clone())
    }
}

/// Answers from a script (then `default`), records what was sent, and can
/// hold every send until released.
struct Script {
    answers: Mutex<VecDeque<Sent>>,
    default: Sent,
    sent: Mutex<Vec<Outgoing>>,
    gate: Option<Arc<tokio::sync::Semaphore>>,
}

impl Script {
    fn always(default: Sent) -> Arc<Self> {
        Arc::new(Self {
            answers: Default::default(),
            default,
            sent: Default::default(),
            gate: None,
        })
    }

    fn sent(&self) -> Vec<Outgoing> {
        self.sent.lock().unwrap().clone()
    }
}

#[async_trait::async_trait]
impl Transport for Script {
    async fn send(&self, request: Outgoing) -> Sent {
        self.sent.lock().unwrap().push(request);
        if let Some(gate) = &self.gate {
            gate.acquire().await.unwrap().forget();
        }
        self.answers
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or_else(|| self.default.clone())
    }
}

fn answered(status: u16) -> Sent {
    Sent::Answered {
        status,
        retry_after_ms: None,
    }
}

fn manifest() -> Manifest {
    Manifest::parse(json!({
        "schemaVersion": 3,
        "operations": [
            { "id": "deliver", "method": "POST", "url": "https://*/inbox", "effect": "write" },
            { "id": "deliver-local", "method": "POST", "url": "http://*/inbox", "effect": "write" },
            { "id": "notify", "method": "POST", "url": "https://hub.example/notify", "effect": "write" },
            { "id": "lookup", "method": "GET", "url": "https://hub.example/lookup", "effect": "read" }
        ],
        "http": {
            "mount": "drive-prefix",
            "routes": [{
                "id": "outbox", "path": "/outbox", "methods": ["POST"],
                "principal": "anonymous", "auth": "none", "body": "json",
                "enqueues": ["deliver", "deliver-local", "notify"]
            }],
            "keys": [
                { "name": "actor-key", "alg": "rsa-sha256" },
                { "name": "ed-key", "alg": "ed25519" }
            ]
        }
    }))
    .unwrap()
    .unwrap()
}

fn allowed() -> Vec<String> {
    vec!["deliver".into(), "deliver-local".into(), "notify".into()]
}

/// Prepares one delivery of the test manifest's `outbox` route.
fn prepare(item: Json) -> Result<Vec<Job>, String> {
    route_delivery::prepare(
        &manifest(),
        &allowed(),
        &json!([item]),
        INSTALLATION,
        "route:outbox",
        NOW,
    )
}

fn delivery(url: &str, id: &str) -> Vec<Job> {
    prepare(json!({
        "operation": if url.starts_with("http:") { "deliver-local" } else { "deliver" },
        "url": url,
        "body": { "type": "Create", "id": id },
        "idempotencyKey": id,
    }))
    .unwrap()
}

fn queue(
    db: &Db,
    per_day: u64,
    host: Arc<FakeHost>,
    transport: Arc<dyn Transport>,
) -> DeliveryQueue {
    DeliveryQueue::new(db.clone(), per_day, host, transport)
}

async fn tick(queue: &DeliveryQueue, now: i64) -> usize {
    let handles = queue.tick(now).await;
    let started = handles.len();
    for handle in handles {
        handle.await.unwrap();
    }
    started
}

fn only_job(db: &Db) -> Job {
    let mut jobs = route_delivery::jobs(db, INSTALLATION);
    assert_eq!(jobs.len(), 1, "{jobs:?}");
    jobs.remove(0)
}

fn settled(db: &Db) -> Vec<Job> {
    route_delivery::settled(db, INSTALLATION)
}

// -- the queue alone -------------------------------------------------------------

#[tokio::test]
async fn a_delivery_goes_through_the_egress_guard_to_a_local_stub() {
    let db = Db::init_temp("delivery_stub").await.unwrap();
    let (origin, received) = stub(vec![]).await;
    let q = queue(
        &db,
        10,
        FakeHost::new(),
        Arc::new(EgressTransport { loopback: true }),
    );
    let jobs = delivery(&format!("{origin}/inbox"), "create-1");
    let enqueued = route_delivery::enqueue(&db, jobs, NOW).unwrap();
    assert_eq!(enqueued.queued, 1);
    assert_eq!(only_job(&db).state, JobState::Queued);

    assert_eq!(tick(&q, NOW).await, 1);
    let received = received.lock().unwrap().clone();
    assert_eq!(received.len(), 1);
    assert_eq!(received[0].method, "POST");
    assert_eq!(received[0].path, "/inbox");
    assert_eq!(received[0].header("content-type"), Some("application/json"));
    let body: Json = serde_json::from_slice(&received[0].body).unwrap();
    assert_eq!(body, json!({ "type": "Create", "id": "create-1" }));

    assert!(route_delivery::jobs(&db, INSTALLATION).is_empty());
    let done = settled(&db);
    assert_eq!(done[0].state, JobState::Delivered);
    assert_eq!(done[0].receipts[0].status, Some(202));
    // Settled jobs keep no payload.
    assert!(done[0].body.is_none() && done[0].headers.is_empty());
    let status = route_delivery::status(&db, INSTALLATION, 10, NOW);
    assert_eq!(status["delivered24h"], 1, "{status}");
    assert_eq!(status["queued"], 0);
    assert_eq!(status["sentToday"], 1);
    assert_eq!(status["dailyCap"], 10);
    // Nothing more to send.
    assert_eq!(tick(&q, NOW + DAY_MS).await, 0);
}

#[tokio::test]
async fn the_egress_guard_refuses_loopback_and_private_addresses() {
    let db = Db::init_temp("delivery_egress").await.unwrap();
    let (origin, received) = stub(vec![]).await;
    // Without the test seam, the stub on loopback is refused: a dead letter
    // after one attempt, not a retry.
    let q = queue(
        &db,
        0,
        FakeHost::new(),
        Arc::new(EgressTransport { loopback: false }),
    );
    route_delivery::enqueue(&db, delivery(&format!("{origin}/inbox"), "a"), NOW).unwrap();
    // A wildcard delivery to a private address: refused even with the seam.
    let seam = queue(
        &db,
        0,
        FakeHost::new(),
        Arc::new(EgressTransport { loopback: true }),
    );
    tick(&q, NOW).await;
    route_delivery::enqueue(&db, delivery("https://10.0.0.7/inbox", "b"), NOW).unwrap();
    route_delivery::enqueue(&db, delivery("https://169.254.169.254/inbox", "c"), NOW).unwrap();
    tick(&seam, NOW).await;
    assert!(received.lock().unwrap().is_empty());
    let dead = settled(&db);
    assert_eq!(dead.len(), 3);
    for job in dead {
        assert_eq!(job.state, JobState::Dead, "{job:?}");
        assert_eq!(job.attempts, 1);
        let error = job.receipts[0].error.clone().unwrap();
        assert!(error.contains("egress guard"), "{error}");
    }
    let status = route_delivery::status(&db, INSTALLATION, 0, NOW);
    assert_eq!(status["dead"], 3);
    assert_eq!(status["lastFailures"].as_array().unwrap().len(), 3);
    assert!(status["dailyCap"].is_null());
}

#[tokio::test]
async fn failures_back_off_with_jitter_and_end_as_a_dead_letter() {
    let db = Db::init_temp("delivery_backoff").await.unwrap();
    let script = Script::always(answered(500));
    let q = queue(&db, 0, FakeHost::new(), script.clone());
    route_delivery::enqueue(&db, delivery("https://a.example/inbox", "x"), NOW).unwrap();

    let mut now = NOW;
    for attempt in 1..MAX_ATTEMPTS {
        assert_eq!(tick(&q, now).await, 1, "attempt {attempt}");
        let job = only_job(&db);
        assert_eq!(job.attempts, attempt);
        assert_eq!(job.state, JobState::Queued);
        let (low, high) = backoff(attempt);
        let wait = job.next_at - now;
        assert!(
            (low..=high).contains(&wait),
            "attempt {attempt}: waited {wait}, not in {low}..={high}"
        );
        // Not due before its time.
        assert_eq!(tick(&q, job.next_at - 1).await, 0);
        now = job.next_at;
    }
    assert_eq!(tick(&q, now).await, 1);
    assert!(route_delivery::jobs(&db, INSTALLATION).is_empty());
    let dead = &settled(&db)[0];
    assert_eq!(dead.state, JobState::Dead);
    assert_eq!(dead.attempts, MAX_ATTEMPTS);
    assert_eq!(script.sent().len(), MAX_ATTEMPTS as usize);
    let status = route_delivery::status(&db, INSTALLATION, 0, now);
    assert_eq!(status["dead"], 1);
    let failure = &status["lastFailures"][0];
    assert!(
        failure["error"].as_str().unwrap().contains("gave up"),
        "{failure}"
    );
    assert_eq!(failure["host"], "a.example");
    assert_eq!(failure["attempts"], MAX_ATTEMPTS);

    // The backoff doubles up to its cap.
    assert_eq!(backoff(1), (30_000, 60_000));
    assert_eq!(backoff(2), (60_000, 120_000));
    assert_eq!(backoff(20).1, route_delivery::BACKOFF_MAX_MS);
}

#[tokio::test]
async fn what_is_retried_and_what_is_not() {
    let db = Db::init_temp("delivery_judge").await.unwrap();
    let script = Arc::new(Script {
        answers: Mutex::new(VecDeque::from(vec![
            answered(404),
            answered(301),
            Sent::Failed {
                permanent: false,
                uncertain: true,
                message: "timed out".into(),
            },
            Sent::Answered {
                status: 429,
                retry_after_ms: Some(2 * 3_600_000),
            },
        ])),
        default: answered(202),
        sent: Default::default(),
        gate: None,
    });
    let q = queue(&db, 0, FakeHost::new(), script.clone());
    for (host, id) in [
        ("gone.example", "a"),
        ("moved.example", "b"),
        ("slow.example", "c"),
    ] {
        route_delivery::enqueue(&db, delivery(&format!("https://{host}/inbox"), id), NOW).unwrap();
        tick(&q, NOW).await;
    }
    route_delivery::enqueue(&db, delivery("https://busy.example/inbox", "d"), NOW).unwrap();
    tick(&q, NOW).await;

    let dead = settled(&db);
    let error = |host: &str| {
        dead.iter()
            .find(|j| j.url.contains(host))
            .map(|j| j.receipts.last().unwrap().error.clone().unwrap())
    };
    assert_eq!(error("gone.example").as_deref(), Some("answered 404"));
    assert!(error("moved.example").unwrap().contains("redirects"));
    let queued = route_delivery::jobs(&db, INSTALLATION);
    let slow = queued.iter().find(|j| j.url.contains("slow")).unwrap();
    assert!(slow.receipts[0].uncertain, "a timeout may have arrived");
    // `Retry-After` wins over a shorter backoff, and holds back the host.
    let busy = queued.iter().find(|j| j.url.contains("busy")).unwrap();
    assert_eq!(busy.next_at - NOW, 2 * 3_600_000);
    route_delivery::enqueue(&db, delivery("https://busy.example/inbox", "e"), NOW).unwrap();
    tick(&q, NOW + 1).await;
    let e = route_delivery::jobs(&db, INSTALLATION)
        .into_iter()
        .find(|j| j.idempotency_key == "e")
        .unwrap();
    assert_eq!(e.attempts, 0, "the host asked to wait");
    assert_eq!(e.next_at, NOW + 2 * 3_600_000);
    // After the wait, both go out.
    tick(&q, NOW + 2 * 3_600_000).await;
    assert_eq!(
        settled(&db)
            .iter()
            .filter(|j| j.url.contains("busy") && j.state == JobState::Delivered)
            .count(),
        2
    );
}

#[tokio::test]
async fn a_job_survives_a_restart_and_an_interrupted_attempt_is_retried() {
    let name = "delivery_restart";
    let db = Db::init_temp(name).await.unwrap();
    // An attempt that never answers, stopped mid-flight like a crash.
    let hanging = Arc::new(Script {
        answers: Default::default(),
        default: answered(202),
        sent: Default::default(),
        gate: Some(Arc::new(tokio::sync::Semaphore::new(0))),
    });
    let q = queue(&db, 0, FakeHost::new(), hanging.clone());
    route_delivery::enqueue(&db, delivery("https://a.example/inbox", "sending"), NOW).unwrap();
    let mut later = delivery("https://b.example/inbox", "later");
    later[0].next_at = NOW + 1;
    route_delivery::enqueue(&db, later, NOW + 1).unwrap();
    let handles = q.tick(NOW).await;
    assert_eq!(handles.len(), 1, "only the first is due");
    for handle in handles {
        handle.abort();
        let _ = handle.await;
    }
    drop(q);
    drop(db);

    // Reopened from disk.
    let path = format!(".temp/db/{name}");
    let db = Db::init_redb_file(
        std::path::Path::new(&path),
        Some("https://localhost".into()),
        std::path::Path::new(&format!("{path}/uploads")),
    )
    .await
    .unwrap();
    let jobs = route_delivery::jobs(&db, INSTALLATION);
    assert_eq!(jobs.len(), 2);
    let sending = jobs
        .iter()
        .find(|j| j.idempotency_key == "sending")
        .unwrap();
    assert_eq!(sending.state, JobState::Sending);
    let script = Script::always(answered(202));
    let q = queue(&db, 0, FakeHost::new(), script.clone());
    assert_eq!(q.recover(NOW + 10), 1);
    let resumed = route_delivery::jobs(&db, INSTALLATION)
        .into_iter()
        .find(|j| j.idempotency_key == "sending")
        .unwrap();
    assert_eq!(resumed.state, JobState::Queued);
    assert!(resumed.receipts[0].uncertain);
    assert_eq!(tick(&q, NOW + 10).await, 2);
    assert!(route_delivery::jobs(&db, INSTALLATION).is_empty());
    let delivered = settled(&db);
    assert_eq!(delivered.len(), 2);
    assert!(delivered.iter().all(|j| j.state == JobState::Delivered));
    let sending = delivered
        .iter()
        .find(|j| j.idempotency_key == "sending")
        .unwrap();
    assert_eq!(sending.attempts, 2, "the interrupted attempt counts");
}

#[tokio::test]
async fn the_daily_cap_defers_jobs_to_the_next_day() {
    let db = Db::init_temp("delivery_cap").await.unwrap();
    let script = Script::always(answered(202));
    let q = queue(&db, 2, FakeHost::new(), script.clone());
    for (i, host) in ["a", "b", "c"].iter().enumerate() {
        route_delivery::enqueue(
            &db,
            delivery(&format!("https://{host}.example/inbox"), &i.to_string()),
            NOW,
        )
        .unwrap();
    }
    assert_eq!(tick(&q, NOW).await, 2);
    let waiting = only_job(&db);
    assert!(waiting.waiting_for_cap);
    assert_eq!(waiting.attempts, 0, "waiting for the cap is not an attempt");
    let tomorrow = (NOW / DAY_MS + 1) * DAY_MS;
    assert!((tomorrow..=tomorrow + 60_000).contains(&waiting.next_at));
    let status = route_delivery::status(&db, INSTALLATION, 2, NOW);
    assert_eq!(status["waitingForCap"], 1, "{status}");
    assert_eq!(status["sentToday"], 2);
    // Still waiting later that day; not dropped.
    assert_eq!(tick(&q, tomorrow - 1).await, 0);
    assert_eq!(only_job(&db).state, JobState::Queued);
    // The next day it goes out.
    assert_eq!(tick(&q, tomorrow + 60_000).await, 1);
    assert_eq!(settled(&db).len(), 3);
    assert_eq!(script.sent().len(), 3);

    // Another installation has its own cap.
    let other = "did:ad:otherInstallation";
    let jobs = route_delivery::prepare(
        &manifest(),
        &allowed(),
        &json!([{ "operation": "deliver", "url": "https://d.example/inbox" }]),
        other,
        "route:outbox",
        tomorrow,
    )
    .unwrap();
    route_delivery::enqueue(&db, jobs, tomorrow).unwrap();
    assert_eq!(tick(&q, tomorrow + 60_000).await, 1);
}

#[tokio::test]
async fn one_destination_host_gets_at_most_two_requests_at_once() {
    let db = Db::init_temp("delivery_per_host").await.unwrap();
    let gate = Arc::new(tokio::sync::Semaphore::new(0));
    let script = Arc::new(Script {
        answers: Default::default(),
        default: answered(202),
        sent: Default::default(),
        gate: Some(gate.clone()),
    });
    let q = queue(&db, 0, FakeHost::new(), script.clone());
    for i in 0..5 {
        route_delivery::enqueue(
            &db,
            delivery("https://busy.example/inbox", &format!("busy-{i}")),
            NOW,
        )
        .unwrap();
    }
    route_delivery::enqueue(&db, delivery("https://quiet.example/inbox", "quiet"), NOW).unwrap();
    let first = q.tick(NOW).await;
    assert_eq!(first.len(), 3, "two to busy.example, one to quiet.example");
    // Ticking again while they are in flight starts nothing new for busy.
    assert!(q.tick(NOW + 1).await.is_empty());
    while script.sent().len() < 3 {
        tokio::task::yield_now().await;
    }
    let hosts: Vec<String> = script
        .sent()
        .iter()
        .map(|o| o.url.host_str().unwrap().to_string())
        .collect();
    assert_eq!(hosts.iter().filter(|h| *h == "busy.example").count(), 2);
    gate.add_permits(3);
    for handle in first {
        handle.await.unwrap();
    }
    let next = q.tick(NOW + 2).await;
    assert_eq!(next.len(), 2);
    gate.add_permits(2);
    for handle in next {
        handle.await.unwrap();
    }
    gate.add_permits(1);
    assert_eq!(tick(&q, NOW + 3).await, 1);
    assert_eq!(settled(&db).len(), 6);
}

#[tokio::test]
async fn an_idempotency_key_is_delivered_once() {
    let db = Db::init_temp("delivery_idempotency").await.unwrap();
    let script = Script::always(answered(202));
    let q = queue(&db, 0, FakeHost::new(), script.clone());
    let url = "https://a.example/inbox";
    let first = route_delivery::enqueue(&db, delivery(url, "activity-1"), NOW).unwrap();
    assert_eq!((first.queued, first.duplicates), (1, 0));
    // Queued: a second enqueue is a duplicate, even with another body.
    let again = prepare(json!({
        "operation": "deliver", "url": url, "body": "changed", "idempotencyKey": "activity-1"
    }))
    .unwrap();
    let second = route_delivery::enqueue(&db, again, NOW).unwrap();
    assert_eq!((second.queued, second.duplicates), (0, 1));
    tick(&q, NOW).await;
    // Delivered: still a duplicate while it is kept.
    let third = route_delivery::enqueue(&db, delivery(url, "activity-1"), NOW + DAY_MS).unwrap();
    assert_eq!((third.queued, third.duplicates), (0, 1));
    assert_eq!(script.sent().len(), 1);
    // Once forgotten, the key may be used again.
    let later = NOW + route_delivery::KEEP_SETTLED_MS + 1;
    tick(&q, later).await;
    let fourth = route_delivery::enqueue(&db, delivery(url, "activity-1"), later).unwrap();
    assert_eq!(fourth.queued, 1);

    // Without a key, the same content is one delivery, other content two;
    // within one verdict too.
    let unkeyed = |body: &str| json!({ "operation": "deliver", "url": url, "body": body });
    let jobs = route_delivery::prepare(
        &manifest(),
        &allowed(),
        &json!([unkeyed("x"), unkeyed("x"), unkeyed("y")]),
        INSTALLATION,
        "route:outbox",
        NOW,
    )
    .unwrap();
    assert_eq!(jobs.len(), 2);
    let stored = route_delivery::enqueue(&db, jobs, later).unwrap();
    assert_eq!(stored.queued, 2);
    let again = route_delivery::enqueue(&db, prepare(unkeyed("x")).unwrap(), later).unwrap();
    assert_eq!(again.duplicates, 1);
}

#[tokio::test]
async fn held_jobs_wait_and_resume_and_gone_ones_are_dropped() {
    let db = Db::init_temp("delivery_hold").await.unwrap();
    let host = FakeHost::new();
    let script = Script::always(answered(202));
    let q = queue(&db, 0, host.clone(), script.clone());
    route_delivery::enqueue(&db, delivery("https://a.example/inbox", "held"), NOW).unwrap();
    // Paused or degraded: kept, not sent.
    host.set(INSTALLATION, Standing::Held);
    assert_eq!(tick(&q, NOW).await, 0);
    let job = only_job(&db);
    assert!(job.held);
    assert_eq!(job.next_at, NOW + route_delivery::HOLD_RECHECK_MS);
    assert_eq!(route_delivery::status(&db, INSTALLATION, 0, NOW)["held"], 1);
    // Active again: resumed at once.
    host.set(INSTALLATION, Standing::Active);
    assert_eq!(route_delivery::resume(&db, INSTALLATION, NOW + 5), 1);
    assert_eq!(tick(&q, NOW + 5).await, 1);
    assert_eq!(script.sent().len(), 1);

    // Gone (revoked): every job of the installation is dropped unsent.
    route_delivery::enqueue(&db, delivery("https://a.example/inbox", "one"), NOW).unwrap();
    route_delivery::enqueue(&db, delivery("https://b.example/inbox", "two"), NOW).unwrap();
    host.set(INSTALLATION, Standing::Gone);
    assert_eq!(tick(&q, NOW + 10).await, 0);
    assert!(route_delivery::jobs(&db, INSTALLATION).is_empty());
    assert!(settled(&db).is_empty());
    assert_eq!(script.sent().len(), 1);
}

#[tokio::test]
async fn a_signed_delivery_verifies_against_the_installations_public_key() {
    let db = Db::init_temp("delivery_signed").await.unwrap();
    let (origin, received) = stub(vec![]).await;
    let q = queue(
        &db,
        0,
        FakeHost::new(),
        Arc::new(EgressTransport { loopback: true }),
    );
    let activity = r#"{"type":"Follow","id":"https://a.example/follow/1"}"#;
    for (key, key_id) in [
        ("actor-key", "https://a.example/actor#main-key"),
        ("ed-key", "https://a.example/actor#ed-key"),
    ] {
        let jobs = prepare(json!({
            "operation": "deliver-local",
            "url": format!("{origin}/inbox"),
            "headers": { "content-type": "application/activity+json" },
            "body": activity,
            "sign": { "key": key, "keyId": key_id },
            "idempotencyKey": key,
        }))
        .unwrap();
        route_delivery::enqueue(&db, jobs, NOW).unwrap();
    }
    assert_eq!(tick(&q, NOW).await, 2);
    let received = received.lock().unwrap().clone();
    assert_eq!(received.len(), 2);
    let now_secs = atomic_lib::utils::now() / 1000;
    for r in &received {
        assert_eq!(r.body, activity.as_bytes());
        assert_eq!(r.header("content-type"), Some("application/activity+json"));
        let message = Message {
            method: &r.method,
            scheme: "http",
            authority: r.header("host").unwrap(),
            path: &r.path,
            query: None,
            headers: &r.headers,
        };
        let parsed = http_signatures::parse(&message).unwrap();
        let name = if parsed[0].key_id.ends_with("#main-key") {
            "actor-key"
        } else {
            "ed-key"
        };
        let pem = route_keys::public(&db, INSTALLATION, &manifest(), name)
            .unwrap()
            .public_key_pem;
        let key = PublicKey::from_pem(&pem).unwrap();
        http_signatures::verify(&parsed[0], &key).expect("the installation's key verifies it");
        http_signatures::check_policy(&parsed[0], &message, &r.body, now_secs)
            .expect("bound to this request, fresh, and covering the body");
        // Over another body it no longer verifies.
        assert!(http_signatures::check_policy(&parsed[0], &message, b"{}", now_secs).is_err());
    }
    let schemes: Vec<_> = received
        .iter()
        .map(|r| r.header("signature-input").is_some())
        .collect();
    assert!(
        schemes.contains(&true) && schemes.contains(&false),
        "cavage and RFC 9421"
    );
}

#[test]
fn prepare_refuses_what_the_route_may_not_send() {
    let refused = |item: Json| prepare(item).unwrap_err();
    let base = |extra: Json| {
        let mut item = json!({ "operation": "deliver", "url": "https://a.example/inbox" });
        item.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        item
    };
    // Accepted: a wildcard host, the declared path, the default method.
    let ok = prepare(base(json!({}))).unwrap();
    assert_eq!(ok[0].method, "POST");
    assert!(prepare(base(
        json!({ "operation": "notify", "url": "https://hub.example/notify" })
    ))
    .is_ok());

    for (item, why) in [
        (base(json!({ "operation": "lookup" })), "enqueues"),
        (base(json!({ "operation": "nope" })), "enqueues"),
        (
            base(json!({ "url": "https://a.example/outbox" })),
            "declares",
        ),
        (base(json!({ "url": "http://a.example/inbox" })), "declares"),
        (base(json!({ "method": "PUT" })), "declares"),
        (
            base(json!({ "operation": "notify", "url": "https://other.example/notify" })),
            "declares",
        ),
        (
            base(json!({ "url": "https://u:p@a.example/inbox" })),
            "credentials",
        ),
        (base(json!({ "url": "ftp://a.example/inbox" })), "HTTP"),
        (
            base(json!({ "headers": { "Host": "x" } })),
            "set by the host",
        ),
        (
            base(json!({ "headers": { "transfer-encoding": "chunked" } })),
            "set by the host",
        ),
        (
            base(
                json!({ "headers": { "signature": "x" }, "sign": { "key": "actor-key", "keyId": "k" } }),
            ),
            "when it signs",
        ),
        (
            base(json!({ "headers": { "authorization": "Bearer secret:token" } })),
            "secret",
        ),
        (base(json!({ "headers": { "x": "a\r\nb" } })), "valid"),
        (
            base(json!({ "sign": { "key": "undeclared", "keyId": "k" } })),
            "no key",
        ),
        (
            base(json!({ "sign": { "key": "actor-key", "keyId": "" } })),
            "keyId",
        ),
        (
            base(json!({ "sign": { "key": "actor-key", "keyId": "k", "format": "jws" } })),
            "format",
        ),
        (base(json!({ "idempotencyKey": "" })), "idempotencyKey"),
        (
            base(json!({ "body": "x".repeat(route_delivery::MAX_BODY_BYTES + 1) })),
            "larger",
        ),
        (base(json!({ "unknown": true })), "not a delivery"),
    ] {
        let error = refused(item.clone());
        assert!(error.contains(why), "{item}: {error}");
    }
    let too_many: Vec<Json> = (0..=route_delivery::MAX_PER_RUN)
        .map(|i| base(json!({ "idempotencyKey": i.to_string() })))
        .collect();
    assert!(route_delivery::prepare(
        &manifest(),
        &allowed(),
        &Json::Array(too_many),
        INSTALLATION,
        "route:outbox",
        NOW
    )
    .is_err());
    assert!(route_delivery::prepare(
        &manifest(),
        &allowed(),
        &json!({ "operation": "deliver" }),
        INSTALLATION,
        "route:outbox",
        NOW
    )
    .is_err());
}

// -- through the app: the inbox fixture's `POST /deliver` --------------------------

macro_rules! app {
    ($appstate:expr) => {
        actix_test::init_service(
            App::new()
                .app_data(web::Data::new($appstate.clone()))
                .configure(crate::routes::config_routes),
        )
        .await
    };
}

struct Installed {
    f: Fixture,
    inbox: String,
    installation: String,
    prefix: String,
}

/// The inbox fixture at `read-write`, installed with its route grant, and a
/// queue whose transport may reach loopback.
async fn setup(name: &str) -> Installed {
    let mut f = fixture_with_args(name, &["--plugin-routes", "read-write"]).await;
    f.appstate.route_delivery = Arc::new(DeliveryQueue::new(
        f.appstate.store.clone(),
        f.appstate.config.opts.plugin_route_deliveries_per_day,
        Arc::new(RegistryHost {
            registry: f.appstate.route_registry.clone(),
            db: f.appstate.store.clone(),
        }),
        Arc::new(EgressTransport { loopback: true }),
    ));
    let store = &f.appstate.store;
    let inbox = genesis(
        store,
        vec![
            (urls::PARENT, Value::AtomicUrl(f.drive.as_str().into())),
            (urls::NAME, Value::String("Inbox".into())),
        ],
    )
    .await;
    let installation = install_release_with(
        &f,
        &inbox_release(),
        Some(inbox_release().manifest["http"]["writeTargets"].clone()),
        Some(json!({ "inbox": inbox })),
    )
    .await
    .unwrap();
    let agent = store
        .get_app_agent_info(&AppAgentKey::new(&f.drive, &installation))
        .unwrap()
        .unwrap()
        .agent;
    let mut resource = store.get_resource(&inbox.as_str().into()).await.unwrap();
    resource
        .set_unsafe(
            urls::WRITE.into(),
            Value::ResourceArray(vec![agent.as_str().into()]),
        )
        .unwrap();
    resource.save(store).await.unwrap();
    let prefix = format!("/_routes/{}", slug(&installation));
    Installed {
        f,
        inbox,
        installation,
        prefix,
    }
}

fn post(uri: &str, body: Json) -> actix_test::TestRequest {
    actix_test::TestRequest::post()
        .uri(uri)
        .insert_header((header::HOST, "localhost"))
        .insert_header((header::CONTENT_TYPE, "application/json"))
        .set_payload(body.to_string())
}

/// Signed as the store's default agent, who owns the Installation.
fn signed_get(appstate: &crate::appstate::AppState, path: &str) -> actix_test::TestRequest {
    let origin = appstate.config.get_origin();
    let headers = atomic_lib::client::get_authentication_headers(
        &format!("{origin}{path}"),
        &appstate.store.get_default_agent().unwrap(),
    )
    .unwrap();
    let authority = url::Url::parse(&origin).unwrap();
    let authority = match authority.port() {
        Some(port) => format!("{}:{port}", authority.host_str().unwrap()),
        None => authority.host_str().unwrap().to_string(),
    };
    let mut request = actix_test::TestRequest::get()
        .uri(path)
        .insert_header((header::HOST, authority));
    for (key, value) in headers {
        request = request.insert_header((key, value));
    }
    request
}

async fn set_status(i: &Installed, status: &str) {
    let store = &i.f.appstate.store;
    let mut installation = store
        .get_resource(&i.installation.as_str().into())
        .await
        .unwrap();
    installation
        .set_unsafe(
            urls::INSTALLATION_STATUS.into(),
            Value::String(status.into()),
        )
        .unwrap();
    installation.save(store).await.unwrap();
}

async fn tick_app(i: &Installed) -> usize {
    tick(&i.f.appstate.route_delivery, atomic_lib::utils::now()).await
}

#[actix_rt::test]
async fn a_route_enqueues_a_signed_delivery_that_the_stub_receives() {
    let i = setup("delivery_route").await;
    let app = app!(i.f.appstate);
    let (origin, received) = stub(vec![]).await;
    let activity = r#"{"type":"Accept","id":"https://x.example/accept/1"}"#;
    let resp = actix_test::call_service(
        &app,
        post(
            &format!("{}/deliver", i.prefix),
            json!({
                "to": format!("{origin}/inbox"),
                "operation": "deliver-local",
                "activity": activity,
                "id": "accept-1",
                "note": "sent an Accept",
            }),
        )
        .to_request(),
    )
    .await;
    assert_eq!(resp.status(), 202);
    // Queued, not sent inline; the note the same verdict wrote is stored.
    assert!(received.lock().unwrap().is_empty());
    let store = &i.f.appstate.store;
    let queued = route_delivery::jobs(store, &i.installation);
    assert_eq!(queued.len(), 1);
    assert_eq!(queued[0].source, "route:deliver");
    let inbox = store.get_resource(&i.inbox.as_str().into()).await.unwrap();
    assert_eq!(inbox.get_children(store).await.unwrap().len(), 1);

    // The route status shows the queued job.
    let path = format!(
        "/plugin-route-status?installation={}",
        urlencoding(&i.installation)
    );
    let resp = actix_test::call_service(&app, signed_get(&i.f.appstate, &path).to_request()).await;
    assert_eq!(resp.status(), 200);
    let status: Json = actix_test::read_body_json(resp).await;
    let route = |status: &Json| {
        status["routes"]
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["id"] == "deliver")
            .unwrap()
            .clone()
    };
    assert_eq!(route(&status)["queueDepth"], 1, "{status}");
    // How the route is called, from the manifest (#1721).
    assert_eq!(route(&status)["path"], "/deliver");
    assert_eq!(route(&status)["methods"], json!(["POST"]));
    assert_eq!(route(&status)["auth"], "none");
    assert_eq!(status["mount"], "drive-prefix");
    assert!(status["refusal"].is_null(), "{status}");
    assert_eq!(status["deliveries"]["queued"], 1);
    assert_eq!(
        status["deliveries"]["dailyCap"],
        crate::plugin_routes::DEFAULT_DELIVERIES_PER_DAY
    );

    // The worker sends it, signed with the installation's key.
    assert_eq!(tick_app(&i).await, 1);
    let received = received.lock().unwrap().clone();
    assert_eq!(received.len(), 1);
    let r = &received[0];
    assert_eq!(r.body, activity.as_bytes());
    let resp = actix_test::call_service(
        &app,
        actix_test::TestRequest::get()
            .uri(&format!("{}/actor", i.prefix))
            .insert_header((header::HOST, "localhost"))
            .to_request(),
    )
    .await;
    let actor: Json = actix_test::read_body_json(resp).await;
    let message = Message {
        method: &r.method,
        scheme: "http",
        authority: r.header("host").unwrap(),
        path: &r.path,
        query: None,
        headers: &r.headers,
    };
    let parsed = http_signatures::parse(&message).unwrap();
    assert_eq!(parsed[0].key_id, actor["publicKey"]["id"]);
    let key = PublicKey::from_pem(actor["publicKey"]["publicKeyPem"].as_str().unwrap()).unwrap();
    http_signatures::verify(&parsed[0], &key).expect("verifies with the published key");
    http_signatures::check_policy(
        &parsed[0],
        &message,
        &r.body,
        atomic_lib::utils::now() / 1000,
    )
    .unwrap();

    let resp = actix_test::call_service(&app, signed_get(&i.f.appstate, &path).to_request()).await;
    let status: Json = actix_test::read_body_json(resp).await;
    assert_eq!(route(&status)["queueDepth"], 0);
    assert_eq!(status["deliveries"]["delivered24h"], 1, "{status}");
    assert_eq!(status["deliveries"]["sentToday"], 1);

    // The same idempotency key again: accepted, not queued twice.
    let resp = actix_test::call_service(
        &app,
        post(
            &format!("{}/deliver", i.prefix),
            json!({ "to": format!("{origin}/inbox"), "operation": "deliver-local",
                    "activity": activity, "id": "accept-1" }),
        )
        .to_request(),
    )
    .await;
    assert_eq!(resp.status(), 202);
    assert!(route_delivery::jobs(store, &i.installation).is_empty());
}

#[actix_rt::test]
async fn a_refused_delivery_refuses_the_whole_verdict() {
    let i = setup("delivery_refused").await;
    let app = app!(i.f.appstate);
    let store = &i.f.appstate.store;
    for body in [
        // Not the operation's path.
        json!({ "to": "https://remote.example/outbox", "note": "n1" }),
        // Plain HTTP is only `deliver-local`.
        json!({ "to": "http://remote.example/inbox", "note": "n2" }),
        // A header the host sets.
        json!({ "to": "https://remote.example/inbox", "note": "n3",
                "extra": { "headers": { "host": "evil.example" } } }),
    ] {
        let resp = actix_test::call_service(
            &app,
            post(&format!("{}/deliver", i.prefix), body.clone()).to_request(),
        )
        .await;
        assert_eq!(resp.status(), 502, "{body}");
        let problem: Json = actix_test::read_body_json(resp).await;
        assert_eq!(problem["type"], "route-enqueue-refused");
    }
    // Neither the deliveries nor the notes of the same verdicts were stored.
    assert!(route_delivery::jobs(store, &i.installation).is_empty());
    let inbox = store.get_resource(&i.inbox.as_str().into()).await.unwrap();
    assert!(inbox.get_children(store).await.unwrap().is_empty());
}

#[actix_rt::test]
async fn pausing_holds_deliveries_and_revoking_drops_them() {
    let i = setup("delivery_lifecycle").await;
    let app = app!(i.f.appstate);
    let (origin, received) = stub(vec![]).await;
    let deliver = |id: &str| {
        post(
            &format!("{}/deliver", i.prefix),
            json!({ "to": format!("{origin}/inbox"), "operation": "deliver-local",
                    "activity": format!("{{\"id\":\"{id}\"}}"), "id": id }),
        )
        .to_request()
    };
    let store = &i.f.appstate.store;
    assert_eq!(
        actix_test::call_service(&app, deliver("a")).await.status(),
        202
    );

    // Paused: held, not sent, not dropped.
    set_status(&i, "paused").await;
    assert_eq!(tick_app(&i).await, 0);
    let jobs = route_delivery::jobs(store, &i.installation);
    assert_eq!(jobs.len(), 1);
    assert!(jobs[0].held);
    // Active again: sent at once.
    set_status(&i, "active").await;
    assert_eq!(tick_app(&i).await, 1);
    assert_eq!(received.lock().unwrap().len(), 1);

    // Queued, then revoked: dropped, never sent.
    set_status(&i, "paused").await;
    set_status(&i, "active").await;
    assert_eq!(
        actix_test::call_service(&app, deliver("b")).await.status(),
        202
    );
    assert_eq!(
        actix_test::call_service(&app, deliver("c")).await.status(),
        202
    );
    assert_eq!(route_delivery::jobs(store, &i.installation).len(), 2);
    set_status(&i, "revoked").await;
    assert!(route_delivery::jobs(store, &i.installation).is_empty());
    assert!(route_delivery::settled(store, &i.installation).is_empty());
    assert_eq!(tick_app(&i).await, 0);
    assert_eq!(received.lock().unwrap().len(), 1);
}

fn urlencoding(s: &str) -> String {
    url::form_urlencoded::byte_serialize(s.as_bytes()).collect()
}

/// Design 0.4 and the issue's acceptance: a restart with the gate closed
/// degrades the installation, and its queued deliveries are paused, not
/// dropped. A restart with the gate open again sends them.
#[actix_rt::test]
async fn a_restart_with_the_gate_closed_pauses_deliveries_until_it_reopens() {
    use super::route_registry::{RouteRegistry, State};
    use crate::plugin_routes::{resolve, OriginContext, PluginRoutesLevel, PluginRoutesOptions};

    let i = setup("delivery_degraded").await;
    let app = app!(i.f.appstate);
    let (origin, received) = stub(vec![]).await;
    let resp = actix_test::call_service(
        &app,
        post(
            &format!("{}/deliver", i.prefix),
            json!({ "to": format!("{origin}/inbox"), "operation": "deliver-local",
                    "activity": "{}", "id": "kept" }),
        )
        .to_request(),
    )
    .await;
    assert_eq!(resp.status(), 202);
    let store = &i.f.appstate.store;
    let restart = |level| async move {
        let config = resolve(
            PluginRoutesOptions {
                level,
                ..Default::default()
            },
            true,
            OriginContext {
                api_origin: "http://localhost:9883",
                ..Default::default()
            },
        )
        .unwrap();
        let registry = Arc::new(RouteRegistry::new(config));
        registry.rebuild(store).await.unwrap();
        let queue = DeliveryQueue::new(
            store.clone(),
            0,
            Arc::new(RegistryHost {
                registry: registry.clone(),
                db: store.clone(),
            }),
            Arc::new(EgressTransport { loopback: true }),
        );
        queue.recover(atomic_lib::utils::now());
        (registry, queue)
    };

    // Restarted at `read-only`: degraded, the job held.
    let (registry, queue) = restart(PluginRoutesLevel::ReadOnly).await;
    assert!(matches!(
        registry.state(&i.installation),
        Some(State::Degraded(_))
    ));
    assert_eq!(tick(&queue, atomic_lib::utils::now()).await, 0);
    let jobs = route_delivery::jobs(store, &i.installation);
    assert_eq!(jobs.len(), 1);
    assert!(jobs[0].held);
    assert!(received.lock().unwrap().is_empty());

    // Restarted at `read-write` again: sent, without a new review.
    let (registry, queue) = restart(PluginRoutesLevel::ReadWrite).await;
    assert_eq!(registry.state(&i.installation), Some(State::Active));
    assert_eq!(tick(&queue, atomic_lib::utils::now()).await, 1);
    assert_eq!(received.lock().unwrap().len(), 1);
    assert!(route_delivery::jobs(store, &i.installation).is_empty());
}
