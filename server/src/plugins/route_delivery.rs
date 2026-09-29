//! The durable delivery queue for plugin routes (#1719, AS-09; design
//! `server-plugin-routes.md` in atomic-plugins, sections 2.6, 2.7 and D5).
//!
//! A route never makes an outbound write inline: that would turn one inbound
//! POST into a fan-out, and make the response wait on third parties. Its
//! verdict *enqueues* declared write operations instead:
//!
//! ```jsonc
//! { "response": { "status": 202 },
//!   "enqueue": [{
//!     "operation": "deliver",                 // listed in the route's `enqueues`
//!     "url": "https://remote.example/inbox",  // matches the operation (`https://*/inbox`)
//!     "headers": { "content-type": "application/activity+json" },
//!     "body": { "type": "Accept" },           // a string, or JSON that is serialized
//!     "sign": { "key": "actor-key", "keyId": "https://…/actor#main-key" },
//!     "idempotencyKey": "accept-123"          // optional; see below
//!   }] }
//! ```
//!
//! Everything is checked before anything is applied (the verdict is refused
//! whole), then the jobs are stored in `Tree::PluginMeta` before the response
//! is sent, so a `2xx` means queued. A worker ([`spawn`]) sends them:
//!
//! - **Through the egress guard**: public addresses only, the checked address
//!   pinned, no proxy, no redirects, a 30 s deadline.
//! - **Signed host-side** at each attempt (a fresh `Date`) with the
//!   installation's key, when the job asks for it ([`super::route_keys`]).
//!   The operation must still be declared by the pinned release at send time.
//! - **Retried** with exponential backoff and jitter on network errors,
//!   `408`, `425`, `429` and `5xx` ([`BACKOFF_BASE_MS`] doubling up to
//!   [`BACKOFF_MAX_MS`], at most [`MAX_ATTEMPTS`] attempts and
//!   [`MAX_AGE_MS`]). A `Retry-After` on `429`/`503` is honoured, for the
//!   whole destination host. Any other answer, a refused address or an
//!   undeclared operation ends the job as *dead*: a dead letter kept for
//!   [`KEEP_SETTLED_MS`] and shown by `readRouteStatus`.
//! - **Politely**: at most [`PER_HOST`] requests in flight per destination
//!   host (across installations), [`IN_FLIGHT`] on the node.
//! - **Within the daily cap** (D5): at most `--plugin-route-deliveries-per-day`
//!   requests per installation per UTC day, retries included. Past it, jobs
//!   wait for the next day; they are not dropped.
//!
//! **Receipts.** Each attempt leaves a receipt on the job (the last
//! [`RECEIPTS`]). An attempt that was running when the server stopped, or
//! that timed out after the request was sent, is marked *uncertain*, like the
//! external-intent journal's missing receipt. Unlike the journal, a delivery
//! is retried after one: deliveries are the kind of write receivers
//! deduplicate (an ActivityPub activity has an id), and giving up would lose
//! it. The job's idempotency key stays the same across attempts.
//!
//! **Idempotency.** Each job has an idempotency key per installation: the
//! plugin's `idempotencyKey`, or else a hash of the operation, method, URL
//! and body. A second enqueue with a key that is queued, or settled within
//! [`KEEP_SETTLED_MS`], is a duplicate and is not queued again.
//!
//! **Lifecycle** (design 0.4, 2.9). A paused or degraded installation's jobs
//! are held, not dropped, and resume when it is active again, across
//! restarts. Revoking or destroying the installation drops them, with its
//! keys. The worker runs only at `--plugin-routes read-write`; at a lower
//! level the jobs stay on disk untouched.

use std::{
    collections::{BTreeMap, HashMap},
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex,
    },
};

use atomic_lib::{
    db::trees::{Method, Operation, Tree},
    Db, Subject,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value as Json};

use super::{egress, manifest::Manifest, route_keys};

const MINUTE_MS: i64 = 60_000;
const HOUR_MS: i64 = 60 * MINUTE_MS;
const DAY_MS: i64 = 24 * HOUR_MS;

// -- numbers (the design proposes only the daily cap) --------------------------

/// The first retry waits about this long; each next one twice as long.
pub const BACKOFF_BASE_MS: i64 = MINUTE_MS;
/// The longest wait between two attempts.
pub const BACKOFF_MAX_MS: i64 = 6 * HOUR_MS;
/// Attempts before a job is a dead letter.
pub const MAX_ATTEMPTS: u32 = 12;
/// A job older than this is a dead letter, however few attempts it had.
pub const MAX_AGE_MS: i64 = 72 * HOUR_MS;
/// Requests in flight to one destination host, from the whole node.
pub const PER_HOST: usize = 2;
/// Requests in flight from the whole node.
pub const IN_FLIGHT: usize = 16;
/// Jobs one installation may have queued. Past it an enqueue answers `503`.
pub const MAX_QUEUED: usize = 10_000;
/// Jobs one verdict may enqueue.
pub const MAX_PER_RUN: usize = 100;
/// A delivery's body.
pub const MAX_BODY_BYTES: usize = 256 * 1024;
/// Headers a job may set, and the length of each value.
pub const MAX_HEADERS: usize = 16;
pub const MAX_HEADER_BYTES: usize = 4096;
pub const MAX_IDEMPOTENCY_KEY: usize = 256;
/// One attempt's deadline, and how much of the answer is read.
pub const SEND_TIMEOUT_SECS: u64 = 30;
pub const RESPONSE_BYTES: usize = 64 * 1024;
/// Delivered and dead jobs are kept this long, for the status and for
/// idempotency.
pub const KEEP_SETTLED_MS: i64 = 7 * DAY_MS;
/// A held job (paused or degraded installation) is looked at again this
/// often. Reactivation resumes it at once.
pub const HOLD_RECHECK_MS: i64 = MINUTE_MS;
/// The longest a destination's `Retry-After` holds back its host.
pub const MAX_RETRY_AFTER_MS: i64 = DAY_MS;
/// Receipts kept per job, and dead letters shown in the status.
pub const RECEIPTS: usize = 5;
const FAILURES_SHOWN: usize = 10;
/// Due jobs read per tick.
const DUE_PER_TICK: usize = 256;
const TICK_MS: u64 = 1_000;
const PRUNE_EVERY_MS: i64 = 10 * MINUTE_MS;

/// Request headers a job may not set: the transport's own, and hop-by-hop.
const FORBIDDEN_HEADERS: [&str; 12] = [
    "connection",
    "content-length",
    "expect",
    "host",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "proxy-connection",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
];
/// Headers the host sets when it signs a job.
const SIGNATURE_HEADERS: [&str; 5] = [
    "content-digest",
    "date",
    "digest",
    "signature",
    "signature-input",
];

// -- keys in `Tree::PluginMeta` --------------------------------------------------

/// `job:<installation>\0<id>` → a queued or sending [`Job`].
const JOB: &str = "route-delivery:job:";
/// `due:<next_at hex>\0<installation>\0<id>` → the job's key.
const DUE: &str = "route-delivery:due:";
/// `settled:<installation>\0<id>` → a delivered or dead [`Job`], without
/// its headers and body.
const SETTLED: &str = "route-delivery:settled:";
/// `idem:<installation>\0<blake3(key)>` → [`Idem`].
const IDEM: &str = "route-delivery:idem:";
/// `day:<installation>\0<UTC day>` → requests sent that day.
const DAY: &str = "route-delivery:day:";

fn pure(subject: &str) -> String {
    Subject::from(subject).pure_id()
}

fn prefix(kind: &str, installation: &str) -> Vec<u8> {
    format!("{kind}{}\0", pure(installation)).into_bytes()
}

fn job_key(installation: &str, id: &str) -> Vec<u8> {
    let mut key = prefix(JOB, installation);
    key.extend_from_slice(id.as_bytes());
    key
}

fn settled_key(installation: &str, id: &str) -> Vec<u8> {
    let mut key = prefix(SETTLED, installation);
    key.extend_from_slice(id.as_bytes());
    key
}

fn due_key(next_at: i64, installation: &str, id: &str) -> Vec<u8> {
    format!(
        "{DUE}{:016x}\0{}\0{id}",
        next_at.max(0) as u64,
        pure(installation)
    )
    .into_bytes()
}

fn idem_key(installation: &str, key: &str) -> Vec<u8> {
    let mut k = prefix(IDEM, installation);
    k.extend_from_slice(blake3::hash(key.as_bytes()).to_hex().as_bytes());
    k
}

fn day_key(installation: &str, day: i64) -> Vec<u8> {
    let mut k = prefix(DAY, installation);
    k.extend_from_slice(day.to_string().as_bytes());
    k
}

/// Serializes the queue's read-modify-writes: enqueue, the worker's state
/// changes, drops. Only held around synchronous store calls.
static LOCK: Mutex<()> = Mutex::new(());

fn lock() -> std::sync::MutexGuard<'static, ()> {
    LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

// -- jobs ------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum JobState {
    Queued,
    Sending,
    Delivered,
    Dead,
}

/// Which key signs a job, at send time.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Sign {
    pub key: String,
    pub key_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub format: Option<String>,
}

/// What one attempt ended as.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Receipt {
    pub at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// The request may have reached the receiver without an answer reaching
    /// us.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub uncertain: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    pub id: String,
    pub installation: String,
    /// `route:<id>` for a route's verdict.
    pub source: String,
    pub operation: String,
    pub method: String,
    pub url: String,
    #[serde(default)]
    pub headers: BTreeMap<String, String>,
    #[serde(default)]
    pub body: Option<String>,
    #[serde(default)]
    pub sign: Option<Sign>,
    pub idempotency_key: String,
    pub enqueued_at: i64,
    pub state: JobState,
    pub attempts: u32,
    pub next_at: i64,
    /// Waiting because the installation is paused or degraded.
    #[serde(default)]
    pub held: bool,
    /// Waiting for the next day's cap.
    #[serde(default)]
    pub waiting_for_cap: bool,
    #[serde(default)]
    pub settled_at: Option<i64>,
    #[serde(default)]
    pub receipts: Vec<Receipt>,
}

impl Job {
    fn host(&self) -> String {
        url::Url::parse(&self.url)
            .ok()
            .and_then(|u| u.host_str().map(str::to_ascii_lowercase))
            .unwrap_or_default()
    }

    fn receipt(&mut self, receipt: Receipt) {
        self.receipts.push(receipt);
        if self.receipts.len() > RECEIPTS {
            self.receipts.remove(0);
        }
    }

    fn last_error(&self) -> Option<&Receipt> {
        self.receipts
            .last()
            .filter(|r| r.error.is_some() || r.status.is_some_and(|s| !(200..300).contains(&s)))
    }
}

#[derive(Serialize, Deserialize)]
struct Idem {
    id: String,
    /// While queued: `None`. Once settled: until when it still counts.
    #[serde(default)]
    until: Option<i64>,
}

fn read<T: serde::de::DeserializeOwned>(db: &Db, key: &[u8]) -> Option<T> {
    db.kv
        .get(Tree::PluginMeta, key)
        .ok()
        .flatten()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
}

fn put(key: Vec<u8>, value: &impl Serialize) -> Operation {
    Operation {
        tree: Tree::PluginMeta,
        method: Method::Insert,
        key,
        val: Some(serde_json::to_vec(value).expect("queue records serialize")),
    }
}

fn delete(key: Vec<u8>) -> Operation {
    Operation {
        tree: Tree::PluginMeta,
        method: Method::Delete,
        key,
        val: None,
    }
}

/// The writes that store `job` in its new state, replacing `before`.
fn store_ops(before: Option<&Job>, job: &Job) -> Vec<Operation> {
    let mut ops = Vec::new();
    if let Some(before) = before.filter(|b| b.state == JobState::Queued) {
        ops.push(delete(due_key(
            before.next_at,
            &before.installation,
            &before.id,
        )));
    }
    match job.state {
        JobState::Queued | JobState::Sending => {
            let key = job_key(&job.installation, &job.id);
            if job.state == JobState::Queued {
                ops.push(Operation {
                    tree: Tree::PluginMeta,
                    method: Method::Insert,
                    key: due_key(job.next_at, &job.installation, &job.id),
                    val: Some(key.clone()),
                });
            }
            ops.push(put(key, job));
        }
        JobState::Delivered | JobState::Dead => {
            ops.push(delete(job_key(&job.installation, &job.id)));
            let mut kept = job.clone();
            kept.headers.clear();
            kept.body = None;
            ops.push(put(settled_key(&job.installation, &job.id), &kept));
            ops.push(put(
                idem_key(&job.installation, &job.idempotency_key),
                &Idem {
                    id: job.id.clone(),
                    until: Some(job.settled_at.unwrap_or(job.next_at) + KEEP_SETTLED_MS),
                },
            ));
        }
    }
    ops
}

fn apply(db: &Db, ops: &[Operation]) -> Result<(), String> {
    db.kv.apply_batch(ops).map_err(|e| e.to_string())
}

// -- preparing a verdict's enqueues ----------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Requested {
    operation: String,
    url: String,
    #[serde(default)]
    method: Option<String>,
    #[serde(default)]
    headers: BTreeMap<String, String>,
    #[serde(default)]
    body: Option<Json>,
    #[serde(default)]
    sign: Option<Sign>,
    #[serde(default)]
    idempotency_key: Option<String>,
}

/// Checks a verdict's `enqueue` against the release and the route, and
/// turns it into jobs. Nothing is stored: a refusal refuses the verdict.
/// `allowed` is the route's `enqueues`.
pub fn prepare(
    manifest: &Manifest,
    allowed: &[String],
    items: &Json,
    installation: &str,
    source: &str,
    now: i64,
) -> Result<Vec<Job>, String> {
    let items = items
        .as_array()
        .ok_or("`enqueue` must be an array of deliveries")?;
    if items.len() > MAX_PER_RUN {
        return Err(format!(
            "at most {MAX_PER_RUN} deliveries may be enqueued at once"
        ));
    }
    let mut jobs: Vec<Job> = Vec::with_capacity(items.len());
    for (i, item) in items.iter().enumerate() {
        let job = prepare_one(manifest, allowed, item, installation, source, now)
            .map_err(|e| format!("delivery {i}: {e}"))?;
        // The same key twice in one verdict is one delivery.
        if !jobs
            .iter()
            .any(|j| j.idempotency_key == job.idempotency_key)
        {
            jobs.push(job);
        }
    }
    Ok(jobs)
}

fn prepare_one(
    manifest: &Manifest,
    allowed: &[String],
    item: &Json,
    installation: &str,
    source: &str,
    now: i64,
) -> Result<Job, String> {
    let requested: Requested =
        serde_json::from_value(item.clone()).map_err(|e| format!("not a delivery: {e}"))?;
    if !allowed.contains(&requested.operation) {
        return Err(format!(
            "operation `{}` is not in this route's `enqueues`",
            requested.operation
        ));
    }
    let operation = manifest
        .operations
        .iter()
        .find(|o| o.id == requested.operation)
        .ok_or_else(|| format!("no operation `{}` is declared", requested.operation))?;
    let method = requested
        .method
        .unwrap_or_else(|| operation.method.clone())
        .to_ascii_uppercase();
    let url = url::Url::parse(&requested.url).map_err(|e| format!("not a URL: {e}"))?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err("the URL must be HTTP(S), without credentials or a fragment".into());
    }
    if !manifest.allows_delivery(&requested.operation, &method, &url) {
        return Err(format!(
            "{method} {url} is not what write operation `{}` declares",
            requested.operation
        ));
    }

    let mut headers = BTreeMap::new();
    if requested.headers.len() > MAX_HEADERS {
        return Err(format!("at most {MAX_HEADERS} headers"));
    }
    for (name, value) in requested.headers {
        let name = name.to_ascii_lowercase();
        if actix_web::http::header::HeaderName::from_bytes(name.as_bytes()).is_err()
            || actix_web::http::header::HeaderValue::from_str(&value).is_err()
            || value.len() > MAX_HEADER_BYTES
        {
            return Err(format!("header `{name}` is not a valid header"));
        }
        if FORBIDDEN_HEADERS.contains(&name.as_str()) {
            return Err(format!("header `{name}` is set by the host"));
        }
        if requested.sign.is_some() && SIGNATURE_HEADERS.contains(&name.as_str()) {
            return Err(format!("header `{name}` is set by the host when it signs"));
        }
        if atomic_lib::db::plugin_secret::mentions_handle(&value) {
            return Err("secret handles are not substituted in deliveries".into());
        }
        headers.insert(name, value);
    }
    let body = match requested.body {
        None | Some(Json::Null) => None,
        Some(Json::String(s)) => Some(s),
        Some(other) => {
            headers
                .entry("content-type".into())
                .or_insert_with(|| "application/json".into());
            Some(other.to_string())
        }
    };
    if body.as_ref().is_some_and(|b| b.len() > MAX_BODY_BYTES) {
        return Err(format!("the body is larger than {MAX_BODY_BYTES} bytes"));
    }
    if let Some(sign) = &requested.sign {
        let declared = manifest
            .http
            .as_ref()
            .is_some_and(|h| h.keys.iter().any(|k| k.name == sign.key));
        if !declared {
            return Err(format!("this plugin declares no key `{}`", sign.key));
        }
        if sign.key_id.is_empty() || sign.key_id.len() > 2048 {
            return Err("keyId must be given, and at most 2048 characters".into());
        }
        if !matches!(
            sign.format.as_deref(),
            None | Some("draft-cavage-12") | Some("rfc9421")
        ) {
            return Err("sign.format must be `draft-cavage-12` or `rfc9421`".into());
        }
    }
    let idempotency_key = match requested.idempotency_key {
        Some(key) if key.is_empty() || key.len() > MAX_IDEMPOTENCY_KEY => {
            return Err(format!(
                "idempotencyKey must be 1 to {MAX_IDEMPOTENCY_KEY} characters"
            ))
        }
        Some(key) => key,
        None => format!(
            "content:{}",
            blake3::hash(
                json!([requested.operation, method, url.as_str(), body])
                    .to_string()
                    .as_bytes()
            )
            .to_hex()
        ),
    };
    Ok(Job {
        id: ulid::Ulid::new().to_string(),
        installation: installation.to_string(),
        source: source.to_string(),
        operation: requested.operation,
        method,
        url: url.to_string(),
        headers,
        body,
        sign: requested.sign,
        idempotency_key,
        enqueued_at: now,
        state: JobState::Queued,
        attempts: 0,
        next_at: now,
        held: false,
        waiting_for_cap: false,
        settled_at: None,
        receipts: Vec::new(),
    })
}

// -- storing ---------------------------------------------------------------------

/// What [`enqueue`] stored.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Enqueued {
    pub queued: usize,
    pub duplicates: usize,
}

fn queued_count(db: &Db, installation: &str) -> usize {
    db.kv
        .scan_prefix(Tree::PluginMeta, &prefix(JOB, installation))
        .count()
}

/// Whether `n` more jobs fit in the installation's queue.
pub fn has_room(db: &Db, installation: &str, n: usize) -> bool {
    n == 0 || queued_count(db, installation) + n <= MAX_QUEUED
}

fn duplicate(db: &Db, job: &Job, now: i64) -> bool {
    read::<Idem>(db, &idem_key(&job.installation, &job.idempotency_key))
        .is_some_and(|idem| idem.until.is_none_or(|until| until > now))
}

/// Stores prepared jobs, durably, skipping duplicates. Refused whole when
/// they don't fit in the installation's queue.
pub fn enqueue(db: &Db, jobs: Vec<Job>, now: i64) -> Result<Enqueued, String> {
    let _guard = lock();
    let mut out = Enqueued::default();
    let Some(installation) = jobs.first().map(|j| j.installation.clone()) else {
        return Ok(out);
    };
    let fresh: Vec<Job> = jobs
        .into_iter()
        .filter(|job| {
            let dup = duplicate(db, job, now);
            out.duplicates += usize::from(dup);
            !dup
        })
        .collect();
    if queued_count(db, &installation) + fresh.len() > MAX_QUEUED {
        return Err(format!(
            "this installation already has {MAX_QUEUED} deliveries queued"
        ));
    }
    let mut ops = Vec::new();
    for job in &fresh {
        ops.extend(store_ops(None, job));
        ops.push(put(
            idem_key(&job.installation, &job.idempotency_key),
            &Idem {
                id: job.id.clone(),
                until: None,
            },
        ));
    }
    apply(db, &ops)?;
    db.flush().map_err(|e| e.to_string())?;
    out.queued = fresh.len();
    Ok(out)
}

/// Drops every job of an installation (on revocation and destruction), with
/// its dead letters, idempotency records and day counts. Returns how many
/// jobs were still queued.
pub fn drop_installation(db: &Db, installation: &str) -> usize {
    let _guard = lock();
    let mut ops = Vec::new();
    let mut dropped = 0;
    for (key, value) in db
        .kv
        .scan_prefix(Tree::PluginMeta, &prefix(JOB, installation))
        .flatten()
    {
        if let Ok(job) = serde_json::from_slice::<Job>(&value) {
            if job.state == JobState::Queued {
                ops.push(delete(due_key(job.next_at, &job.installation, &job.id)));
            }
        }
        ops.push(delete(key));
        dropped += 1;
    }
    for kind in [SETTLED, IDEM, DAY] {
        for (key, _) in db
            .kv
            .scan_prefix(Tree::PluginMeta, &prefix(kind, installation))
            .flatten()
        {
            ops.push(delete(key));
        }
    }
    if let Err(e) = apply(db, &ops).and_then(|_| db.flush().map_err(|e| e.to_string())) {
        tracing::warn!(installation, "could not drop plugin deliveries: {e}");
    }
    dropped
}

/// Makes an installation's held jobs due now: it is active again.
pub fn resume(db: &Db, installation: &str, now: i64) -> usize {
    let _guard = lock();
    let mut ops = Vec::new();
    let mut resumed = 0;
    for (_, value) in db
        .kv
        .scan_prefix(Tree::PluginMeta, &prefix(JOB, installation))
        .flatten()
    {
        let Ok(before) = serde_json::from_slice::<Job>(&value) else {
            continue;
        };
        if before.state == JobState::Queued && before.held {
            let mut job = before.clone();
            job.held = false;
            job.next_at = now;
            ops.extend(store_ops(Some(&before), &job));
            resumed += 1;
        }
    }
    if let Err(e) = apply(db, &ops) {
        tracing::warn!(installation, "could not resume plugin deliveries: {e}");
    }
    resumed
}

/// Every job of an installation that is still queued or sending.
pub fn jobs(db: &Db, installation: &str) -> Vec<Job> {
    db.kv
        .scan_prefix(Tree::PluginMeta, &prefix(JOB, installation))
        .flatten()
        .filter_map(|(_, v)| serde_json::from_slice(&v).ok())
        .collect()
}

/// Every delivered or dead job of an installation still kept.
pub fn settled(db: &Db, installation: &str) -> Vec<Job> {
    db.kv
        .scan_prefix(Tree::PluginMeta, &prefix(SETTLED, installation))
        .flatten()
        .filter_map(|(_, v)| serde_json::from_slice(&v).ok())
        .collect()
}

fn day_count(db: &Db, installation: &str, day: i64) -> u64 {
    read(db, &day_key(installation, day)).unwrap_or(0)
}

// -- status ----------------------------------------------------------------------

/// The queue part of `readRouteStatus` (#1721): per route, how many jobs are
/// queued and the oldest one that is failing; for the installation, the
/// counts, today's use of the cap, and the last failures (dead letters
/// first, then failing jobs), newest first.
pub fn status(db: &Db, installation: &str, per_day: u64, now: i64) -> Json {
    let queued = jobs(db, installation);
    let settled = settled(db, installation);
    let mut routes: BTreeMap<String, (u64, Option<&Job>)> = BTreeMap::new();
    for job in &queued {
        let Some(route) = job.source.strip_prefix("route:") else {
            continue;
        };
        let entry = routes.entry(route.to_string()).or_default();
        entry.0 += 1;
        if job.last_error().is_some() && entry.1.is_none_or(|o| o.enqueued_at > job.enqueued_at) {
            entry.1 = Some(job);
        }
    }
    let failure = |job: &Job| {
        let receipt = job.receipts.last();
        json!({
            "id": job.id,
            "route": job.source.strip_prefix("route:"),
            "operation": job.operation,
            "host": job.host(),
            "state": job.state,
            "attempts": job.attempts,
            "enqueuedAt": job.enqueued_at,
            "at": receipt.map(|r| r.at),
            "status": receipt.and_then(|r| r.status),
            "error": receipt.and_then(|r| r.error.clone()),
            "uncertain": receipt.is_some_and(|r| r.uncertain),
            "nextAt": (job.state == JobState::Queued).then_some(job.next_at),
        })
    };
    let mut failures: Vec<&Job> = settled
        .iter()
        .filter(|j| j.state == JobState::Dead)
        .chain(queued.iter().filter(|j| j.last_error().is_some()))
        .collect();
    failures.sort_by_key(|j| std::cmp::Reverse(j.receipts.last().map(|r| r.at).unwrap_or(0)));
    let count = |f: &dyn Fn(&Job) -> bool| queued.iter().filter(|j| f(j)).count();
    let since = now - DAY_MS;
    json!({
        "routes": routes.iter().map(|(route, (depth, oldest))| (route.clone(), json!({
            "queueDepth": depth,
            "oldestQueueFailure": oldest.map(&failure),
        }))).collect::<serde_json::Map<_, _>>(),
        "queued": count(&|j| j.state == JobState::Queued),
        "sending": count(&|j| j.state == JobState::Sending),
        "held": count(&|j| j.held),
        "waitingForCap": count(&|j| j.waiting_for_cap),
        "delivered24h": settled.iter().filter(|j| j.state == JobState::Delivered && j.settled_at.unwrap_or(0) >= since).count(),
        "dead": settled.iter().filter(|j| j.state == JobState::Dead).count(),
        "sentToday": day_count(db, installation, now.div_euclid(DAY_MS)),
        "dailyCap": (per_day > 0).then_some(per_day),
        "lastFailures": failures.into_iter().take(FAILURES_SHOWN).map(failure).collect::<Vec<_>>(),
    })
}

// -- sending ---------------------------------------------------------------------

/// Whether an installation's jobs may be sent now.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Standing {
    Active,
    /// Paused or degraded: kept, not sent.
    Held,
    /// Revoked, destroyed or unknown: dropped.
    Gone,
}

/// What the queue needs to know about installations.
#[async_trait::async_trait]
pub trait QueueHost: Send + Sync {
    async fn standing(&self, installation: &str) -> Standing;
    /// The manifest of the release the installation pins now.
    async fn manifest(&self, installation: &str) -> Option<Manifest>;
}

/// One request, as the transport sends it.
#[derive(Clone, Debug)]
pub struct Outgoing {
    pub method: String,
    pub url: url::Url,
    pub headers: Vec<(String, String)>,
    pub body: Option<Vec<u8>>,
}

/// What a send ended as.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Sent {
    Answered {
        status: u16,
        /// From `Retry-After`, in ms from now.
        retry_after_ms: Option<i64>,
    },
    Failed {
        /// Not worth retrying: the egress guard refused the address.
        permanent: bool,
        /// The request may have been received.
        uncertain: bool,
        message: String,
    },
}

#[async_trait::async_trait]
pub trait Transport: Send + Sync {
    async fn send(&self, request: Outgoing) -> Sent;
}

/// Sends through the egress guard: every resolved address public, the
/// checked address pinned, no proxy, no redirects, [`SEND_TIMEOUT_SECS`],
/// and at most [`RESPONSE_BYTES`] of the answer read.
pub struct EgressTransport {
    /// A test seam ([`crate::config::Config::plugin_delivery_loopback`]):
    /// loopback addresses pass. Every other refusal stays.
    pub loopback: bool,
}

impl EgressTransport {
    async fn addresses(&self, url: &url::Url) -> Result<Vec<std::net::SocketAddr>, String> {
        if !self.loopback {
            return egress::checked_addresses(url).await;
        }
        let host = url.host_str().ok_or("URL has no host")?;
        let port = url.port_or_known_default().ok_or("URL has no port")?;
        let addresses: Vec<_> = tokio::net::lookup_host((host.trim_matches(['[', ']']), port))
            .await
            .map_err(|e| format!("could not resolve {host}: {e}"))?
            .collect();
        if addresses.is_empty() {
            return Err("host resolved to no addresses".into());
        }
        for address in &addresses {
            match egress::refuse_address(address.ip()) {
                None | Some(egress::Refusal::Loopback) => {}
                Some(refusal) => {
                    return Err(format!(
                        "{host} resolves to a refused address ({refusal:?})"
                    ))
                }
            }
        }
        Ok(addresses)
    }
}

fn retry_after_ms(value: Option<&reqwest::header::HeaderValue>) -> Option<i64> {
    let value = value?.to_str().ok()?.trim();
    if let Ok(secs) = value.parse::<i64>() {
        return Some(secs.max(0).saturating_mul(1000));
    }
    let at = httpdate::parse_http_date(value).ok()?;
    Some(
        at.duration_since(std::time::SystemTime::now())
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0),
    )
}

#[async_trait::async_trait]
impl Transport for EgressTransport {
    async fn send(&self, request: Outgoing) -> Sent {
        let refused = |message: String| Sent::Failed {
            permanent: true,
            uncertain: false,
            message,
        };
        let host = match request.url.host_str() {
            Some(host) => host.to_string(),
            None => return refused("URL has no host".into()),
        };
        let addresses = match self.addresses(&request.url).await {
            Ok(addresses) => addresses,
            // A name that doesn't resolve may resolve later.
            Err(e) if e.starts_with("could not resolve") => {
                return Sent::Failed {
                    permanent: false,
                    uncertain: false,
                    message: e,
                }
            }
            Err(e) => return refused(format!("the egress guard refused it: {e}")),
        };
        let client = match reqwest::Client::builder()
            .no_proxy()
            .resolve_to_addrs(&host, &addresses)
            .timeout(std::time::Duration::from_secs(SEND_TIMEOUT_SECS))
            .redirect(reqwest::redirect::Policy::none())
            .build()
        {
            Ok(client) => client,
            Err(e) => return refused(format!("could not build an HTTP client: {e}")),
        };
        let method = match reqwest::Method::from_bytes(request.method.as_bytes()) {
            Ok(method) => method,
            Err(_) => return refused(format!("`{}` is not a method", request.method)),
        };
        let mut builder = client.request(method, request.url.clone());
        for (name, value) in &request.headers {
            if name != "host" {
                builder = builder.header(name, value);
            }
        }
        if let Some(body) = request.body {
            builder = builder.body(body);
        }
        match builder.send().await {
            Ok(response) => {
                let status = response.status().as_u16();
                let retry_after = retry_after_ms(response.headers().get("retry-after"));
                // Read (a little of) the answer, so the connection closes
                // cleanly; its content is not kept.
                let origin = egress::origin_of(&request.url).unwrap_or_default();
                let _ =
                    super::host_core::read_capped(response.bytes_stream(), RESPONSE_BYTES, &origin)
                        .await;
                Sent::Answered {
                    status,
                    retry_after_ms: retry_after,
                }
            }
            Err(e) => Sent::Failed {
                permanent: false,
                uncertain: !e.is_connect(),
                message: format!("could not deliver: {e}"),
            },
        }
    }
}

/// The wait before retry `attempt` (1 for the first retry): the base,
/// doubled per attempt, capped, then jittered to between half and all of it.
pub fn backoff(attempt: u32) -> (i64, i64) {
    let full = BACKOFF_BASE_MS
        .saturating_mul(1i64 << attempt.saturating_sub(1).min(30))
        .min(BACKOFF_MAX_MS);
    (full / 2, full)
}

fn jittered((low, high): (i64, i64)) -> i64 {
    use rand::Rng;
    rand::thread_rng().gen_range(low..=high)
}

/// How an answered attempt counts.
enum Verdict {
    Delivered,
    Retry,
    Dead,
}

fn judge(status: u16) -> Verdict {
    match status {
        200..=299 => Verdict::Delivered,
        408 | 425 | 429 | 500..=599 => Verdict::Retry,
        _ => Verdict::Dead,
    }
}

#[derive(Default)]
struct HostState {
    in_flight: usize,
    blocked_until: i64,
}

/// The queue's worker: which jobs are due, and sending them. The jobs
/// themselves live in the store; this only holds what is in flight.
pub struct DeliveryQueue {
    db: Db,
    per_day: u64,
    host: Arc<dyn QueueHost>,
    transport: Arc<dyn Transport>,
    hosts: Arc<Mutex<HashMap<String, HostState>>>,
    in_flight: Arc<AtomicUsize>,
    wake: tokio::sync::Notify,
    ticking: tokio::sync::Mutex<i64>,
}

/// A taken send slot: one for the node, one for the destination host.
struct Slot {
    hosts: Arc<Mutex<HashMap<String, HostState>>>,
    in_flight: Arc<AtomicUsize>,
    host: String,
}

impl Drop for Slot {
    fn drop(&mut self) {
        self.in_flight.fetch_sub(1, Ordering::AcqRel);
        if let Some(state) = self
            .hosts
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get_mut(&self.host)
        {
            state.in_flight = state.in_flight.saturating_sub(1);
        }
    }
}

impl DeliveryQueue {
    pub fn new(
        db: Db,
        per_day: u64,
        host: Arc<dyn QueueHost>,
        transport: Arc<dyn Transport>,
    ) -> Self {
        Self {
            db,
            per_day,
            host,
            transport,
            hosts: Default::default(),
            in_flight: Default::default(),
            wake: tokio::sync::Notify::new(),
            ticking: tokio::sync::Mutex::new(0),
        }
    }

    /// The daily cap per installation; `0` is none.
    pub fn per_day(&self) -> u64 {
        self.per_day
    }

    /// Something was enqueued: look now rather than at the next tick.
    pub fn wake(&self) {
        self.wake.notify_one();
    }

    /// After a restart: an attempt that was sending when the server stopped
    /// is uncertain and is retried; held jobs are looked at again; the due
    /// index is rebuilt from the jobs.
    pub fn recover(&self, now: i64) -> usize {
        let _guard = lock();
        let db = &self.db;
        let mut ops: Vec<Operation> = db
            .kv
            .scan_prefix(Tree::PluginMeta, DUE.as_bytes())
            .flatten()
            .map(|(key, _)| delete(key))
            .collect();
        let mut uncertain = 0;
        for (_, value) in db
            .kv
            .scan_prefix(Tree::PluginMeta, JOB.as_bytes())
            .flatten()
        {
            let Ok(mut job) = serde_json::from_slice::<Job>(&value) else {
                continue;
            };
            if job.state == JobState::Sending {
                job.state = JobState::Queued;
                job.next_at = now;
                job.receipt(Receipt {
                    at: now,
                    status: None,
                    error: Some(
                        "the server stopped during this attempt; whether it arrived is unknown"
                            .into(),
                    ),
                    uncertain: true,
                });
                uncertain += 1;
            }
            if job.held {
                job.held = false;
                job.next_at = job.next_at.min(now);
            }
            // `before: None`: every due entry was deleted above.
            ops.extend(store_ops(None, &job));
        }
        if let Err(e) = apply(db, &ops).and_then(|_| db.flush().map_err(|e| e.to_string())) {
            tracing::warn!("could not recover plugin deliveries: {e}");
        }
        uncertain
    }

    /// Updates a job under the lock, if it still exists (it may have been
    /// dropped meanwhile). Returns the job as stored.
    fn change(&self, installation: &str, id: &str, f: impl FnOnce(&mut Job)) -> Option<Job> {
        let _guard = lock();
        let before: Job = read(&self.db, &job_key(installation, id))?;
        let mut job = before.clone();
        f(&mut job);
        if let Err(e) = apply(&self.db, &store_ops(Some(&before), &job)) {
            tracing::warn!(installation, id, "could not update a plugin delivery: {e}");
            return None;
        }
        Some(job)
    }

    /// Sends what is due at `now`, within the limits. Returns the attempts
    /// it started, which run on their own; tests await them.
    pub async fn tick(&self, now: i64) -> Vec<tokio::task::JoinHandle<()>> {
        let mut ticking = self.ticking.lock().await;
        if now - *ticking >= PRUNE_EVERY_MS {
            *ticking = now;
            prune(&self.db, now);
        }
        let due = self
            .db
            .kv
            .range_page(
                Tree::PluginMeta,
                DUE.as_bytes().to_vec(),
                format!("{DUE}{:016x}", (now + 1).max(0) as u64).into_bytes(),
                DUE_PER_TICK,
            )
            .unwrap_or_default();
        let mut standings: HashMap<String, Standing> = HashMap::new();
        let mut started = Vec::new();
        for (due, key) in due {
            if self.in_flight.load(Ordering::Acquire) >= IN_FLIGHT {
                break;
            }
            let Some(job) = read::<Job>(&self.db, &key) else {
                let _ = self.db.kv.remove(Tree::PluginMeta, &due);
                continue;
            };
            let standing = match standings.get(&job.installation) {
                Some(standing) => *standing,
                None => {
                    let standing = self.host.standing(&job.installation).await;
                    standings.insert(job.installation.clone(), standing);
                    standing
                }
            };
            match standing {
                Standing::Gone => {
                    let dropped = drop_installation(&self.db, &job.installation);
                    tracing::info!(
                        installation = job.installation,
                        dropped,
                        "dropped the deliveries of an installation that is gone"
                    );
                    continue;
                }
                Standing::Held => {
                    self.change(&job.installation, &job.id, |job| {
                        job.held = true;
                        job.next_at = now + HOLD_RECHECK_MS;
                    });
                    continue;
                }
                Standing::Active => {}
            }
            if now - job.enqueued_at > MAX_AGE_MS {
                self.change(&job.installation, &job.id, |job| {
                    job.receipt(Receipt {
                        at: now,
                        status: None,
                        error: Some(format!(
                            "expired: not delivered within {} hours",
                            MAX_AGE_MS / HOUR_MS
                        )),
                        uncertain: false,
                    });
                    job.state = JobState::Dead;
                    job.settled_at = Some(now);
                });
                continue;
            }
            let host = job.host();
            {
                let mut hosts = self.hosts.lock().unwrap_or_else(|e| e.into_inner());
                let state = hosts.entry(host.clone()).or_default();
                if state.blocked_until > now {
                    let until = state.blocked_until;
                    drop(hosts);
                    self.change(&job.installation, &job.id, |job| job.next_at = until);
                    continue;
                }
                if state.in_flight >= PER_HOST {
                    // Stays due; looked at again next tick.
                    continue;
                }
            }
            // The daily cap (D5): every request counts; past it, wait for
            // the next UTC day.
            let day = now.div_euclid(DAY_MS);
            let booked = {
                let _guard = lock();
                let used = day_count(&self.db, &job.installation, day);
                if self.per_day > 0 && used >= self.per_day {
                    false
                } else {
                    let _ = self.db.kv.insert(
                        Tree::PluginMeta,
                        &day_key(&job.installation, day),
                        (used + 1).to_string().as_bytes(),
                    );
                    true
                }
            };
            if !booked {
                let next_day = (day + 1) * DAY_MS + jittered((0, MINUTE_MS));
                self.change(&job.installation, &job.id, |job| {
                    job.waiting_for_cap = true;
                    job.next_at = next_day;
                });
                continue;
            }
            let Some(job) = self.change(&job.installation, &job.id, |job| {
                job.state = JobState::Sending;
                job.attempts += 1;
                job.waiting_for_cap = false;
                job.held = false;
            }) else {
                continue;
            };
            let _ = self.db.flush();
            self.in_flight.fetch_add(1, Ordering::AcqRel);
            self.hosts
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .entry(host.clone())
                .or_default()
                .in_flight += 1;
            let slot = Slot {
                hosts: self.hosts.clone(),
                in_flight: self.in_flight.clone(),
                host,
            };
            let attempt = Attempt {
                db: self.db.clone(),
                host: self.host.clone(),
                transport: self.transport.clone(),
                hosts: self.hosts.clone(),
            };
            started.push(tokio::spawn(async move {
                attempt.run(job, now).await;
                drop(slot);
            }));
        }
        started
    }
}

/// One attempt at one job, on its own task.
struct Attempt {
    db: Db,
    host: Arc<dyn QueueHost>,
    transport: Arc<dyn Transport>,
    hosts: Arc<Mutex<HashMap<String, HostState>>>,
}

enum Ended {
    Delivered(u16),
    Retry {
        status: Option<u16>,
        error: Option<String>,
        uncertain: bool,
        retry_after_ms: Option<i64>,
    },
    Dead {
        status: Option<u16>,
        error: String,
    },
}

impl Attempt {
    async fn send(&self, job: &Job) -> Ended {
        let dead = |error: String| Ended::Dead {
            status: None,
            error,
        };
        let Some(manifest) = self.host.manifest(&job.installation).await else {
            return dead("the installation's pinned release is not on this node".into());
        };
        let Ok(url) = url::Url::parse(&job.url) else {
            return dead("not a URL".into());
        };
        // An upgrade may have removed the operation since it was enqueued.
        let enqueued_by_a_route = manifest.http.as_ref().is_some_and(|h| {
            h.routes
                .iter()
                .any(|r| r.enqueues.iter().any(|e| e == &job.operation))
        });
        if !enqueued_by_a_route || !manifest.allows_delivery(&job.operation, &job.method, &url) {
            return dead(format!(
                "the pinned release no longer declares this delivery (operation `{}`)",
                job.operation
            ));
        }
        let mut headers: Vec<(String, String)> = job
            .headers
            .iter()
            .map(|(n, v)| (n.clone(), v.clone()))
            .collect();
        if let Some(sign) = &job.sign {
            let request = route_keys::SignRequest {
                key: sign.key.clone(),
                key_id: sign.key_id.clone(),
                operation: job.operation.clone(),
                request: route_keys::OutboundRequest {
                    method: job.method.clone(),
                    url: job.url.clone(),
                    body: job.body.clone(),
                },
                format: sign.format.clone(),
            };
            match route_keys::sign(
                &self.db,
                &job.installation,
                &manifest,
                &request,
                std::time::SystemTime::now(),
            ) {
                Ok((signed, _log)) => {
                    for (name, value) in signed["headers"].as_object().into_iter().flatten() {
                        if let Some(value) = value.as_str() {
                            headers.retain(|(n, _)| n != name);
                            headers.push((name.clone(), value.to_string()));
                        }
                    }
                }
                Err(e) => return dead(format!("could not sign: {e}")),
            }
        }
        let sent = self
            .transport
            .send(Outgoing {
                method: job.method.clone(),
                url,
                headers,
                body: job.body.clone().map(String::into_bytes),
            })
            .await;
        match sent {
            Sent::Answered {
                status,
                retry_after_ms,
            } => match judge(status) {
                Verdict::Delivered => Ended::Delivered(status),
                Verdict::Retry => Ended::Retry {
                    status: Some(status),
                    error: Some(format!("answered {status}")),
                    uncertain: false,
                    retry_after_ms: retry_after_ms.filter(|_| matches!(status, 429 | 503)),
                },
                Verdict::Dead => Ended::Dead {
                    status: Some(status),
                    error: if (300..400).contains(&status) {
                        format!("answered {status}; redirects are not followed")
                    } else {
                        format!("answered {status}")
                    },
                },
            },
            Sent::Failed {
                permanent: true,
                message,
                ..
            } => dead(message),
            Sent::Failed {
                uncertain, message, ..
            } => Ended::Retry {
                status: None,
                error: Some(message),
                uncertain,
                retry_after_ms: None,
            },
        }
    }

    async fn run(self, job: Job, now: i64) {
        let ended = self.send(&job).await;
        let host = job.host();
        let _guard = lock();
        let key = job_key(&job.installation, &job.id);
        // Dropped while it was sending (revoked): nothing to record.
        let Some(before) = read::<Job>(&self.db, &key) else {
            return;
        };
        let mut after = before.clone();
        match ended {
            Ended::Delivered(status) => {
                after.receipt(Receipt {
                    at: now,
                    status: Some(status),
                    error: None,
                    uncertain: false,
                });
                after.state = JobState::Delivered;
                after.settled_at = Some(now);
            }
            Ended::Dead { status, error } => {
                tracing::info!(
                    installation = job.installation,
                    operation = job.operation,
                    host,
                    "a plugin delivery failed for good: {error}"
                );
                after.receipt(Receipt {
                    at: now,
                    status,
                    error: Some(error),
                    uncertain: false,
                });
                after.state = JobState::Dead;
                after.settled_at = Some(now);
            }
            Ended::Retry {
                status,
                error,
                uncertain,
                retry_after_ms,
            } => {
                after.receipt(Receipt {
                    at: now,
                    status,
                    error: error.clone(),
                    uncertain,
                });
                let wait = jittered(backoff(after.attempts))
                    .max(retry_after_ms.unwrap_or(0).min(MAX_RETRY_AFTER_MS));
                if let Some(ms) = retry_after_ms {
                    let mut hosts = self.hosts.lock().unwrap_or_else(|e| e.into_inner());
                    let state = hosts.entry(host.clone()).or_default();
                    state.blocked_until = state
                        .blocked_until
                        .max(now + ms.clamp(0, MAX_RETRY_AFTER_MS));
                }
                let next_at = now + wait;
                if after.attempts >= MAX_ATTEMPTS {
                    after.receipt(Receipt {
                        at: now,
                        status: None,
                        error: Some(format!("gave up after {MAX_ATTEMPTS} attempts")),
                        uncertain: false,
                    });
                    after.state = JobState::Dead;
                    after.settled_at = Some(now);
                } else if next_at - after.enqueued_at > MAX_AGE_MS {
                    after.receipt(Receipt {
                        at: now,
                        status: None,
                        error: Some(format!(
                            "expired: not delivered within {} hours",
                            MAX_AGE_MS / HOUR_MS
                        )),
                        uncertain: false,
                    });
                    after.state = JobState::Dead;
                    after.settled_at = Some(now);
                } else {
                    after.state = JobState::Queued;
                    after.next_at = next_at;
                }
            }
        }
        if let Err(e) = apply(&self.db, &store_ops(Some(&before), &after))
            .and_then(|_| self.db.flush().map_err(|e| e.to_string()))
        {
            tracing::warn!(
                installation = job.installation,
                "could not record a plugin delivery: {e}"
            );
        }
    }
}

/// Forgets settled jobs, idempotency records and day counts past their time.
fn prune(db: &Db, now: i64) {
    let _guard = lock();
    let mut ops = Vec::new();
    for (key, value) in db
        .kv
        .scan_prefix(Tree::PluginMeta, SETTLED.as_bytes())
        .flatten()
    {
        if serde_json::from_slice::<Job>(&value)
            .map(|j| j.settled_at.unwrap_or(0) + KEEP_SETTLED_MS <= now)
            .unwrap_or(true)
        {
            ops.push(delete(key));
        }
    }
    for (key, value) in db
        .kv
        .scan_prefix(Tree::PluginMeta, IDEM.as_bytes())
        .flatten()
    {
        if serde_json::from_slice::<Idem>(&value)
            .map(|i| i.until.is_some_and(|until| until <= now))
            .unwrap_or(true)
        {
            ops.push(delete(key));
        }
    }
    let today = now.div_euclid(DAY_MS);
    for (key, _) in db
        .kv
        .scan_prefix(Tree::PluginMeta, DAY.as_bytes())
        .flatten()
    {
        let day = key
            .rsplit(|b| *b == 0)
            .next()
            .and_then(|d| std::str::from_utf8(d).ok()?.parse::<i64>().ok());
        if day.is_none_or(|d| d < today - 1) {
            ops.push(delete(key));
        }
    }
    if !ops.is_empty() {
        if let Err(e) = apply(db, &ops) {
            tracing::warn!("could not prune plugin deliveries: {e}");
        }
    }
}

// -- the node's queue ------------------------------------------------------------

/// Installations as the route registry sees them on this node.
pub struct RegistryHost {
    pub registry: Arc<super::route_registry::RouteRegistry>,
    pub db: Db,
}

#[async_trait::async_trait]
impl QueueHost for RegistryHost {
    async fn standing(&self, installation: &str) -> Standing {
        use super::route_registry::State;
        match self.registry.state(installation) {
            Some(State::Active) => Standing::Active,
            Some(State::Paused) | Some(State::Degraded(_)) => Standing::Held,
            Some(State::Retired { .. }) => Standing::Gone,
            // Not registered here: held while the installation exists.
            None => {
                use atomic_lib::Storelike;
                match self.db.get_resource(&installation.into()).await {
                    Ok(resource)
                        if resource
                            .get(atomic_lib::urls::INSTALLATION_STATUS)
                            .map(|s| s.to_string())
                            .ok()
                            .as_deref()
                            != Some(super::plugin::STATUS_REVOKED) =>
                    {
                        Standing::Held
                    }
                    _ => Standing::Gone,
                }
            }
        }
    }

    async fn manifest(&self, installation: &str) -> Option<Manifest> {
        use atomic_lib::Storelike;
        let resource = self.db.get_resource(&installation.into()).await.ok()?;
        super::route_registry::pinned_manifest(&self.db, &resource)
    }
}

/// Runs the worker: recovers after a restart, then sends what is due every
/// second, or as soon as something is enqueued. Only at `read-write`.
pub fn spawn(queue: Arc<DeliveryQueue>) {
    actix_web::rt::spawn(async move {
        let uncertain = queue.recover(atomic_lib::utils::now());
        if uncertain > 0 {
            tracing::warn!(
                "{uncertain} plugin deliveries were interrupted by a restart and will be retried"
            );
        }
        loop {
            let _ = queue.tick(atomic_lib::utils::now()).await;
            tokio::select! {
                _ = tokio::time::sleep(std::time::Duration::from_millis(TICK_MS)) => {}
                _ = queue.wake.notified() => {}
            }
        }
    });
}
