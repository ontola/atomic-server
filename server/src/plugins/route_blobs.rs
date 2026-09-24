//! Blob request and response bodies for plugin routes (#1720, design
//! `server-plugin-routes.md` in atomic-plugins, sections 2.6 and 2.8).
//!
//! - **In.** A route with `body: "blob"` never sees its request body. The host
//!   reads it (refusing it with `413` past the route's limit, and with `429`
//!   past the installation's `bytes-per-day` quota, both as soon as either is
//!   known), hashes it with BLAKE3, stores it content-addressed in the blob
//!   store, and hands the handler `request.blob = { hash, size, type,
//!   subject }`. Only at `--plugin-routes read-write`.
//! - **Out.** A handler may answer with `response.blob` (a hash, or an
//!   `atomic:blob:` subject) instead of a `body`. The host sends those bytes
//!   with the handler's content type (checked by the same rules as inline
//!   bodies: no HTML or SVG on `drive-prefix`, `nosniff`), and an `ETag` of
//!   the hash. A route may only serve a blob its installation stored, or one
//!   a resource under its approved write targets holds.
//! - **Conditional requests.** The host answers `If-Match` and
//!   `If-None-Match` against the blob a `GET` serves, or against
//!   `response.current`, the blob the handler says the target held before a
//!   write. A failed precondition is `412` (`304` for a `GET`), and nothing
//!   the verdict asks for is stored.
//!
//! The blob backend takes whole values, so a body is buffered in memory up
//! to the route's limit (at most the operator's
//! `--plugin-route-max-blob-bytes`) while it is hashed, then stored. Which
//! installation stored which blob is kept in `Tree::PluginMeta`, and erased
//! with the installation's keys and tokens on revocation. The blobs
//! themselves stay: they are content-addressed, and a File may hold them.

use actix_web::{
    http::{header, StatusCode},
    web, HttpRequest,
};
use atomic_lib::{db::trees::Tree, storelike::Query, urls, Db, Storelike, Subject, Value};
use futures::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value as Json};

use super::{
    manifest_http::{Http, Route},
    route_writes::{allowed_targets, QuotaLedger},
};

/// A blob body without `maxBodyBytes` (design 2.8).
pub const DEFAULT_BLOB_BYTES: u64 = 16 * 1024 * 1024;
/// The operator's maximum without `--plugin-route-max-blob-bytes`.
pub const DEFAULT_MAX_BLOB_BYTES: u64 = 16 * 1024 * 1024;
/// The longest content type kept with a blob.
const MAX_TYPE_LEN: usize = 255;

/// `route-blob:stored:<installation>\0<hash>` → [`BlobRef`]: blobs this
/// installation's routes stored, which it may serve.
const STORED: &str = "route-blob:stored:";

/// What a handler gets instead of a blob body.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BlobRef {
    /// Lowercase hex BLAKE3 of the bytes.
    pub hash: String,
    pub size: u64,
    /// The request's `Content-Type`, or `application/octet-stream`.
    #[serde(rename = "type")]
    pub media_type: String,
}

impl BlobRef {
    /// `request.blob`, with the `atomic:blob:` subject a File's `blob`
    /// property takes.
    pub fn to_json(&self) -> Json {
        json!({
            "hash": self.hash,
            "size": self.size,
            "type": self.media_type,
            "subject": atomic_lib::identifiers::blob_subject(&self.hash),
        })
    }
}

/// The body limit of a blob route: its `maxBodyBytes`, or the default, never
/// more than the operator allows.
pub fn limit(route: &Route, operator_max: u64) -> u64 {
    route
        .max_body_bytes
        .unwrap_or(DEFAULT_BLOB_BYTES)
        .min(operator_max)
}

/// A blob hash from what a handler answers: 64 hex characters, or an
/// `atomic:blob:` / `did:ad:blob:` subject of one. Lowercased.
pub fn parse_hash(raw: &str) -> Option<String> {
    let hex = atomic_lib::identifiers::blob_hash_hex(raw).unwrap_or(raw);
    (hex.len() == 64 && hex.bytes().all(|b| b.is_ascii_hexdigit()))
        .then(|| hex.to_ascii_lowercase())
}

fn hash_bytes(hash: &str) -> Option<Vec<u8>> {
    hex::decode(hash).ok().filter(|b| b.len() == 32)
}

fn pure(subject: &str) -> String {
    Subject::from(subject).pure_id()
}

fn prefix(installation: &str) -> Vec<u8> {
    format!("{STORED}{}\0", pure(installation)).into_bytes()
}

fn stored_key(installation: &str, hash: &str) -> Vec<u8> {
    let mut key = prefix(installation);
    key.extend_from_slice(hash.as_bytes());
    key
}

/// The blob, if this installation's routes stored it.
pub fn stored(db: &Db, installation: &str, hash: &str) -> Option<BlobRef> {
    db.kv
        .get(Tree::PluginMeta, &stored_key(installation, hash))
        .ok()
        .flatten()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
}

/// Forgets which blobs the installation stored (on revocation and
/// destruction). The bytes stay: other resources may hold them.
pub fn erase(db: &Db, installation: &str) -> usize {
    let keys: Vec<Vec<u8>> = db
        .kv
        .scan_prefix(Tree::PluginMeta, &prefix(installation))
        .flatten()
        .map(|(key, _)| key.to_vec())
        .collect();
    for key in &keys {
        let _ = db.kv.remove(Tree::PluginMeta, key);
    }
    keys.len()
}

/// Whether a resource directly under one of `parents` holds the blob in its
/// `blob` property.
pub async fn held_under(store: &Db, hash: &str, parents: &[String]) -> bool {
    if parents.is_empty() {
        return false;
    }
    // Both spellings: the property-value index is a string match.
    for subject in
        atomic_lib::identifiers::storage_lookup_keys(&atomic_lib::identifiers::blob_subject(hash))
    {
        let mut q = Query::new();
        q.property = Some(urls::BLOB.to_string());
        q.value = Some(Value::AtomicUrl(subject.into()));
        let Ok(result) = store.query(&q).await else {
            continue;
        };
        if result.resources.iter().any(|r| {
            r.get(urls::PARENT).is_ok_and(|p| {
                let parent = store
                    .normalize_subject(&Subject::from_raw(&p.to_string(), None))
                    .to_string();
                parents.contains(&parent)
            })
        }) {
            return true;
        }
    }
    false
}

/// The resolved parents of every write target the installation's route
/// grant approves, whichever route declares it.
pub fn approved_parents(
    store: &Db,
    http: &Http,
    route: &Route,
    config: &Json,
    grants: &Json,
) -> Vec<String> {
    let every = Route {
        writes: http.write_targets.iter().map(|t| t.id.clone()).collect(),
        ..route.clone()
    };
    allowed_targets(store, http, &every, config, grants)
        .map(|allowed| allowed.into_iter().map(|t| t.parent).collect())
        .unwrap_or_default()
}

/// Whether the installation may serve (or reference in a route write) this
/// blob: it stored it, or its approved write targets hold it.
pub async fn may_use(store: &Db, installation: &str, hash: &str, parents: &[String]) -> bool {
    stored(store, installation, hash).is_some() || held_under(store, hash, parents).await
}

/// Every blob hash a JSON value names as an `atomic:blob:` / `did:ad:blob:`
/// subject.
pub fn referenced(value: &Json, out: &mut Vec<String>) {
    match value {
        Json::String(s) => {
            if let Some(hash) = atomic_lib::identifiers::blob_hash_hex(s) {
                out.push(hash.to_ascii_lowercase());
            }
        }
        Json::Array(items) => items.iter().for_each(|v| referenced(v, out)),
        Json::Object(map) => map.values().for_each(|v| referenced(v, out)),
        _ => {}
    }
}

// -- receiving ------------------------------------------------------------------

/// Why a blob body was not stored.
#[derive(Debug, PartialEq, Eq)]
pub enum Refused {
    /// Past the route's limit: `413`.
    TooLarge(u64),
    /// Past the installation's `bytes-per-day` quota: `429`, and the seconds
    /// until the day ends.
    Quota { limit: u64, retry_after_secs: u64 },
    /// The connection failed: `400`.
    Unreadable(String),
    /// The blob store failed: `500`.
    Store(String),
}

/// The body's content type as it is kept with the blob.
pub fn media_type(req: &HttpRequest) -> String {
    req.headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
        .filter(|v| !v.is_empty() && v.len() <= MAX_TYPE_LEN)
        .unwrap_or("application/octet-stream")
        .to_string()
}

/// Reads a blob body, refusing it as soon as it passes `limit` or the bytes
/// the installation has left today (`left`). Hashes as it reads.
pub async fn read(
    mut payload: web::Payload,
    declared: Option<u64>,
    limit: u64,
    left: Option<(u64, u64)>,
    quota: u64,
) -> Result<(Vec<u8>, String), Refused> {
    let over_quota = |n: u64| {
        left.and_then(|(left, retry)| {
            (n > left).then_some(Refused::Quota {
                limit: quota,
                retry_after_secs: retry,
            })
        })
    };
    if let Some(n) = declared {
        if n > limit {
            return Err(Refused::TooLarge(limit));
        }
        if let Some(refused) = over_quota(n) {
            return Err(refused);
        }
    }
    let mut hasher = blake3::Hasher::new();
    let mut body = Vec::with_capacity(declared.unwrap_or(0).min(limit) as usize);
    while let Some(chunk) = payload.next().await {
        let chunk = chunk.map_err(|e| Refused::Unreadable(e.to_string()))?;
        let total = (body.len() + chunk.len()) as u64;
        if total > limit {
            return Err(Refused::TooLarge(limit));
        }
        if let Some(refused) = over_quota(total) {
            return Err(refused);
        }
        hasher.update(&chunk);
        body.extend_from_slice(&chunk);
    }
    Ok((body, hasher.finalize().to_hex().to_string()))
}

/// Books the bytes against the installation's quota, stores them (unless the
/// store already has them) and records that this installation stored them.
pub async fn store(
    db: &Db,
    ledger: &QuotaLedger,
    installation: &str,
    bytes: &[u8],
    hash: &str,
    media_type: String,
    at: i64,
) -> Result<BlobRef, Refused> {
    let size = bytes.len() as u64;
    // Every accepted body counts in full, also when the store already had
    // the same bytes: the quota bounds what a remote caller can make the
    // node take in, not only what ends up on disk.
    ledger
        .reserve(installation, "blob", 0, size, at)
        .map_err(|exceeded| Refused::Quota {
            limit: exceeded.limit,
            retry_after_secs: exceeded.retry_after_secs,
        })?;
    let key = hash_bytes(hash).ok_or_else(|| Refused::Store("not a blob hash".into()))?;
    let stored_now = async {
        if !db.has_blob(&key).await? {
            db.put_blob(&key, bytes).await?;
        }
        atomic_lib::errors::AtomicResult::Ok(())
    }
    .await;
    if let Err(e) = stored_now {
        ledger.refund(installation, "blob", 0, size, at);
        return Err(Refused::Store(e.to_string()));
    }
    let blob = BlobRef {
        hash: hash.to_string(),
        size,
        media_type,
    };
    db.kv
        .insert(
            Tree::PluginMeta,
            &stored_key(installation, hash),
            &serde_json::to_vec(&blob).expect("a blob reference serializes"),
        )
        .map_err(|e| Refused::Store(e.to_string()))?;
    Ok(blob)
}

/// The bytes of a blob, or its size alone (for `HEAD`).
pub async fn load(db: &Db, hash: &str, head: bool) -> Option<Result<Vec<u8>, u64>> {
    let key = hash_bytes(hash)?;
    if head {
        return db.blob_size(&key).await.ok().flatten().map(Err);
    }
    db.get_blob(&key).await.ok().flatten().map(Ok)
}

// -- conditional requests -------------------------------------------------------

/// The strong `ETag` the host gives a blob.
pub fn etag(hash: &str) -> String {
    format!("\"{hash}\"")
}

fn opaque(tag: &str) -> &str {
    tag.trim().trim_start_matches("W/")
}

fn list_matches(header: &str, current: Option<&str>, weak: bool) -> bool {
    let Some(current) = current else {
        return false;
    };
    let current = etag(current);
    header.split(',').map(str::trim).any(|tag| {
        tag == "*"
            || if weak {
                opaque(tag) == current
            } else {
                !tag.starts_with("W/") && tag == current
            }
    })
}

/// The answer to `If-Match` / `If-None-Match` against the blob the target
/// holds (`current`, `None` when it holds nothing), or `None` to go on.
/// `If-Match: *` needs something there; `If-None-Match: *` needs nothing.
pub fn precondition(req: &HttpRequest, current: Option<&str>) -> Option<StatusCode> {
    let get = matches!(req.method().as_str(), "GET" | "HEAD");
    let value = |name| {
        req.headers()
            .get_all(name)
            .filter_map(|v| v.to_str().ok())
            .collect::<Vec<_>>()
            .join(",")
    };
    let if_match = value(header::IF_MATCH);
    if !if_match.is_empty() && !list_matches(&if_match, current, false) {
        return Some(StatusCode::PRECONDITION_FAILED);
    }
    let if_none_match = value(header::IF_NONE_MATCH);
    if !if_none_match.is_empty() && list_matches(&if_none_match, current, true) {
        return Some(if get {
            StatusCode::NOT_MODIFIED
        } else {
            StatusCode::PRECONDITION_FAILED
        });
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use actix_web::test::TestRequest;

    const H: &str = "af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262";
    const OTHER: &str = "0000000000000000000000000000000000000000000000000000000000000000";

    #[test]
    fn hashes_parse_from_hex_and_subjects() {
        assert_eq!(parse_hash(H).as_deref(), Some(H));
        assert_eq!(
            parse_hash(&H.to_ascii_uppercase()).as_deref(),
            Some(H),
            "lowercased"
        );
        assert_eq!(parse_hash(&format!("atomic:blob:{H}")).as_deref(), Some(H));
        assert_eq!(parse_hash(&format!("did:ad:blob:{H}")).as_deref(), Some(H));
        assert_eq!(parse_hash("abc"), None);
        assert_eq!(parse_hash(&format!("{}zz", &H[..62])), None);
    }

    #[test]
    fn the_limit_is_capped_by_the_operator() {
        let route: Route = serde_json::from_value(json!({
            "id": "r", "path": "/r", "methods": ["PUT"], "body": "blob"
        }))
        .unwrap();
        assert_eq!(limit(&route, u64::MAX), DEFAULT_BLOB_BYTES);
        assert_eq!(limit(&route, 1000), 1000);
        let declared = Route {
            max_body_bytes: Some(100 * 1024 * 1024),
            ..route
        };
        assert_eq!(limit(&declared, DEFAULT_MAX_BLOB_BYTES), 16 * 1024 * 1024);
        assert_eq!(limit(&declared, 1 << 40), 100 * 1024 * 1024);
    }

    #[test]
    fn conditional_requests() {
        let get = |name: &str, value: &str| {
            TestRequest::get()
                .insert_header((name, value))
                .to_http_request()
        };
        let put = |name: &str, value: &str| {
            TestRequest::put()
                .insert_header((name, value))
                .to_http_request()
        };
        let tag = etag(H);
        // GET
        assert_eq!(
            precondition(&get("if-none-match", &tag), Some(H)),
            Some(StatusCode::NOT_MODIFIED)
        );
        assert_eq!(
            precondition(&get("if-none-match", &format!("W/{tag}")), Some(H)),
            Some(StatusCode::NOT_MODIFIED),
            "If-None-Match compares weakly"
        );
        assert_eq!(
            precondition(&get("if-none-match", &etag(OTHER)), Some(H)),
            None
        );
        assert_eq!(precondition(&get("if-match", &tag), Some(H)), None);
        assert_eq!(
            precondition(&get("if-match", &etag(OTHER)), Some(H)),
            Some(StatusCode::PRECONDITION_FAILED)
        );
        assert_eq!(
            precondition(&get("if-match", &format!("W/{tag}")), Some(H)),
            Some(StatusCode::PRECONDITION_FAILED),
            "If-Match compares strongly"
        );
        assert_eq!(
            precondition(&TestRequest::get().to_http_request(), Some(H)),
            None
        );
        // PUT: create only if absent, update only the version the client saw.
        assert_eq!(precondition(&put("if-none-match", "*"), None), None);
        assert_eq!(
            precondition(&put("if-none-match", "*"), Some(H)),
            Some(StatusCode::PRECONDITION_FAILED)
        );
        assert_eq!(precondition(&put("if-match", &tag), Some(H)), None);
        assert_eq!(
            precondition(
                &put("if-match", &format!("{}, {tag}", etag(OTHER))),
                Some(H)
            ),
            None
        );
        assert_eq!(
            precondition(&put("if-match", &etag(OTHER)), Some(H)),
            Some(StatusCode::PRECONDITION_FAILED)
        );
        assert_eq!(
            precondition(&put("if-match", "*"), None),
            Some(StatusCode::PRECONDITION_FAILED)
        );
        assert_eq!(precondition(&put("if-match", "*"), Some(H)), None);
    }

    #[test]
    fn blob_references_are_found_anywhere_in_a_value() {
        let mut out = Vec::new();
        referenced(
            &json!({ "a": format!("atomic:blob:{H}"), "b": [format!("did:ad:blob:{OTHER}"), 3], "c": "text" }),
            &mut out,
        );
        out.sort();
        assert_eq!(out, vec![OTHER.to_string(), H.to_string()]);
    }
}
