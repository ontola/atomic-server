//! Who sent a plugin route request, verified by the host before the sandbox
//! starts (#1718; design `server-plugin-routes.md` in atomic-plugins, 2.5
//! and 2.7), and the crypto host calls a route handler gets (D8).
//!
//! | `auth` | Verified here | `request.caller` |
//! | --- | --- | --- |
//! | `http-signature` | draft-cavage-12 or RFC 9421, the body digest, ±5 min | `{ keyId, owner, scheme, alg }` |
//! | `bearer` | a token of this installation's `tokens` store | `{ token: { id, name, scopes, client } }` |
//!
//! A failure is a `401` from the host, and the sandbox never runs. `atomic`
//! and `dpop` are not verified here (see `route_exec`).
//!
//! **Keys of remote callers.** A `keyId` is fetched (without its fragment)
//! through the egress guard: public addresses only, the checked address
//! pinned, no redirects, 5 s, 64 KiB. The document may be the key itself or
//! an actor with `publicKey`; the key's `id` must be the `keyId`, and its
//! `owner` must be on the same origin. Keys are cached per installation for
//! an hour, failures for a minute. When a cached key fails to verify, it is
//! fetched again (at most once a minute), since the sender may have rotated
//! it. A `keyId` an installation on this node bound
//! ([`super::route_keys::bind_key_id`]) is not fetched.

use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

use actix_web::HttpRequest;
use atomic_lib::{Db, Subject};
use serde_json::{json, Value as Json};

use super::{
    egress, host_core,
    http_signatures::{self, Message, PublicKey, Refused},
    manifest::Manifest,
    route_keys,
    route_registry::RouteRegistry,
    route_tokens::{self, Consents, Issue, Pending},
};

/// Key documents: how long to wait, and how much to read.
pub const KEY_FETCH_TIMEOUT_SECS: u64 = 5;
pub const KEY_FETCH_MAX_BYTES: usize = 64 * 1024;
/// How long a fetched key, and a failed fetch, is remembered.
pub const KEY_TTL_MS: i64 = 60 * 60 * 1000;
pub const NEGATIVE_TTL_MS: i64 = 60 * 1000;
/// A cached key that fails to verify is fetched again at most this often.
pub const REFETCH_AFTER_MS: i64 = 60 * 1000;
/// Cached keys per installation.
pub const MAX_CACHED_KEYS: usize = 1024;
/// Signatures per request that are tried.
const MAX_SIGNATURES: usize = 4;

fn pure(subject: &str) -> String {
    Subject::from(subject).pure_id()
}

// -- key fetching ---------------------------------------------------------------

/// Fetches a key document. The real one goes through the egress guard.
#[async_trait::async_trait]
pub trait KeyFetch: Send + Sync {
    async fn fetch(&self, url: &url::Url) -> Result<Vec<u8>, String>;
}

/// The egress-guarded fetch: every resolved address public, the checked
/// address pinned, no proxy, no redirects, a 5 s deadline and a 64 KiB cap.
pub struct EgressFetch;

#[async_trait::async_trait]
impl KeyFetch for EgressFetch {
    async fn fetch(&self, url: &url::Url) -> Result<Vec<u8>, String> {
        let addresses = egress::checked_addresses(url).await?;
        let host = url.host_str().ok_or("URL has no host")?;
        let client = reqwest::Client::builder()
            .no_proxy()
            .resolve_to_addrs(host, &addresses)
            .timeout(std::time::Duration::from_secs(KEY_FETCH_TIMEOUT_SECS))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|e| format!("could not build an HTTP client: {e}"))?;
        let response = client
            .get(url.clone())
            .header(
                "accept",
                "application/activity+json, application/ld+json; profile=\"https://www.w3.org/ns/activitystreams\", application/json",
            )
            .send()
            .await
            .map_err(|e| format!("could not fetch the key: {e}"))?;
        if !response.status().is_success() {
            return Err(format!("the key document answered {}", response.status()));
        }
        let origin = egress::origin_of(url)?;
        host_core::read_capped(response.bytes_stream(), KEY_FETCH_MAX_BYTES, &origin).await
    }
}

/// Finds the key `key_id` names in a fetched document, and its owner.
pub fn key_from_document(
    document: &[u8],
    key_id: &url::Url,
) -> Result<(PublicKey, String), String> {
    let doc: Json = serde_json::from_slice(document).map_err(|_| "the key document is not JSON")?;
    let mut candidates: Vec<&Json> = Vec::new();
    if doc.get("publicKeyPem").is_some() {
        candidates.push(&doc);
    }
    match doc.get("publicKey") {
        Some(Json::Array(keys)) => candidates.extend(keys.iter()),
        Some(key @ Json::Object(_)) => candidates.push(key),
        _ => {}
    }
    let wanted = key_id.as_str();
    let key = candidates
        .into_iter()
        .find(|k| k["id"].as_str() == Some(wanted))
        .ok_or("the key document has no key with this keyId")?;
    let owner = key["owner"]
        .as_str()
        .or_else(|| key["controller"].as_str())
        .or_else(|| doc["id"].as_str())
        .ok_or("the key has no owner")?;
    let owner_url = url::Url::parse(owner).map_err(|_| "the key's owner is not a URL")?;
    if owner_url.origin() != key_id.origin() {
        return Err("the key's owner is on another origin than the key".into());
    }
    let pem = key["publicKeyPem"]
        .as_str()
        .ok_or("the key has no publicKeyPem")?;
    let public = PublicKey::from_pem(pem)?;
    public.check_strength()?;
    Ok((public, owner.to_string()))
}

#[derive(Clone)]
enum Cached {
    Found {
        key: PublicKey,
        owner: String,
        at: i64,
    },
    Missing {
        reason: String,
        at: i64,
    },
}

/// Remote keys, per installation, with a short negative cache.
pub struct KeyResolver {
    fetch: Arc<dyn KeyFetch>,
    cache: Mutex<HashMap<String, HashMap<String, Cached>>>,
}

impl Default for KeyResolver {
    fn default() -> Self {
        Self::new(Arc::new(EgressFetch))
    }
}

/// A resolved key and where it came from.
pub struct Resolved {
    pub key: PublicKey,
    pub owner: String,
    /// Answered from the cache, not fetched now.
    pub cached: bool,
}

impl KeyResolver {
    pub fn new(fetch: Arc<dyn KeyFetch>) -> Self {
        Self {
            fetch,
            cache: Mutex::new(HashMap::new()),
        }
    }

    fn cached(&self, installation: &str, key_id: &str, now: i64) -> Option<Cached> {
        let cache = self.cache.lock().unwrap_or_else(|e| e.into_inner());
        let entry = cache.get(&pure(installation))?.get(key_id)?.clone();
        let fresh = match &entry {
            Cached::Found { at, .. } => now - at < KEY_TTL_MS,
            Cached::Missing { at, .. } => now - at < NEGATIVE_TTL_MS,
        };
        fresh.then_some(entry)
    }

    fn store(&self, installation: &str, key_id: &str, entry: Cached) {
        let mut cache = self.cache.lock().unwrap_or_else(|e| e.into_inner());
        let keys = cache.entry(pure(installation)).or_default();
        if keys.len() >= MAX_CACHED_KEYS && !keys.contains_key(key_id) {
            // Oldest out.
            if let Some(oldest) = keys
                .iter()
                .min_by_key(|(_, c)| match c {
                    Cached::Found { at, .. } | Cached::Missing { at, .. } => *at,
                })
                .map(|(k, _)| k.clone())
            {
                keys.remove(&oldest);
            }
        }
        keys.insert(key_id.to_string(), entry);
    }

    /// The key for `key_id`: a key this node's installations bound, a cached
    /// one, or one fetched now.
    pub async fn resolve(
        &self,
        db: &Db,
        installation: &str,
        key_id: &str,
        now: i64,
    ) -> Result<Resolved, Refused> {
        if let Some((_, key)) = route_keys::local_key(db, key_id) {
            let owner = key_id.split('#').next().unwrap_or(key_id).to_string();
            return Ok(Resolved {
                key,
                owner,
                cached: false,
            });
        }
        match self.cached(installation, key_id, now) {
            Some(Cached::Found { key, owner, .. }) => {
                return Ok(Resolved {
                    key,
                    owner,
                    cached: true,
                })
            }
            Some(Cached::Missing { reason, .. }) => return Err(Refused(reason)),
            None => {}
        }
        self.fetch_now(installation, key_id, now).await
    }

    async fn fetch_now(
        &self,
        installation: &str,
        key_id: &str,
        now: i64,
    ) -> Result<Resolved, Refused> {
        let result = async {
            let parsed =
                url::Url::parse(key_id).map_err(|_| "the keyId is not a URL".to_string())?;
            if !matches!(parsed.scheme(), "http" | "https") {
                return Err("the keyId is not an HTTP URL".to_string());
            }
            let mut document = parsed.clone();
            document.set_fragment(None);
            let bytes = self.fetch.fetch(&document).await?;
            key_from_document(&bytes, &parsed)
        }
        .await;
        match result {
            Ok((key, owner)) => {
                self.store(
                    installation,
                    key_id,
                    Cached::Found {
                        key: key.clone(),
                        owner: owner.clone(),
                        at: now,
                    },
                );
                Ok(Resolved {
                    key,
                    owner,
                    cached: false,
                })
            }
            Err(e) => {
                let reason = format!("the signing key could not be used: {e}");
                self.store(
                    installation,
                    key_id,
                    Cached::Missing {
                        reason: reason.clone(),
                        at: now,
                    },
                );
                Err(Refused(reason))
            }
        }
    }

    /// After a cached key failed to verify: fetch it again, unless it was
    /// fetched within [`REFETCH_AFTER_MS`].
    async fn refetch(&self, installation: &str, key_id: &str, now: i64) -> Option<Resolved> {
        let stale = matches!(
            self.cached(installation, key_id, now),
            Some(Cached::Found { at, .. }) if now - at >= REFETCH_AFTER_MS
        );
        if !stale {
            return None;
        }
        self.fetch_now(installation, key_id, now).await.ok()
    }
}

// -- authenticating a request --------------------------------------------------------

/// The request, as the signature verifier needs it.
pub struct RequestParts {
    pub method: String,
    pub scheme: String,
    pub authority: String,
    pub path: String,
    pub query: Option<String>,
    pub headers: Vec<(String, String)>,
}

impl RequestParts {
    pub fn of(req: &HttpRequest) -> Self {
        let info = req.connection_info();
        Self {
            method: req.method().to_string(),
            scheme: info.scheme().to_string(),
            authority: info.host().to_string(),
            path: req.uri().path().to_string(),
            query: req.uri().query().map(str::to_string),
            headers: req
                .headers()
                .iter()
                .filter_map(|(n, v)| Some((n.as_str().to_string(), v.to_str().ok()?.to_string())))
                .collect(),
        }
    }

    pub fn message(&self) -> Message<'_> {
        Message {
            method: &self.method,
            scheme: &self.scheme,
            authority: &self.authority,
            path: &self.path,
            query: self.query.as_deref(),
            headers: &self.headers,
        }
    }
}

/// Verifies an `http-signature` request. Policy (freshness, coverage,
/// digest) is checked before any key is fetched, so a stale or unbound
/// request costs no fetch.
pub async fn verify_signature(
    resolver: &KeyResolver,
    db: &Db,
    installation: &str,
    parts: &RequestParts,
    body: &[u8],
    now_ms: i64,
) -> Result<Json, Refused> {
    let message = parts.message();
    let now = now_ms.div_euclid(1000);
    let signatures = http_signatures::parse(&message)?;
    let mut last = Refused("the request is not signed".into());
    for parsed in signatures.iter().take(MAX_SIGNATURES) {
        if let Err(e) = http_signatures::check_policy(parsed, &message, body, now) {
            last = e;
            continue;
        }
        let resolved = match resolver
            .resolve(db, installation, &parsed.key_id, now_ms)
            .await
        {
            Ok(r) => r,
            Err(e) => {
                last = e;
                continue;
            }
        };
        let verified = match http_signatures::verify(parsed, &resolved.key) {
            Ok(alg) => Some((alg, resolved.owner)),
            Err(e) if resolved.cached => {
                match resolver.refetch(installation, &parsed.key_id, now_ms).await {
                    Some(again) => http_signatures::verify(parsed, &again.key)
                        .ok()
                        .map(|alg| (alg, again.owner)),
                    None => {
                        last = e;
                        None
                    }
                }
            }
            Err(e) => {
                last = e;
                None
            }
        };
        if let Some((alg, owner)) = verified {
            return Ok(json!({
                "keyId": parsed.key_id,
                "owner": owner,
                "scheme": parsed.scheme.as_str(),
                "alg": alg.rfc9421_name(),
            }));
        }
    }
    Err(last)
}

/// Verifies a `bearer` request against the installation's tokens.
pub fn verify_bearer(
    db: &Db,
    installation: &str,
    req: &HttpRequest,
    now: i64,
) -> Result<Json, Refused> {
    let header = req
        .headers()
        .get(actix_web::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| Refused("the request has no bearer token".into()))?;
    let (scheme, token) = header
        .split_once(' ')
        .ok_or_else(|| Refused("the request has no bearer token".into()))?;
    if !scheme.eq_ignore_ascii_case("bearer") {
        return Err(Refused("the request has no bearer token".into()));
    }
    let info = route_tokens::verify(db, installation, token.trim(), now)
        .ok_or_else(|| Refused("the bearer token is unknown, revoked or expired".into()))?;
    Ok(json!({ "token": {
        "id": info.id,
        "name": info.name,
        "scopes": info.scopes,
        "client": info.client,
    }}))
}

// -- host calls -----------------------------------------------------------------

/// What a route's crypto host calls need. Built per request.
pub struct CryptoHost {
    pub db: Arc<Db>,
    pub installation: String,
    pub manifest: Manifest,
    pub registry: Arc<RouteRegistry>,
    pub consents: Arc<Consents>,
    /// `scheme://host`, how this request reached the node, and the
    /// installation's base URL there (with `/_routes/<slug>` on
    /// `drive-prefix`).
    pub base: String,
    /// The API origin, where the consent page is.
    pub api_origin: String,
    /// Lines for the run log: every signature, with its operation id.
    pub log: Arc<Mutex<Vec<String>>>,
    pub now: i64,
}

impl CryptoHost {
    fn tokens_declared(&self, name: &str) -> Result<(), String> {
        let declared = self
            .manifest
            .http
            .as_ref()
            .is_some_and(|h| h.tokens.iter().any(|t| t.name == name));
        if declared {
            Ok(())
        } else {
            Err(format!(
                "this plugin declares no token store named `{name}`"
            ))
        }
    }

    /// Binds `key_id` to the key if it lies in this installation's own
    /// route space, so this node verifies it without a fetch.
    fn maybe_bind(&self, name: &str, key_id: &str) -> Result<(), String> {
        let Ok(url) = url::Url::parse(key_id) else {
            return Ok(());
        };
        let Some(host) = url.host_str() else {
            return Ok(());
        };
        let host = match url.port() {
            Some(port) => format!("{host}:{port}"),
            None => host.to_string(),
        };
        // `/_routes/<slug>/` is the installation's only on this node's API
        // hosts: the same path on another host is someone else's URL.
        let own = self
            .registry
            .target(&host, url.path())
            .is_some_and(|(subject, mount, _)| {
                pure(&subject) == pure(&self.installation)
                    && (mount != super::manifest_http::Mount::DrivePrefix
                        || self
                            .registry
                            .config()
                            .is_api_host(&super::route_registry::host_name(&host)))
            });
        if own {
            route_keys::bind_key_id(&self.db, &self.installation, name, key_id)?;
        }
        Ok(())
    }

    /// One `ctx.keys.*` or `ctx.tokens.*` call. Errors go back to the
    /// plugin, so none carries key material.
    pub async fn call(&self, name: &str, request: &str) -> Result<String, String> {
        let request: Json =
            serde_json::from_str(request).map_err(|e| format!("not a JSON request: {e}"))?;
        let out = match name {
            "keys.publicKey" => {
                let key = request["key"].as_str().ok_or("give the key's name")?;
                let info = route_keys::public(&self.db, &self.installation, &self.manifest, key)?;
                let key_id = request["keyId"].as_str();
                if let Some(key_id) = key_id {
                    self.maybe_bind(key, key_id)?;
                }
                let mut out = serde_json::to_value(info).map_err(|e| e.to_string())?;
                out["keyId"] = json!(key_id);
                out
            }
            "keys.sign" => {
                let sign: route_keys::SignRequest = serde_json::from_value(request)
                    .map_err(|e| format!("not a signing request: {e}"))?;
                let (out, line) = route_keys::sign(
                    &self.db,
                    &self.installation,
                    &self.manifest,
                    &sign,
                    std::time::SystemTime::now(),
                )?;
                self.maybe_bind(&sign.key, &sign.key_id)?;
                self.log
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .push(line);
                out
            }
            "tokens.issue" => {
                let issue = if let Some(code) = request["code"].as_str() {
                    let granted = self.consents.redeem(&self.installation, code, self.now)?;
                    Issue {
                        name: granted.name,
                        scopes: granted.scopes,
                        client: granted.client,
                        expires_at: expires_at(&request, self.now)?,
                        approved_by: Some(granted.approved_by),
                    }
                } else {
                    let name = request["name"]
                        .as_str()
                        .ok_or("give the token store's name")?;
                    self.tokens_declared(name)?;
                    Issue {
                        name: name.to_string(),
                        scopes: strings(&request["scopes"])?,
                        client: request["client"].as_str().map(str::to_string),
                        expires_at: expires_at(&request, self.now)?,
                        approved_by: None,
                    }
                };
                let (token, info) =
                    route_tokens::issue(&self.db, &self.installation, issue, self.now)?;
                let mut out = serde_json::to_value(info).map_err(|e| e.to_string())?;
                out["token"] = json!(token);
                out
            }
            "tokens.verify" => {
                let token = request["token"].as_str().ok_or("give the token")?;
                json!(route_tokens::verify(
                    &self.db,
                    &self.installation,
                    token,
                    self.now
                ))
            }
            "tokens.revoke" => {
                let id = request["id"].as_str().ok_or("give the token's id")?;
                json!(route_tokens::revoke(&self.db, &self.installation, id)?)
            }
            "tokens.requestConsent" => {
                let name = request["name"]
                    .as_str()
                    .ok_or("give the token store's name")?;
                self.tokens_declared(name)?;
                let redirect = request["redirect"]
                    .as_str()
                    .ok_or("give the route path the answer goes to")?;
                self.check_redirect(redirect)?;
                let id = self.consents.request(
                    Pending {
                        installation: self.installation.clone(),
                        name: name.to_string(),
                        scopes: strings(&request["scopes"])?,
                        client: request["client"].as_str().map(str::to_string),
                        redirect: format!("{}{redirect}", self.base),
                        state: request["state"].as_str().map(str::to_string),
                        expires_at: self.now + route_tokens::CONSENT_TTL_MS,
                    },
                    self.now,
                )?;
                json!({ "url": consent_url(&self.api_origin, &id) })
            }
            other => return Err(format!("there is no host call `{other}`")),
        };
        Ok(out.to_string())
    }

    /// The consent answer may only go to a `GET` route of this installation.
    fn check_redirect(&self, path: &str) -> Result<(), String> {
        let segments = super::route_registry::request_segments(path);
        let routed = path.starts_with('/')
            && !path.contains("//")
            && !path.contains(['?', '#', '\\'])
            && !segments.iter().any(|s| *s == ".." || *s == ".")
            && self.manifest.http.as_ref().is_some_and(|h| {
                h.routes.iter().any(|r| {
                    r.methods.iter().any(|m| m == "GET")
                        && super::manifest_http::pattern(&r.path)
                            .is_ok_and(|p| super::route_registry::matches(&p, &segments))
                })
            });
        if routed {
            Ok(())
        } else {
            Err(format!(
                "the consent answer can only go to a GET route of this plugin; `{path}` is not one"
            ))
        }
    }
}

/// The host's consent page for a request id.
pub fn consent_url(api_origin: &str, id: &str) -> String {
    format!(
        "{}/app/route-consent?request={id}",
        api_origin.trim_end_matches('/')
    )
}

fn strings(value: &Json) -> Result<Vec<String>, String> {
    match value {
        Json::Null => Ok(Vec::new()),
        Json::Array(items) => items
            .iter()
            .map(|i| {
                i.as_str()
                    .map(str::to_string)
                    .ok_or("scopes are strings".to_string())
            })
            .collect(),
        _ => Err("scopes are an array of strings".into()),
    }
}

fn expires_at(request: &Json, now: i64) -> Result<Option<i64>, String> {
    match &request["expiresIn"] {
        Json::Null => Ok(None),
        value => value
            .as_u64()
            .filter(|s| *s > 0 && *s <= 10 * 365 * 24 * 3600)
            .map(|s| Some(now + (s as i64) * 1000))
            .ok_or_else(|| "expiresIn is a number of seconds, up to ten years".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// Serves one key document from memory and counts fetches.
    struct Fake {
        document: Mutex<Vec<u8>>,
        fetches: AtomicUsize,
    }

    #[async_trait::async_trait]
    impl KeyFetch for Fake {
        async fn fetch(&self, url: &url::Url) -> Result<Vec<u8>, String> {
            self.fetches.fetch_add(1, Ordering::SeqCst);
            assert!(url.fragment().is_none(), "the fragment is not fetched");
            let doc = self.document.lock().unwrap().clone();
            if doc.is_empty() {
                Err("404".into())
            } else {
                Ok(doc)
            }
        }
    }

    fn actor(key: &ed25519_dalek::SigningKey) -> Vec<u8> {
        json!({
            "id": "https://remote.example/users/bob",
            "type": "Person",
            "publicKey": {
                "id": "https://remote.example/users/bob#main-key",
                "owner": "https://remote.example/users/bob",
                "publicKeyPem": PublicKey::Ed25519(key.verifying_key()).to_pem(),
            }
        })
        .to_string()
        .into_bytes()
    }

    struct Ed(ed25519_dalek::SigningKey);
    impl http_signatures::Signer for Ed {
        fn algorithm(&self) -> http_signatures::Algorithm {
            http_signatures::Algorithm::Ed25519
        }
        fn sign(&self, data: &[u8]) -> Vec<u8> {
            use ed25519_dalek::Signer as _;
            self.0.sign(data).to_bytes().to_vec()
        }
    }

    fn signed_parts(
        key: &ed25519_dalek::SigningKey,
        body: &[u8],
        at: std::time::SystemTime,
    ) -> RequestParts {
        let url = url::Url::parse("https://node.example/_routes/s/inbox").unwrap();
        let mut headers = http_signatures::sign_cavage(
            &Ed(key.clone()),
            "https://remote.example/users/bob#main-key",
            &http_signatures::Outbound {
                method: "POST",
                url: &url,
                body: Some(body),
            },
            at,
        );
        headers.push(("content-type".into(), "application/activity+json".into()));
        RequestParts {
            method: "POST".into(),
            scheme: "https".into(),
            authority: "node.example".into(),
            path: "/_routes/s/inbox".into(),
            query: None,
            headers,
        }
    }

    fn now_ms(at: std::time::SystemTime) -> i64 {
        at.duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64
    }

    #[tokio::test]
    async fn a_signed_request_is_verified_through_a_cached_key_fetch() {
        let db = Db::init_temp("route_auth_cache").await.unwrap();
        let key = ed25519_dalek::SigningKey::generate(&mut rand::rngs::OsRng);
        let fake = Arc::new(Fake {
            document: Mutex::new(actor(&key)),
            fetches: AtomicUsize::new(0),
        });
        let resolver = KeyResolver::new(fake.clone());
        let body = br#"{"type":"Follow"}"#;
        let at = std::time::SystemTime::now();
        let parts = signed_parts(&key, body, at);
        let caller = verify_signature(&resolver, &db, "did:ad:i", &parts, body, now_ms(at))
            .await
            .unwrap();
        assert_eq!(caller["keyId"], "https://remote.example/users/bob#main-key");
        assert_eq!(caller["owner"], "https://remote.example/users/bob");
        assert_eq!(caller["scheme"], "draft-cavage-12");
        assert_eq!(caller["alg"], "ed25519");
        // Cached per installation: a second request fetches nothing.
        verify_signature(&resolver, &db, "did:ad:i", &parts, body, now_ms(at))
            .await
            .unwrap();
        assert_eq!(fake.fetches.load(Ordering::SeqCst), 1);
        // Another installation has its own cache.
        verify_signature(&resolver, &db, "did:ad:j", &parts, body, now_ms(at))
            .await
            .unwrap();
        assert_eq!(fake.fetches.load(Ordering::SeqCst), 2);

        // A stale request never costs a fetch.
        let old = at - std::time::Duration::from_secs(600);
        let err = verify_signature(
            &resolver,
            &db,
            "did:ad:k",
            &signed_parts(&key, body, old),
            body,
            now_ms(at),
        )
        .await
        .unwrap_err();
        assert!(err.0.contains("seconds"), "{err}");
        // Nor does a digest that does not match the body.
        let err = verify_signature(&resolver, &db, "did:ad:k", &parts, b"{}", now_ms(at))
            .await
            .unwrap_err();
        assert!(err.0.contains("Digest"), "{err}");
        assert_eq!(fake.fetches.load(Ordering::SeqCst), 2);

        // The sender rotates its key. The cached key fails; once it is a
        // minute old, it is fetched again and the new key verifies.
        let rotated = ed25519_dalek::SigningKey::generate(&mut rand::rngs::OsRng);
        *fake.document.lock().unwrap() = actor(&rotated);
        let later = at + std::time::Duration::from_secs(30);
        let parts2 = signed_parts(&rotated, body, later);
        assert!(
            verify_signature(&resolver, &db, "did:ad:i", &parts2, body, now_ms(later))
                .await
                .is_err()
        );
        assert_eq!(
            fake.fetches.load(Ordering::SeqCst),
            2,
            "not refetched within a minute"
        );
        let later = at + std::time::Duration::from_secs(90);
        let parts2 = signed_parts(&rotated, body, later);
        verify_signature(&resolver, &db, "did:ad:i", &parts2, body, now_ms(later))
            .await
            .unwrap();
        assert_eq!(fake.fetches.load(Ordering::SeqCst), 3);
    }

    #[tokio::test]
    async fn missing_keys_are_cached_briefly() {
        let db = Db::init_temp("route_auth_negative").await.unwrap();
        let key = ed25519_dalek::SigningKey::generate(&mut rand::rngs::OsRng);
        let fake = Arc::new(Fake {
            document: Mutex::new(Vec::new()),
            fetches: AtomicUsize::new(0),
        });
        let resolver = KeyResolver::new(fake.clone());
        let body = b"{}";
        let at = std::time::SystemTime::now();
        let parts = signed_parts(&key, body, at);
        for _ in 0..3 {
            let err = verify_signature(&resolver, &db, "did:ad:i", &parts, body, now_ms(at))
                .await
                .unwrap_err();
            assert!(err.0.contains("could not be used"), "{err}");
        }
        assert_eq!(fake.fetches.load(Ordering::SeqCst), 1, "negative cache");
        *fake.document.lock().unwrap() = actor(&key);
        let later = at + std::time::Duration::from_millis(NEGATIVE_TTL_MS as u64 + 1000);
        let parts = signed_parts(&key, body, later);
        verify_signature(&resolver, &db, "did:ad:i", &parts, body, now_ms(later))
            .await
            .unwrap();
        assert_eq!(fake.fetches.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn key_documents_must_name_the_key_and_an_owner_on_its_origin() {
        let key = ed25519_dalek::SigningKey::generate(&mut rand::rngs::OsRng);
        let pem = PublicKey::Ed25519(key.verifying_key()).to_pem();
        let id = url::Url::parse("https://remote.example/users/bob#main-key").unwrap();
        // The key document itself.
        let doc = json!({"id": id.as_str(), "owner": "https://remote.example/users/bob", "publicKeyPem": pem});
        assert_eq!(
            key_from_document(doc.to_string().as_bytes(), &id)
                .unwrap()
                .1,
            "https://remote.example/users/bob"
        );
        // Another key's id.
        let doc = json!({"publicKey": {"id": "https://remote.example/users/bob#other", "owner": "https://remote.example/users/bob", "publicKeyPem": pem}});
        assert!(key_from_document(doc.to_string().as_bytes(), &id).is_err());
        // An owner on another origin.
        let doc = json!({"publicKey": {"id": id.as_str(), "owner": "https://evil.example/users/bob", "publicKeyPem": pem}});
        assert!(key_from_document(doc.to_string().as_bytes(), &id)
            .unwrap_err()
            .contains("another origin"));
        assert!(key_from_document(b"<html>", &id).is_err());
    }

    #[tokio::test]
    async fn key_fetches_go_through_the_egress_guard() {
        // The real fetcher refuses what a keyId must never reach: loopback,
        // private ranges, metadata endpoints.
        for url in [
            "http://127.0.0.1:9883/users/bob",
            "http://10.0.0.1/users/bob",
            "http://169.254.169.254/latest/meta-data",
            "http://[::1]/users/bob",
            "http://user:pass@example.com/users/bob",
        ] {
            let err = EgressFetch
                .fetch(&url::Url::parse(url).unwrap())
                .await
                .unwrap_err();
            assert!(
                err.contains("refused") || err.contains("credentials"),
                "{url}: {err}"
            );
        }
        // And a refused keyId is remembered as missing, not fetched again.
        let db = Db::init_temp("route_auth_egress").await.unwrap();
        let resolver = KeyResolver::default();
        let err = resolver
            .resolve(&db, "did:ad:i", "http://127.0.0.1:1/k#main-key", 0)
            .await
            .err()
            .unwrap();
        assert!(err.0.contains("refused"), "{err}");
        assert!(matches!(
            resolver.cached("did:ad:i", "http://127.0.0.1:1/k#main-key", 1),
            Some(Cached::Missing { .. })
        ));
    }
}
