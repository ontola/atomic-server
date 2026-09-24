//! Running plugin routes: the `http` trigger (AS-05, design
//! `server-plugin-routes.md` in atomic-plugins, sections 2.1 and 2.5–2.8).
//!
//! A request the [`super::route_registry`] matched is admitted here (rate
//! limits, body, content type, a slot in the route pool), turned into a small
//! JSON request, and handed to the installation's pinned JS release as one
//! sandbox run with `trigger.kind: "http"`, which the runtime dispatches to
//! the exported `handle(ctx, request)`. The response it returns is validated
//! before anything is sent: allowlisted headers only, no HTML on a shared
//! host, `nosniff`, a size cap.
//!
//! What a route may *cause* is decided by the node's level. At `read-only` a
//! verdict with intents or enqueues is refused and nothing is applied. At
//! `read-write`, intents into the route's declared write targets are applied
//! under the Installation's route grant, within quotas, before the response
//! is sent ([`super::route_writes`], AS-07), and the deliveries it enqueues
//! into the route's declared `enqueues` are stored in the durable queue
//! ([`super::route_delivery`], AS-09), which sends them later. `auth: http-signature` and `auth: bearer` are verified by
//! [`super::route_auth`] before the sandbox starts (AS-08), and a failure is
//! a `401`; `auth: atomic`, `auth: dpop` and the `caller` principal still
//! answer `501` without starting it. At `read-write` a handler also gets the
//! host-held `ctx.keys` and `ctx.tokens` ([`super::route_keys`],
//! [`super::route_tokens`]).
//!
//! Runs happen on their own small runtime ([`pool`]), apart from the HTTP
//! workers and the job scheduler, so a flood of route requests cannot starve
//! either. Every request is counted for `readRouteStatus`
//! ([`RouteExecutor::status`]), and a sample of them is kept as a run log in
//! memory.

use std::{
    collections::{HashMap, VecDeque},
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex, OnceLock,
    },
    time::Duration,
};

use actix_web::{
    http::{
        header::{self, HeaderName, HeaderValue},
        StatusCode,
    },
    web, HttpRequest, HttpResponse,
};
use atomic_lib::{agents::ForAgent, db::app_agent::AppAgentKey, urls, Db, Storelike, Value};
use futures::StreamExt;
use serde_json::{json, Value as Json};

use super::{
    host_core::{self, PluginHost, ResourceGrants},
    js_runtime::{self, StoreHost},
    manifest::Manifest,
    manifest_http::{Auth, Body, Cors, Mount, Principal, Route},
    route_registry::{slug, Target},
};
use crate::{plugin_routes::PluginRoutesLevel, rate_limit::WriteRateLimiter};

// -- limits (design 2.8, all *proposed* there) --------------------------------

/// Wall-clock deadline without `timeoutMs`, and the most a route gets without
/// the `extended-fuel` grant.
pub const DEFAULT_TIMEOUT_MS: u64 = 3_000;
/// The most `timeoutMs` buys with `extended-fuel`.
pub const EXTENDED_TIMEOUT_MS: u64 = 30_000;
/// Inline request body without `maxBodyBytes`. The manifest caps
/// `maxBodyBytes` at 1 MiB (`manifest_http::MAX_INLINE_BODY_BYTES`).
pub const DEFAULT_BODY_BYTES: u64 = 256 * 1024;
/// Response body, and with `extended-memory`.
pub const RESPONSE_BYTES: usize = 1024 * 1024;
pub const EXTENDED_RESPONSE_BYTES: usize = 8 * 1024 * 1024;
/// `ctx.http` calls per request, and with `extended-fuel`. Only at
/// `read-write`, and only declared read operations.
pub const INLINE_READS: u32 = 2;
pub const EXTENDED_INLINE_READS: u32 = 4;
/// Requests of one installation running at once, and with `extended-fuel`.
pub const CONCURRENCY: usize = 8;
pub const EXTENDED_CONCURRENCY: usize = 32;
/// Route runs on the whole node at once.
pub const POOL_SLOTS: usize = 64;
/// Requests per minute to one installation, from anywhere.
pub const INSTALLATION_PER_MINUTE: u32 = 600;
/// Requests per minute to one installation from one remote address.
pub const REMOTE_PER_MINUTE: u32 = 120;

/// How many run-log entries an installation keeps, and one in how many 2xx
/// responses is logged (every other status is).
const RUN_LOG: usize = 50;
const SAMPLE_2XX: u64 = 10;

/// Request headers a handler sees. Everything else is dropped before the
/// sandbox, including every `x-atomic-*` header and `authorization`.
const REQUEST_HEADERS: [&str; 15] = [
    "accept",
    "accept-language",
    "content-digest",
    "content-length",
    "content-type",
    "date",
    "digest",
    "if-match",
    "if-modified-since",
    "if-none-match",
    "if-unmodified-since",
    "origin",
    "signature",
    "signature-input",
    "user-agent",
];

/// Response headers a handler may set (design 2.7). CORS headers only as
/// declared; `location` only to the same host.
const RESPONSE_HEADERS: [&str; 9] = [
    "cache-control",
    "content-type",
    "etag",
    "last-modified",
    "link",
    "location",
    "retry-after",
    "vary",
    "www-authenticate",
];

/// What a handler may add under `cors: any-origin-no-credentials`.
/// `access-control-allow-origin` is always `*`, set by the host.
const CORS_HEADERS: [&str; 4] = [
    "access-control-allow-headers",
    "access-control-allow-methods",
    "access-control-expose-headers",
    "access-control-max-age",
];

/// Content types that a browser runs as a document. Refused on a shared host
/// (`drive-prefix`), which carries the API origin's cookies.
const DOCUMENT_TYPES: [&str; 3] = ["text/html", "application/xhtml+xml", "image/svg+xml"];

/// The CORS headers a plugin route answers with, attached to its response.
/// The server's own CORS layer adds headers to every response; the
/// `credentials_gate` middleware replaces them with exactly these on a
/// response that carries this marker, so a route is only as cross-origin as
/// it declared.
#[derive(Clone, Debug, Default)]
pub struct RouteCors(pub Vec<(HeaderName, HeaderValue)>);

impl RouteCors {
    pub fn declared(cors: Cors) -> Self {
        match cors {
            Cors::None => Self::default(),
            Cors::AnyOriginNoCredentials => Self(vec![(
                header::ACCESS_CONTROL_ALLOW_ORIGIN,
                HeaderValue::from_static("*"),
            )]),
        }
    }

    /// Replaces every `access-control-*` header with the declared ones.
    pub fn apply(&self, headers: &mut actix_web::http::header::HeaderMap) {
        let names: Vec<HeaderName> = headers
            .keys()
            .filter(|n| n.as_str().starts_with("access-control-"))
            .cloned()
            .collect();
        for name in names {
            headers.remove(name);
        }
        for (name, value) in &self.0 {
            headers.append(name.clone(), value.clone());
        }
    }
}

/// The runtime route runs execute on: a few threads of their own.
fn pool() -> &'static tokio::runtime::Runtime {
    static POOL: OnceLock<tokio::runtime::Runtime> = OnceLock::new();
    POOL.get_or_init(|| {
        let threads = std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(2)
            .clamp(2, 4);
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(threads)
            .thread_name("plugin-routes")
            .enable_all()
            .build()
            .expect("could not start the plugin route pool")
    })
}

/// A taken slot, given back on drop.
struct Slot(Arc<AtomicUsize>);

impl Slot {
    fn take(counter: &Arc<AtomicUsize>, max: usize) -> Option<Self> {
        counter
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |n| {
                (n < max).then_some(n + 1)
            })
            .ok()
            .map(|_| Slot(counter.clone()))
    }
}

impl Drop for Slot {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}

/// One entry of an installation's sampled run log.
#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunEntry {
    pub at: i64,
    pub route: String,
    pub method: String,
    pub status: u16,
    pub duration_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fuel: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub problems: Vec<String>,
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LastError {
    pub at: i64,
    pub status: u16,
    pub message: String,
}

const HOUR_MS: i64 = 60 * 60 * 1000;

#[derive(Default)]
struct RouteStats {
    /// `(hour, requests, errors)`, oldest first, at most 24 hours.
    hours: VecDeque<(i64, u64, u64)>,
    last_error: Option<LastError>,
}

impl RouteStats {
    fn count(&mut self, at: i64, error: bool) {
        let hour = at.div_euclid(HOUR_MS);
        match self.hours.back_mut() {
            Some((h, requests, errors)) if *h == hour => {
                *requests += 1;
                *errors += u64::from(error);
            }
            _ => self.hours.push_back((hour, 1, u64::from(error))),
        }
        while self.hours.len() > 24 {
            self.hours.pop_front();
        }
    }

    fn last_day(&self, now: i64) -> (u64, u64) {
        let since = now.div_euclid(HOUR_MS) - 23;
        self.hours
            .iter()
            .filter(|(h, _, _)| *h >= since)
            .fold((0, 0), |(r, e), (_, requests, errors)| {
                (r + requests, e + errors)
            })
    }
}

#[derive(Default)]
struct InstallationStats {
    routes: HashMap<String, RouteStats>,
    log: VecDeque<RunEntry>,
    ok_seen: u64,
}

/// Admission and bookkeeping for plugin route runs. One per `AppState`.
pub struct RouteExecutor {
    pool: Arc<AtomicUsize>,
    running: Mutex<HashMap<String, Arc<AtomicUsize>>>,
    /// Per installation (the "agent" budget, keyed by slug) and per remote
    /// address and installation (the "anonymous" budget).
    rate: WriteRateLimiter,
    stats: Mutex<HashMap<String, InstallationStats>>,
    /// Route write quotas (AS-07); see [`super::route_writes`].
    pub quotas: super::route_writes::QuotaLedger,
    /// Remote callers' signing keys, cached per installation (AS-08).
    pub keys: super::route_auth::KeyResolver,
    /// Consent requests and codes for route tokens (AS-08).
    pub consents: Arc<super::route_tokens::Consents>,
}

impl Default for RouteExecutor {
    fn default() -> Self {
        Self::new(INSTALLATION_PER_MINUTE, REMOTE_PER_MINUTE)
    }
}

impl RouteExecutor {
    pub fn new(installation_per_minute: u32, remote_per_minute: u32) -> Self {
        Self {
            pool: Arc::new(AtomicUsize::new(0)),
            running: Mutex::new(HashMap::new()),
            rate: WriteRateLimiter::new(installation_per_minute, remote_per_minute),
            stats: Mutex::new(HashMap::new()),
            quotas: Default::default(),
            keys: Default::default(),
            consents: Default::default(),
        }
    }

    /// This executor with another way to fetch remote keys (tests).
    pub fn with_key_fetch(mut self, fetch: Arc<dyn super::route_auth::KeyFetch>) -> Self {
        self.keys = super::route_auth::KeyResolver::new(fetch);
        self
    }

    /// This executor with these route write quotas.
    pub fn with_quotas(mut self, quotas: super::route_writes::Quotas) -> Self {
        self.quotas = super::route_writes::QuotaLedger::new(quotas);
        self
    }

    fn running(&self, installation: &str) -> Arc<AtomicUsize> {
        self.running
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .entry(installation.to_string())
            .or_default()
            .clone()
    }

    fn record(&self, installation: &str, entry: RunEntry) {
        let mut stats = self.stats.lock().unwrap_or_else(|e| e.into_inner());
        let stats = stats.entry(installation.to_string()).or_default();
        let error = entry.status >= 500;
        let route = stats.routes.entry(entry.route.clone()).or_default();
        route.count(entry.at, error);
        if error {
            route.last_error = Some(LastError {
                at: entry.at,
                status: entry.status,
                message: entry
                    .error
                    .clone()
                    .unwrap_or_else(|| format!("answered {}", entry.status)),
            });
        }
        // A run in which the host signed with an installation key is always
        // kept: every signature is logged with its operation id (2.7).
        let signed = entry
            .problems
            .iter()
            .any(|p| p.starts_with(super::route_keys::SIGNED_LOG_PREFIX));
        let sampled = if (200..300).contains(&entry.status) && !signed {
            stats.ok_seen += 1;
            (stats.ok_seen - 1).is_multiple_of(SAMPLE_2XX)
        } else {
            true
        };
        if sampled {
            stats.log.push_back(entry);
            while stats.log.len() > RUN_LOG {
                stats.log.pop_front();
            }
        }
    }

    /// `readRouteStatus`: per route, 24 h request and error counts and the
    /// last error; the sampled run log, newest first. The queue fields are
    /// `null` here; the status endpoint fills them from the delivery queue
    /// ([`super::route_delivery::status`]).
    pub fn status(&self, installation: &str, routes: &[(String, String)], now: i64) -> Json {
        let stats = self.stats.lock().unwrap_or_else(|e| e.into_inner());
        let stats = stats.get(installation);
        let routes: Vec<Json> = routes
            .iter()
            .map(|(id, url)| {
                let route = stats.and_then(|s| s.routes.get(id));
                let (requests, errors) = route.map(|r| r.last_day(now)).unwrap_or((0, 0));
                json!({
                    "id": id,
                    "url": url,
                    "requests24h": requests,
                    "errors24h": errors,
                    "lastError": route.and_then(|r| r.last_error.clone()),
                    "queueDepth": null,
                    "oldestQueueFailure": null,
                })
            })
            .collect();
        let log: Vec<&RunEntry> = stats
            .map(|s| s.log.iter().rev().collect())
            .unwrap_or_default();
        json!({ "routes": routes, "runs": log })
    }
}

// -- responses ----------------------------------------------------------------

/// A problem answer from the host (never from the plugin).
fn problem(status: StatusCode, kind: &str, title: &str, detail: &str) -> HttpResponse {
    HttpResponse::build(status)
        .content_type("application/problem+json")
        .insert_header((header::CACHE_CONTROL, "no-store"))
        .insert_header((header::X_CONTENT_TYPE_OPTIONS, "nosniff"))
        .body(
            json!({
                "type": kind,
                "status": status.as_u16(),
                "title": title,
                "detail": detail,
            })
            .to_string(),
        )
}

/// What a request ended as: the response and what the run log keeps.
struct Outcome {
    response: HttpResponse,
    error: Option<String>,
    problems: Vec<String>,
    fuel: Option<u64>,
}

impl From<HttpResponse> for Outcome {
    fn from(response: HttpResponse) -> Self {
        Self {
            response,
            error: None,
            problems: Vec::new(),
            fuel: None,
        }
    }
}

impl Outcome {
    fn failed(response: HttpResponse, error: impl Into<String>) -> Self {
        Self {
            error: Some(error.into()),
            ..Self::from(response)
        }
    }
}

/// The rules a handler's response is held to.
pub struct ResponseRules<'a> {
    /// `drive-prefix`: the API origin's host, with its cookies.
    pub shared_host: bool,
    /// The request's `Host`, for `location`.
    pub host: &'a str,
    pub cors: Cors,
    pub max_bytes: usize,
    pub head: bool,
    /// A `location` on another host is allowed when it starts with this:
    /// the host's consent page, which a route redirects to (D6).
    pub consent_page: Option<String>,
}

/// A validated response, and the headers that were dropped from it.
#[derive(Debug)]
pub struct Built {
    pub status: StatusCode,
    pub headers: Vec<(HeaderName, HeaderValue)>,
    pub body: Vec<u8>,
    pub dropped: Vec<String>,
}

fn same_host(location: &str, host: &str) -> bool {
    if location.starts_with('/') {
        return !location.starts_with("//") && !location.starts_with("/\\");
    }
    url::Url::parse(location).is_ok_and(|u| {
        matches!(u.scheme(), "http" | "https")
            && u.host_str().is_some_and(|h| {
                let authority = match u.port() {
                    Some(port) => format!("{h}:{port}"),
                    None => h.to_string(),
                };
                authority.eq_ignore_ascii_case(host.trim())
                    || (u.port().is_none()
                        && host
                            .rsplit_once(':')
                            .is_some_and(|(name, _)| name.eq_ignore_ascii_case(h)))
            })
    })
}

/// Builds the HTTP response from a handler's `response`, or says why it is
/// refused. Headers outside the allowlist are dropped, not refused.
pub fn build_response(response: &Json, rules: &ResponseRules) -> Result<Built, String> {
    let object = response
        .as_object()
        .ok_or("handle() returned no response object")?;
    let status = match object.get("status") {
        None | Some(Json::Null) => 200,
        Some(value) => value
            .as_u64()
            .filter(|s| (200..=599).contains(s))
            .ok_or_else(|| format!("status {value} is not an HTTP status from 200 to 599"))?,
    };
    let status = StatusCode::from_u16(status as u16).map_err(|e| e.to_string())?;

    let mut headers = Vec::new();
    let mut dropped = Vec::new();
    let mut content_type = None;
    match object.get("headers") {
        None | Some(Json::Null) => {}
        Some(Json::Object(map)) => {
            for (name, value) in map {
                let lower = name.to_ascii_lowercase();
                let value = match value {
                    Json::String(s) => s.clone(),
                    Json::Number(n) => n.to_string(),
                    _ => {
                        dropped.push(lower);
                        continue;
                    }
                };
                let allowed = RESPONSE_HEADERS.contains(&lower.as_str())
                    || (rules.cors == Cors::AnyOriginNoCredentials
                        && CORS_HEADERS.contains(&lower.as_str()));
                let location_ok = same_host(&value, rules.host)
                    || rules
                        .consent_page
                        .as_deref()
                        .is_some_and(|page| value.starts_with(page));
                if !allowed || (lower == "location" && !location_ok) {
                    dropped.push(lower);
                    continue;
                }
                let (Ok(name), Ok(value)) = (
                    HeaderName::from_bytes(lower.as_bytes()),
                    HeaderValue::from_str(&value),
                ) else {
                    dropped.push(lower);
                    continue;
                };
                if name == header::CONTENT_TYPE {
                    content_type = Some(value.to_str().unwrap_or("").to_string());
                    continue;
                }
                headers.push((name, value));
            }
        }
        Some(_) => return Err("response headers must be an object".into()),
    }

    let (body, default_type) = match object.get("body") {
        None | Some(Json::Null) => (Vec::new(), None),
        Some(Json::String(s)) => (s.clone().into_bytes(), Some("text/plain; charset=utf-8")),
        Some(other) => (
            serde_json::to_vec(other).map_err(|e| e.to_string())?,
            Some("application/json"),
        ),
    };
    if body.len() > rules.max_bytes {
        return Err(format!(
            "the response body is {} bytes, more than this route's {} byte limit",
            body.len(),
            rules.max_bytes
        ));
    }
    let content_type = content_type.or(default_type.map(str::to_string));
    if let Some(content_type) = &content_type {
        let essence = content_type
            .split(';')
            .next()
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase();
        if rules.shared_host && DOCUMENT_TYPES.contains(&essence.as_str()) {
            return Err(format!(
                "`{essence}` is not served on a shared host (the `drive-prefix` mount); use the `installation-origin` mount"
            ));
        }
        headers.push((
            header::CONTENT_TYPE,
            HeaderValue::from_str(content_type).map_err(|e| e.to_string())?,
        ));
    }
    headers.push((
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    ));
    if rules.shared_host {
        headers.push((
            header::CONTENT_SECURITY_POLICY,
            HeaderValue::from_static("default-src 'none'; sandbox"),
        ));
    }
    Ok(Built {
        status,
        headers,
        body: if rules.head { Vec::new() } else { body },
        dropped,
    })
}

// -- requests -----------------------------------------------------------------

/// `{name}` and `{*name}` values of `path` against the route's pattern,
/// percent-decoded.
pub fn params(pattern: &str, path: &str) -> serde_json::Map<String, Json> {
    let decode = |s: &str| {
        percent_encoding::percent_decode_str(s)
            .decode_utf8_lossy()
            .into_owned()
    };
    let request: Vec<&str> = path
        .strip_prefix('/')
        .filter(|p| !p.is_empty())
        .map(|p| p.split('/').collect())
        .unwrap_or_default();
    let mut out = serde_json::Map::new();
    for (i, segment) in pattern
        .strip_prefix('/')
        .unwrap_or(pattern)
        .split('/')
        .filter(|s| !s.is_empty())
        .enumerate()
    {
        if let Some(name) = segment.strip_prefix("{*").and_then(|s| s.strip_suffix('}')) {
            let rest = request.get(i..).unwrap_or_default().join("/");
            out.insert(name.into(), Json::String(decode(&rest)));
            break;
        }
        if let Some(name) = segment.strip_prefix('{').and_then(|s| s.strip_suffix('}')) {
            if let Some(value) = request.get(i) {
                out.insert(name.into(), Json::String(decode(value)));
            }
        }
    }
    out
}

/// The query string as an object; a repeated key becomes an array.
fn query(raw: &str) -> serde_json::Map<String, Json> {
    let mut out = serde_json::Map::new();
    for (key, value) in url::form_urlencoded::parse(raw.as_bytes()) {
        let value = Json::String(value.into_owned());
        match out.get_mut(key.as_ref()) {
            None => {
                out.insert(key.into_owned(), value);
            }
            Some(Json::Array(values)) => values.push(value),
            Some(existing) => *existing = Json::Array(vec![existing.take(), value]),
        }
    }
    out
}

/// The allowlisted request headers, lowercased; repeats joined with `, `.
/// On `installation-origin` the handler also gets `cookie`: that origin is
/// the installation's own. Never on a shared host.
pub fn request_headers(req: &HttpRequest, shared_host: bool) -> serde_json::Map<String, Json> {
    let mut out = serde_json::Map::new();
    for (name, value) in req.headers() {
        let name = name.as_str();
        if !(REQUEST_HEADERS.contains(&name) || (!shared_host && name == "cookie")) {
            continue;
        }
        let Ok(value) = value.to_str() else { continue };
        match out.get_mut(name) {
            Some(Json::String(existing)) => {
                existing.push_str(", ");
                existing.push_str(value);
            }
            _ => {
                out.insert(name.into(), Json::String(value.into()));
            }
        }
    }
    out
}

fn content_length(req: &HttpRequest) -> Option<u64> {
    req.headers()
        .get(header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.trim().parse().ok())
}

fn has_body(req: &HttpRequest) -> bool {
    content_length(req).is_some_and(|n| n > 0)
        || req.headers().contains_key(header::TRANSFER_ENCODING)
}

fn essence(req: &HttpRequest) -> String {
    req.headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.split(';').next())
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase()
}

/// Reads the body, refusing it as soon as it passes `limit`.
async fn read_body(mut payload: web::Payload, limit: u64) -> Result<Vec<u8>, HttpResponse> {
    let mut body = Vec::new();
    while let Some(chunk) = payload.next().await {
        let chunk = chunk.map_err(|e| {
            problem(
                StatusCode::BAD_REQUEST,
                "route-body-unreadable",
                "The request body could not be read",
                &e.to_string(),
            )
        })?;
        if (body.len() + chunk.len()) as u64 > limit {
            return Err(too_large(limit));
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

fn too_large(limit: u64) -> HttpResponse {
    problem(
        StatusCode::PAYLOAD_TOO_LARGE,
        "route-body-too-large",
        "The request body is too large",
        &format!("This route accepts at most {limit} bytes."),
    )
}

// -- the host a route runs against ---------------------------------------------

/// A [`StoreHost`] narrowed for one route request: reads as the route's
/// principal, no integration actions, and `ctx.http` only at `read-write`,
/// only for declared read operations, at most a few per request.
struct RouteHost {
    inner: StoreHost,
    grants: ResourceGrants,
    fetches: bool,
    reads_left: u32,
    /// `ctx.keys.*` and `ctx.tokens.*`: only at `read-write`, where a
    /// release that declares keys or tokens can be installed at all.
    crypto: Option<super::route_auth::CryptoHost>,
}

#[async_trait::async_trait]
impl PluginHost for RouteHost {
    async fn fetch(&mut self, request: String) -> Result<String, String> {
        if !self.fetches {
            return Err(
                "at `--plugin-routes read-only` a route cannot make outbound requests".into(),
            );
        }
        if self.reads_left == 0 {
            return Err(
                "this route already made as many ctx.http calls as a request allows".into(),
            );
        }
        self.reads_left -= 1;
        self.inner.request(request, "read").await
    }

    async fn get_resource(&mut self, subject: String) -> Result<String, String> {
        self.inner.get_resource(subject).await
    }

    async fn query(&mut self, property: String, value: String) -> Result<String, String> {
        self.inner.query(property, value).await
    }

    async fn resource_grants(&mut self) -> ResourceGrants {
        self.grants
    }

    async fn host_call(&mut self, name: String, request: String) -> Result<String, String> {
        match &self.crypto {
            Some(crypto) => crypto.call(&name, &request).await,
            None => Err(
                "keys and tokens are only available to routes at `--plugin-routes read-write`"
                    .into(),
            ),
        }
    }
}

// -- execution ----------------------------------------------------------------

/// The installation's pinned release, as far as one route needs it.
struct Loaded {
    drive: String,
    source: String,
    manifest: Manifest,
    route: Route,
    config: Json,
    /// The Installation's `grants`, for the route grant.
    grants: Json,
}

fn text(resource: &atomic_lib::Resource, property: &str) -> Option<String> {
    match resource.get(property).ok()? {
        Value::String(s) | Value::Markdown(s) => Some(s.clone()),
        Value::AtomicUrl(s) => Some(s.to_string()),
        other => Some(other.to_string()),
    }
}

async fn load(store: &Db, installation: &str, route: &str) -> Result<Loaded, String> {
    let resource = store
        .get_resource(&installation.into())
        .await
        .map_err(|e| format!("the installation could not be read: {e}"))?;
    let drive = text(&resource, urls::PARENT).ok_or("the installation has no drive")?;
    let id = text(&resource, urls::RELEASE_ID).ok_or("the installation pins no release")?;
    let release = store
        .get_plugin_release(&id)
        .map_err(|e| format!("the pinned release is not on this node: {e}"))?;
    let source = release
        .source
        .ok_or("the pinned release is not a JS release")?;
    let manifest =
        Manifest::parse(release.manifest)?.ok_or("the pinned release has no manifest")?;
    let route = manifest
        .http
        .as_ref()
        .and_then(|http| http.routes.iter().find(|r| r.id == route))
        .cloned()
        .ok_or_else(|| format!("the pinned release has no route `{route}`"))?;
    let config = match resource.get(urls::CONFIG) {
        Ok(Value::Json(json)) => json.clone(),
        Ok(Value::String(s)) => serde_json::from_str(s).unwrap_or(Json::Null),
        _ => Json::Null,
    };
    let grants = match resource.get(urls::GRANTS) {
        Ok(Value::Json(json)) => json.clone(),
        Ok(Value::String(s)) => serde_json::from_str(s).unwrap_or(Json::Null),
        _ => Json::Null,
    };
    Ok(Loaded {
        drive,
        source,
        manifest,
        route,
        config,
        grants,
    })
}

/// One matched request to a plugin route, end to end: a route's own path,
/// or a `/.well-known/` claim ([`Target::well_known`]) that names the route.
pub async fn execute(
    appstate: &crate::appstate::AppState,
    req: &HttpRequest,
    payload: web::Payload,
    target: &Target,
) -> HttpResponse {
    let executor = &appstate.route_exec;
    let started = std::time::Instant::now();
    let at = atomic_lib::utils::now();
    let mut cors = RouteCors::default();
    let installation = target.installation.as_str();
    let route_id = target.route.as_str();
    let outcome = run(appstate, req, payload, target, at, &mut cors).await;
    let mut response = outcome.response;
    executor.record(
        installation,
        RunEntry {
            at,
            route: route_id.to_string(),
            method: req.method().to_string(),
            status: response.status().as_u16(),
            duration_ms: started.elapsed().as_millis() as u64,
            fuel: outcome.fuel,
            error: outcome.error,
            problems: outcome.problems,
        },
    );
    response.extensions_mut().insert(cors);
    response
}

async fn run(
    appstate: &crate::appstate::AppState,
    req: &HttpRequest,
    payload: web::Payload,
    target: &Target,
    at: i64,
    cors: &mut RouteCors,
) -> Outcome {
    let Target {
        installation,
        mount,
        path,
        route: route_id,
        well_known,
    } = target;
    let (installation, mount, path) = (installation.as_str(), *mount, path.as_str());
    let executor = &appstate.route_exec;
    let store = &appstate.store;
    let level = appstate.route_registry.config().level();
    let slug = slug(installation);
    let shared_host = mount != Mount::InstallationOrigin;

    // Rate limits first: a flood costs a lookup, nothing more.
    let remote = crate::helpers::peer_ip(req);
    if let Err(limited) = executor
        .rate
        .check(&slug, false)
        .and_then(|_| executor.rate.check(&format!("{slug} {remote}"), true))
    {
        let mut response = problem(
            StatusCode::TOO_MANY_REQUESTS,
            "route-rate-limited",
            "Too many requests",
            "This plugin route is receiving more requests than it may answer. Try again later.",
        );
        response.headers_mut().insert(
            header::RETRY_AFTER,
            HeaderValue::from(limited.retry_after_secs),
        );
        return response.into();
    }

    let loaded = match load(store, installation, route_id).await {
        Ok(loaded) => loaded,
        Err(e) => {
            return Outcome::failed(
                problem(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "route-unavailable",
                    "This plugin route cannot run",
                    "The plugin that serves this URL could not be loaded on this server.",
                ),
                e,
            )
        }
    };
    let route = &loaded.route;
    *cors = RouteCors::declared(route.cors);

    // Authentication (design 2.5, AS-08). `bearer` and `http-signature` are
    // verified below. `atomic` (and with it the `caller` principal) needs
    // Atomic request signatures bound to the method and body (v2, #1696),
    // which this server does not have yet; `dpop` is phase 3. Never run a
    // handler that expects a caller this host cannot verify.
    if matches!(route.auth, Auth::Atomic | Auth::Dpop) || route.principal == Principal::Caller {
        return problem(
            StatusCode::NOT_IMPLEMENTED,
            "route-auth-unavailable",
            "This plugin route needs authentication this server cannot verify yet",
            "Routes with `auth: atomic` or `auth: dpop`, or the `caller` principal, are not served by this server version.",
        )
        .into();
    }
    // A bearer token costs a lookup, so it is checked before the body is
    // read. A signature needs the body for its digest: below.
    let mut caller = Json::Null;
    if route.auth == Auth::Bearer {
        match super::route_auth::verify_bearer(store, installation, req, at) {
            Ok(verified) => caller = verified,
            Err(refused) => return unauthorized(route.auth, &slug, refused),
        }
    }
    let for_agent = match route.principal {
        Principal::Anonymous => ForAgent::Public,
        Principal::Installation => {
            match store.get_app_agent_info(&AppAgentKey::new(&loaded.drive, installation)) {
                Ok(Some(info)) => ForAgent::AgentSubject(info.agent.into()),
                _ => {
                    return Outcome::failed(
                        problem(
                            StatusCode::SERVICE_UNAVAILABLE,
                            "route-unavailable",
                            "This plugin route cannot run",
                            "The plugin's identity on this server is missing.",
                        ),
                        "the installation has no agent to act as",
                    )
                }
            }
        }
        Principal::Caller => unreachable!("refused above"),
    };

    // Body admission, before the pool: an oversized upload never costs a slot.
    let body = match route.body {
        None if has_body(req) => {
            return problem(
                StatusCode::PAYLOAD_TOO_LARGE,
                "route-body-not-accepted",
                "This route takes no request body",
                "Send the request without a body.",
            )
            .into()
        }
        None => None,
        Some(Body::Blob) => {
            return problem(
                StatusCode::NOT_IMPLEMENTED,
                "route-blob-unavailable",
                "Blob request bodies are not supported yet",
                "Routes with `body: blob` are not served by this server version.",
            )
            .into()
        }
        Some(kind) => {
            let content_type = essence(req);
            let type_ok = match kind {
                Body::Json => content_type == "application/json" || content_type.ends_with("+json"),
                _ => true,
            } && (route.accept.is_empty()
                || route
                    .accept
                    .iter()
                    .any(|a| a.eq_ignore_ascii_case(&content_type)));
            if !type_ok {
                return problem(
                    StatusCode::UNSUPPORTED_MEDIA_TYPE,
                    "route-unsupported-media-type",
                    "Unsupported content type",
                    &format!("This route does not accept `{content_type}`."),
                )
                .into();
            }
            let limit = route.max_body_bytes.unwrap_or(DEFAULT_BODY_BYTES);
            if content_length(req).is_some_and(|n| n > limit) {
                return too_large(limit).into();
            }
            let bytes = match read_body(payload, limit).await {
                Ok(bytes) => bytes,
                Err(response) => return response.into(),
            };
            let Ok(text) = String::from_utf8(bytes) else {
                return problem(
                    StatusCode::BAD_REQUEST,
                    "route-body-invalid",
                    "The request body is not UTF-8 text",
                    "This route takes a text or JSON body.",
                )
                .into();
            };
            if kind == Body::Json && serde_json::from_str::<Json>(&text).is_err() {
                return problem(
                    StatusCode::BAD_REQUEST,
                    "route-body-invalid",
                    "The request body is not JSON",
                    "This route takes a JSON body.",
                )
                .into();
            }
            Some(text)
        }
    };

    // Verified before the pool: a flood of bad signatures costs no slot
    // and no fuel, and a stale or unbound one not even a key fetch.
    if route.auth == Auth::HttpSignature {
        let parts = super::route_auth::RequestParts::of(req);
        match super::route_auth::verify_signature(
            &executor.keys,
            store,
            installation,
            &parts,
            body.as_deref().unwrap_or("").as_bytes(),
            at,
        )
        .await
        {
            Ok(verified) => caller = verified,
            Err(refused) => return unauthorized(route.auth, &slug, refused),
        }
    }
    // Per verified caller, like per remote address above.
    let caller_key = caller["owner"]
        .as_str()
        .or_else(|| caller["token"]["id"].as_str());
    if let Some(key) = caller_key {
        if let Err(limited) = executor.rate.check(&format!("{slug} caller {key}"), true) {
            let mut response = problem(
                StatusCode::TOO_MANY_REQUESTS,
                "route-rate-limited",
                "Too many requests",
                "This caller is sending this plugin route more requests than it may answer. Try again later.",
            );
            response.headers_mut().insert(
                header::RETRY_AFTER,
                HeaderValue::from(limited.retry_after_secs),
            );
            return response.into();
        }
    }

    let grants =
        host_core::installation_grants(store, &loaded.drive, installation, Some(&loaded.manifest))
            .await;
    let busy = |detail: &str| {
        let mut response = problem(
            StatusCode::SERVICE_UNAVAILABLE,
            "route-busy",
            "This plugin route is busy",
            detail,
        );
        response
            .headers_mut()
            .insert(header::RETRY_AFTER, HeaderValue::from_static("1"));
        Outcome::from(response)
    };
    let Some(_pool_slot) = Slot::take(&executor.pool, POOL_SLOTS) else {
        return busy("This server is answering as many plugin route requests as it can.");
    };
    let concurrency = if grants.extended_fuel {
        EXTENDED_CONCURRENCY
    } else {
        CONCURRENCY
    };
    let Some(_slot) = Slot::take(&executor.running(installation), concurrency) else {
        return busy("This plugin is answering as many requests as it may at once.");
    };

    // A claim's path is `/.well-known/<name>`, not the route's pattern:
    // there are no params, and the handler is told which name it answers.
    let params = match well_known {
        Some(_) => serde_json::Map::new(),
        None => params(&route.path, path),
    };
    // Where this request reached the installation: `url` as the client
    // addressed it, `base` the installation's root on that host. A plugin
    // needs them for ids it publishes (an actor, a `keyId`).
    let origin = {
        let info = req.connection_info();
        format!("{}://{}", info.scheme(), info.host())
    };
    let base = match mount {
        Mount::DrivePrefix => format!(
            "{origin}/{}/{slug}",
            atomic_lib::subject::PLUGIN_ROUTES_SEGMENT
        ),
        _ => origin.clone(),
    };
    let url = format!(
        "{origin}{}",
        req.uri()
            .path_and_query()
            .map(|p| p.as_str())
            .unwrap_or("/")
    );
    let request = json!({
        "method": req.method().as_str(),
        "path": path,
        "url": url,
        "base": base,
        "wellKnown": well_known,
        "params": params,
        "query": query(req.query_string()),
        "headers": request_headers(req, shared_host),
        "body": body,
        "caller": caller,
        "receivedAt": at,
    });
    let request_id = format!("http:{}", ulid::Ulid::new().to_string().to_lowercase());
    let input = json!({
        "trigger": {
            "kind": "http",
            "id": request_id,
            "at": at,
            "route": route.id,
            "request": request,
        },
        "config": loaded.config,
    })
    .to_string();

    // Every signature the host makes for this request, for the run log.
    let signed: Arc<Mutex<Vec<String>>> = Default::default();
    let host = RouteHost {
        inner: StoreHost {
            db: Arc::new(store.clone()),
            plugin: installation.to_string(),
            drive: loaded.drive.clone(),
            for_agent,
            manifest: Some(loaded.manifest.clone()),
        },
        grants,
        fetches: level >= PluginRoutesLevel::ReadWrite,
        reads_left: if grants.extended_fuel {
            EXTENDED_INLINE_READS
        } else {
            INLINE_READS
        },
        crypto: (level >= PluginRoutesLevel::ReadWrite).then(|| super::route_auth::CryptoHost {
            db: Arc::new(store.clone()),
            installation: installation.to_string(),
            manifest: loaded.manifest.clone(),
            registry: appstate.route_registry.clone(),
            consents: executor.consents.clone(),
            base: base.clone(),
            api_origin: appstate.config.get_origin(),
            log: signed.clone(),
            now: at,
        }),
    };
    let deadline = route
        .timeout_ms
        .unwrap_or(DEFAULT_TIMEOUT_MS)
        .min(if grants.extended_fuel {
            EXTENDED_TIMEOUT_MS
        } else {
            DEFAULT_TIMEOUT_MS
        });
    let runtime = match js_runtime::embedded_runtime() {
        Ok(runtime) => runtime,
        Err(e) => {
            return Outcome::failed(
                problem(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "route-unavailable",
                    "This plugin route cannot run",
                    "This server cannot run plugins.",
                ),
                e.to_string(),
            )
        }
    };
    let source = loaded.source.clone();
    let joined = pool()
        .spawn(async move {
            tokio::time::timeout(
                Duration::from_millis(deadline),
                runtime.run_route(&source, &input, host),
            )
            .await
        })
        .await;

    let run = match joined {
        Err(e) => {
            return Outcome::failed(
                problem(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "route-host-error",
                    "The server failed while running this route",
                    "See the server log.",
                ),
                format!("the route run panicked: {e}"),
            )
        }
        Ok(Err(_elapsed)) => {
            return Outcome::failed(
                problem(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "route-deadline-exceeded",
                    "This plugin route took too long",
                    &format!("The handler did not answer within {deadline} ms."),
                ),
                format!("the handler did not answer within {deadline} ms"),
            )
        }
        Ok(Ok(Err(e))) => {
            return Outcome::failed(
                problem(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "route-unavailable",
                    "This plugin route cannot run",
                    "The plugin runtime could not start.",
                ),
                e.to_string(),
            )
        }
        Ok(Ok(Ok(run))) => run,
    };
    tracing::debug!(
        installation,
        route = route.id,
        instantiate_us = run.instantiate.as_micros() as u64,
        total_us = run.total.as_micros() as u64,
        fuel = run.fuel_used,
        "plugin route run"
    );
    let fuel = Some(run.fuel_used);
    let verdict = match run.outcome {
        Err(stopped) if stopped.exhausted => {
            return Outcome {
                fuel,
                ..Outcome::failed(
                    problem(
                        StatusCode::SERVICE_UNAVAILABLE,
                        "route-resources-exhausted",
                        "This plugin route ran out of resources",
                        "The handler used more computation or memory than a request may.",
                    ),
                    stopped.message,
                )
            }
        }
        Err(stopped) => {
            return Outcome {
                fuel,
                ..Outcome::failed(handler_failed(), stopped.message)
            }
        }
        Ok(verdict) => verdict,
    };
    let verdict: Json = match serde_json::from_str(&verdict) {
        Ok(verdict) => verdict,
        Err(e) => {
            return Outcome {
                fuel,
                ..Outcome::failed(handler_failed(), format!("the verdict is not JSON: {e}"))
            }
        }
    };
    let problems: Vec<String> = verdict["problems"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|p| {
            p["message"]
                .as_str()
                .map(str::to_string)
                .unwrap_or_else(|| p.to_string())
        })
        .chain(std::mem::take(
            &mut *signed.lock().unwrap_or_else(|e| e.into_inner()),
        ))
        .collect();

    // What a route may cause. Refusals here come before anything is applied.
    let non_empty = |v: &Json| match v {
        Json::Null => false,
        Json::Array(a) => !a.is_empty(),
        Json::Object(o) => !o.is_empty(),
        _ => true,
    };
    let waits = non_empty(&verdict["integrationWaits"]);
    let intents = non_empty(&verdict["intents"]);
    let enqueues = non_empty(&verdict["enqueue"]);
    if intents || enqueues || waits {
        let declared =
            (!intents || !route.writes.is_empty()) && (!enqueues || !route.enqueues.is_empty());
        let refusal = if level < PluginRoutesLevel::ReadWrite {
            Some((
                StatusCode::BAD_GATEWAY,
                "route-write-refused",
                "This plugin route tried to write",
                "the verdict has intents or enqueues, and at `--plugin-routes read-only` a route cannot write or enqueue; nothing was applied",
            ))
        } else if waits {
            Some((
                StatusCode::BAD_GATEWAY,
                "route-write-refused",
                "This plugin route tried to write",
                "a route cannot wait on integration actions; nothing was applied",
            ))
        } else if !declared {
            Some((
                StatusCode::BAD_GATEWAY,
                "route-write-refused",
                "This plugin route tried to write",
                "the verdict has intents or enqueues this route does not declare; nothing was applied",
            ))
        } else {
            None
        };
        if let Some((status, kind, title, error)) = refusal {
            return Outcome {
                fuel,
                problems,
                ..Outcome::failed(
                    problem(
                        status,
                        kind,
                        title,
                        "The plugin's answer was refused and nothing was stored.",
                    ),
                    error,
                )
            };
        }
    }

    let host = req
        .headers()
        .get(header::HOST)
        .and_then(|h| h.to_str().ok())
        .unwrap_or("");
    let rules = ResponseRules {
        shared_host,
        host,
        cors: route.cors,
        max_bytes: if grants.extended_memory {
            EXTENDED_RESPONSE_BYTES
        } else {
            RESPONSE_BYTES
        },
        head: req.method() == actix_web::http::Method::HEAD,
        consent_page: (level >= PluginRoutesLevel::ReadWrite)
            .then(|| super::route_auth::consent_url(&appstate.config.get_origin(), "")),
    };
    // The response is validated before anything is written, and the writes
    // are stored before it is sent: a 2xx means stored (design 2.6).
    match build_response(&verdict["response"], &rules) {
        Ok(built) => {
            let mut problems = problems;
            // Deliveries are checked before anything is applied, and stored
            // after the intents, before the response (design 2.6).
            let mut deliveries = Vec::new();
            if enqueues {
                match super::route_delivery::prepare(
                    &loaded.manifest,
                    &route.enqueues,
                    &verdict["enqueue"],
                    installation,
                    &format!("route:{}", route.id),
                    at,
                ) {
                    Ok(jobs)
                        if !super::route_delivery::has_room(store, installation, jobs.len()) =>
                    {
                        return Outcome {
                            fuel,
                            problems,
                            ..Outcome::failed(
                                queue_full(),
                                "the delivery queue is full; nothing was applied",
                            )
                        };
                    }
                    Ok(jobs) => deliveries = jobs,
                    Err(e) => {
                        return Outcome {
                            fuel,
                            problems,
                            ..Outcome::failed(
                                problem(
                                    StatusCode::BAD_GATEWAY,
                                    "route-enqueue-refused",
                                    "This plugin route asked for a delivery it may not make",
                                    "The plugin's answer was refused and nothing was stored.",
                                ),
                                format!("{e}; nothing was applied"),
                            )
                        };
                    }
                }
            }
            if intents {
                let Some(http) = loaded.manifest.http.as_ref() else {
                    return Outcome {
                        fuel,
                        problems,
                        ..Outcome::failed(handler_failed(), "the release has no http block")
                    };
                };
                let written = super::route_writes::apply(
                    super::route_writes::WriteRequest {
                        store,
                        ledger: &executor.quotas,
                        installation,
                        drive: &loaded.drive,
                        http,
                        route,
                        config: &loaded.config,
                        grants: &loaded.grants,
                        request_id: &request_id,
                        caller: &caller,
                        remote: &remote,
                        at,
                    },
                    &verdict["intents"],
                )
                .await;
                match written {
                    Ok(applied) => problems.push(applied.summary),
                    Err(refusal) => {
                        let mut response =
                            problem(refusal.status, refusal.kind, refusal.title, &refusal.detail);
                        if let Some(secs) = refusal.retry_after_secs {
                            response
                                .headers_mut()
                                .insert(header::RETRY_AFTER, HeaderValue::from(secs));
                        }
                        return Outcome {
                            fuel,
                            problems,
                            ..Outcome::failed(response, refusal.error)
                        };
                    }
                }
            }
            if !deliveries.is_empty() {
                match super::route_delivery::enqueue(store, deliveries, at) {
                    Ok(enqueued) => {
                        problems.push(format!(
                            "queued {} deliveries ({} duplicates)",
                            enqueued.queued, enqueued.duplicates
                        ));
                        appstate.route_delivery.wake();
                    }
                    Err(e) => {
                        return Outcome {
                            fuel,
                            problems,
                            ..Outcome::failed(queue_full(), e)
                        };
                    }
                }
            }
            let mut response = HttpResponse::build(built.status);
            for (name, value) in built.headers {
                response.append_header((name, value));
            }
            if !built.dropped.is_empty() {
                problems.push(format!(
                    "dropped response headers: {}",
                    built.dropped.join(", ")
                ));
            }
            Outcome {
                response: response.body(built.body),
                error: None,
                problems,
                fuel,
            }
        }
        Err(e) => Outcome {
            fuel,
            problems,
            ..Outcome::failed(handler_failed(), format!("the response was refused: {e}"))
        },
    }
}

/// `401` from the host: the caller could not be verified, and the sandbox
/// did not start. The reason names what failed (a stale date, a digest,
/// an unknown token), never key material.
fn unauthorized(auth: Auth, slug: &str, refused: super::http_signatures::Refused) -> Outcome {
    let challenge = match auth {
        Auth::Bearer => format!("Bearer realm=\"{slug}\""),
        _ => format!("Signature realm=\"{slug}\",headers=\"(request-target) host date digest\""),
    };
    let mut response = problem(
        StatusCode::UNAUTHORIZED,
        "route-unauthorized",
        "The request could not be verified",
        &format!("{refused}."),
    );
    if let Ok(value) = HeaderValue::from_str(&challenge) {
        response
            .headers_mut()
            .insert(header::WWW_AUTHENTICATE, value);
    }
    Outcome::failed(response, format!("not verified: {refused}"))
}

/// `503`: the installation's delivery queue has no room.
fn queue_full() -> HttpResponse {
    let mut response = problem(
        StatusCode::SERVICE_UNAVAILABLE,
        "route-queue-full",
        "This plugin has too many deliveries waiting",
        "Nothing was stored. Try again later.",
    );
    response
        .headers_mut()
        .insert(header::RETRY_AFTER, HeaderValue::from(60));
    response
}

fn handler_failed() -> HttpResponse {
    problem(
        StatusCode::BAD_GATEWAY,
        "route-handler-failed",
        "This plugin route failed",
        "The plugin did not produce a valid answer. Its owner can see why in the route status.",
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugins::test_fixture::{
        fixture_with_args, install_release, js_release_with_source, Fixture,
    };
    use actix_web::{middleware, test as actix_test, App};

    /// Installs `source` as plugin `acme/<name>` with these routes on the
    /// `drive-prefix` mount. Returns the installation and its mount's path.
    async fn install(f: &Fixture, name: &str, source: &str, routes: Json) -> (String, String) {
        install_with(f, name, source, routes, &[]).await
    }

    /// [`install`], also declaring (and so granted) these capabilities.
    async fn install_with(
        f: &Fixture,
        name: &str,
        source: &str,
        routes: Json,
        extra: &[&str],
    ) -> (String, String) {
        let mut capabilities = vec![json!({"name": "storage", "reason": "keeps a cursor"})];
        capabilities.extend(
            extra
                .iter()
                .map(|name| json!({"name": name, "reason": "a test"})),
        );
        let release = js_release_with_source(
            source,
            json!({
                "schemaVersion": 3,
                "name": name,
                "namespace": "acme",
                "capabilities": capabilities,
                "http": {"mount": "drive-prefix", "routes": routes},
            }),
        );
        let installation = install_release(f, &release).await.unwrap();
        let prefix = format!("/_routes/{}", slug(&installation));
        (installation, prefix)
    }

    fn get(path: &str) -> Json {
        json!({"id": "r", "path": path, "methods": ["GET", "HEAD"]})
    }

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

    async fn problem_type<B: actix_web::body::MessageBody>(
        resp: actix_web::dev::ServiceResponse<B>,
    ) -> String {
        assert_eq!(
            resp.headers().get(header::CONTENT_TYPE).unwrap(),
            "application/problem+json"
        );
        let body: Json = actix_test::read_body_json(resp).await;
        body["type"].as_str().unwrap().to_string()
    }

    const WRITES: &str = r#"
        export function handle(ctx, request) {
          return {
            response: { status: 200, body: 'stored' },
            intents: [{ op: 'create', localId: 'x', parent: request.query.drive, isA: [],
              set: { 'https://atomicdata.dev/properties/name': 'from a route' } }],
          };
        }"#;

    #[actix_rt::test]
    async fn a_read_only_route_that_writes_is_refused_and_nothing_is_applied() {
        for level in ["read-only", "read-write"] {
            let f = fixture_with_args(
                &format!("route_writes_{level}"),
                &["--plugin-routes", level],
            )
            .await;
            let (installation, prefix) = install(&f, "writer", WRITES, json!([get("/w")])).await;
            let app = app!(f.appstate);
            let resp = actix_test::call_service(
                &app,
                actix_test::TestRequest::get()
                    .uri(&format!("{prefix}/w?drive={}", f.drive))
                    .to_request(),
            )
            .await;
            assert_eq!(resp.status(), 502, "{level}");
            assert_eq!(problem_type(resp).await, "route-write-refused");
            assert_eq!(
                crate::plugins::test_fixture::children_named(&f, &f.drive, "from a route").await,
                0
            );
            let status = f.appstate.route_exec.status(
                &installation,
                &[("r".into(), String::new())],
                atomic_lib::utils::now(),
            );
            assert_eq!(status["routes"][0]["errors24h"], 1, "{status}");
            assert!(
                status["routes"][0]["lastError"]["message"]
                    .as_str()
                    .unwrap()
                    .contains("nothing was applied"),
                "{status}"
            );
        }
    }

    #[actix_rt::test]
    async fn the_deadline_and_exhaustion_answer_503() {
        const SPIN: &str = r#"
            export function handle(ctx, request) {
              if (request.params.what === 'memory') {
                const hoard = [];
                for (;;) hoard.push('x'.repeat(1 << 20) + hoard.length);
              }
              for (;;) {}
            }"#;
        let f = fixture_with_args("route_limits", &["--plugin-routes", "read-only"]).await;
        // `extended-fuel` (10G) outlasts a 200 ms deadline; the baseline 1G
        // does not outlast the default 3 s one.
        let (_, spinner) = install_with(
            &f,
            "spinner",
            SPIN,
            json!([{"id": "spin", "path": "/spin/{what}", "methods": ["GET"], "timeoutMs": 200}]),
            &["extended-fuel"],
        )
        .await;
        let (_, prefix) = install(
            &f,
            "burner",
            SPIN,
            json!([{"id": "burn", "path": "/burn/{what}", "methods": ["GET"]}]),
        )
        .await;
        let app = app!(f.appstate);
        // Compiling the runtime is once per process, not per request.
        js_runtime::embedded_runtime().unwrap();

        let started = std::time::Instant::now();
        let resp = actix_test::call_service(
            &app,
            actix_test::TestRequest::get()
                .uri(&format!("{spinner}/spin/cpu"))
                .to_request(),
        )
        .await;
        let took = started.elapsed();
        assert_eq!(resp.status(), 503);
        assert_eq!(problem_type(resp).await, "route-deadline-exceeded");
        assert!(took < Duration::from_secs(2), "{took:?}");

        let resp = actix_test::call_service(
            &app,
            actix_test::TestRequest::get()
                .uri(&format!("{prefix}/burn/cpu"))
                .to_request(),
        )
        .await;
        assert_eq!(resp.status(), 503);
        assert_eq!(problem_type(resp).await, "route-resources-exhausted");

        let resp = actix_test::call_service(
            &app,
            actix_test::TestRequest::get()
                .uri(&format!("{prefix}/burn/memory"))
                .to_request(),
        )
        .await;
        assert_eq!(resp.status(), 503);
        assert_eq!(problem_type(resp).await, "route-resources-exhausted");
    }

    #[actix_rt::test]
    async fn bodies_are_limited_and_typed() {
        let f = fixture_with_args("route_bodies", &["--plugin-routes", "read-write"]).await;
        let (_, prefix) = install(
            &f,
            "echo",
            r#"
            export function handle(ctx, request) {
              return { status: 200, body: { got: request.body } };
            }"#,
            json!([
                {"id": "text", "path": "/text", "methods": ["POST"], "body": "text", "maxBodyBytes": 16},
                {"id": "json", "path": "/json", "methods": ["POST"], "body": "json"},
                get("/nobody"),
            ]),
        )
        .await;
        let app = app!(f.appstate);
        let post = |path: &str, content_type: &str, body: &'static str| {
            actix_test::TestRequest::post()
                .uri(&format!("{prefix}{path}"))
                .insert_header((header::CONTENT_TYPE, content_type))
                .set_payload(body)
                .to_request()
        };

        let resp = actix_test::call_service(&app, post("/text", "text/plain", "0123456789")).await;
        assert_eq!(resp.status(), 200);
        let body: Json = actix_test::read_body_json(resp).await;
        assert_eq!(body["got"], "0123456789");

        let resp =
            actix_test::call_service(&app, post("/text", "text/plain", "0123456789abcdefg")).await;
        assert_eq!(resp.status(), 413);
        assert_eq!(problem_type(resp).await, "route-body-too-large");

        let resp = actix_test::call_service(&app, post("/json", "text/plain", "{}")).await;
        assert_eq!(resp.status(), 415);
        let resp = actix_test::call_service(&app, post("/json", "application/json", "{nope")).await;
        assert_eq!(resp.status(), 400);
        let resp =
            actix_test::call_service(&app, post("/json", "application/activity+json", "[1]")).await;
        assert_eq!(resp.status(), 200);
        let body: Json = actix_test::read_body_json(resp).await;
        assert_eq!(body["got"], "[1]");

        let resp = actix_test::call_service(
            &app,
            actix_test::TestRequest::get()
                .uri(&format!("{prefix}/nobody"))
                .set_payload("sneaky")
                .to_request(),
        )
        .await;
        assert_eq!(resp.status(), 413);
        assert_eq!(problem_type(resp).await, "route-body-not-accepted");
    }

    const HEADERS: &str = r#"
        export function handle(ctx, request) {
          if (request.params.what === 'html') {
            return { headers: { 'content-type': 'text/html' }, body: '<script>alert(1)</script>' };
          }
          return {
            status: 201,
            headers: {
              'Content-Type': 'application/json',
              'Cache-Control': 'max-age=60',
              'Set-Cookie': 'atomic_session=stolen',
              'Access-Control-Allow-Origin': 'https://evil.example',
              'Access-Control-Allow-Credentials': 'true',
              'X-Custom': 'nope',
              'Server': 'plugin',
              'Location': 'https://evil.example/elsewhere',
              'Link': '</x>; rel="next"',
            },
            body: JSON.stringify({ seen: request.headers, query: request.query, path: request.path }),
          };
        }"#;

    #[actix_rt::test]
    async fn headers_are_filtered_both_ways() {
        let f = fixture_with_args("route_headers", &["--plugin-routes", "read-only"]).await;
        let (_, prefix) = install(&f, "headers", HEADERS, json!([get("/h/{what}")])).await;
        // The server's CORS layers, as `serve.rs` wraps them.
        let app = actix_test::init_service(
            App::new()
                .app_data(web::Data::new(f.appstate.clone()))
                .wrap(crate::cors::any_origin())
                .wrap(middleware::from_fn(crate::cors::credentials_gate))
                .configure(crate::routes::config_routes),
        )
        .await;
        let resp = actix_test::call_service(
            &app,
            actix_test::TestRequest::get()
                .uri(&format!("{prefix}/h/json?a=1&a=2&b=%20x"))
                .insert_header((header::HOST, "localhost:9883"))
                .insert_header((header::ORIGIN, "http://localhost:9883"))
                .insert_header((header::ACCEPT, "application/json"))
                .insert_header((header::COOKIE, "atomic_session=secret"))
                .insert_header((header::AUTHORIZATION, "Bearer secret"))
                .insert_header(("x-atomic-public-key", "secret"))
                .insert_header(("x-atomic-signature", "secret"))
                .to_request(),
        )
        .await;
        assert_eq!(resp.status(), 201);
        let headers = resp.headers().clone();
        assert_eq!(headers.get(header::CACHE_CONTROL).unwrap(), "max-age=60");
        assert_eq!(
            headers.get(header::CONTENT_TYPE).unwrap(),
            "application/json"
        );
        assert_eq!(headers.get(header::LINK).unwrap(), "</x>; rel=\"next\"");
        assert_eq!(
            headers.get(header::X_CONTENT_TYPE_OPTIONS).unwrap(),
            "nosniff"
        );
        assert!(headers.contains_key(header::CONTENT_SECURITY_POLICY));
        for dropped in [
            "set-cookie",
            "x-custom",
            "location",
            "access-control-allow-origin",
            "access-control-allow-credentials",
        ] {
            assert!(!headers.contains_key(dropped), "{dropped}: {headers:?}");
        }
        assert_ne!(
            headers.get(header::SERVER).map(|v| v.as_bytes()),
            Some(&b"plugin"[..])
        );
        let body: Json = actix_test::read_body_json(resp).await;
        let seen = body["seen"].as_object().unwrap();
        assert_eq!(seen["accept"], "application/json");
        for secret in [
            "cookie",
            "authorization",
            "x-atomic-public-key",
            "x-atomic-signature",
            "host",
        ] {
            assert!(!seen.contains_key(secret), "{secret}: {body}");
        }
        assert_eq!(body["query"], json!({"a": ["1", "2"], "b": " x"}));
        assert_eq!(body["path"], "/h/json");

        // A document on the API origin is refused, not served.
        let resp = actix_test::call_service(
            &app,
            actix_test::TestRequest::get()
                .uri(&format!("{prefix}/h/html"))
                .insert_header((header::ORIGIN, "https://evil.example"))
                .to_request(),
        )
        .await;
        assert_eq!(resp.status(), 502);
        assert!(!resp
            .headers()
            .contains_key(header::ACCESS_CONTROL_ALLOW_ORIGIN));
        assert_eq!(problem_type(resp).await, "route-handler-failed");
    }

    #[actix_rt::test]
    async fn a_route_that_declares_cors_gets_exactly_that() {
        let f = fixture_with_args("route_cors", &["--plugin-routes", "read-only"]).await;
        let (_, prefix) = install(
            &f,
            "cors",
            HEADERS,
            json!([{"id": "r", "path": "/h/{what}", "methods": ["GET"], "cors": "any-origin-no-credentials"}]),
        )
        .await;
        let app = actix_test::init_service(
            App::new()
                .app_data(web::Data::new(f.appstate.clone()))
                .wrap(crate::cors::any_origin())
                .wrap(middleware::from_fn(crate::cors::credentials_gate))
                .configure(crate::routes::config_routes),
        )
        .await;
        let resp = actix_test::call_service(
            &app,
            actix_test::TestRequest::get()
                .uri(&format!("{prefix}/h/json"))
                .insert_header((header::ORIGIN, "http://localhost:9883"))
                .to_request(),
        )
        .await;
        assert_eq!(resp.status(), 201);
        let origins: Vec<_> = resp
            .headers()
            .get_all(header::ACCESS_CONTROL_ALLOW_ORIGIN)
            .collect();
        assert_eq!(origins, vec!["*"]);
        assert!(!resp
            .headers()
            .contains_key(header::ACCESS_CONTROL_ALLOW_CREDENTIALS));
    }

    #[test]
    fn params_are_decoded_and_rest_is_joined() {
        let p = params(
            "/users/{name}/files/{*rest}",
            "/users/al%20ice/files/a/b%2Fc",
        );
        assert_eq!(p["name"], "al ice");
        assert_eq!(p["rest"], "a/b/c");
        assert!(params("/", "/").is_empty());
    }

    #[test]
    fn locations_must_stay_on_the_host() {
        for (location, ok) in [
            ("/elsewhere", true),
            ("//evil.example/x", false),
            ("/\\evil.example", false),
            ("http://localhost:9883/x", true),
            ("http://localhost/x", true),
            ("https://evil.example/x", false),
            ("javascript:alert(1)", false),
        ] {
            assert_eq!(same_host(location, "localhost:9883"), ok, "{location}");
        }
    }

    #[test]
    fn the_status_counts_the_last_day_and_samples_successes() {
        let executor = RouteExecutor::default();
        let now = 100 * HOUR_MS;
        let entry = |at: i64, status: u16| RunEntry {
            at,
            route: "r".into(),
            method: "GET".into(),
            status,
            duration_ms: 1,
            fuel: None,
            error: (status >= 500).then(|| "boom".to_string()),
            problems: Vec::new(),
        };
        // A day and a half ago: outside the window.
        executor.record("i", entry(now - 36 * HOUR_MS, 500));
        for _ in 0..20 {
            executor.record("i", entry(now, 200));
        }
        executor.record("i", entry(now, 404));
        executor.record("i", entry(now, 503));
        let status = executor.status("i", &[("r".into(), "u".into())], now);
        assert_eq!(status["routes"][0]["requests24h"], 22);
        assert_eq!(status["routes"][0]["errors24h"], 1);
        assert_eq!(status["routes"][0]["lastError"]["status"], 503);
        // Every non-2xx, and two of twenty 2xx.
        assert_eq!(status["runs"].as_array().unwrap().len(), 5);
        assert_eq!(status["runs"][0]["status"], 503);
    }

    #[test]
    fn rate_limits_answer_429() {
        let executor = RouteExecutor::new(2, 0);
        assert!(executor.rate.check("s", false).is_ok());
        assert!(executor.rate.check("s", false).is_ok());
        assert!(executor.rate.check("s", false).is_err());
    }

    /// The instantiation cost per request, reported on the PR. Run with
    /// `cargo test -p atomic-server --features plugin-routes --lib --
    /// route_exec::tests::measure --ignored --nocapture`.
    #[actix_rt::test]
    #[ignore]
    async fn measure_instantiation_cost() {
        let runtime = js_runtime::embedded_runtime().unwrap();
        let input =
            json!({"trigger": {"kind": "http", "at": 1, "request": {"params": {"name": "x"}}}})
                .to_string();
        let source = crate::plugins::test_fixture::HELLO_ROUTE_SOURCE;
        let mut runs = Vec::new();
        for _ in 0..50 {
            runs.push(
                runtime
                    .run_route(source, &input, js_runtime::NoCapabilities)
                    .await
                    .unwrap(),
            );
        }
        let runs = &runs[5..];
        let avg = |f: &dyn Fn(&js_runtime::Run) -> f64| {
            runs.iter().map(f).sum::<f64>() / runs.len() as f64
        };
        eprintln!(
            "route run over {} requests: instantiate {:.2} ms, total {:.2} ms, fuel {:.0}",
            runs.len(),
            avg(&|r| r.instantiate.as_secs_f64() * 1000.0),
            avg(&|r| r.total.as_secs_f64() * 1000.0),
            avg(&|r| r.fuel_used as f64),
        );
        assert!(runs.iter().all(|r| r.outcome.is_ok()));
    }
}
