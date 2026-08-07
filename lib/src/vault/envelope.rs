//! Sealing and opening vault objects — Phase 1 of
//! `atomic-saas/planning/CLOUD_VAULT_ARCHITECTURE.md`.
//!
//! XChaCha20-Poly1305 over a subkey of the drive's `DriveVaultKey`. XChaCha
//! rather than ChaCha because its 192-bit nonce can be drawn at random without
//! tracking a counter: vault objects are produced by several devices that never
//! coordinate, so any scheme needing unique counters across devices would be a
//! correctness hazard the moment two of them backed up at once.
//!
//! The visible header travels in the clear — the vault operator must be able to
//! route and garbage-collect objects without a key — and is bound into the AEAD
//! as associated data. Flipping a header field on a stored object therefore
//! makes it fail to open rather than silently decrypt under the wrong
//! interpretation.

use super::dek::{DriveVaultKey, Purpose, VAULT_KEY_LEN};
use crate::errors::AtomicResult;
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{Key, XChaCha20Poly1305, XNonce};
use rand::RngCore;

/// Format version of the sealed layout. Bumped only when the byte layout
/// changes, and refused rather than guessed at on read — a vault written by a
/// newer client must not be half-parsed by an older one.
pub const ENVELOPE_VERSION: u8 = 1;

const NONCE_LEN: usize = 24;

/// What kind of object the ciphertext holds. Visible to the vault operator by
/// design (it is in the S3 key layout anyway) and bound into the AEAD so an
/// object cannot be relabelled.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum ObjectKind {
    Pack = 1,
    Checkpoint = 2,
    Index = 3,
    Blob = 4,
}

impl ObjectKind {
    fn from_byte(byte: u8) -> AtomicResult<Self> {
        match byte {
            1 => Ok(ObjectKind::Pack),
            2 => Ok(ObjectKind::Checkpoint),
            3 => Ok(ObjectKind::Index),
            4 => Ok(ObjectKind::Blob),
            other => Err(format!("unknown vault object kind {other}").into()),
        }
    }

    fn purpose(self) -> Purpose {
        match self {
            ObjectKind::Pack | ObjectKind::Checkpoint => Purpose::Pack,
            ObjectKind::Index => Purpose::Index,
            ObjectKind::Blob => Purpose::Blob,
        }
    }
}

/// The cleartext header on every vault object.
///
/// Keep this minimal: everything here is readable by the vault operator, and
/// the privacy budget in the architecture doc is a promise about exactly this
/// struct. Anything that would identify a resource, a subject or a count
/// belongs in the ciphertext.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EnvelopeHeader {
    pub version: u8,
    pub kind: ObjectKind,
    pub key_epoch: u32,
}

impl EnvelopeHeader {
    pub fn new(kind: ObjectKind, key_epoch: u32) -> Self {
        Self {
            version: ENVELOPE_VERSION,
            kind,
            key_epoch,
        }
    }

    /// Wire layout: version, kind, then the epoch big-endian. Fixed width, so
    /// the reader never has to trust a length taken from untrusted bytes.
    fn to_bytes(self) -> [u8; 6] {
        let mut out = [0u8; 6];
        out[0] = self.version;
        out[1] = self.kind as u8;
        out[2..6].copy_from_slice(&self.key_epoch.to_be_bytes());
        out
    }

    fn from_bytes(bytes: &[u8]) -> AtomicResult<Self> {
        if bytes.len() < 6 {
            return Err("vault object truncated: header incomplete".into());
        }
        let version = bytes[0];
        if version != ENVELOPE_VERSION {
            return Err(format!(
                "unsupported vault envelope version {version}, this build understands {ENVELOPE_VERSION}"
            )
            .into());
        }
        Ok(Self {
            version,
            kind: ObjectKind::from_byte(bytes[1])?,
            key_epoch: u32::from_be_bytes([bytes[2], bytes[3], bytes[4], bytes[5]]),
        })
    }
}

/// Encrypt `plaintext` into a self-describing vault object.
///
/// Layout: `header | nonce | ciphertext+tag`. The header is authenticated but
/// not encrypted; everything else is both.
pub fn seal(key: &DriveVaultKey, kind: ObjectKind, plaintext: &[u8]) -> AtomicResult<Vec<u8>> {
    let header = EnvelopeHeader::new(kind, key.epoch());
    let header_bytes = header.to_bytes();

    let subkey = key.subkey(kind.purpose());
    let cipher = XChaCha20Poly1305::new(Key::from_slice(&subkey));

    let mut nonce_bytes = [0u8; NONCE_LEN];
    rand::thread_rng().fill_bytes(&mut nonce_bytes);
    let nonce = XNonce::from_slice(&nonce_bytes);

    let ciphertext = cipher
        .encrypt(
            nonce,
            Payload {
                msg: plaintext,
                aad: &header_bytes,
            },
        )
        .map_err(|_| "vault seal failed")?;

    let mut out = Vec::with_capacity(header_bytes.len() + NONCE_LEN + ciphertext.len());
    out.extend_from_slice(&header_bytes);
    out.extend_from_slice(&nonce_bytes);
    out.extend_from_slice(&ciphertext);
    Ok(out)
}

/// Decrypt a vault object, returning its header alongside the plaintext.
///
/// Fails if the object was sealed at a different key epoch than `key`: opening
/// it would need the older key, and silently returning garbage would be worse
/// than an error a restore can report.
pub fn open(key: &DriveVaultKey, sealed: &[u8]) -> AtomicResult<(EnvelopeHeader, Vec<u8>)> {
    let header = EnvelopeHeader::from_bytes(sealed)?;
    let header_bytes = header.to_bytes();

    if header.key_epoch != key.epoch() {
        return Err(format!(
            "vault object was sealed at key epoch {}, but the key provided is epoch {}",
            header.key_epoch,
            key.epoch()
        )
        .into());
    }

    let rest = &sealed[header_bytes.len()..];
    if rest.len() < NONCE_LEN {
        return Err("vault object truncated: nonce incomplete".into());
    }
    let (nonce_bytes, ciphertext) = rest.split_at(NONCE_LEN);

    let subkey = key.subkey(header.kind.purpose());
    let cipher = XChaCha20Poly1305::new(Key::from_slice(&subkey));

    let plaintext = cipher
        .decrypt(
            XNonce::from_slice(nonce_bytes),
            Payload {
                msg: ciphertext,
                aad: &header_bytes,
            },
        )
        .map_err(|_| {
            "vault object failed to decrypt: wrong key, or the ciphertext was altered".to_string()
        })?;

    Ok((header, plaintext))
}

/// Read the cleartext header without a key. This is what the vault operator
/// (and a GC worker) can see, and the reason the header is deliberately dull.
pub fn peek_header(sealed: &[u8]) -> AtomicResult<EnvelopeHeader> {
    EnvelopeHeader::from_bytes(sealed)
}

/// Subkey length, re-exported so callers sizing buffers do not hardcode 32.
pub const SUBKEY_LEN: usize = VAULT_KEY_LEN;

#[cfg(test)]
mod tests {
    use super::*;

    fn key(epoch: u32) -> DriveVaultKey {
        DriveVaultKey::from_bytes([9u8; VAULT_KEY_LEN], epoch)
    }

    #[test]
    fn round_trips() {
        let k = key(1);
        let sealed = seal(&k, ObjectKind::Pack, b"loro delta bytes").unwrap();
        let (header, plaintext) = open(&k, &sealed).unwrap();
        assert_eq!(plaintext, b"loro delta bytes");
        assert_eq!(header.kind, ObjectKind::Pack);
        assert_eq!(header.key_epoch, 1);
    }

    #[test]
    fn ciphertext_does_not_contain_the_plaintext() {
        let k = key(1);
        let secret = b"a subject that must not be visible";
        let sealed = seal(&k, ObjectKind::Pack, secret).unwrap();
        assert!(
            !sealed.windows(secret.len()).any(|w| w == secret),
            "plaintext leaked into the sealed object"
        );
    }

    #[test]
    fn each_seal_uses_a_fresh_nonce() {
        let k = key(1);
        let a = seal(&k, ObjectKind::Pack, b"same input").unwrap();
        let b = seal(&k, ObjectKind::Pack, b"same input").unwrap();
        assert_ne!(a, b, "identical plaintext must not seal to identical bytes");
    }

    #[test]
    fn a_different_key_cannot_open_it() {
        let sealed = seal(&key(1), ObjectKind::Pack, b"secret").unwrap();
        let other = DriveVaultKey::from_bytes([1u8; VAULT_KEY_LEN], 1);
        assert!(open(&other, &sealed).is_err());
    }

    #[test]
    fn a_wrong_epoch_is_refused_rather_than_guessed() {
        let sealed = seal(&key(1), ObjectKind::Pack, b"secret").unwrap();
        let err = open(&key(2), &sealed).unwrap_err().to_string();
        assert!(err.contains("epoch"), "{err}");
    }

    /// The header is authenticated, so an operator cannot relabel a pack as an
    /// index to make it decrypt under a different subkey.
    #[test]
    fn tampering_with_the_header_breaks_decryption() {
        let k = key(1);
        let mut sealed = seal(&k, ObjectKind::Pack, b"secret").unwrap();
        sealed[1] = ObjectKind::Index as u8;
        assert!(open(&k, &sealed).is_err());
    }

    #[test]
    fn tampering_with_the_ciphertext_is_detected() {
        let k = key(1);
        let mut sealed = seal(&k, ObjectKind::Pack, b"secret").unwrap();
        let last = sealed.len() - 1;
        sealed[last] ^= 0xFF;
        assert!(open(&k, &sealed).is_err());
    }

    #[test]
    fn truncated_objects_error_rather_than_panic() {
        let k = key(1);
        let sealed = seal(&k, ObjectKind::Pack, b"secret").unwrap();
        for len in 0..sealed.len() {
            assert!(open(&k, &sealed[..len]).is_err(), "len {len} should fail");
        }
    }

    #[test]
    fn an_unknown_version_is_refused() {
        let k = key(1);
        let mut sealed = seal(&k, ObjectKind::Pack, b"secret").unwrap();
        sealed[0] = 99;
        let err = open(&k, &sealed).unwrap_err().to_string();
        assert!(err.contains("version"), "{err}");
    }

    #[test]
    fn header_is_readable_without_a_key() {
        let sealed = seal(&key(7), ObjectKind::Checkpoint, b"x").unwrap();
        let header = peek_header(&sealed).unwrap();
        assert_eq!(header.kind, ObjectKind::Checkpoint);
        assert_eq!(header.key_epoch, 7);
    }

    /// Blobs and packs use different subkeys, so a blob sealed under one cannot
    /// be opened as the other even with the same drive key.
    #[test]
    fn kinds_are_cryptographically_separated() {
        let k = key(1);
        let mut sealed = seal(&k, ObjectKind::Blob, b"file bytes").unwrap();
        // Relabel to Pack *and* recompute nothing else: the AAD check fires
        // first, but even ignoring it the subkey would differ.
        sealed[1] = ObjectKind::Pack as u8;
        assert!(open(&k, &sealed).is_err());
    }
}
