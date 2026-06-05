//! Self-verifying genesis certificate.
//!
//! A DID resource's identity is its genesis: the resource subject is
//! `did:ad:<base64url(signature)>`, where the signature is an Ed25519 signature
//! by the creating agent over this certificate's canonical bytes. The
//! certificate is carried *inline* on the resource (an immutable `genesis`
//! propval), so authorship + identity can be verified offline with no commit
//! fetch.
//!
//! The signed bytes ARE [`GenesisCert::encode`]'s output — a fixed binary
//! layout, deliberately *not* JSON, so there is no canonicalization ambiguity
//! in the trust path. The signature is not stored in the certificate: it is the
//! resource subject.
//!
//! See `planning/genesis-self-verifying.md`.

use crate::agents::{decode_base64, encode_base64};
use crate::errors::AtomicResult;

/// Current certificate format version. A signed layout can never change
/// retroactively — only new versions may be added, and verifiers dispatch on
/// this byte.
pub const GENESIS_VERSION_V1: u8 = 0x01;

/// `flags` bit 0: a 32-byte `stateHash` is present after the nonce.
const FLAG_HAS_STATE_HASH: u8 = 0b0000_0001;

/// The signed identity payload of a DID resource.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GenesisCert {
    /// Ed25519 public key of the creating agent (raw 32 bytes).
    pub signer_pubkey: [u8; 32],
    /// Creation time, Unix milliseconds.
    pub created_at: i64,
    /// CSPRNG uniqueness salt — guarantees a distinct DID even for the same
    /// agent + parent + millisecond (Ed25519 is deterministic).
    pub nonce: [u8; 16],
    /// Optional Blake3 of the canonical genesis projection — binds the initial
    /// content (authorship of the exact starting state).
    pub state_hash: Option<[u8; 32]>,
    /// The ORIGINAL parent subject (immutable provenance — distinct from the
    /// resource's current, mutable `parent` propval).
    pub parent: String,
    /// The resource's drive DID. Immutable — a resource effectively never moves
    /// between drives. Binding it into the signed identity makes rights checks
    /// drive-first and race-free, and lets did: subjects be drive-scoped in the
    /// watched-query index. See `planning/genesis-self-verifying.md`.
    pub drive: String,
}

impl GenesisCert {
    /// Serialize to the canonical v1 binary layout (little-endian integers).
    /// These bytes are exactly what gets signed/verified.
    pub fn encode(&self) -> Vec<u8> {
        let parent_bytes = self.parent.as_bytes();
        let drive_bytes = self.drive.as_bytes();
        let mut out =
            Vec::with_capacity(2 + 32 + 8 + 16 + 32 + 2 + parent_bytes.len() + 2 + drive_bytes.len());

        out.push(GENESIS_VERSION_V1);
        let mut flags = 0u8;
        if self.state_hash.is_some() {
            flags |= FLAG_HAS_STATE_HASH;
        }
        out.push(flags);

        out.extend_from_slice(&self.signer_pubkey);
        out.extend_from_slice(&self.created_at.to_le_bytes());
        out.extend_from_slice(&self.nonce);

        if let Some(hash) = &self.state_hash {
            out.extend_from_slice(hash);
        }

        // parent: u16 length prefix + UTF-8.
        let parent_len: u16 = parent_bytes
            .len()
            .try_into()
            .expect("genesis parent subject exceeds 65535 bytes");
        out.extend_from_slice(&parent_len.to_le_bytes());
        out.extend_from_slice(parent_bytes);

        // drive: u16 length prefix + UTF-8.
        let drive_len: u16 = drive_bytes
            .len()
            .try_into()
            .expect("genesis drive subject exceeds 65535 bytes");
        out.extend_from_slice(&drive_len.to_le_bytes());
        out.extend_from_slice(drive_bytes);

        out
    }

    /// Parse the canonical binary layout. Rejects unknown versions, truncated
    /// input, and trailing bytes.
    pub fn decode(bytes: &[u8]) -> AtomicResult<Self> {
        fn take<'a>(bytes: &'a [u8], cursor: &mut usize, n: usize) -> AtomicResult<&'a [u8]> {
            let end = *cursor + n;
            if end > bytes.len() {
                return Err("Genesis certificate is truncated".into());
            }
            let slice = &bytes[*cursor..end];
            *cursor = end;
            Ok(slice)
        }

        let mut cursor = 0;
        let header = take(bytes, &mut cursor, 2)?;
        let version = header[0];
        if version != GENESIS_VERSION_V1 {
            return Err(format!("Unsupported genesis certificate version {version}").into());
        }
        let flags = header[1];

        let mut signer_pubkey = [0u8; 32];
        signer_pubkey.copy_from_slice(take(bytes, &mut cursor, 32)?);

        let created_at = i64::from_le_bytes(take(bytes, &mut cursor, 8)?.try_into().unwrap());

        let mut nonce = [0u8; 16];
        nonce.copy_from_slice(take(bytes, &mut cursor, 16)?);

        let state_hash = if flags & FLAG_HAS_STATE_HASH != 0 {
            let mut hash = [0u8; 32];
            hash.copy_from_slice(take(bytes, &mut cursor, 32)?);
            Some(hash)
        } else {
            None
        };

        let parent_len = u16::from_le_bytes(take(bytes, &mut cursor, 2)?.try_into().unwrap()) as usize;
        let parent = String::from_utf8(take(bytes, &mut cursor, parent_len)?.to_vec())
            .map_err(|e| format!("Genesis parent is not valid UTF-8: {e}"))?;

        let drive_len = u16::from_le_bytes(take(bytes, &mut cursor, 2)?.try_into().unwrap()) as usize;
        let drive = String::from_utf8(take(bytes, &mut cursor, drive_len)?.to_vec())
            .map_err(|e| format!("Genesis drive is not valid UTF-8: {e}"))?;

        if cursor != bytes.len() {
            return Err("Genesis certificate has trailing bytes".into());
        }

        Ok(Self {
            signer_pubkey,
            created_at,
            nonce,
            state_hash,
            parent,
            drive,
        })
    }

    /// The signing agent's DID (`did:ad:agent:<pubkey>`), so callers can
    /// cross-check the certificate's signer against `createdBy`.
    pub fn signer_did(&self) -> String {
        format!("did:ad:agent:{}", encode_base64(&self.signer_pubkey))
    }

    /// The resource subject that a given signature implies.
    pub fn subject_for_signature(signature: &str) -> String {
        format!("did:ad:{signature}")
    }

    /// Sign the certificate with an Ed25519 private key (32-byte seed, base64).
    /// Returns the signature (base64url); the resource subject is
    /// `did:ad:<signature>`. Errors if the key does not match `signer_pubkey`.
    pub fn sign(&self, private_key: &str) -> AtomicResult<String> {
        use ed25519_dalek::{Signer, SigningKey};

        let seed: [u8; 32] = decode_base64(private_key)?
            .try_into()
            .map_err(|_| "Ed25519 private key must be 32 bytes")?;
        let signing_key = SigningKey::from_bytes(&seed);
        if signing_key.verifying_key().as_bytes() != &self.signer_pubkey {
            return Err("Genesis signer pubkey does not match the signing key".into());
        }
        let signature = signing_key.sign(&self.encode());
        Ok(encode_base64(&signature.to_bytes()))
    }

    /// Verify `signature` (base64) is a valid Ed25519 signature of this
    /// certificate by `signer_pubkey`. The caller separately confirms
    /// [`Self::subject_for_signature`] equals the resource subject (binding the
    /// signature to the DID), and that `signer_pubkey` matches `createdBy`.
    pub fn verify(&self, signature: &str) -> AtomicResult<()> {
        use ed25519_dalek::Verifier;

        let verifying_key = ed25519_dalek::VerifyingKey::from_bytes(&self.signer_pubkey)
            .map_err(|e| format!("Invalid genesis signer pubkey: {e}"))?;
        let sig_bytes: [u8; 64] = decode_base64(signature)?
            .try_into()
            .map_err(|_| "Ed25519 signature must be 64 bytes")?;
        let sig = ed25519_dalek::Signature::from_bytes(&sig_bytes);
        verifying_key
            .verify(&self.encode(), &sig)
            .map_err(|_| "Genesis certificate signature is invalid".into())
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use ed25519_dalek::SigningKey;

    /// Deterministic signing key for tests. Returns (private_key_b64, pubkey32).
    fn test_key(seed_byte: u8) -> (String, [u8; 32]) {
        let seed = [seed_byte; 32];
        let signing_key = SigningKey::from_bytes(&seed);
        let pubkey = *signing_key.verifying_key().as_bytes();
        (encode_base64(&seed), pubkey)
    }

    fn sample(pubkey: [u8; 32], state_hash: Option<[u8; 32]>) -> GenesisCert {
        GenesisCert {
            signer_pubkey: pubkey,
            created_at: 1_780_000_123_456,
            nonce: [7u8; 16],
            state_hash,
            parent: "https://example.com/parent".to_string(),
            drive: "https://example.com/drive".to_string(),
        }
    }

    #[test]
    fn encode_decode_roundtrip_without_state_hash() {
        let (_pk, pubkey) = test_key(1);
        let cert = sample(pubkey, None);
        let decoded = GenesisCert::decode(&cert.encode()).unwrap();
        assert_eq!(cert, decoded);
        // Layout: 2 header + 32 pubkey + 8 createdAt + 16 nonce
        //         + 2 len + parent + 2 len + drive.
        assert_eq!(
            cert.encode().len(),
            2 + 32
                + 8
                + 16
                + 2
                + "https://example.com/parent".len()
                + 2
                + "https://example.com/drive".len()
        );
    }

    #[test]
    fn known_byte_vector_v1() {
        // This exact vector is pinned identically in the TypeScript mirror
        // (`browser/lib/src/genesis.test.ts`). If either side drifts, a
        // browser-minted DID stops verifying server-side. Change only with a
        // new version byte + both sides updated.
        let cert = GenesisCert {
            signer_pubkey: [1u8; 32],
            created_at: 1,
            nonce: [2u8; 16],
            state_hash: None,
            parent: "x".to_string(),
            drive: "d".to_string(),
        };

        let mut expected = vec![0x01u8, 0x00]; // version, flags (no stateHash)
        expected.extend_from_slice(&[1u8; 32]); // signer pubkey
        expected.extend_from_slice(&1i64.to_le_bytes()); // createdAt
        expected.extend_from_slice(&[2u8; 16]); // nonce
        expected.extend_from_slice(&1u16.to_le_bytes()); // parent length
        expected.push(b'x');
        expected.extend_from_slice(&1u16.to_le_bytes()); // drive length
        expected.push(b'd');

        assert_eq!(cert.encode(), expected);
    }

    #[test]
    fn encode_decode_roundtrip_with_state_hash() {
        let (_pk, pubkey) = test_key(2);
        let cert = sample(pubkey, Some([9u8; 32]));
        let bytes = cert.encode();
        assert_eq!(bytes[1] & FLAG_HAS_STATE_HASH, FLAG_HAS_STATE_HASH);
        assert_eq!(GenesisCert::decode(&bytes).unwrap(), cert);
    }

    #[test]
    fn sign_then_verify_succeeds_and_derives_subject() {
        let (private_key, pubkey) = test_key(3);
        let cert = sample(pubkey, Some([1u8; 32]));

        let signature = cert.sign(&private_key).unwrap();
        cert.verify(&signature).unwrap();

        let subject = GenesisCert::subject_for_signature(&signature);
        assert!(subject.starts_with("did:ad:"));
        assert_eq!(cert.signer_did(), format!("did:ad:agent:{}", encode_base64(&pubkey)));
    }

    #[test]
    fn signing_with_wrong_key_is_rejected() {
        let (_pk1, pubkey1) = test_key(4);
        let (private_key2, _pubkey2) = test_key(5);
        let cert = sample(pubkey1, None);
        // Signing key #2 does not match the cert's signer pubkey #1.
        assert!(cert.sign(&private_key2).is_err());
    }

    #[test]
    fn tampered_cert_fails_verification() {
        let (private_key, pubkey) = test_key(6);
        let cert = sample(pubkey, None);
        let signature = cert.sign(&private_key).unwrap();

        // A cert with any field changed must not verify against the signature.
        let mut tampered = cert.clone();
        tampered.created_at += 1;
        assert!(tampered.verify(&signature).is_err());

        let mut tampered2 = cert.clone();
        tampered2.parent = "https://example.com/evil".to_string();
        assert!(tampered2.verify(&signature).is_err());
    }

    #[test]
    fn decode_rejects_bad_version_truncation_and_trailing() {
        let (_pk, pubkey) = test_key(7);
        let cert = sample(pubkey, None);
        let bytes = cert.encode();

        let mut bad_version = bytes.clone();
        bad_version[0] = 0xFF;
        assert!(GenesisCert::decode(&bad_version).is_err());

        assert!(GenesisCert::decode(&bytes[..bytes.len() - 3]).is_err());

        let mut trailing = bytes.clone();
        trailing.push(0);
        assert!(GenesisCert::decode(&trailing).is_err());
    }
}
