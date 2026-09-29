//! `auth: dpop`: Solid-OIDC access tokens bound to DPoP proofs, verified by
//! the host before a plugin route's sandbox starts (atomic-plugins#167,
//! section 3; [Solid-OIDC](https://solidproject.org/TR/oidc) and
//! [RFC 9449](https://www.rfc-editor.org/rfc/rfc9449)).
//!
//! A request with `Authorization: DPoP <access token>` and a `DPoP` proof is
//! verified here:
//!
//! - **The proof** (RFC 9449 section 4.3): `typ: dpop+jwt`, a supported
//!   `alg`, a public `jwk` (no private members) that verifies the signature,
//!   `htm` equal to the request method, `htu` equal to the request URL as
//!   *this node* names it (built from the operator's configured origins,
//!   never from `Host` or `Forwarded` headers; query and fragment ignored),
//!   `iat` at most [`PROOF_MAX_AGE_SECS`] old and at most
//!   [`PROOF_MAX_FUTURE_SECS`] ahead, a `jti` accepted once
//!   ([`crate::replay_cache`]), and `ath` equal to the token's hash when the
//!   client sent one.
//! - **The access token**: its `iss` must be one of the operator's
//!   `--solid-oidc-issuers`, exactly. Its signature must verify against a key
//!   of that issuer's JWKS, found through
//!   `<iss>/.well-known/openid-configuration` (whose `issuer` must be `iss`).
//!   `exp` in the future and `nbf`/`iat` not in the future (both with
//!   [`TOKEN_LEEWAY_SECS`]), `aud` containing `solid`, `cnf.jkt` equal to
//!   the RFC 7638 thumbprint of the proof's key, and a `webid`.
//! - **The WebID**: its profile (Turtle only) must list `iss` as a
//!   `solid:oidcIssuer` of that WebID.
//!
//! The handler then gets `request.caller = { scheme: "dpop", webid, issuer,
//! clientId, jkt }`. A request with neither header is *not* refused: it runs
//! as the anonymous principal with `caller: null`, and the host refuses any
//! write it proposes (see `route_exec`), so a Solid resource server can
//! answer public reads and ask for authentication (`401`) itself. Anything
//! else — a `Bearer` token, a token without a proof, a bad proof or token —
//! is a `401` from the host.
//!
//! A verified WebID is who is asking, not what they may do: the handler
//! decides that (WAC/ACP), and the host still limits reads to the route's
//! principal and writes to the installation's approved write targets.
//!
//! **Not done here**: server-provided DPoP nonces, open issuer discovery (an
//! issuer must be on the operator's list), JSON-LD WebID profiles, token
//! introspection or revocation, and refresh. Fetches of issuer metadata,
//! JWKS and WebID profiles go through the egress guard (public addresses
//! only), except fetches on the origin of a configured issuer, which the
//! operator vouched for and which may be on loopback (a development issuer).
//! Documents are cached for [`DOC_TTL_MS`]; an unknown `kid` refetches the
//! issuer's JWKS at most once a minute.

use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD as B64URL, Engine};
use serde_json::{json, Value as Json};

use super::{egress, host_core, http_signatures::Refused};

/// How old a proof's `iat` may be.
pub const PROOF_MAX_AGE_SECS: i64 = 120;
/// How far ahead of this node's clock a proof's `iat` may be.
pub const PROOF_MAX_FUTURE_SECS: i64 = 60;
/// Clock leeway for the token's `exp`, `nbf` and `iat`.
pub const TOKEN_LEEWAY_SECS: i64 = 60;
/// How long issuer metadata, JWKS and WebID profiles are cached.
pub const DOC_TTL_MS: i64 = 10 * 60 * 1000;
/// A cached JWKS without the wanted `kid` is refetched at most this often.
pub const JWKS_REFETCH_MS: i64 = 60 * 1000;
/// Largest document fetched (metadata, JWKS, profile).
pub const MAX_DOC_BYTES: usize = 64 * 1024;
/// Fetch deadline.
pub const FETCH_TIMEOUT_SECS: u64 = 5;
/// Largest access token or proof accepted.
pub const MAX_JWT_BYTES: usize = 16 * 1024;
/// Longest `jti`.
pub const MAX_JTI_CHARS: usize = 256;

const SOLID_OIDC_ISSUER: &str = "http://www.w3.org/ns/solid/terms#oidcIssuer";

fn refused(reason: impl Into<String>) -> Refused {
    Refused(reason.into())
}

/// An issuer as compared: without a trailing slash.
fn normalize_issuer(issuer: &str) -> String {
    issuer.trim().trim_end_matches('/').to_string()
}

/// The operator's trusted Solid-OIDC issuers (`--solid-oidc-issuers`,
/// comma-separated `http(s)` origins or URLs).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Issuers(Vec<String>);

impl Issuers {
    pub fn parse(raw: Option<&str>) -> Result<Self, String> {
        let mut out = Vec::new();
        for item in raw.unwrap_or("").split(',').map(str::trim) {
            if item.is_empty() {
                continue;
            }
            let url = url::Url::parse(item)
                .map_err(|_| format!("Solid-OIDC issuer `{item}` is not a URL"))?;
            if !matches!(url.scheme(), "http" | "https")
                || url.host_str().is_none()
                || url.query().is_some()
                || url.fragment().is_some()
            {
                return Err(format!(
                    "Solid-OIDC issuer `{item}` must be an http(s) URL without query or fragment"
                ));
            }
            let issuer = normalize_issuer(item);
            if !out.contains(&issuer) {
                out.push(issuer);
            }
        }
        Ok(Self(out))
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    fn contains(&self, issuer: &str) -> bool {
        let issuer = normalize_issuer(issuer);
        self.0.iter().any(|i| *i == issuer)
    }

    /// Origins of the configured issuers: fetches there may reach loopback.
    fn origins(&self) -> Vec<String> {
        self.0
            .iter()
            .filter_map(|i| url::Url::parse(i).ok())
            .map(|u| u.origin().ascii_serialization())
            .collect()
    }
}

// -- fetching -------------------------------------------------------------------

/// Fetches a document for verification. The real one is [`GuardedFetch`].
#[async_trait::async_trait]
pub trait DocFetch: Send + Sync {
    async fn fetch(&self, url: &url::Url, accept: &str) -> Result<Vec<u8>, String>;
}

/// Public addresses only through the egress guard, except the origins of
/// configured issuers; no redirects, [`FETCH_TIMEOUT_SECS`], [`MAX_DOC_BYTES`].
pub struct GuardedFetch {
    trusted: Vec<String>,
}

impl GuardedFetch {
    pub fn new(issuers: &Issuers) -> Self {
        Self {
            trusted: issuers.origins(),
        }
    }
}

#[async_trait::async_trait]
impl DocFetch for GuardedFetch {
    async fn fetch(&self, url: &url::Url, accept: &str) -> Result<Vec<u8>, String> {
        if !matches!(url.scheme(), "http" | "https") {
            return Err("only http(s) documents are fetched".into());
        }
        let origin = egress::origin_of(url)?;
        let mut builder = reqwest::Client::builder()
            .no_proxy()
            .timeout(std::time::Duration::from_secs(FETCH_TIMEOUT_SECS))
            .redirect(reqwest::redirect::Policy::none());
        if !self.trusted.contains(&url.origin().ascii_serialization()) {
            let addresses = egress::checked_addresses(url).await?;
            let host = url.host_str().ok_or("URL has no host")?;
            builder = builder.resolve_to_addrs(host, &addresses);
        }
        let client = builder
            .build()
            .map_err(|e| format!("could not build an HTTP client: {e}"))?;
        let response = client
            .get(url.clone())
            .header("accept", accept)
            .send()
            .await
            .map_err(|e| format!("could not fetch {url}: {e}"))?;
        if !response.status().is_success() {
            return Err(format!("{url} answered {}", response.status()));
        }
        host_core::read_capped(response.bytes_stream(), MAX_DOC_BYTES, &origin).await
    }
}

// -- JOSE -----------------------------------------------------------------------

/// A compact JWS, decoded but not yet verified.
pub struct Jws {
    pub header: Json,
    pub claims: Json,
    signing_input: String,
    signature: Vec<u8>,
}

pub fn decode_jws(token: &str) -> Result<Jws, String> {
    if token.len() > MAX_JWT_BYTES {
        return Err("the JWT is too large".into());
    }
    let mut parts = token.split('.');
    let (Some(h), Some(c), Some(s), None) = (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return Err("not a compact JWS".into());
    };
    let decode = |part: &str| B64URL.decode(part).map_err(|_| "not base64url".to_string());
    let header: Json =
        serde_json::from_slice(&decode(h)?).map_err(|_| "the JWS header is not JSON")?;
    let claims: Json =
        serde_json::from_slice(&decode(c)?).map_err(|_| "the JWS payload is not JSON")?;
    if !header.is_object() || !claims.is_object() {
        return Err("the JWS header and payload must be objects".into());
    }
    Ok(Jws {
        header,
        claims,
        signing_input: format!("{h}.{c}"),
        signature: decode(s)?,
    })
}

fn b64_member(jwk: &Json, name: &str) -> Result<Vec<u8>, String> {
    let value = jwk[name]
        .as_str()
        .ok_or_else(|| format!("the JWK has no `{name}`"))?;
    B64URL
        .decode(value)
        .map_err(|_| format!("the JWK's `{name}` is not base64url"))
}

/// Whether `jwk` carries private key members.
fn is_private(jwk: &Json) -> bool {
    ["d", "p", "q", "dp", "dq", "qi", "k"]
        .iter()
        .any(|m| jwk.get(m).is_some())
}

/// Verifies `jws` with `jwk` under `alg`. Supported: ES256, RS256, PS256,
/// EdDSA (Ed25519).
pub fn verify_with_jwk(jws: &Jws, jwk: &Json, alg: &str) -> Result<(), String> {
    use ring::signature::{self, RsaPublicKeyComponents, UnparsedPublicKey};
    let message = jws.signing_input.as_bytes();
    let kty = jwk["kty"].as_str().unwrap_or("");
    if let Some(key_alg) = jwk["alg"].as_str() {
        if key_alg != alg {
            return Err(format!("the key is for `{key_alg}`, not `{alg}`"));
        }
    }
    let bad = |_| "the signature does not verify".to_string();
    match (alg, kty) {
        ("ES256", "EC") => {
            if jwk["crv"] != "P-256" {
                return Err("ES256 needs a P-256 key".into());
            }
            let (x, y) = (b64_member(jwk, "x")?, b64_member(jwk, "y")?);
            if x.len() != 32 || y.len() != 32 {
                return Err("the P-256 key has the wrong size".into());
            }
            let mut point = vec![0x04];
            point.extend_from_slice(&x);
            point.extend_from_slice(&y);
            UnparsedPublicKey::new(&signature::ECDSA_P256_SHA256_FIXED, point)
                .verify(message, &jws.signature)
                .map_err(bad)
        }
        ("RS256" | "PS256", "RSA") => {
            let key = RsaPublicKeyComponents {
                n: b64_member(jwk, "n")?,
                e: b64_member(jwk, "e")?,
            };
            let params = if alg == "RS256" {
                &signature::RSA_PKCS1_2048_8192_SHA256
            } else {
                &signature::RSA_PSS_2048_8192_SHA256
            };
            key.verify(params, message, &jws.signature).map_err(bad)
        }
        ("EdDSA", "OKP") => {
            if jwk["crv"] != "Ed25519" {
                return Err("EdDSA needs an Ed25519 key".into());
            }
            UnparsedPublicKey::new(&signature::ED25519, b64_member(jwk, "x")?)
                .verify(message, &jws.signature)
                .map_err(bad)
        }
        ("ES256" | "RS256" | "PS256" | "EdDSA", _) => {
            Err(format!("a `{kty}` key cannot verify `{alg}`"))
        }
        _ => Err(format!("the algorithm `{alg}` is not supported")),
    }
}

/// The RFC 7638 thumbprint of a public JWK, base64url.
pub fn thumbprint(jwk: &Json) -> Result<String, String> {
    let member = |name: &str| {
        jwk[name]
            .as_str()
            .map(str::to_string)
            .ok_or_else(|| format!("the JWK has no `{name}`"))
    };
    // Required members only, in lexicographic order, no whitespace.
    let canonical = match jwk["kty"].as_str() {
        Some("EC") => format!(
            r#"{{"crv":{},"kty":"EC","x":{},"y":{}}}"#,
            Json::String(member("crv")?),
            Json::String(member("x")?),
            Json::String(member("y")?)
        ),
        Some("RSA") => format!(
            r#"{{"e":{},"kty":"RSA","n":{}}}"#,
            Json::String(member("e")?),
            Json::String(member("n")?)
        ),
        Some("OKP") => format!(
            r#"{{"crv":{},"kty":"OKP","x":{}}}"#,
            Json::String(member("crv")?),
            Json::String(member("x")?)
        ),
        _ => return Err("the JWK's `kty` is not supported".into()),
    };
    Ok(B64URL.encode(ring::digest::digest(&ring::digest::SHA256, canonical.as_bytes())))
}

/// The URL as a DPoP `htu` compares: without query and fragment.
fn htu_form(raw: &str) -> Option<String> {
    let mut url = url::Url::parse(raw).ok()?;
    if !matches!(url.scheme(), "http" | "https") {
        return None;
    }
    url.set_query(None);
    url.set_fragment(None);
    Some(url.to_string())
}

/// The Turtle profile's `solid:oidcIssuer`s of `webid`. Relative IRIs
/// resolve against `document`: an `@base` is prepended, which a `@base` in
/// the profile itself overrides, as Turtle says.
pub fn profile_issuers(profile: &[u8], document: &str, webid: &str) -> Result<Vec<String>, String> {
    use rio_api::{
        model::{NamedNode, Subject, Term},
        parser::TriplesParser,
    };
    let text = std::str::from_utf8(profile).map_err(|_| "the WebID profile is not UTF-8")?;
    let source = format!("@base <{document}> .\n{text}");
    let mut parser = rio_turtle::TurtleParser::new(source.as_bytes(), None);
    let mut issuers = Vec::new();
    parser
        .parse_all(&mut |t| -> Result<(), rio_turtle::TurtleError> {
            if let (Subject::NamedNode(NamedNode { iri: s }), Term::NamedNode(NamedNode { iri: o })) =
                (t.subject, t.object)
            {
                if s == webid && t.predicate.iri == SOLID_OIDC_ISSUER {
                    issuers.push(normalize_issuer(o));
                }
            }
            Ok(())
        })
        .map_err(|e| format!("the WebID profile is not Turtle this server reads: {e}"))?;
    Ok(issuers)
}

// -- the verifier ---------------------------------------------------------------

/// What a request presented.
pub struct Presented<'a> {
    pub method: &'a str,
    /// The request URL as this node names it (see the module docs).
    pub url: &'a str,
    pub authorization: Option<&'a str>,
    pub dpop: Option<&'a str>,
}

#[derive(Clone)]
struct Cached<T> {
    value: T,
    at: i64,
}

/// Verifies Solid-OIDC DPoP-bound access tokens. One per node.
pub struct DpopVerifier {
    issuers: Issuers,
    fetch: Arc<dyn DocFetch>,
    jwks: Mutex<HashMap<String, Cached<Json>>>,
    profiles: Mutex<HashMap<String, Cached<Vec<String>>>>,
    replay: crate::replay_cache::ReplayCache,
}

impl Default for DpopVerifier {
    fn default() -> Self {
        Self::new(Issuers::default())
    }
}

impl DpopVerifier {
    pub fn new(issuers: Issuers) -> Self {
        let fetch = Arc::new(GuardedFetch::new(&issuers));
        Self::with_fetch(issuers, fetch)
    }

    pub fn with_fetch(issuers: Issuers, fetch: Arc<dyn DocFetch>) -> Self {
        Self {
            issuers,
            fetch,
            jwks: Mutex::new(HashMap::new()),
            profiles: Mutex::new(HashMap::new()),
            replay: Default::default(),
        }
    }

    /// `Ok(None)`: nothing was presented, the request is anonymous.
    pub async fn verify(&self, p: &Presented<'_>, now_ms: i64) -> Result<Option<Json>, Refused> {
        let (token, proof) = match (p.authorization, p.dpop) {
            (None, None) => return Ok(None),
            (Some(auth), proof) => {
                let (scheme, token) = auth
                    .split_once(' ')
                    .ok_or_else(|| refused("the Authorization header is malformed"))?;
                if !scheme.eq_ignore_ascii_case("dpop") {
                    return Err(refused(
                        "this route takes Solid-OIDC access tokens bound to a DPoP proof (`Authorization: DPoP`), not other schemes",
                    ));
                }
                let proof = proof.ok_or_else(|| refused("the request has no DPoP proof"))?;
                (token.trim(), proof.trim())
            }
            (None, Some(_)) => return Err(refused("the DPoP proof comes without an access token")),
        };
        if self.issuers.is_empty() {
            return Err(refused(
                "this server trusts no Solid-OIDC issuer (the operator sets --solid-oidc-issuers)",
            ));
        }
        let now = now_ms.div_euclid(1000);

        // The proof first: it is local, and a replay or stale proof then
        // costs no fetch.
        let proof = decode_jws(proof).map_err(|e| refused(format!("the DPoP proof: {e}")))?;
        if proof.header["typ"] != "dpop+jwt" {
            return Err(refused("the DPoP proof's `typ` is not `dpop+jwt`"));
        }
        let proof_alg = proof.header["alg"].as_str().unwrap_or("");
        let jwk = &proof.header["jwk"];
        if !jwk.is_object() || is_private(jwk) {
            return Err(refused("the DPoP proof needs a public `jwk`"));
        }
        verify_with_jwk(&proof, jwk, proof_alg)
            .map_err(|e| refused(format!("the DPoP proof: {e}")))?;
        let claims = &proof.claims;
        if !claims["htm"]
            .as_str()
            .is_some_and(|m| m.eq_ignore_ascii_case(p.method))
        {
            return Err(refused("the DPoP proof is for another method"));
        }
        let expected = htu_form(p.url).ok_or_else(|| refused("this route's URL is not http(s)"))?;
        if claims["htu"].as_str().and_then(htu_form).as_deref() != Some(expected.as_str()) {
            return Err(refused(format!(
                "the DPoP proof is for another URL than {expected}"
            )));
        }
        let iat = claims["iat"]
            .as_i64()
            .ok_or_else(|| refused("the DPoP proof has no `iat`"))?;
        if now - iat > PROOF_MAX_AGE_SECS || iat - now > PROOF_MAX_FUTURE_SECS {
            return Err(refused("the DPoP proof is not fresh"));
        }
        let jti = claims["jti"]
            .as_str()
            .filter(|j| !j.is_empty() && j.chars().count() <= MAX_JTI_CHARS)
            .ok_or_else(|| refused("the DPoP proof needs a `jti`"))?;
        if let Some(ath) = claims.get("ath") {
            let hash = B64URL.encode(ring::digest::digest(&ring::digest::SHA256, token.as_bytes()));
            if ath.as_str() != Some(hash.as_str()) {
                return Err(refused("the DPoP proof's `ath` is not this access token's"));
            }
        }
        let jkt = thumbprint(jwk).map_err(|e| refused(format!("the DPoP proof: {e}")))?;

        // The access token.
        let access = decode_jws(token).map_err(|e| refused(format!("the access token: {e}")))?;
        let tc = &access.claims;
        let iss = tc["iss"]
            .as_str()
            .ok_or_else(|| refused("the access token has no `iss`"))?;
        if !self.issuers.contains(iss) {
            return Err(refused(format!(
                "the access token's issuer {iss} is not one this server trusts"
            )));
        }
        let exp = tc["exp"]
            .as_i64()
            .ok_or_else(|| refused("the access token has no `exp`"))?;
        if exp + TOKEN_LEEWAY_SECS < now {
            return Err(refused("the access token has expired"));
        }
        for claim in ["nbf", "iat"] {
            if tc[claim].as_i64().is_some_and(|t| t - TOKEN_LEEWAY_SECS > now) {
                return Err(refused(format!("the access token's `{claim}` is in the future")));
            }
        }
        let audience_ok = match &tc["aud"] {
            Json::String(a) => a == "solid",
            Json::Array(a) => a.iter().any(|v| v == "solid"),
            _ => false,
        };
        if !audience_ok {
            return Err(refused("the access token's audience does not include `solid`"));
        }
        if tc["cnf"]["jkt"].as_str() != Some(jkt.as_str()) {
            return Err(refused("the access token is not bound to the DPoP proof's key"));
        }
        let webid = tc["webid"]
            .as_str()
            .filter(|w| {
                url::Url::parse(w).is_ok_and(|u| matches!(u.scheme(), "http" | "https"))
            })
            .ok_or_else(|| refused("the access token has no `webid`"))?;
        let token_alg = access.header["alg"].as_str().unwrap_or("");
        self.verify_token_signature(&access, iss, token_alg, now_ms)
            .await
            .map_err(|e| refused(format!("the access token: {e}")))?;

        // The WebID names this issuer.
        let issuers = self
            .profile_issuers(webid, now_ms)
            .await
            .map_err(|e| refused(format!("the WebID: {e}")))?;
        if !issuers.contains(&normalize_issuer(iss)) {
            return Err(refused(format!(
                "the WebID profile does not list {iss} as its solid:oidcIssuer"
            )));
        }

        // Everything verified: take the proof's single use.
        let key = format!("dpop\n{jkt}\n{jti}");
        self.replay
            .record(key.as_bytes(), iat.saturating_mul(1000), now_ms)
            .map_err(|e| match e {
                crate::replay_cache::Refusal::Replayed => {
                    refused("this DPoP proof was already used; send a new one")
                }
                crate::replay_cache::Refusal::Full => refused(e.to_string()),
            })?;

        let client = tc["client_id"].as_str().or_else(|| tc["azp"].as_str());
        Ok(Some(json!({
            "scheme": "dpop",
            "webid": webid,
            "issuer": iss,
            "clientId": client,
            "jkt": jkt,
        })))
    }

    async fn fetch_json(&self, url: &str) -> Result<Json, String> {
        let url = url::Url::parse(url).map_err(|_| format!("`{url}` is not a URL"))?;
        let bytes = self.fetch.fetch(&url, "application/json").await?;
        serde_json::from_slice(&bytes).map_err(|_| format!("{url} is not JSON"))
    }

    async fn jwks(&self, iss: &str, now_ms: i64, fresh: bool) -> Result<Json, String> {
        let issuer = normalize_issuer(iss);
        if !fresh {
            let cached = self.jwks.lock().unwrap_or_else(|e| e.into_inner()).get(&issuer).cloned();
            if let Some(c) = cached.filter(|c| now_ms - c.at < DOC_TTL_MS) {
                return Ok(c.value);
            }
        }
        let metadata = self
            .fetch_json(&format!("{issuer}/.well-known/openid-configuration"))
            .await?;
        if metadata["issuer"].as_str().map(normalize_issuer).as_deref() != Some(issuer.as_str()) {
            return Err("the issuer's metadata names another issuer".into());
        }
        let jwks_uri = metadata["jwks_uri"]
            .as_str()
            .ok_or("the issuer's metadata has no jwks_uri")?;
        let jwks = self.fetch_json(jwks_uri).await?;
        if !jwks["keys"].is_array() {
            return Err("the issuer's JWKS has no keys".into());
        }
        self.jwks.lock().unwrap_or_else(|e| e.into_inner()).insert(
            issuer,
            Cached {
                value: jwks.clone(),
                at: now_ms,
            },
        );
        Ok(jwks)
    }

    async fn verify_token_signature(
        &self,
        access: &Jws,
        iss: &str,
        alg: &str,
        now_ms: i64,
    ) -> Result<(), String> {
        let kid = access.header["kid"].as_str();
        let attempt = |jwks: &Json| -> Option<Result<(), String>> {
            let candidates: Vec<&Json> = jwks["keys"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|k| kid.is_none_or(|kid| k["kid"].as_str() == Some(kid)))
                .filter(|k| !is_private(k))
                .collect();
            if candidates.is_empty() {
                return None;
            }
            let mut last = Err("no key of the issuer verifies it".to_string());
            for key in candidates {
                last = verify_with_jwk(access, key, alg);
                if last.is_ok() {
                    break;
                }
            }
            Some(last)
        };
        let jwks = self.jwks(iss, now_ms, false).await?;
        if let Some(result) = attempt(&jwks) {
            return result;
        }
        // An unknown kid: the issuer may have rotated its keys.
        let at = self
            .jwks
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&normalize_issuer(iss))
            .map(|c| c.at)
            .unwrap_or(0);
        if now_ms - at < JWKS_REFETCH_MS {
            return Err("no key of the issuer has this `kid`".into());
        }
        let jwks = self.jwks(iss, now_ms, true).await?;
        attempt(&jwks).unwrap_or_else(|| Err("no key of the issuer has this `kid`".into()))
    }

    async fn profile_issuers(&self, webid: &str, now_ms: i64) -> Result<Vec<String>, String> {
        let cached = self
            .profiles
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(webid)
            .cloned();
        if let Some(c) = cached.filter(|c| now_ms - c.at < DOC_TTL_MS) {
            return Ok(c.value);
        }
        let mut document = url::Url::parse(webid).map_err(|_| "the WebID is not a URL")?;
        document.set_fragment(None);
        let bytes = self.fetch.fetch(&document, "text/turtle").await?;
        let issuers = profile_issuers(&bytes, document.as_str(), webid)?;
        self.profiles.lock().unwrap_or_else(|e| e.into_inner()).insert(
            webid.to_string(),
            Cached {
                value: issuers.clone(),
                at: now_ms,
            },
        );
        Ok(issuers)
    }
}

#[cfg(test)]
pub(crate) mod testing {
    //! A test issuer: ES256 keys, tokens and proofs, signed with ring.
    use super::*;
    use ring::{
        rand::SystemRandom,
        signature::{EcdsaKeyPair, KeyPair, ECDSA_P256_SHA256_FIXED_SIGNING},
    };

    pub struct Es256 {
        pair: EcdsaKeyPair,
        pub kid: String,
    }

    impl Es256 {
        pub fn generate(kid: &str) -> Self {
            let rng = SystemRandom::new();
            let pkcs8 = EcdsaKeyPair::generate_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, &rng).unwrap();
            let pair =
                EcdsaKeyPair::from_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, pkcs8.as_ref(), &rng)
                    .unwrap();
            Self {
                pair,
                kid: kid.into(),
            }
        }

        pub fn jwk(&self) -> Json {
            let point = self.pair.public_key().as_ref();
            json!({
                "kty": "EC",
                "crv": "P-256",
                "x": B64URL.encode(&point[1..33]),
                "y": B64URL.encode(&point[33..65]),
            })
        }

        pub fn sign(&self, header: Json, claims: Json) -> String {
            let input = format!(
                "{}.{}",
                B64URL.encode(header.to_string()),
                B64URL.encode(claims.to_string())
            );
            let signature = self
                .pair
                .sign(&SystemRandom::new(), input.as_bytes())
                .unwrap();
            format!("{input}.{}", B64URL.encode(signature.as_ref()))
        }
    }

    /// Documents from memory, keyed by URL without fragment.
    #[derive(Default)]
    pub struct Docs(pub Mutex<HashMap<String, Vec<u8>>>, pub std::sync::atomic::AtomicUsize);

    #[async_trait::async_trait]
    impl DocFetch for Docs {
        async fn fetch(&self, url: &url::Url, _accept: &str) -> Result<Vec<u8>, String> {
            self.1.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            self.0
                .lock()
                .unwrap()
                .get(url.as_str())
                .cloned()
                .ok_or_else(|| format!("{url} answered 404"))
        }
    }

    pub const ISSUER: &str = "https://issuer.example";
    pub const WEBID: &str = "https://pod.example/alice/profile/card#me";

    /// An issuer with one key and Alice's profile naming it.
    pub fn issuer_docs(key: &Es256) -> Arc<Docs> {
        let docs = Docs::default();
        {
            let mut map = docs.0.lock().unwrap();
            map.insert(
                format!("{ISSUER}/.well-known/openid-configuration"),
                json!({"issuer": ISSUER, "jwks_uri": format!("{ISSUER}/jwks")})
                    .to_string()
                    .into_bytes(),
            );
            let mut public = key.jwk();
            public["kid"] = json!(key.kid);
            public["alg"] = json!("ES256");
            map.insert(
                format!("{ISSUER}/jwks"),
                json!({"keys": [public]}).to_string().into_bytes(),
            );
            map.insert(
                "https://pod.example/alice/profile/card".into(),
                format!(
                    "@prefix solid: <http://www.w3.org/ns/solid/terms#>.\n<#me> a <http://xmlns.com/foaf/0.1/Person>; solid:oidcIssuer <{ISSUER}/>.\n"
                )
                .into_bytes(),
            );
        }
        Arc::new(docs)
    }

    /// A client: its DPoP key, and a token the issuer bound to it.
    pub struct Client {
        pub dpop: Es256,
        pub token: String,
    }

    impl Client {
        pub fn new(issuer: &Es256, now: i64, extra: Json) -> Self {
            let dpop = Es256::generate("client");
            let mut claims = json!({
                "iss": ISSUER,
                "aud": ["solid", "https://app.example/id"],
                "sub": "alice",
                "webid": WEBID,
                "client_id": "https://app.example/id",
                "iat": now,
                "exp": now + 300,
                "cnf": {"jkt": thumbprint(&dpop.jwk()).unwrap()},
            });
            if let (Json::Object(c), Json::Object(e)) = (&mut claims, extra) {
                for (k, v) in e {
                    if v.is_null() {
                        c.remove(&k);
                    } else {
                        c.insert(k, v);
                    }
                }
            }
            let token = issuer.sign(
                json!({"alg": "ES256", "typ": "at+jwt", "kid": issuer.kid}),
                claims,
            );
            Self { dpop, token }
        }

        pub fn proof(&self, method: &str, url: &str, now: i64, jti: &str) -> String {
            self.dpop.sign(
                json!({"typ": "dpop+jwt", "alg": "ES256", "jwk": self.dpop.jwk()}),
                json!({"htm": method, "htu": url, "iat": now, "jti": jti}),
            )
        }

        pub fn authorization(&self) -> String {
            format!("DPoP {}", self.token)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::testing::*;
    use super::*;

    const URL: &str = "https://abc.routes.example/notes/a";
    const NOW: i64 = 1_800_000_000;

    fn verifier(key: &Es256) -> (DpopVerifier, Arc<Docs>) {
        let docs = issuer_docs(key);
        let issuers = Issuers::parse(Some(&format!("{ISSUER}/"))).unwrap();
        (DpopVerifier::with_fetch(issuers, docs.clone()), docs)
    }

    async fn check(
        v: &DpopVerifier,
        method: &str,
        url: &str,
        authorization: Option<&str>,
        proof: Option<&str>,
    ) -> Result<Option<Json>, String> {
        v.verify(
            &Presented {
                method,
                url,
                authorization,
                dpop: proof,
            },
            NOW * 1000,
        )
        .await
        .map_err(|e| e.0)
    }

    #[actix_rt::test]
    async fn a_bound_token_names_its_webid_once() {
        let key = Es256::generate("k1");
        let (v, docs) = verifier(&key);
        let client = Client::new(&key, NOW, json!({}));
        let proof = client.proof("PUT", URL, NOW, "one");
        let caller = check(&v, "PUT", URL, Some(&client.authorization()), Some(&proof))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(caller["webid"], WEBID);
        assert_eq!(caller["issuer"], ISSUER);
        assert_eq!(caller["clientId"], "https://app.example/id");
        assert_eq!(caller["jkt"], thumbprint(&client.dpop.jwk()).unwrap());

        // The same proof again is a replay.
        let again = check(&v, "PUT", URL, Some(&client.authorization()), Some(&proof)).await;
        assert!(again.unwrap_err().contains("already used"));

        // A new proof is fine, and the documents came from the cache.
        let fetched = docs.1.load(std::sync::atomic::Ordering::SeqCst);
        let proof = client.proof("GET", &format!("{URL}?x=1"), NOW, "two");
        assert!(check(&v, "GET", URL, Some(&client.authorization()), Some(&proof))
            .await
            .unwrap()
            .is_some());
        assert_eq!(docs.1.load(std::sync::atomic::Ordering::SeqCst), fetched);
    }

    #[actix_rt::test]
    async fn nothing_presented_is_anonymous() {
        let key = Es256::generate("k1");
        let (v, _) = verifier(&key);
        assert_eq!(check(&v, "GET", URL, None, None).await.unwrap(), None);
    }

    #[actix_rt::test]
    async fn proofs_are_bound_to_method_url_time_and_key() {
        let key = Es256::generate("k1");
        let (v, _) = verifier(&key);
        let client = Client::new(&key, NOW, json!({}));
        let auth = client.authorization();
        let cases = [
            (client.proof("GET", URL, NOW, "m"), "another method"),
            (client.proof("PUT", "https://abc.routes.example/other", NOW, "u"), "another URL"),
            (client.proof("PUT", URL, NOW - PROOF_MAX_AGE_SECS - 1, "t"), "not fresh"),
            (client.proof("PUT", URL, NOW + PROOF_MAX_FUTURE_SECS + 1, "f"), "not fresh"),
            // Another key signs a proof for the same token.
            (Client::new(&key, NOW, json!({})).proof("PUT", URL, NOW, "k"), "not bound"),
        ];
        for (proof, expected) in cases {
            let err = check(&v, "PUT", URL, Some(&auth), Some(&proof))
                .await
                .unwrap_err();
            assert!(err.contains(expected), "{expected}: {err}");
        }
        // A tampered signature.
        let proof = client.proof("PUT", URL, NOW, "s");
        let tampered = format!("{}AA", &proof[..proof.len() - 2]);
        assert!(check(&v, "PUT", URL, Some(&auth), Some(&tampered))
            .await
            .is_err());
        // A Bearer token, or a token without a proof, is refused.
        let bearer = format!("Bearer {}", client.token);
        assert!(check(&v, "PUT", URL, Some(&bearer), Some(&proof))
            .await
            .unwrap_err()
            .contains("not other schemes"));
        assert!(check(&v, "PUT", URL, Some(&auth), None)
            .await
            .unwrap_err()
            .contains("no DPoP proof"));
    }

    #[actix_rt::test]
    async fn tokens_need_a_trusted_issuer_audience_expiry_and_signature() {
        let key = Es256::generate("k1");
        let (v, _) = verifier(&key);
        let cases = [
            (json!({"iss": "https://other.example"}), "not one this server trusts"),
            (json!({"aud": "https://app.example/id"}), "audience"),
            (json!({"exp": NOW - TOKEN_LEEWAY_SECS - 1}), "expired"),
            (json!({"webid": null}), "no `webid`"),
            (
                json!({"webid": "https://pod.example/bob/card#me"}),
                "WebID",
            ),
        ];
        for (extra, expected) in cases {
            let client = Client::new(&key, NOW, extra);
            let proof = client.proof("GET", URL, NOW, expected);
            let err = check(&v, "GET", URL, Some(&client.authorization()), Some(&proof))
                .await
                .unwrap_err();
            assert!(err.contains(expected), "{expected}: {err}");
        }
        // Signed by a key the issuer did not publish.
        let impostor = Es256::generate("k1");
        let client = Client::new(&impostor, NOW, json!({}));
        let proof = client.proof("GET", URL, NOW, "imp");
        assert!(check(&v, "GET", URL, Some(&client.authorization()), Some(&proof))
            .await
            .unwrap_err()
            .contains("does not verify"));
    }

    #[actix_rt::test]
    async fn the_webid_profile_must_name_the_issuer() {
        let key = Es256::generate("k1");
        let (v, docs) = verifier(&key);
        docs.0.lock().unwrap().insert(
            "https://pod.example/alice/profile/card".into(),
            b"<#me> <http://www.w3.org/ns/solid/terms#oidcIssuer> <https://evil.example> .".to_vec(),
        );
        let client = Client::new(&key, NOW, json!({}));
        let proof = client.proof("GET", URL, NOW, "p");
        assert!(check(&v, "GET", URL, Some(&client.authorization()), Some(&proof))
            .await
            .unwrap_err()
            .contains("does not list"));
    }

    #[test]
    fn issuers_are_http_urls() {
        assert!(Issuers::parse(Some("ftp://x.example")).is_err());
        assert!(Issuers::parse(Some("https://x.example/?q")).is_err());
        let i = Issuers::parse(Some("https://a.example/, http://127.0.0.1:9000")).unwrap();
        assert!(i.contains("https://a.example"));
        assert!(i.contains("http://127.0.0.1:9000/"));
        assert_eq!(
            i.origins(),
            vec!["https://a.example".to_string(), "http://127.0.0.1:9000".to_string()]
        );
        assert!(Issuers::parse(None).unwrap().is_empty());
    }

    #[test]
    fn thumbprints_follow_rfc_7638() {
        // RFC 7638, section 3.1.
        let jwk = json!({
            "kty": "RSA",
            "n": "0vx7agoebGcQSuuPiLJXZptN9nndrQmbXEps2aiAFbWhM78LhWx4cbbfAAtVT86zwu1RK7aPFFxuhDR1L6tSoc_BJECPebWKRXjBZCiFV4n3oknjhMstn64tZ_2W-5JsGY4Hc5n9yBXArwl93lqt7_RN5w6Cf0h4QyQ5v-65YGjQR0_FDW2QvzqY368QQMicAtaSqzs8KJZgnYb9c7d0zgdAZHzu6qMQvRL5hajrn1n91CbOpbISD08qNLyrdkt-bFTWhAI4vMQFh6WeZu0fM4lFd2NcRwr3XPksINHaQ-G_xBniIqbw0Ls1jF44-csFCur-kEgU8awapJzKnqDKgw",
            "e": "AQAB",
            "alg": "RS256",
            "kid": "2011-04-29"
        });
        assert_eq!(
            thumbprint(&jwk).unwrap(),
            "NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs"
        );
    }

    #[test]
    fn profiles_resolve_relative_iris() {
        let profile = b"@prefix solid: <http://www.w3.org/ns/solid/terms#>.\n<#me> solid:oidcIssuer <https://a.example/>, <https://b.example>.\n<#other> solid:oidcIssuer <https://c.example>.";
        assert_eq!(
            profile_issuers(profile, "https://pod.example/card", "https://pod.example/card#me")
                .unwrap(),
            vec!["https://a.example".to_string(), "https://b.example".to_string()]
        );
        assert!(profile_issuers(b"not turtle <", "https://pod.example/card", "x").is_err());
    }
}
