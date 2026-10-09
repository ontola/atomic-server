//! Optional OIDC sign-in for self-hosted servers. Off unless
//! `--oidc-issuer` / `ATOMIC_OIDC_ISSUER` is set.
//!
//! The design, and why it looks like this, is in `planning/oidc-sign-in.md`.
//! In short: the server proves *who the user is at the identity provider*
//! (authorization code + PKCE, ID token validated here), then lets that proof
//! link one agent to that identity and release the identity's client-encrypted
//! recovery blob. The private key never reaches the server, and the proof is
//! not a login session: requests are still authorised by signed agent requests.

pub mod jose;
pub mod links;

use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use ring::{digest, rand::SecureRandom};
use serde::Deserialize;
use serde_json::{Map, Value};

const DISCOVERY_TTL: Duration = Duration::from_secs(3600);
const JWKS_TTL: Duration = Duration::from_secs(3600);
const JWKS_FORCED_REFRESH_EVERY: Duration = Duration::from_secs(60);
const PENDING_TTL: Duration = Duration::from_secs(600);
const TICKET_TTL: Duration = Duration::from_secs(300);
const MAX_PENDING: usize = 10_000;
const MAX_TICKETS: usize = 10_000;
const MAX_TICKET_USES: u32 = 20;
const MAX_RESPONSE_BYTES: usize = 256 * 1024;
const HTTP_TIMEOUT: Duration = Duration::from_secs(10);
const CLOCK_LEEWAY_SECS: i64 = 60;
pub const COOKIE_NAME: &str = "atomic_oidc";

/// A string that never prints. The client secret travels through `Opts`, which
/// derives `Debug` and is printed on startup problems.
#[derive(Clone)]
pub struct Redacted(pub String);

impl std::fmt::Debug for Redacted {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "<redacted>")
    }
}

impl std::str::FromStr for Redacted {
    type Err = std::convert::Infallible;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Ok(Redacted(s.to_string()))
    }
}

/// Validated, ready-to-use configuration.
#[derive(Clone)]
pub struct OidcSettings {
    pub issuer: String,
    pub client_id: String,
    pub client_secret: Option<String>,
    pub name: String,
    pub scopes: Vec<String>,
    pub redirect_url: String,
    pub allowed_email_domains: Vec<String>,
    pub required_claims: Vec<(String, String)>,
}

impl std::fmt::Debug for OidcSettings {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("OidcSettings")
            .field("issuer", &self.issuer)
            .field("client_id", &self.client_id)
            .field(
                "client_secret",
                &self.client_secret.as_ref().map(|_| "<redacted>"),
            )
            .field("name", &self.name)
            .finish_non_exhaustive()
    }
}

/// `https`, or `http` for a loopback host (a local Keycloak, the test mock).
fn is_acceptable_url(raw: &str) -> bool {
    let Ok(url) = url::Url::parse(raw) else {
        return false;
    };

    match url.scheme() {
        "https" => url.host_str().is_some(),
        "http" => match url.host() {
            Some(url::Host::Domain(d)) => d == "localhost",
            Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
            Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
            None => false,
        },
        _ => false,
    }
}

impl OidcSettings {
    /// `Ok(None)` when OIDC is not configured. An error when it is half
    /// configured or malformed: a server that silently skipped sign-in the
    /// operator thought they had enabled is worse than one that refuses to start.
    pub fn from_opts(
        opts: &crate::config::Opts,
        origin: &str,
    ) -> Result<Option<OidcSettings>, String> {
        let Some(issuer) = opts
            .oidc_issuer
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        else {
            if opts.oidc_client_id.is_some() || opts.oidc_client_secret.is_some() {
                return Err(
                    "ATOMIC_OIDC_CLIENT_ID / ATOMIC_OIDC_CLIENT_SECRET are set but ATOMIC_OIDC_ISSUER is not"
                        .into(),
                );
            }

            return Ok(None);
        };

        if !is_acceptable_url(issuer) {
            return Err(format!(
                "ATOMIC_OIDC_ISSUER must be an https URL (http only for localhost), got '{issuer}'"
            ));
        }

        let client_id = opts
            .oidc_client_id
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .ok_or("ATOMIC_OIDC_CLIENT_ID is required when ATOMIC_OIDC_ISSUER is set")?
            .to_string();

        let client_secret = opts
            .oidc_client_secret
            .as_ref()
            .map(|s| s.0.clone())
            .filter(|s| !s.is_empty());

        let host = url::Url::parse(issuer)
            .ok()
            .and_then(|u| u.host_str().map(str::to_string))
            .unwrap_or_else(|| "SSO".into());
        let name = opts
            .oidc_name
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .unwrap_or(host);

        let mut scopes: Vec<String> = opts
            .oidc_scopes
            .split_whitespace()
            .map(str::to_string)
            .collect();

        if !scopes.iter().any(|s| s == "openid") {
            scopes.insert(0, "openid".into());
        }

        let redirect_url = opts
            .oidc_redirect_url
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| format!("{origin}/oidc/callback"));

        if !is_acceptable_url(&redirect_url) {
            return Err(format!(
                "ATOMIC_OIDC_REDIRECT_URL must be an https URL (http only for localhost), got '{redirect_url}'"
            ));
        }

        let mut required_claims = Vec::new();

        for entry in &opts.oidc_required_claims {
            let (k, v) = entry
                .split_once('=')
                .filter(|(k, _)| !k.trim().is_empty())
                .ok_or_else(|| {
                    format!(
                        "ATOMIC_OIDC_REQUIRED_CLAIMS entries look like name=value, got '{entry}'"
                    )
                })?;
            required_claims.push((k.trim().to_string(), v.trim().to_string()));
        }

        Ok(Some(OidcSettings {
            issuer: issuer.to_string(),
            client_id,
            client_secret,
            name,
            scopes,
            redirect_url,
            allowed_email_domains: opts
                .oidc_allowed_email_domains
                .iter()
                .map(|d| d.trim().trim_start_matches('@').to_lowercase())
                .filter(|d| !d.is_empty())
                .collect(),
            required_claims,
        }))
    }

    fn cookie_secure(&self) -> bool {
        self.redirect_url.starts_with("https://")
    }
}

/// Why a sign-in failed, as shown to the browser. Fixed vocabulary: provider
/// text is never reflected.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Failure {
    Denied,
    Expired,
    Policy,
    Provider,
}

impl Failure {
    pub fn code(self) -> &'static str {
        match self {
            Failure::Denied => "denied",
            Failure::Expired => "expired",
            Failure::Policy => "policy",
            Failure::Provider => "provider",
        }
    }
}

#[derive(Debug, Deserialize)]
struct Discovery {
    issuer: String,
    authorization_endpoint: String,
    token_endpoint: String,
    jwks_uri: String,
    #[serde(default)]
    token_endpoint_auth_methods_supported: Vec<String>,
}

struct Pending {
    nonce: String,
    verifier: String,
    binding: String,
    return_to: String,
    expires: Instant,
}

/// The proven identity behind a ticket. Never leaves the process.
#[derive(Clone)]
pub struct Proof {
    pub issuer: String,
    pub sub: String,
}

struct Ticket {
    proof: Proof,
    expires: Instant,
    uses: u32,
}

#[derive(Default)]
struct Cache {
    discovery: Option<(Instant, Arc<Discovery>)>,
    jwks: Option<(Instant, Arc<jose::Jwks>)>,
    last_forced_refresh: Option<Instant>,
}

pub struct Oidc {
    pub settings: OidcSettings,
    http: reqwest::Client,
    cache: tokio::sync::Mutex<Cache>,
    pending: Mutex<HashMap<String, Pending>>,
    tickets: Mutex<HashMap<String, Ticket>>,
}

pub struct Begin {
    /// Where to send the browser.
    pub location: String,
    /// Value for the `atomic_oidc` cookie.
    pub binding: String,
}

pub struct Finished {
    /// A validated same-origin path.
    pub return_to: String,
    pub result: Result<String, Failure>,
}

fn random_token(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    ring::rand::SystemRandom::new()
        .fill(&mut buf)
        .expect("system randomness");
    URL_SAFE_NO_PAD.encode(buf)
}

fn sha256_hex(s: &str) -> String {
    hex::encode(digest::digest(&digest::SHA256, s.as_bytes()).as_ref())
}

fn unix_now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Reduces a user-supplied post-login destination to a path on this server.
/// Anything that could leave the origin, or be read as something other than a
/// plain path by a browser, becomes `/`.
pub fn sanitize_return(raw: &str, origin: &str) -> String {
    const FALLBACK: &str = "/";

    if raw.is_empty()
        || raw.len() > 2048
        || !raw.starts_with('/')
        || raw.starts_with("//")
        || raw.contains('\\')
        || raw.chars().any(|c| c.is_control())
    {
        return FALLBACK.into();
    }

    let Ok(base) = url::Url::parse(origin) else {
        return FALLBACK.into();
    };
    let Ok(joined) = base.join(raw) else {
        return FALLBACK.into();
    };

    if joined.origin() != base.origin() {
        return FALLBACK.into();
    }

    let mut out = joined.path().to_string();

    if let Some(q) = joined.query() {
        out.push('?');
        out.push_str(q);
    }

    // `url` normalises `/a/../b`; a result that starts `//` would be
    // protocol-relative once placed in a Location header.
    if out.starts_with("//") {
        return FALLBACK.into();
    }

    out
}

/// Email domain and required-claim policy. Admission only: neither is ever
/// used to identify or find a user.
pub fn check_policy(s: &OidcSettings, claims: &Map<String, Value>) -> Result<(), Failure> {
    if !s.allowed_email_domains.is_empty() {
        let unverified = match claims.get("email_verified") {
            Some(Value::Bool(false)) => true,
            Some(Value::String(v)) => v == "false",
            _ => false,
        };
        let verified = !unverified;
        let email = claims.get("email").and_then(Value::as_str).unwrap_or("");
        let domain = email.rsplit_once('@').map(|(_, d)| d.to_lowercase());

        match domain {
            Some(d) if verified && s.allowed_email_domains.iter().any(|a| a == &d) => {}
            _ => return Err(Failure::Policy),
        }
    }

    for (name, want) in &s.required_claims {
        let ok = match claims.get(name) {
            Some(Value::String(v)) => v == want,
            Some(Value::Array(items)) => items.iter().any(|i| match i {
                Value::String(v) => v == want,
                other => &other.to_string() == want,
            }),
            Some(Value::Bool(b)) => &b.to_string() == want,
            Some(Value::Number(n)) => &n.to_string() == want,
            _ => false,
        };

        if !ok {
            return Err(Failure::Policy);
        }
    }

    Ok(())
}

impl Oidc {
    pub fn new(settings: OidcSettings) -> Result<Oidc, String> {
        let http = reqwest::Client::builder()
            .timeout(HTTP_TIMEOUT)
            .redirect(reqwest::redirect::Policy::none())
            .user_agent(concat!("atomic-server/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|e| format!("Could not build the OIDC HTTP client: {e}"))?;

        Ok(Oidc {
            settings,
            http,
            cache: Default::default(),
            pending: Default::default(),
            tickets: Default::default(),
        })
    }

    async fn get_capped(&self, url: &str) -> Result<Vec<u8>, Failure> {
        let resp = self.http.get(url).send().await.map_err(|e| {
            tracing::warn!("OIDC request failed: {}", e.without_url());
            Failure::Provider
        })?;

        Self::read_capped(resp).await
    }

    async fn read_capped(mut resp: reqwest::Response) -> Result<Vec<u8>, Failure> {
        if !resp.status().is_success() {
            tracing::warn!("OIDC provider answered {}", resp.status());
            return Err(Failure::Provider);
        }

        let mut buf = Vec::new();

        while let Some(chunk) = resp.chunk().await.map_err(|_| Failure::Provider)? {
            buf.extend_from_slice(&chunk);

            if buf.len() > MAX_RESPONSE_BYTES {
                tracing::warn!("OIDC provider response too large");
                return Err(Failure::Provider);
            }
        }

        Ok(buf)
    }

    async fn discovery(&self) -> Result<Arc<Discovery>, Failure> {
        {
            let cache = self.cache.lock().await;

            if let Some((at, d)) = &cache.discovery {
                if at.elapsed() < DISCOVERY_TTL {
                    return Ok(d.clone());
                }
            }
        }

        let url = format!(
            "{}/.well-known/openid-configuration",
            self.settings.issuer.trim_end_matches('/')
        );
        let doc: Discovery =
            serde_json::from_slice(&self.get_capped(&url).await?).map_err(|_| Failure::Provider)?;

        // The document must describe the issuer we were configured for, and
        // every URL we will call must be one we would accept configured.
        if doc.issuer != self.settings.issuer
            || !is_acceptable_url(&doc.authorization_endpoint)
            || !is_acceptable_url(&doc.token_endpoint)
            || !is_acceptable_url(&doc.jwks_uri)
        {
            tracing::warn!("OIDC discovery document does not match the configured issuer");
            return Err(Failure::Provider);
        }

        let doc = Arc::new(doc);
        self.cache.lock().await.discovery = Some((Instant::now(), doc.clone()));

        Ok(doc)
    }

    async fn jwks(&self, force: bool) -> Result<Arc<jose::Jwks>, Failure> {
        {
            let mut cache = self.cache.lock().await;

            if let Some((at, j)) = &cache.jwks {
                let fresh = at.elapsed() < JWKS_TTL;
                let may_force = cache
                    .last_forced_refresh
                    .map(|t| t.elapsed() >= JWKS_FORCED_REFRESH_EVERY)
                    .unwrap_or(true);

                if fresh && !(force && may_force) {
                    return Ok(j.clone());
                }
            }

            if force {
                cache.last_forced_refresh = Some(Instant::now());
            }
        }

        let discovery = self.discovery().await?;
        let jwks: jose::Jwks = serde_json::from_slice(&self.get_capped(&discovery.jwks_uri).await?)
            .map_err(|_| Failure::Provider)?;
        let jwks = Arc::new(jwks);
        self.cache.lock().await.jwks = Some((Instant::now(), jwks.clone()));

        Ok(jwks)
    }

    /// Step 1: where to send the browser, and the cookie that binds this
    /// attempt to it.
    pub async fn begin(&self, return_to: String) -> Result<Begin, Failure> {
        let discovery = self.discovery().await?;
        let state = random_token(32);
        let nonce = random_token(32);
        let verifier = random_token(48);
        let binding = random_token(32);
        let challenge =
            URL_SAFE_NO_PAD.encode(digest::digest(&digest::SHA256, verifier.as_bytes()));

        let mut url =
            url::Url::parse(&discovery.authorization_endpoint).map_err(|_| Failure::Provider)?;
        url.query_pairs_mut()
            .append_pair("response_type", "code")
            .append_pair("client_id", &self.settings.client_id)
            .append_pair("redirect_uri", &self.settings.redirect_url)
            .append_pair("scope", &self.settings.scopes.join(" "))
            .append_pair("state", &state)
            .append_pair("nonce", &nonce)
            .append_pair("code_challenge", &challenge)
            .append_pair("code_challenge_method", "S256");

        {
            let mut pending = self.pending.lock().unwrap_or_else(|e| e.into_inner());
            let now = Instant::now();
            pending.retain(|_, p| p.expires > now);

            if pending.len() >= MAX_PENDING {
                return Err(Failure::Provider);
            }

            pending.insert(
                state,
                Pending {
                    nonce,
                    verifier,
                    binding: binding.clone(),
                    return_to,
                    expires: now + PENDING_TTL,
                },
            );
        }

        Ok(Begin {
            location: url.to_string(),
            binding,
        })
    }

    /// Step 2: the provider's redirect back. `error` is the provider's
    /// `error` parameter, if any. `None` means the state itself is unknown or
    /// reused, which gets no redirect at all.
    pub async fn finish(
        &self,
        code: Option<&str>,
        state: &str,
        provider_error: Option<&str>,
        cookie_binding: Option<&str>,
    ) -> Option<Finished> {
        let pending = {
            let mut map = self.pending.lock().unwrap_or_else(|e| e.into_inner());
            map.remove(state)?
        };

        // Login CSRF: this browser must be the one that started the flow.
        let bound = cookie_binding
            .map(|c| jose::constant_time_eq(c, &pending.binding))
            .unwrap_or(false);

        if !bound {
            return None;
        }

        let return_to = pending.return_to.clone();

        if pending.expires <= Instant::now() {
            return Some(Finished {
                return_to,
                result: Err(Failure::Expired),
            });
        }

        let result = async {
            if provider_error.is_some() {
                return Err(Failure::Denied);
            }

            let code = code.filter(|c| !c.is_empty()).ok_or(Failure::Denied)?;
            let claims = self.redeem(code, &pending).await?;
            check_policy(&self.settings, &claims)?;

            let sub = claims
                .get("sub")
                .and_then(Value::as_str)
                .ok_or(Failure::Provider)?
                .to_string();

            Ok(self.mint_ticket(Proof {
                issuer: self.settings.issuer.clone(),
                sub,
            }))
        }
        .await;

        Some(Finished { return_to, result })
    }

    async fn redeem(&self, code: &str, pending: &Pending) -> Result<Map<String, Value>, Failure> {
        let discovery = self.discovery().await?;
        let s = &self.settings;

        let mut body = vec![
            ("grant_type", "authorization_code"),
            ("code", code),
            ("redirect_uri", s.redirect_url.as_str()),
            ("code_verifier", pending.verifier.as_str()),
        ];

        let methods = &discovery.token_endpoint_auth_methods_supported;
        let use_basic = s.client_secret.is_some()
            && (methods.is_empty() || methods.iter().any(|m| m == "client_secret_basic"));

        let mut req = self
            .http
            .post(&discovery.token_endpoint)
            .header("Accept", "application/json");

        match (&s.client_secret, use_basic) {
            (Some(secret), true) => {
                req = req.basic_auth(
                    urlencoding::encode(&s.client_id).into_owned(),
                    Some(urlencoding::encode(secret).into_owned()),
                );
            }
            (Some(secret), false) => {
                body.push(("client_id", s.client_id.as_str()));
                body.push(("client_secret", secret.as_str()));
            }
            (None, _) => body.push(("client_id", s.client_id.as_str())),
        }

        let encoded = body
            .iter()
            .map(|(k, v)| format!("{}={}", urlencoding::encode(k), urlencoding::encode(v)))
            .collect::<Vec<_>>()
            .join("&");

        let resp = req
            .header("Content-Type", "application/x-www-form-urlencoded")
            .body(encoded)
            .send()
            .await
            .map_err(|e| {
                tracing::warn!("OIDC token request failed: {}", e.without_url());
                Failure::Provider
            })?;

        #[derive(Deserialize)]
        struct TokenResponse {
            id_token: String,
        }

        let tokens: TokenResponse = serde_json::from_slice(&Self::read_capped(resp).await?)
            .map_err(|_| Failure::Provider)?;

        let validation = |now: i64| jose::Validation {
            issuer: &s.issuer,
            client_id: &s.client_id,
            nonce: &pending.nonce,
            now,
            leeway_secs: CLOCK_LEEWAY_SECS,
        };

        let jwks = self.jwks(false).await?;

        match jose::verify_id_token(&tokens.id_token, &jwks, &validation(unix_now())) {
            Ok(claims) => Ok(claims),
            // A rotated key: refresh once (rate limited) and try again.
            Err(jose::JoseError::UnknownKey) => {
                let jwks = self.jwks(true).await?;

                jose::verify_id_token(&tokens.id_token, &jwks, &validation(unix_now())).map_err(
                    |e| {
                        tracing::warn!("OIDC ID token rejected: {e}");
                        Failure::Provider
                    },
                )
            }
            Err(e) => {
                tracing::warn!("OIDC ID token rejected: {e}");
                Err(Failure::Provider)
            }
        }
    }

    fn mint_ticket(&self, proof: Proof) -> String {
        let ticket = random_token(32);
        let mut tickets = self.tickets.lock().unwrap_or_else(|e| e.into_inner());
        let now = Instant::now();
        tickets.retain(|_, t| t.expires > now);

        if tickets.len() >= MAX_TICKETS {
            // Oldest-first eviction is not worth the bookkeeping; a flood of
            // real logins this large is not a normal day.
            tickets.clear();
        }

        tickets.insert(
            sha256_hex(&ticket),
            Ticket {
                proof,
                expires: now + TICKET_TTL,
                uses: 0,
            },
        );

        ticket
    }

    /// Looks a ticket up for one operation. Counts the use; an expired or
    /// over-used ticket is gone.
    pub fn use_ticket(&self, ticket: &str) -> Option<Proof> {
        let key = sha256_hex(ticket);
        let mut tickets = self.tickets.lock().unwrap_or_else(|e| e.into_inner());
        let t = tickets.get_mut(&key)?;

        if t.expires <= Instant::now() || t.uses >= MAX_TICKET_USES {
            tickets.remove(&key);
            return None;
        }

        t.uses += 1;
        Some(t.proof.clone())
    }

    /// A ticket buys one successful state change.
    pub fn consume_ticket(&self, ticket: &str) {
        self.tickets
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&sha256_hex(ticket));
    }

    pub fn cookie_header(&self, binding: &str, clear: bool) -> String {
        let secure = if self.settings.cookie_secure() {
            "; Secure"
        } else {
            ""
        };
        let (value, max_age) = if clear {
            ("", 0)
        } else {
            (binding, PENDING_TTL.as_secs())
        };

        format!(
            "{COOKIE_NAME}={value}; Path=/oidc; Max-Age={max_age}; HttpOnly; SameSite=Lax{secure}"
        )
    }

    /// The message an agent signs to prove it holds its key when linking.
    pub fn link_message(ticket: &str, agent: &str) -> String {
        format!("atomic-oidc-link:v1:{ticket}:{agent}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn settings() -> OidcSettings {
        OidcSettings {
            issuer: "https://idp.example".into(),
            client_id: "c".into(),
            client_secret: None,
            name: "Corp".into(),
            scopes: vec!["openid".into()],
            redirect_url: "https://app.example/oidc/callback".into(),
            allowed_email_domains: vec![],
            required_claims: vec![],
        }
    }

    const ORIGIN: &str = "https://app.example";

    #[test]
    fn return_path_cannot_leave_the_origin() {
        for evil in [
            "https://evil.example/x",
            "//evil.example",
            "///evil.example",
            "/\\evil.example",
            "\\\\evil.example",
            "/\t/evil.example",
            "/%0d%0aSet-Cookie:x",
            "javascript:alert(1)",
            "evil.example",
            "",
            "/a\nb",
            "/../../..//evil.example",
        ] {
            let got = sanitize_return(evil, ORIGIN);
            assert!(
                got.starts_with('/') && !got.starts_with("//") && !got.contains('\\'),
                "{evil} -> {got}"
            );
            assert!(
                url::Url::parse(ORIGIN)
                    .unwrap()
                    .join(&got)
                    .unwrap()
                    .origin()
                    == url::Url::parse(ORIGIN).unwrap().origin(),
                "{evil} -> {got}"
            );
        }

        assert_eq!(sanitize_return("https://evil.example/x", ORIGIN), "/");
        assert_eq!(sanitize_return("//evil.example", ORIGIN), "/");
        assert_eq!(
            sanitize_return("/app/drive?x=1#frag", ORIGIN),
            "/app/drive?x=1"
        );
        assert_eq!(sanitize_return("/", ORIGIN), "/");
    }

    #[test]
    fn email_domain_policy_needs_a_verified_matching_email() {
        let mut s = settings();
        s.allowed_email_domains = vec!["example.org".into()];

        let ok = |c: Value| check_policy(&s, c.as_object().unwrap());

        assert!(ok(json!({"email":"a@example.org"})).is_ok());
        assert!(ok(json!({"email":"a@EXAMPLE.org","email_verified":true})).is_ok());
        assert!(ok(json!({"email":"a@evil.org"})).is_err());
        assert!(ok(json!({"email":"a@example.org","email_verified":false})).is_err());
        assert!(ok(json!({"email":"a@example.org","email_verified":"false"})).is_err());
        assert!(ok(json!({})).is_err());
        assert!(ok(json!({"email":"a@sub.example.org"})).is_err());
        assert!(ok(json!({"email":"example.org"})).is_err());
    }

    #[test]
    fn required_claims_match_strings_and_array_members() {
        let mut s = settings();
        s.required_claims = vec![
            ("groups".into(), "atomic".into()),
            ("tid".into(), "t1".into()),
        ];

        let ok = |c: Value| check_policy(&s, c.as_object().unwrap());

        assert!(ok(json!({"groups":["a","atomic"],"tid":"t1"})).is_ok());
        assert!(ok(json!({"groups":["a"],"tid":"t1"})).is_err());
        assert!(ok(json!({"groups":"atomic","tid":"t1"})).is_ok());
        assert!(ok(json!({"groups":["atomic"]})).is_err());
        assert!(check_policy(&settings(), &Map::new()).is_ok());
    }

    #[test]
    fn tickets_expire_by_use_count_and_are_consumed() {
        let oidc = Oidc::new(settings()).unwrap();
        let t = oidc.mint_ticket(Proof {
            issuer: "i".into(),
            sub: "s".into(),
        });

        assert!(oidc.use_ticket("not-a-ticket").is_none());

        for _ in 0..MAX_TICKET_USES {
            assert_eq!(oidc.use_ticket(&t).unwrap().sub, "s");
        }

        assert!(oidc.use_ticket(&t).is_none());

        let t = oidc.mint_ticket(Proof {
            issuer: "i".into(),
            sub: "s".into(),
        });
        oidc.consume_ticket(&t);
        assert!(oidc.use_ticket(&t).is_none());
    }

    #[test]
    fn settings_debug_never_prints_the_secret() {
        let mut s = settings();
        s.client_secret = Some("hunter2".into());
        assert!(!format!("{s:?}").contains("hunter2"));
        assert!(!format!("{:?}", Redacted("hunter2".into())).contains("hunter2"));
    }

    #[test]
    fn only_secure_or_loopback_urls_are_accepted() {
        assert!(is_acceptable_url("https://login.example/x"));
        assert!(is_acceptable_url("http://localhost:8080/realms/x"));
        assert!(is_acceptable_url("http://127.0.0.1:1/x"));
        assert!(!is_acceptable_url("http://idp.example"));
        assert!(!is_acceptable_url("ftp://idp.example"));
        assert!(!is_acceptable_url("not a url"));
    }
}
