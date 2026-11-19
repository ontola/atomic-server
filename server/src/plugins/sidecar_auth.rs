//! How the host signs what it sends an operator sidecar
//! (`atomic-sidecar:` operations, atomic-plugins#167 section 7).
//!
//! Loopback alone is not a boundary: any local process can reach a
//! sidecar's port and set `x-atomic-installation`. So every sidecar request
//! carries an Atomic version 2 request signature by that installation's app
//! agent on this node, extended to cover the host's own `x-atomic-*`
//! headers:
//!
//! ```text
//! atomic-request-v2
//! {METHOD}
//! {full URL, including query}
//! {timestamp, Unix ms}
//! {sha-256 hex of the body}
//! {name}:{value}      one line per bound header, names lower case, sorted
//! ```
//!
//! The first five lines are exactly
//! [`atomic_lib::authentication::request_signature_message_v2`]. The bound
//! headers are every `x-atomic-*` request header except the five that carry
//! the proof ([`PROOF_HEADERS`]); today `x-atomic-drive` and
//! `x-atomic-installation`. A bound header twice is refused: which copy was
//! signed would be ambiguous.
//!
//! The sidecar checks the proof, and asks `GET /plugin-runtime?installation=`
//! (see [`crate::handlers::plugin_runtime`]) whether that agent is the
//! installation's app agent here. The NextGraph sidecar implements the other
//! side (atomic-plugins `integrations/nextgraph/sidecar/src/auth.rs`);
//! [`tests::golden_vector`] checks the same bytes it does.

use atomic_lib::{
    agents::Agent,
    authentication::{
        request_signature_message_v2, sha256_hex, SIGNATURE_VERSION_2, SIGNATURE_VERSION_HEADER,
    },
};

/// The headers that carry the proof, and so are not signed themselves.
pub const PROOF_HEADERS: [&str; 5] = [
    "x-atomic-agent",
    "x-atomic-public-key",
    "x-atomic-signature",
    "x-atomic-signature-version",
    "x-atomic-timestamp",
];

/// The `x-atomic-*` headers a signature covers: lower case, sorted by name,
/// without the proof headers. A header named twice is refused.
pub fn bound_headers(headers: &[(String, String)]) -> Result<Vec<(String, String)>, String> {
    let mut bound: Vec<(String, String)> = headers
        .iter()
        .map(|(name, value)| (name.to_ascii_lowercase(), value.clone()))
        .filter(|(name, _)| {
            name.starts_with("x-atomic-") && !PROOF_HEADERS.contains(&name.as_str())
        })
        .collect();
    bound.sort();
    if bound.windows(2).any(|pair| pair[0].0 == pair[1].0) {
        return Err(
            "an x-atomic-* header is set twice, so what is signed would be ambiguous".into(),
        );
    }
    Ok(bound)
}

/// The exact bytes signed; see the module docs.
pub fn message(
    method: &str,
    url: &str,
    timestamp: i64,
    body_sha256_hex: &str,
    bound: &[(String, String)],
) -> String {
    let mut out = request_signature_message_v2(method, url, timestamp, body_sha256_hex);
    for (name, value) in bound {
        out.push('\n');
        out.push_str(name);
        out.push(':');
        out.push_str(value);
    }
    out
}

/// `headers` with a proof by `agent` over them added: the plugin's
/// `x-atomic-*` headers are the host's by then (see
/// `host_core::sidecar_headers`), and any proof headers already there are
/// dropped rather than signed around.
pub fn sign(
    agent: &Agent,
    method: &str,
    url: &str,
    body: &[u8],
    headers: Vec<(String, String)>,
    timestamp: i64,
) -> Result<Vec<(String, String)>, String> {
    let mut headers: Vec<(String, String)> = headers
        .into_iter()
        .filter(|(name, _)| !PROOF_HEADERS.contains(&name.to_ascii_lowercase().as_str()))
        .collect();
    let bound = bound_headers(&headers)?;
    let signed = message(method, url, timestamp, &sha256_hex(body), &bound);
    let private_key = agent
        .private_key
        .as_deref()
        .ok_or("the installation's app agent has no private key")?;
    let signature = atomic_lib::agents::sign_message(signed.as_bytes(), private_key)
        .map_err(|e| e.to_string())?;
    headers.extend([
        ("x-atomic-agent".into(), agent.subject.to_string()),
        ("x-atomic-public-key".into(), agent.public_key.clone()),
        ("x-atomic-signature".into(), signature),
        ("x-atomic-timestamp".into(), timestamp.to_string()),
        (
            SIGNATURE_VERSION_HEADER.to_ascii_lowercase(),
            SIGNATURE_VERSION_2.into(),
        ),
    ]);
    Ok(headers)
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use atomic_lib::agents::{decode_base64, encode_base64};

    const INSTALLATION: &str = "http://localhost:9883/installation";
    const DRIVE: &str = "http://localhost:9883/drive";
    const URL: &str = "http://127.0.0.1:14480/v1/query";
    const NOW: i64 = 1_700_000_000_000;
    const BODY: &[u8] = br#"{"document":"did:ng:o:doc"}"#;

    /// The agent with Ed25519 seed `[1; 32]`, as the sidecar's tests use.
    fn seed_one() -> Agent {
        Agent::new_from_private_key(None, &encode_base64(&[1u8; 32])).unwrap()
    }

    /// Checks a proof the way the sidecar does, without the clock, replay
    /// and registry checks: the message it rebuilds verifies strictly.
    pub fn verify(
        method: &str,
        url: &str,
        body: &[u8],
        headers: &[(String, String)],
    ) -> Result<(), String> {
        let get = |name: &str| -> Result<&str, String> {
            let mut found = headers.iter().filter(|(n, _)| n.eq_ignore_ascii_case(name));
            match (found.next(), found.next()) {
                (Some((_, v)), None) => Ok(v),
                _ => Err(format!("{name} missing or doubled")),
            }
        };
        if get("x-atomic-signature-version")? != "2" {
            return Err("not version 2".into());
        }
        let timestamp: i64 = get("x-atomic-timestamp")?
            .parse()
            .map_err(|_| "timestamp")?;
        let key: [u8; 32] = decode_base64(get("x-atomic-public-key")?)
            .map_err(|e| e.to_string())?
            .try_into()
            .map_err(|_| "key length")?;
        let signature: [u8; 64] = decode_base64(get("x-atomic-signature")?)
            .map_err(|e| e.to_string())?
            .try_into()
            .map_err(|_| "signature length")?;
        let signed = message(
            method,
            url,
            timestamp,
            &sha256_hex(body),
            &bound_headers(headers)?,
        );
        ed25519_dalek::VerifyingKey::from_bytes(&key)
            .map_err(|e| e.to_string())?
            .verify_strict(
                signed.as_bytes(),
                &ed25519_dalek::Signature::from_bytes(&signature),
            )
            .map_err(|_| format!("the signature does not cover {signed:?}"))
    }

    /// atomic-plugins `claude/server-nextgraph` @ 6319d38,
    /// `integrations/nextgraph/sidecar/src/auth.rs`, `tests::golden_vector`:
    /// key seed `[1; 32]`, the same request. The expected signature is what
    /// that test prints (on the sidecar's ed25519-dalek 1.0.1); Ed25519 is
    /// deterministic, so both sides must produce exactly these bytes.
    #[test]
    fn golden_vector() {
        let agent = seed_one();
        assert_eq!(
            agent.public_key.trim_end_matches('='),
            "iojj3XQJ8ZX9UtstPLpdcspnCb8dlBIb83SIAbQPb1w"
        );
        assert_eq!(
            sha256_hex(BODY),
            "e837d7147ce69a0ab268de56267e0d4be5ca9e9b1c06ef942aede33033ee47cf"
        );
        let headers = vec![
            (
                "X-Atomic-Installation".to_string(),
                INSTALLATION.to_string(),
            ),
            ("x-atomic-drive".to_string(), DRIVE.to_string()),
            ("content-type".to_string(), "application/json".to_string()),
        ];
        let bound = bound_headers(&headers).unwrap();
        let signed = message("post", URL, NOW, &sha256_hex(BODY), &bound);
        assert_eq!(
            signed,
            "atomic-request-v2\nPOST\nhttp://127.0.0.1:14480/v1/query\n1700000000000\ne837d7147ce69a0ab268de56267e0d4be5ca9e9b1c06ef942aede33033ee47cf\nx-atomic-drive:http://localhost:9883/drive\nx-atomic-installation:http://localhost:9883/installation"
        );
        let sent = sign(&agent, "POST", URL, BODY, headers, NOW).unwrap();
        let signature = sent
            .iter()
            .find(|(n, _)| n == "x-atomic-signature")
            .map(|(_, v)| decode_base64(v).unwrap())
            .unwrap();
        assert_eq!(
            signature,
            decode_base64(
                "73Bc81Zk8tKfQmYkBXBUMoqAhwZam4dwyhWEgkAvZFGoai14wVbDaiYkQd5aQxLiL9SASQBAx_oZWLj8BeSmCA"
            )
            .unwrap()
        );
        verify("POST", URL, BODY, &sent).unwrap();
    }

    #[test]
    fn what_the_signature_covers() {
        let agent = seed_one();
        let headers = vec![
            (
                "x-atomic-installation".to_string(),
                INSTALLATION.to_string(),
            ),
            ("x-atomic-drive".to_string(), DRIVE.to_string()),
        ];
        let sent = sign(&agent, "POST", URL, BODY, headers.clone(), NOW).unwrap();
        verify("POST", URL, BODY, &sent).unwrap();
        // Another body, URL, method, installation or an added header: refused.
        assert!(verify("POST", URL, b"{}", &sent).is_err());
        assert!(verify("POST", "http://127.0.0.1:14480/v1/update", BODY, &sent).is_err());
        assert!(verify("GET", URL, BODY, &sent).is_err());
        let mut other = sent.clone();
        other[0].1 = "http://localhost:9883/other".into();
        assert!(verify("POST", URL, BODY, &other).is_err());
        let mut added = sent.clone();
        added.push(("x-atomic-extra".into(), "1".into()));
        assert!(verify("POST", URL, BODY, &added).is_err());
        // A bound header twice is refused when signing, and when checking.
        let mut doubled = headers;
        doubled.push(("X-Atomic-Installation".into(), INSTALLATION.into()));
        assert!(sign(&agent, "POST", URL, BODY, doubled, NOW).is_err());
        // Proof headers already there are replaced, never signed around.
        let stale = vec![
            (
                "x-atomic-installation".to_string(),
                INSTALLATION.to_string(),
            ),
            ("X-Atomic-Signature".to_string(), "forged".to_string()),
        ];
        let sent = sign(&agent, "POST", URL, BODY, stale, NOW).unwrap();
        assert_eq!(
            sent.iter()
                .filter(|(n, _)| n.eq_ignore_ascii_case("x-atomic-signature"))
                .count(),
            1
        );
        verify("POST", URL, BODY, &sent).unwrap();
    }
}
