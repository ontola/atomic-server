//! Check signatures in authentication headers, find the correct agent. Authorization is done in Hierarchies

use crate::{
    agents::{decode_base64, ForAgent},
    errors::{AtomicError, AtomicResult},
    urls,
    utils::check_timestamp_fresh,
    Storelike,
};

/// Set of values extracted from the request.
/// Most are coming from headers.
#[derive(serde::Deserialize)]
pub struct AuthValues {
    // x-atomic-public-key
    #[serde(rename = "https://atomicdata.dev/properties/auth/publicKey")]
    pub public_key: String,
    // x-atomic-timestamp
    #[serde(rename = "https://atomicdata.dev/properties/auth/timestamp")]
    pub timestamp: i64,
    // x-atomic-signature
    // Base64 encoded public key from `subject_url timestamp`
    #[serde(rename = "https://atomicdata.dev/properties/auth/signature")]
    pub signature: String,
    #[serde(rename = "https://atomicdata.dev/properties/auth/requestedSubject")]
    pub requested_subject: String,
    #[serde(rename = "https://atomicdata.dev/properties/auth/agent")]
    pub agent_subject: String,
    /// Set for a version 2 request signature (`x-atomic-signature-version: 2`):
    /// the method and body the signature must cover. `None` is version 1.
    ///
    /// Never deserialized: a cookie or a WebSocket `AUTH` frame is a
    /// reusable proof by design, and can only ever be version 1.
    #[serde(skip)]
    pub request: Option<RequestBinding>,
}

/// The value of `x-atomic-signature-version` that selects [request_signature_message_v2].
pub const SIGNATURE_VERSION_2: &str = "2";

/// The header that selects the signature version. Absent means version 1.
pub const SIGNATURE_VERSION_HEADER: &str = "x-atomic-signature-version";

/// What a version 2 request signature covers besides the URL and timestamp.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RequestBinding {
    /// The HTTP method, upper case.
    pub method: String,
    /// Lower-case hex SHA-256 of the raw request body (of zero bytes when
    /// there is none).
    pub body_sha256_hex: String,
}

impl RequestBinding {
    /// Binds a request's method and the body bytes the handler will act on.
    pub fn new(method: &str, body: &[u8]) -> Self {
        RequestBinding {
            method: method.to_ascii_uppercase(),
            body_sha256_hex: sha256_hex(body),
        }
    }
}

/// Lower-case hex SHA-256.
pub fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::Digest;
    hex::encode(sha2::Sha256::digest(bytes))
}

/// The message a version 2 request signature signs.
///
/// ```text
/// atomic-request-v2
/// {METHOD}
/// {full URL, including query}
/// {timestamp, Unix ms}
/// {sha-256 hex of the body}
/// ```
///
/// Version 1 (`"{url} {timestamp}"`) covers neither method nor body, and is
/// accepted for five minutes, so a captured `POST` could be replayed with a
/// different body. Version 2 closes that; see ontola/atomic-plugins#54.
pub fn request_signature_message_v2(
    method: &str,
    url: &str,
    timestamp: i64,
    body_sha256_hex: &str,
) -> String {
    format!(
        "atomic-request-v2\n{}\n{}\n{}\n{}",
        method.to_ascii_uppercase(),
        url,
        timestamp,
        body_sha256_hex
    )
}

/// Checks if the signature is valid for this timestamp.
/// Does not check if the agent has rights to access the subject.
#[tracing::instrument(skip_all)]
pub fn check_auth_signature(subject: &str, auth_header: &AuthValues) -> AtomicResult<()> {
    if let Some(request) = &auth_header.request {
        return check_auth_signature_v2(subject, auth_header, request);
    }
    let agent_pubkey = decode_base64(&auth_header.public_key)?;
    let message = format!("{} {}", subject, auth_header.timestamp);
    let pubkey_bytes: [u8; 32] = agent_pubkey
        .try_into()
        .map_err(|_| "Ed25519 public key must be 32 bytes")?;
    let verifying_key = ed25519_dalek::VerifyingKey::from_bytes(&pubkey_bytes)
        .map_err(|e| format!("Invalid public key: {}", e))?;
    let signature_bytes = decode_base64(&auth_header.signature)?;
    let sig_bytes: [u8; 64] = signature_bytes
        .try_into()
        .map_err(|_| "Ed25519 signature must be 64 bytes")?;
    let sig = ed25519_dalek::Signature::from_bytes(&sig_bytes);
    use ed25519_dalek::Verifier;

    let result = verifying_key.verify(message.as_bytes(), &sig);

    if result.is_err() {
        // The client may have signed the URL without its query string (e.g.
        // it signed `http://host/setup` and the request is `/setup?reset=true`).
        // That form is still bound to the host, so it is accepted.
        //
        // A path-only message (`"/setup <ts>"`) is NOT: such a signature is
        // valid on every host and tenant for the whole timestamp window, and
        // it sidesteps the WebSocket challenge binding, which relies on the
        // full requested subject being what was signed.
        if let Ok(url) = url::Url::parse(subject) {
            if url.query().is_some() {
                let mut url_no_query = url.clone();
                url_no_query.set_query(None);
                let message_no_query = format!("{} {}", url_no_query, auth_header.timestamp);
                if verifying_key
                    .verify(message_no_query.as_bytes(), &sig)
                    .is_ok()
                {
                    return Ok(());
                }
            }
        }

        // If we haven't returned Ok, return the original error.
        return Err(format!(
            "Incorrect signature for auth headers. This could be due to an error during signing or serialization of the commit. Compare this to the serialized message in the client: {}",
            message,
        )
        .into());
    }

    Ok(())
}

/// Version 2: only the v2 message is tried. Unlike version 1 there is no
/// query-less retry, and a failure here is never retried as version 1: a
/// client that asked for v2 and whose proof does not verify is refused, or
/// a downgrade would undo what v2 is for.
fn check_auth_signature_v2(
    url: &str,
    auth_header: &AuthValues,
    request: &RequestBinding,
) -> AtomicResult<()> {
    let message = request_signature_message_v2(
        &request.method,
        url,
        auth_header.timestamp,
        &request.body_sha256_hex,
    );
    let pubkey_bytes: [u8; 32] = decode_base64(&auth_header.public_key)?
        .try_into()
        .map_err(|_| "Ed25519 public key must be 32 bytes")?;
    let verifying_key = ed25519_dalek::VerifyingKey::from_bytes(&pubkey_bytes)
        .map_err(|e| format!("Invalid public key: {}", e))?;
    let sig_bytes: [u8; 64] = decode_base64(&auth_header.signature)?
        .try_into()
        .map_err(|_| "Ed25519 signature must be 64 bytes")?;
    let sig = ed25519_dalek::Signature::from_bytes(&sig_bytes);
    // Strict: no small-order keys, no malleable signatures. v1 keeps plain
    // `verify` for compatibility with what it has always accepted.
    verifying_key
        .verify_strict(message.as_bytes(), &sig)
        .map_err(|_| {
            format!(
                "Incorrect version 2 request signature. The server checked this message (method, full URL, timestamp, SHA-256 of the body it received): {:?}",
                message
            )
            .into()
        })
}

const ACCEPTABLE_TIME_DIFFERENCE: i64 = 10000;

/// How old a signed authentication proof may be, in milliseconds.
///
/// An `AUTH` frame or signed auth header is a bearer proof: whoever holds
/// the bytes is the agent, for as long as the responder accepts them. Until
/// 2026-09 the only timestamp check was "not in the future", so a captured
/// proof never expired. Clients sign immediately before sending (the
/// browser per request and per socket, `WsClient` at `authenticate()`, the
/// Iroh initiator at dial), so a few minutes leaves ample room for clock
/// skew and slow links without turning a capture into a permanent key.
pub const AUTH_MAX_AGE_MS: i64 = 5 * 60 * 1000;

/// What a set of [AuthValues] turned out to prove.
#[derive(Debug)]
enum Authenticated {
    /// A proof that verifies and that this server still accepts.
    Agent(ForAgent),
    /// A proof that verifies, but whose timestamp this server will not take:
    /// older than [`AUTH_MAX_AGE_MS`], or far enough in the future that the
    /// signer's clock cannot be trusted. Carries the reason, for logging.
    NotFresh(String),
}

/// Get the Agent's subject from [AuthValues]
/// Checks if the auth headers are correct, whether signature matches the public key, whether the timestamp is valid.
/// by default, returns the public agent
///
/// For a caller who asked to be authenticated and is owed an answer either
/// way: the `AUTH` frame of a socket, a peer handshake. A proof that has aged
/// out is refused here, because "you are signed in" would be a lie and the
/// client can sign a fresh one. A request that merely *carried* a proof wants
/// [`get_agent_from_auth_values_or_public`] instead.
#[tracing::instrument(skip_all)]
pub async fn get_agent_from_auth_values_and_check(
    auth_header_values: Option<AuthValues>,
    store: &impl Storelike,
) -> AtomicResult<ForAgent> {
    match auth_header_values {
        // Every failure below means the caller is not who the headers say
        // (a server answers 401), whichever check tripped.
        Some(auth_vals) => match check_auth_values(auth_vals, store)
            .await
            .map_err(AtomicError::into_unauthorized)?
        {
            Authenticated::Agent(for_agent) => Ok(for_agent),
            Authenticated::NotFresh(reason) => Err(AtomicError::unauthorized(reason)),
        },
        None => Ok(ForAgent::Public),
    }
}

/// The same checks, for a request that did not have to be authenticated in the
/// first place: an HTTP request, or the headers a socket was opened with. Here
/// a proof that has aged out is treated as no proof at all.
///
/// A proof says who the caller is, and one that has expired says the caller
/// *was* this agent and is no longer. That is a different thing from a caller
/// pretending to be someone, and it is not by itself a reason to refuse a
/// request: the rights check is the layer that knows whether being nobody is
/// a problem for what was asked. Public data is served, anything that needs
/// rights is refused there.
///
/// Refusing at this layer instead failed the request whatever it asked for. A
/// browser keeps its proof in a cookie, and until 0.41 a proof never expired,
/// so a stale one is the ordinary state of any tab left open. On staging that
/// meant thousands of rejections a day, from tabs polling the public `/server`
/// endpoint with a cookie nothing refreshed, for data anyone may read.
#[tracing::instrument(skip_all)]
pub async fn get_agent_from_auth_values_or_public(
    auth_header_values: Option<AuthValues>,
    store: &impl Storelike,
) -> AtomicResult<ForAgent> {
    match auth_header_values {
        Some(auth_vals) => match check_auth_values(auth_vals, store)
            .await
            .map_err(AtomicError::into_unauthorized)?
        {
            Authenticated::Agent(for_agent) => Ok(for_agent),
            Authenticated::NotFresh(reason) => {
                tracing::debug!("Continuing as the public agent. {}", reason);
                Ok(ForAgent::Public)
            }
        },
        None => Ok(ForAgent::Public),
    }
}

async fn check_auth_values(
    auth_vals: AuthValues,
    store: &impl Storelike,
) -> AtomicResult<Authenticated> {
    // If there are auth headers, check 'em, make sure they are valid.
    // The signature first: a proof that does not verify is a forgery whatever
    // its timestamp says, and is refused outright.
    check_auth_signature(&auth_vals.requested_subject, &auth_vals)
        .map_err(|e| format!("Error checking authentication headers. {}", e))?;
    // check if the timestamp is valid: not in the future, and not so old
    // that a captured proof could be replayed indefinitely.
    if let Err(e) = check_timestamp_fresh(
        auth_vals.timestamp,
        ACCEPTABLE_TIME_DIFFERENCE,
        AUTH_MAX_AGE_MS,
    ) {
        return Ok(Authenticated::NotFresh(format!(
            "Authentication timestamp rejected. {}",
            e
        )));
    }
    // check if the public key belongs to the agent
    // For DID subjects, we need to fetch the agent resource locally
    // unless it's a DID based on the public key, in which case we can verify it directly.
    let agent_subject = crate::Subject::from_raw(auth_vals.agent_subject.trim(), None);
    let public_key_trimmed = auth_vals.public_key.trim();

    if agent_subject.is_did() {
        // The DID subject embeds the agent's public key
        // (`did:ad:agent:{pubkey}`) and the auth header carries the same
        // key. The two may use different base64 alphabets — the url-safe
        // alphabet (the new default) vs the legacy standard alphabet
        // (`+` `/` `=`) — so a raw-string `ends_with` wrongly rejects a key
        // whose decoded BYTES are identical. Compare the decoded bytes.
        let did_pubkey = agent_subject
            .agent_public_key()
            .unwrap_or_else(|| agent_subject.as_str());
        if public_keys_match(did_pubkey, public_key_trimmed) {
            return Ok(Authenticated::Agent(ForAgent::AgentSubject(agent_subject)));
        } else {
            return Err(format!(
                "The public key in the auth headers '{}' does not match the DID subject '{}'",
                public_key_trimmed, auth_vals.agent_subject
            )
            .into());
        }
    }

    // Legacy `https://host/agents/{pubkey}` subjects are treated as
    // `did:ad:agent:{pubkey}` by every rights check, so the key in the
    // path is the identity being claimed: bind it to the signing key.
    // Looking the key up in a resource at that URL instead would let
    // anyone host `https://theirs/agents/<victim key>` carrying their own
    // key and be authorized as the victim (including as the server's own
    // root agent, whose key is public).
    if let Some(path_key) = crate::agents::legacy_agent_pubkey(agent_subject.as_str()) {
        if public_keys_match(&path_key, public_key_trimmed) {
            return Ok(Authenticated::Agent(ForAgent::AgentSubject(agent_subject)));
        }
        return Err(format!(
            "The public key in the auth headers '{}' does not match the agent subject '{}'",
            public_key_trimmed, auth_vals.agent_subject
        )
        .into());
    }

    // Any other agent subject must be a resource this store already
    // holds. Never fetch it over the network during authentication: that
    // is an unauthenticated SSRF, and the fetched body would be written
    // into the store as a trusted resource.
    let normalized_agent = store.normalize_subject(&agent_subject);
    if !normalized_agent.is_local() {
        return Err(format!(
                "Agent subject '{}' is hosted elsewhere and cannot be used to authenticate here; sign in with a did:ad:agent identity",
                auth_vals.agent_subject
            )
            .into());
    }
    let agent_resource = store.get_resource(&normalized_agent).await?;
    let found_public_key = agent_resource.get(urls::PUBLIC_KEY)?;
    if !public_keys_match(found_public_key.to_string().trim(), public_key_trimmed) {
        Err(
            "The public key in the auth headers does not match the public key in the agent"
                .to_string()
                .into(),
        )
    } else {
        Ok(Authenticated::Agent(ForAgent::AgentSubject(agent_subject)))
    }
}

/// Two base64-encoded public keys match if their decoded bytes are equal.
/// Tolerates differing base64 alphabets (url-safe — the new default — vs the
/// legacy standard alphabet with `+` `/` `=`), so an agent whose DID or stored
/// key was minted with one alphabet still authenticates against an auth header
/// using the other. Falls back to `false` if either string can't be decoded.
pub fn public_keys_match(a: &str, b: &str) -> bool {
    if a == b {
        return true;
    }

    matches!(
        (
            crate::agents::decode_base64(a),
            crate::agents::decode_base64(b),
        ),
        (Ok(da), Ok(db)) if da == db
    )
}

// fn get_agent_from_value_index() {
//     let map = store.get_prop_subject_map(&auth_vals.public_key)?;
//     let agents = map.get(crate::urls::PUBLIC_KEY).ok_or(format!(
//         "No agents for this public key: {}",
//         &auth_vals.public_key
//     ))?;
//     // TODO: This is unreliable, as this will break if multiple atoms with the same public key exist.
//     if agents.len() > 1 {
//         return Err("Multiple agents for this public key".into());
//     } else if let Some(found) = agents.iter().next() {
//         for_agent = Some(found.to_string());
//     }
// }

#[cfg(test)]
mod test {
    use super::*;
    use crate::agents::{generate_public_key, sign_message};

    /// A 32-byte ed25519 seed. Any 32 bytes are a valid one.
    const PRIVATE_KEY: &str = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const REQUESTED: &str = "https://example.com/server";

    fn signed_at(timestamp: i64) -> AuthValues {
        let pair = generate_public_key(PRIVATE_KEY);
        let signature = sign_message(
            format!("{} {}", REQUESTED, timestamp).as_bytes(),
            &pair.private,
        )
        .unwrap();
        AuthValues {
            agent_subject: format!("{}{}", crate::subject::DID_AD_AGENT_PREFIX, pair.public),
            public_key: pair.public,
            timestamp,
            signature,
            requested_subject: REQUESTED.to_string(),
            request: None,
        }
    }

    #[tokio::test]
    async fn a_fresh_proof_authenticates() {
        let store = crate::Store::init().await.unwrap();
        let for_agent =
            get_agent_from_auth_values_or_public(Some(signed_at(crate::utils::now())), &store)
                .await
                .unwrap();
        assert!(
            matches!(for_agent, ForAgent::AgentSubject(ref s) if s.is_did()),
            "expected the signing agent, got {for_agent:?}"
        );
    }

    /// The staging 401 flood. A browser's stored proof ages out while the tab
    /// stays open, and every request it made after that was refused, including
    /// requests for data that needs no credentials at all. An aged-out proof
    /// now means "nobody", so the rights check decides what that is allowed to
    /// see.
    #[tokio::test]
    async fn a_proof_that_has_aged_out_is_nobody_rather_than_a_refusal() {
        let store = crate::Store::init().await.unwrap();
        let stale = crate::utils::now() - AUTH_MAX_AGE_MS - 1;
        let for_agent = get_agent_from_auth_values_or_public(Some(signed_at(stale)), &store)
            .await
            .expect("an expired proof is not an error on this path");
        assert_eq!(for_agent, ForAgent::Public);

        // The handshake path still refuses it, so a client that asked to be
        // authenticated is told it is not.
        get_agent_from_auth_values_and_check(Some(signed_at(stale)), &store)
            .await
            .expect_err("an AUTH frame with a stale proof is refused");
    }

    /// A clock far enough ahead that its timestamps cannot be trusted is the
    /// same situation: not a credential, not a forgery.
    #[tokio::test]
    async fn a_proof_from_a_clock_too_far_ahead_is_nobody_too() {
        let store = crate::Store::init().await.unwrap();
        let ahead = crate::utils::now() + ACCEPTABLE_TIME_DIFFERENCE + 60_000;
        let for_agent = get_agent_from_auth_values_or_public(Some(signed_at(ahead)), &store)
            .await
            .unwrap();
        assert_eq!(for_agent, ForAgent::Public);
    }

    /// The leniency stops at the signature. Someone presenting a proof they
    /// could not have signed is refused, however fresh they claim it is.
    #[tokio::test]
    async fn a_signature_that_does_not_verify_is_still_refused() {
        let store = crate::Store::init().await.unwrap();
        let mut forged = signed_at(crate::utils::now());
        forged.requested_subject = "https://example.com/someone-elses-drive".to_string();
        let error = get_agent_from_auth_values_or_public(Some(forged), &store)
            .await
            .expect_err("a forged proof must not authenticate");
        assert_eq!(
            error.error_type,
            crate::errors::AtomicErrorType::UnauthorizedError
        );
    }

    /// And a caller who presents nothing is simply the public agent, as before.
    #[tokio::test]
    async fn no_proof_at_all_is_the_public_agent() {
        let store = crate::Store::init().await.unwrap();
        assert_eq!(
            get_agent_from_auth_values_or_public(None, &store)
                .await
                .unwrap(),
            ForAgent::Public
        );
    }

    use super::public_keys_match;

    /// The same ed25519 key, encoded in the legacy standard base64 alphabet
    /// (as embedded in a legacy agent DID) and in the url-safe alphabet (as
    /// sent in modern auth headers), must be recognised as the same key —
    /// otherwise legacy agents can't authenticate (WS AUTH fails → the client
    /// never gets AUTH_OK → it falls offline and edits never sync).
    #[test]
    fn public_keys_match_across_base64_alphabets() {
        let standard = "gJRZVTGPngaG3mSPA/e6LEewKixYpZtuUYQhNg+t7Y4=";
        let url_safe = "gJRZVTGPngaG3mSPA_e6LEewKixYpZtuUYQhNg-t7Y4";
        assert!(
            public_keys_match(standard, url_safe),
            "standard and url-safe encodings of the same key should match"
        );
        assert!(public_keys_match(standard, standard));
        assert!(public_keys_match(url_safe, url_safe));
    }

    #[test]
    fn public_keys_match_rejects_different_keys() {
        let a = "gJRZVTGPngaG3mSPA_e6LEewKixYpZtuUYQhNg-t7Y4";
        let b = "AAAAVTGPngaG3mSPA_e6LEewKixYpZtuUYQhNg-t7Y4";
        assert!(!public_keys_match(a, b));
    }

    // ---- Version 2 request signatures ----

    /// The shared cross-language vectors. The copy next to the TypeScript
    /// test must be byte-identical; see `browser_copy_is_identical`.
    const V2_VECTORS_JSON: &str = include_str!("authentication_v2_vectors.json");

    #[derive(serde::Deserialize, serde::Serialize)]
    struct V2Vector {
        name: String,
        private_key: String,
        public_key: String,
        agent: String,
        method: String,
        url: String,
        timestamp: i64,
        body: String,
        body_sha256_hex: String,
        message: String,
        signature: String,
    }

    #[derive(serde::Deserialize, serde::Serialize)]
    struct V2Vectors {
        note: String,
        vectors: Vec<V2Vector>,
    }

    fn v2_cases() -> Vec<(&'static str, &'static str, &'static str, i64, &'static str)> {
        vec![
            (
                "post_delegation",
                "POST",
                "https://proxy.example/connections/c_123/agents",
                1_790_000_000_000,
                r#"{"agent":"atomic:agent:AAAA","label":"Timesheets"}"#,
            ),
            (
                "get_with_query_empty_body",
                "GET",
                "https://proxy.example/proxy/c_123/google-calendar/calendars/primary/events?maxResults=10&pageToken=a%2Fb",
                1_790_000_000_001,
                "",
            ),
            (
                "delete_lowercase_method_in",
                "delete",
                "http://localhost:8787/connections/c_123",
                1_790_000_000_002,
                "",
            ),
            (
                "patch_utf8_body",
                "PATCH",
                "https://example.com/app-agent?drive=atomic%3Adrive%3Ax",
                1_790_000_000_003,
                "{\"title\":\"Caf\u{e9} \u{2615} \u{1f600}\"}",
            ),
        ]
    }

    fn make_v2_vector(name: &str, method: &str, url: &str, timestamp: i64, body: &str) -> V2Vector {
        let pair = generate_public_key(PRIVATE_KEY);
        let body_sha256_hex = sha256_hex(body.as_bytes());
        let message = request_signature_message_v2(method, url, timestamp, &body_sha256_hex);
        let signature = sign_message(message.as_bytes(), &pair.private).unwrap();
        V2Vector {
            name: name.to_string(),
            private_key: PRIVATE_KEY.to_string(),
            agent: format!("{}{}", crate::ATOMIC_AGENT_PREFIX, pair.public),
            public_key: pair.public,
            method: method.to_string(),
            url: url.to_string(),
            timestamp,
            body: body.to_string(),
            body_sha256_hex,
            message,
            signature,
        }
    }

    /// Prints the vectors file. Regenerate with
    /// `cargo test -p atomic_lib print_v2_vectors -- --ignored --nocapture`
    /// and paste into both copies of `authentication_v2_vectors.json`.
    #[test]
    #[ignore]
    fn print_v2_vectors() {
        let vectors = V2Vectors {
            note: "Golden version 2 request signatures (ontola/atomic-plugins#54) for lib/src/authentication.rs and browser/lib/src/authentication.ts. Regenerate with `cargo test -p atomic_lib print_v2_vectors -- --ignored --nocapture`; keep both copies identical.".to_string(),
            vectors: v2_cases()
                .into_iter()
                .map(|(n, m, u, t, b)| make_v2_vector(n, m, u, t, b))
                .collect(),
        };
        println!("{}", serde_json::to_string_pretty(&vectors).unwrap());
    }

    fn v2_vectors() -> V2Vectors {
        serde_json::from_str(V2_VECTORS_JSON).expect("vectors parse")
    }

    fn v2_auth_values(v: &V2Vector, body: &[u8]) -> AuthValues {
        AuthValues {
            public_key: v.public_key.clone(),
            timestamp: v.timestamp,
            signature: v.signature.clone(),
            requested_subject: v.url.clone(),
            agent_subject: v.agent.clone(),
            request: Some(RequestBinding::new(&v.method, body)),
        }
    }

    /// Ed25519 is deterministic in dalek, so regenerating each vector must
    /// give the recorded bytes: message, body hash and signature.
    #[test]
    fn v2_vectors_are_what_this_code_produces() {
        let file = v2_vectors();
        assert_eq!(file.vectors.len(), v2_cases().len());
        for (v, (n, m, u, t, b)) in file.vectors.iter().zip(v2_cases()) {
            let fresh = make_v2_vector(n, m, u, t, b);
            assert_eq!(v.name, fresh.name);
            assert_eq!(v.body_sha256_hex, fresh.body_sha256_hex, "{}", v.name);
            assert_eq!(v.message, fresh.message, "{}", v.name);
            assert_eq!(v.signature, fresh.signature, "{}", v.name);
            assert_eq!(v.agent, fresh.agent, "{}", v.name);
        }
    }

    #[test]
    fn v2_vectors_verify() {
        for v in v2_vectors().vectors {
            check_auth_signature(&v.url, &v2_auth_values(&v, v.body.as_bytes()))
                .unwrap_or_else(|e| panic!("{}: {}", v.name, e));
        }
    }

    #[test]
    fn v2_message_shape() {
        assert_eq!(
            request_signature_message_v2("post", "https://x.example/a?b=c", 5, &sha256_hex(b"")),
            "atomic-request-v2\nPOST\nhttps://x.example/a?b=c\n5\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    /// Everything the signature covers is bound: changing any one part fails.
    #[test]
    fn v2_rejects_a_different_method_body_url_or_timestamp() {
        let file = v2_vectors();
        let v = file
            .vectors
            .iter()
            .find(|v| v.name == "post_delegation")
            .unwrap();

        let mut other_body = v2_auth_values(v, br#"{"agent":"atomic:agent:EVIL"}"#);
        assert!(check_auth_signature(&v.url, &other_body).is_err(), "body");
        other_body.request = Some(RequestBinding::new("PUT", v.body.as_bytes()));
        assert!(check_auth_signature(&v.url, &other_body).is_err(), "method");

        let same = v2_auth_values(v, v.body.as_bytes());
        assert!(
            check_auth_signature("https://proxy.example/connections/c_999/agents", &same).is_err(),
            "url"
        );
        assert!(
            check_auth_signature("https://other.example/connections/c_123/agents", &same).is_err(),
            "origin"
        );
        let mut later = v2_auth_values(v, v.body.as_bytes());
        later.timestamp += 1;
        assert!(check_auth_signature(&v.url, &later).is_err(), "timestamp");
    }

    /// A v2 request never falls back to v1, even when a valid v1 proof for
    /// the same URL and timestamp is presented.
    #[test]
    fn v2_never_falls_back_to_v1() {
        let mut v1 = signed_at(1_790_000_000_000);
        assert!(check_auth_signature(REQUESTED, &v1).is_ok(), "valid as v1");
        v1.request = Some(RequestBinding::new("GET", b""));
        assert!(
            check_auth_signature(REQUESTED, &v1).is_err(),
            "the same proof sent as v2 must fail"
        );
    }

    /// And no query-less retry either: that leniency is v1's alone.
    #[test]
    fn v2_does_not_drop_the_query() {
        let file = v2_vectors();
        let v = file
            .vectors
            .iter()
            .find(|v| v.name == "get_with_query_empty_body")
            .unwrap();
        let auth = v2_auth_values(v, b"");
        assert!(check_auth_signature(&v.url, &auth).is_ok());
        let extra = format!("{}&extra=1", v.url);
        assert!(check_auth_signature(&extra, &auth).is_err());
    }

    /// v2 goes through the same agent binding and freshness checks as v1.
    #[tokio::test]
    async fn a_fresh_v2_proof_authenticates_and_a_mismatched_agent_does_not() {
        let store = crate::Store::init().await.unwrap();
        let pair = generate_public_key(PRIVATE_KEY);
        let ts = crate::utils::now();
        let binding = RequestBinding::new("POST", b"{}");
        let message = request_signature_message_v2("POST", REQUESTED, ts, &binding.body_sha256_hex);
        let auth = || AuthValues {
            agent_subject: format!("{}{}", crate::ATOMIC_AGENT_PREFIX, pair.public),
            public_key: pair.public.clone(),
            timestamp: ts,
            signature: sign_message(message.as_bytes(), &pair.private).unwrap(),
            requested_subject: REQUESTED.to_string(),
            request: Some(binding.clone()),
        };
        let agent = get_agent_from_auth_values_and_check(Some(auth()), &store)
            .await
            .unwrap();
        assert!(matches!(agent, ForAgent::AgentSubject(_)));

        let mut other = auth();
        other.agent_subject = format!(
            "{}{}",
            crate::ATOMIC_AGENT_PREFIX,
            generate_public_key("AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE").public
        );
        get_agent_from_auth_values_and_check(Some(other), &store)
            .await
            .expect_err("the agent must be the signing key");
    }

    /// A cookie or a WebSocket AUTH frame is JSON; it can never select v2.
    #[test]
    fn deserialized_auth_values_are_always_v1() {
        let v = signed_at(1);
        let json = serde_json::json!({
            "https://atomicdata.dev/properties/auth/publicKey": v.public_key,
            "https://atomicdata.dev/properties/auth/timestamp": v.timestamp,
            "https://atomicdata.dev/properties/auth/signature": v.signature,
            "https://atomicdata.dev/properties/auth/requestedSubject": v.requested_subject,
            "https://atomicdata.dev/properties/auth/agent": v.agent_subject,
            "request": {"method": "GET", "body_sha256_hex": ""},
        });
        let parsed: AuthValues = serde_json::from_value(json).unwrap();
        assert!(parsed.request.is_none());
    }

    #[test]
    fn browser_copy_of_v2_vectors_is_identical() {
        let browser = include_str!("../../browser/lib/src/authentication_v2_vectors.json");
        assert_eq!(
            V2_VECTORS_JSON, browser,
            "lib/src/authentication_v2_vectors.json and browser/lib/src/authentication_v2_vectors.json drifted"
        );
    }
}
