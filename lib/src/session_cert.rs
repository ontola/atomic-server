//! Session certificates: one Agent key certifying another, for a window.
//!
//! A **root** Agent is the person: its DID is what `write` lists name and what
//! `createdBy` records. A **session** Agent is one browser, one device, one
//! sitting — a fresh Ed25519 keypair whose private half never leaves that
//! device, and which the root signs a short-lived certificate over. The session
//! key signs commits and authentication proofs; every rights check is answered
//! for the root.
//!
//! This is a certificate authority, not "another public key on the Agent". The
//! session DID never appears in an ACL, never gets an Agent resource, and stops
//! being able to reach a live node when the window closes.
//!
//! The signed bytes ARE [`SessionCert::signed_bytes`] — a fixed binary layout,
//! deliberately not JSON, so there is no canonicalization ambiguity in the
//! trust path. Unlike [`crate::genesis::GenesisCert`], whose signature is the
//! resource subject, a session certificate carries its own signature inline:
//! there is no subject to hang it on, and a verifier replaying history in 2029
//! must be able to check it with no side store and no network.
//!
//! See `planning/oidc-oauth.md`.

use crate::agents::{decode_base64, encode_base64, ForAgent};
use crate::errors::AtomicResult;
use crate::subject::DID_AD_AGENT_PREFIX;
use crate::Subject;

/// Certificate format version, and the first signed byte.
///
/// Deliberately **not** `0x01`, which is [`crate::genesis::GENESIS_VERSION_V1`].
/// Both certificates are Ed25519 signatures by an agent key over a compact
/// binary blob, so if their signed payloads could ever be read as each other, a
/// genesis certificate of the right length would double as a session
/// certificate delegating to whatever bytes happened to sit at the session-key
/// offset. Distinct leading bytes make the two payload languages disjoint at
/// the first byte, which is the cheapest possible domain separation.
pub const SESSION_CERT_VERSION_V1: u8 = 0x53;

/// Bytes covered by the signature: everything before it.
const SIGNED_LEN: usize = 81;

/// Total encoded length: [`SIGNED_LEN`] plus the 64-byte signature.
pub const SESSION_CERT_LEN: usize = SIGNED_LEN + 64;

/// A root Agent's signed statement that a session key may act for it until
/// `not_after`.
///
/// ```text
/// offset  size  field
/// 0       1     version        0x53
/// 1       32    sessionPubKey  Ed25519 raw
/// 33      8     notBefore      i64 unix ms, little-endian
/// 41      8     notAfter       i64 unix ms, little-endian
/// 49      32    rootPubKey     Ed25519 raw
/// 81      64    signature      Ed25519 by the root over bytes [0, 81)
/// ```
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SessionCert {
    /// The delegated key. Whatever signs a commit or an auth proof carrying
    /// this certificate must be exactly this key.
    pub session_pubkey: [u8; 32],
    /// Start of the validity window, Unix milliseconds.
    pub not_before: i64,
    /// End of the validity window, Unix milliseconds.
    pub not_after: i64,
    /// The issuing root Agent's key. Rights are answered for this identity.
    pub root_pubkey: [u8; 32],
    /// Ed25519 signature by `root_pubkey` over bytes `[0, 81)`.
    pub signature: [u8; 64],
}

/// The unsigned half of a certificate — what a root commits to when it signs.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SessionCertClaims {
    pub session_pubkey: [u8; 32],
    pub not_before: i64,
    pub not_after: i64,
    pub root_pubkey: [u8; 32],
}

impl SessionCertClaims {
    /// The exact bytes a root signs. Shared by signing and verification so the
    /// two can never drift.
    pub fn signed_bytes(&self) -> [u8; SIGNED_LEN] {
        let mut out = [0u8; SIGNED_LEN];
        out[0] = SESSION_CERT_VERSION_V1;
        out[1..33].copy_from_slice(&self.session_pubkey);
        out[33..41].copy_from_slice(&self.not_before.to_le_bytes());
        out[41..49].copy_from_slice(&self.not_after.to_le_bytes());
        out[49..81].copy_from_slice(&self.root_pubkey);
        out
    }

    /// Sign with the root's Ed25519 private key (32-byte seed, base64).
    /// Errors if that key is not the one named in `root_pubkey`.
    pub fn sign(&self, root_private_key: &str) -> AtomicResult<SessionCert> {
        use ed25519_dalek::{Signer, SigningKey};

        let seed: [u8; 32] = decode_base64(root_private_key)?
            .try_into()
            .map_err(|_| "Ed25519 private key must be 32 bytes")?;
        let signing_key = SigningKey::from_bytes(&seed);
        if signing_key.verifying_key().as_bytes() != &self.root_pubkey {
            return Err("Session certificate root pubkey does not match the signing key".into());
        }
        let signature = signing_key.sign(&self.signed_bytes());
        Ok(SessionCert {
            session_pubkey: self.session_pubkey,
            not_before: self.not_before,
            not_after: self.not_after,
            root_pubkey: self.root_pubkey,
            signature: signature.to_bytes(),
        })
    }
}

impl SessionCert {
    /// The claims this certificate attests.
    pub fn claims(&self) -> SessionCertClaims {
        SessionCertClaims {
            session_pubkey: self.session_pubkey,
            not_before: self.not_before,
            not_after: self.not_after,
            root_pubkey: self.root_pubkey,
        }
    }

    /// Serialize to the canonical binary layout.
    pub fn encode(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(SESSION_CERT_LEN);
        out.extend_from_slice(&self.claims().signed_bytes());
        out.extend_from_slice(&self.signature);
        out
    }

    /// Base64url form, which is how the certificate travels on a commit
    /// propval and in an authentication header.
    pub fn encode_b64(&self) -> String {
        encode_base64(&self.encode())
    }

    /// Parse the canonical binary layout. Rejects unknown versions, truncated
    /// input, and trailing bytes.
    pub fn decode(bytes: &[u8]) -> AtomicResult<Self> {
        if bytes.len() < SESSION_CERT_LEN {
            return Err("Session certificate is truncated".into());
        }
        if bytes.len() > SESSION_CERT_LEN {
            return Err("Session certificate has trailing bytes".into());
        }
        let version = bytes[0];
        if version != SESSION_CERT_VERSION_V1 {
            return Err(format!("Unsupported session certificate version {version}").into());
        }

        let mut session_pubkey = [0u8; 32];
        session_pubkey.copy_from_slice(&bytes[1..33]);
        let not_before = i64::from_le_bytes(bytes[33..41].try_into().unwrap());
        let not_after = i64::from_le_bytes(bytes[41..49].try_into().unwrap());
        let mut root_pubkey = [0u8; 32];
        root_pubkey.copy_from_slice(&bytes[49..81]);
        let mut signature = [0u8; 64];
        signature.copy_from_slice(&bytes[81..SESSION_CERT_LEN]);

        Ok(Self {
            session_pubkey,
            not_before,
            not_after,
            root_pubkey,
            signature,
        })
    }

    /// Parse the base64url form.
    pub fn decode_b64(value: &str) -> AtomicResult<Self> {
        Self::decode(&decode_base64(value)?)
    }

    /// The issuing root Agent's DID. This is the identity every rights check
    /// is answered for.
    pub fn root_did(&self) -> String {
        format!("{DID_AD_AGENT_PREFIX}{}", encode_base64(&self.root_pubkey))
    }

    /// The delegated session Agent's DID. Never put this in an ACL: it outlives
    /// its certificate there.
    pub fn session_did(&self) -> String {
        format!(
            "{DID_AD_AGENT_PREFIX}{}",
            encode_base64(&self.session_pubkey)
        )
    }

    /// Verify the certificate and return the root Agent's DID.
    ///
    /// 1. `claimed_session_pubkey` is the key that actually signed the commit
    ///    or auth proof; it must be the key this certificate delegates to.
    /// 2. The root's Ed25519 signature must cover the claims.
    /// 3. `t` must fall inside `[not_before, not_after]`. On a commit that is
    ///    `createdAt`, so history stays valid after the window closes; on a
    ///    live request it is the auth timestamp, which is separately bounded
    ///    for freshness.
    ///
    /// No store lookup, no network, no identity provider.
    pub fn verify(&self, claimed_session_pubkey: &[u8; 32], t: i64) -> AtomicResult<String> {
        use ed25519_dalek::Verifier;

        if &self.session_pubkey != claimed_session_pubkey {
            return Err(
                "Session certificate was issued for a different key than the one that signed"
                    .into(),
            );
        }

        let verifying_key = ed25519_dalek::VerifyingKey::from_bytes(&self.root_pubkey)
            .map_err(|e| format!("Invalid session certificate root pubkey: {e}"))?;
        let sig = ed25519_dalek::Signature::from_bytes(&self.signature);
        verifying_key
            .verify(&self.claims().signed_bytes(), &sig)
            .map_err(|_| "Session certificate signature is invalid")?;

        if t < self.not_before {
            return Err(format!(
                "Session certificate is not valid yet: {t} is before {}",
                self.not_before
            )
            .into());
        }
        if t > self.not_after {
            return Err(format!(
                "Session certificate expired: {t} is after {}",
                self.not_after
            )
            .into());
        }

        Ok(self.root_did())
    }
}

/// The public key a `did:ad:agent:` subject embeds.
///
/// Session certificates delegate from one key to another, so both ends have to
/// be keys. A signer whose key lives somewhere else — a legacy
/// `https://host/agents/{key}` subject, or an Agent resource in the store — is
/// refused rather than resolved: the delegation would then depend on mutable
/// state, and "who may act as this person" is exactly the question that must
/// not.
fn agent_did_pubkey(signer: &Subject) -> AtomicResult<[u8; 32]> {
    let encoded = signer
        .as_str()
        .strip_prefix(DID_AD_AGENT_PREFIX)
        .ok_or_else(|| {
            format!(
                "A session certificate can only be used by a {DID_AD_AGENT_PREFIX} signer, not '{signer}'"
            )
        })?;
    decode_base64(encoded)?
        .try_into()
        .map_err(|_| "Ed25519 public key must be 32 bytes".into())
}

/// Who a signature counts as, for rights.
///
/// Without a certificate this is the signer, byte for byte today's behaviour.
/// With one, the signer is a session key and the answer is the root that
/// certified it. Every rights check in the codebase — `check_read`,
/// `check_write`, `check_append`, drive enrollment, the genesis `write`-list
/// insert — consumes this and keeps comparing one DID against a list. The
/// certificate case lives here and nowhere else, so a disposable session DID
/// cannot leak into an ACL and outlive its window.
///
/// Fails closed: a certificate that is present and does not verify is an
/// error, never a silent fall back to the session identity.
pub fn effective_agent(
    signer: &Subject,
    session_cert: Option<&str>,
    t: i64,
) -> AtomicResult<ForAgent> {
    match session_cert {
        None => Ok(ForAgent::AgentSubject(signer.clone())),
        Some(encoded) => {
            let cert = SessionCert::decode_b64(encoded)?;
            let signer_pubkey = agent_did_pubkey(signer)?;
            let root_did = cert.verify(&signer_pubkey, t)?;
            Ok(ForAgent::AgentSubject(root_did.into()))
        }
    }
}

/// [`effective_agent`] as a subject, for the call sites that want the string.
pub fn effective_signer(
    signer: &Subject,
    session_cert: Option<&str>,
    t: i64,
) -> AtomicResult<Subject> {
    match effective_agent(signer, session_cert, t)? {
        ForAgent::AgentSubject(subject) => Ok(subject),
        other => Err(format!("Unexpected effective agent {other}").into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agents::Agent;

    /// Deterministic keypair from a seed byte, so vectors are reproducible.
    fn keypair(seed_byte: u8) -> ([u8; 32], String, [u8; 32]) {
        let seed = [seed_byte; 32];
        let signing_key = ed25519_dalek::SigningKey::from_bytes(&seed);
        let pubkey = *signing_key.verifying_key().as_bytes();
        (seed, encode_base64(&seed), pubkey)
    }

    fn claims(session: [u8; 32], root: [u8; 32]) -> SessionCertClaims {
        SessionCertClaims {
            session_pubkey: session,
            not_before: 1_700_000_000_000,
            not_after: 1_700_000_086_400_000,
            root_pubkey: root,
        }
    }

    #[test]
    fn signs_and_verifies_inside_the_window() {
        let (_, root_private, root_pub) = keypair(1);
        let (_, _, session_pub) = keypair(2);
        let cert = claims(session_pub, root_pub).sign(&root_private).unwrap();

        let did = cert.verify(&session_pub, 1_700_000_000_001).unwrap();
        assert_eq!(did, cert.root_did());
        assert!(did.starts_with(DID_AD_AGENT_PREFIX));
        assert_ne!(did, cert.session_did());
    }

    #[test]
    fn round_trips_through_bytes_and_base64() {
        let (_, root_private, root_pub) = keypair(3);
        let (_, _, session_pub) = keypair(4);
        let cert = claims(session_pub, root_pub).sign(&root_private).unwrap();

        assert_eq!(cert.encode().len(), SESSION_CERT_LEN);
        assert_eq!(SessionCert::decode(&cert.encode()).unwrap(), cert);
        assert_eq!(SessionCert::decode_b64(&cert.encode_b64()).unwrap(), cert);
    }

    #[test]
    fn rejects_a_key_the_certificate_was_not_issued_for() {
        let (_, root_private, root_pub) = keypair(5);
        let (_, _, session_pub) = keypair(6);
        let (_, _, other_pub) = keypair(7);
        let cert = claims(session_pub, root_pub).sign(&root_private).unwrap();

        assert!(cert.verify(&other_pub, 1_700_000_000_001).is_err());
    }

    #[test]
    fn rejects_a_timestamp_outside_the_window() {
        let (_, root_private, root_pub) = keypair(8);
        let (_, _, session_pub) = keypair(9);
        let cert = claims(session_pub, root_pub).sign(&root_private).unwrap();

        assert!(cert.verify(&session_pub, 1_699_999_999_999).is_err());
        assert!(cert.verify(&session_pub, 1_700_000_086_400_001).is_err());
        // Both bounds are inclusive.
        assert!(cert.verify(&session_pub, cert.not_before).is_ok());
        assert!(cert.verify(&session_pub, cert.not_after).is_ok());
    }

    #[test]
    fn rejects_a_tampered_signature_and_tampered_claims() {
        let (_, root_private, root_pub) = keypair(10);
        let (_, _, session_pub) = keypair(11);
        let cert = claims(session_pub, root_pub).sign(&root_private).unwrap();

        let mut flipped = cert.clone();
        flipped.signature[0] ^= 0xff;
        assert!(flipped.verify(&session_pub, cert.not_before).is_err());

        // Extending the window is the attack the signature exists to stop.
        let mut extended = cert.clone();
        extended.not_after += 86_400_000;
        assert!(extended.verify(&session_pub, extended.not_after).is_err());
    }

    #[test]
    fn refuses_to_sign_with_a_key_that_is_not_the_named_root() {
        let (_, other_private, _) = keypair(12);
        let (_, _, root_pub) = keypair(13);
        let (_, _, session_pub) = keypair(14);
        assert!(claims(session_pub, root_pub).sign(&other_private).is_err());
    }

    #[test]
    fn rejects_truncation_trailing_bytes_and_a_foreign_version() {
        let (_, root_private, root_pub) = keypair(15);
        let (_, _, session_pub) = keypair(16);
        let encoded = claims(session_pub, root_pub)
            .sign(&root_private)
            .unwrap()
            .encode();

        assert!(SessionCert::decode(&encoded[..SESSION_CERT_LEN - 1]).is_err());
        let mut longer = encoded.clone();
        longer.push(0);
        assert!(SessionCert::decode(&longer).is_err());

        let mut wrong_version = encoded.clone();
        wrong_version[0] = crate::genesis::GENESIS_VERSION_V1;
        assert!(SessionCert::decode(&wrong_version).is_err());
    }

    /// The reason the version byte is not `0x01`: a genesis certificate's
    /// signed payload must never be readable as a session certificate's.
    #[test]
    fn a_genesis_payload_is_not_a_session_payload() {
        let (_, _, pubkey) = keypair(17);
        let genesis = crate::genesis::GenesisCert {
            signer_pubkey: pubkey,
            created_at: 0,
            nonce: [0u8; 16],
            state_hash: None,
            // 58 + (2 + 9) + (2 + 10) = 81 bytes: exactly a session cert's
            // signed length, so length alone would not separate them.
            parent: "did:ad:pa".to_string(),
            drive: "did:ad:dri".to_string(),
        };
        let encoded = genesis.encode();
        assert_eq!(encoded.len(), SIGNED_LEN);
        assert_ne!(encoded[0], SESSION_CERT_VERSION_V1);
    }

    #[test]
    fn effective_agent_without_a_certificate_is_the_signer() {
        let agent = Agent::new(None).unwrap();
        let signer: Subject = agent.subject.clone();
        let got = effective_agent(&signer, None, 0).unwrap();
        assert_eq!(got, ForAgent::AgentSubject(signer));
    }

    #[test]
    fn effective_agent_with_a_certificate_is_the_root() {
        let (_, root_private, root_pub) = keypair(18);
        let (_, _, session_pub) = keypair(19);
        let cert = claims(session_pub, root_pub).sign(&root_private).unwrap();
        let session_signer: Subject = cert.session_did().into();

        let got = effective_agent(
            &session_signer,
            Some(&cert.encode_b64()),
            cert.not_before + 1,
        )
        .unwrap();
        assert_eq!(got, ForAgent::AgentSubject(cert.root_did().into()));
    }

    #[test]
    fn effective_agent_fails_closed_on_a_bad_certificate() {
        let (_, root_private, root_pub) = keypair(20);
        let (_, _, session_pub) = keypair(21);
        let cert = claims(session_pub, root_pub).sign(&root_private).unwrap();
        let session_signer: Subject = cert.session_did().into();
        let other_signer: Subject = SessionCert {
            session_pubkey: keypair(22).2,
            ..cert.clone()
        }
        .session_did()
        .into();

        // Expired.
        assert!(effective_agent(
            &session_signer,
            Some(&cert.encode_b64()),
            cert.not_after + 1
        )
        .is_err());
        // Signed by a key the certificate does not name.
        assert!(
            effective_agent(&other_signer, Some(&cert.encode_b64()), cert.not_before + 1).is_err()
        );
        // Not a certificate at all.
        assert!(effective_agent(&session_signer, Some("not-base64!!"), 0).is_err());
        // A signer whose key is not in its subject cannot be delegated to.
        assert!(effective_agent(
            &Subject::from_raw("https://example.com/agents/abc", None),
            Some(&cert.encode_b64()),
            cert.not_before + 1
        )
        .is_err());
    }
}

#[cfg(test)]
mod golden {
    //! Cross-language vectors. The Rust and TypeScript implementations must
    //! produce byte-identical certificates, or a commit signed in the browser
    //! will not verify on the node. Same discipline as
    //! `genesis_test_vectors.json`.
    use super::*;

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }

    fn unhex(s: &str) -> Vec<u8> {
        (0..s.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
            .collect()
    }

    struct VectorInput {
        root_seed: u8,
        session_seed: u8,
        not_before: i64,
        not_after: i64,
    }

    fn golden_inputs() -> Vec<VectorInput> {
        vec![
            // Typical: a 24-hour window, the default TTL.
            VectorInput {
                root_seed: 1,
                session_seed: 2,
                not_before: 1_700_000_000_000,
                not_after: 1_700_086_400_000,
            },
            // Zero and a negative bound: pins two's-complement little-endian
            // encoding, which a naive TS `writeUInt` would get wrong.
            VectorInput {
                root_seed: 3,
                session_seed: 4,
                not_before: 0,
                not_after: -1,
            },
            // Far future, to pin the full 8-byte width of the timestamps.
            VectorInput {
                root_seed: 5,
                session_seed: 6,
                not_before: 4_102_444_800_000,
                not_after: 4_102_531_200_000,
            },
        ]
    }

    fn cert_for(input: &VectorInput) -> (String, SessionCert) {
        let root_seed = [input.root_seed; 32];
        let session_seed = [input.session_seed; 32];
        let root_private = encode_base64(&root_seed);
        let claims = SessionCertClaims {
            session_pubkey: *ed25519_dalek::SigningKey::from_bytes(&session_seed)
                .verifying_key()
                .as_bytes(),
            not_before: input.not_before,
            not_after: input.not_after,
            root_pubkey: *ed25519_dalek::SigningKey::from_bytes(&root_seed)
                .verifying_key()
                .as_bytes(),
        };
        let cert = claims.sign(&root_private).unwrap();
        (root_private, cert)
    }

    /// Regenerate the fixture. Not run by default: it prints, it does not
    /// assert, and a fixture that rewrites itself pins nothing.
    #[test]
    #[ignore]
    fn generate_golden_vectors() {
        let vectors: Vec<_> = golden_inputs()
            .iter()
            .map(|input| {
                let (root_private, cert) = cert_for(input);
                serde_json::json!({
                    "rootSeedByte": input.root_seed,
                    "sessionSeedByte": input.session_seed,
                    "rootPrivateKeyBase64": root_private,
                    "rootPubKeyHex": hex(&cert.root_pubkey),
                    "sessionPubKeyHex": hex(&cert.session_pubkey),
                    "notBefore": cert.not_before,
                    "notAfter": cert.not_after,
                    "signedBytesHex": hex(&cert.claims().signed_bytes()),
                    "certBytesHex": hex(&cert.encode()),
                    "certBase64": cert.encode_b64(),
                    "rootDid": cert.root_did(),
                    "sessionDid": cert.session_did(),
                })
            })
            .collect();
        let doc = serde_json::json!({
            "_comment": "Golden cross-language vectors for the v1 session certificate. \
                Both the Rust SessionCert and the browser TS implementation MUST reproduce \
                every field. Byte fields are hex; certBase64 / rootDid / sessionDid use \
                base64url-no-pad. Seeds are [seedByte; 32] Ed25519 seeds — TEST KEYS ONLY. \
                Regenerate via `cargo test -p atomic_lib session_cert::golden::generate_golden_vectors \
                -- --ignored --nocapture`.",
            "version": 1,
            "vectors": vectors,
        });
        println!(
            "GOLDEN_START\n{}\nGOLDEN_END",
            serde_json::to_string_pretty(&doc).unwrap()
        );
    }

    #[test]
    fn matches_the_golden_vectors() {
        let fixture: serde_json::Value =
            serde_json::from_str(include_str!("session_cert_test_vectors.json")).unwrap();
        let vectors = fixture["vectors"].as_array().unwrap();
        let inputs = golden_inputs();
        assert_eq!(
            vectors.len(),
            inputs.len(),
            "fixture vector count drifted from golden_inputs — regenerate the fixture"
        );

        for (input, expected) in inputs.iter().zip(vectors) {
            let (_, cert) = cert_for(input);

            assert_eq!(
                hex(&cert.claims().signed_bytes()),
                expected["signedBytesHex"].as_str().unwrap(),
                "signed bytes differ for root seed {}",
                input.root_seed
            );
            assert_eq!(
                hex(&cert.encode()),
                expected["certBytesHex"].as_str().unwrap(),
                "cert bytes differ for root seed {}",
                input.root_seed
            );
            assert_eq!(cert.encode_b64(), expected["certBase64"].as_str().unwrap());
            assert_eq!(cert.root_did(), expected["rootDid"].as_str().unwrap());
            assert_eq!(cert.session_did(), expected["sessionDid"].as_str().unwrap());

            // Decoding the fixture must reproduce the same certificate, so the
            // TS side has a decode target and not only an encode one.
            let decoded =
                SessionCert::decode(&unhex(expected["certBytesHex"].as_str().unwrap())).unwrap();
            assert_eq!(decoded, cert);
            // And it must verify, so a bad fixture cannot look like a pass.
            // One vector carries a deliberately empty window (`notAfter` is
            // -1, pinning two's-complement little-endian): no instant is
            // inside it, which is itself the behaviour to pin.
            if cert.not_before <= cert.not_after {
                decoded
                    .verify(&cert.session_pubkey, cert.not_before)
                    .unwrap();
            } else {
                assert!(decoded
                    .verify(&cert.session_pubkey, cert.not_before)
                    .is_err());
                assert!(decoded
                    .verify(&cert.session_pubkey, cert.not_after)
                    .is_err());
            }
        }
    }
}
