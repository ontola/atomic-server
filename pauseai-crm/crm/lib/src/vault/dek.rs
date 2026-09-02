//! The per-drive key hierarchy — Phase 0 of
//! `atomic-saas/planning/CLOUD_VAULT_ARCHITECTURE.md`.
//!
//! One random `DriveVaultKey` per drive, epoch-numbered. Everything the vault
//! encrypts uses a *subkey* derived from it, never the key itself, so the
//! purposes stay cryptographically separated: a pack subkey cannot open a blob,
//! and a blob-id hash cannot be replayed as a content key.
//!
//! The agent's Ed25519 identity deliberately never encrypts bulk data. Rotating
//! an agent key, sharing a drive, and multi-agent drives all depend on the
//! wrapping key being separable from the data key — see decision 5 in the
//! architecture doc.

use rand::RngCore;

/// Length of a vault key and of every subkey derived from one.
pub const VAULT_KEY_LEN: usize = 32;

/// Domain-separation contexts. BLAKE3's `derive_key` mixes these into the KDF,
/// so two subkeys of the same drive key are unrelated even though the input
/// key material is identical. Changing any of these strings changes every
/// subkey derived from it — they are format, not implementation detail.
const CONTEXT_PACK: &str = "atomic-vault 2026 pack envelope";
const CONTEXT_BLOB: &str = "atomic-vault 2026 blob chunk";
const CONTEXT_BLOB_ID: &str = "atomic-vault 2026 blob id";
const CONTEXT_INDEX: &str = "atomic-vault 2026 index metadata";

/// What a subkey is allowed to do. Passing one of these rather than a raw
/// context string keeps call sites from inventing their own domains.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Purpose {
    /// Sealing pack and checkpoint objects.
    Pack,
    /// Sealing file blob chunks.
    Blob,
    /// Keyed hashing of blob plaintext to derive its storage id.
    BlobId,
    /// Sealing pack indexes and checkpoint metadata.
    Index,
}

impl Purpose {
    fn context(self) -> &'static str {
        match self {
            Purpose::Pack => CONTEXT_PACK,
            Purpose::Blob => CONTEXT_BLOB,
            Purpose::BlobId => CONTEXT_BLOB_ID,
            Purpose::Index => CONTEXT_INDEX,
        }
    }
}

/// The root secret for one drive's vault, at one key epoch.
///
/// Epochs exist so a drive can re-key without rewriting history: objects record
/// the epoch they were sealed under, and a restore picks the matching key. A
/// key at epoch N cannot open objects written at epoch N-1 — that is the point,
/// and it is why the epoch travels with the object rather than being inferred.
#[derive(Clone)]
pub struct DriveVaultKey {
    key: [u8; VAULT_KEY_LEN],
    epoch: u32,
}

impl DriveVaultKey {
    /// A fresh random key. This is the only place drive key material is
    /// invented; everything else derives from it.
    pub fn generate(epoch: u32) -> Self {
        let mut key = [0u8; VAULT_KEY_LEN];
        rand::thread_rng().fill_bytes(&mut key);
        Self { key, epoch }
    }

    /// Rebuild a key from stored bytes — used after unwrapping the envelope
    /// that survived a device wipe.
    pub fn from_bytes(key: [u8; VAULT_KEY_LEN], epoch: u32) -> Self {
        Self { key, epoch }
    }

    /// The raw key, for wrapping into an envelope. Deliberately not `Deref` or
    /// `AsRef`: handing this out should be a visible act at the call site.
    pub fn expose_secret(&self) -> &[u8; VAULT_KEY_LEN] {
        &self.key
    }

    pub fn epoch(&self) -> u32 {
        self.epoch
    }

    /// Derive the subkey for one purpose. Deterministic: the same drive key and
    /// purpose always produce the same subkey, which is what lets a restore on
    /// a fresh device open objects written months earlier.
    pub fn subkey(&self, purpose: Purpose) -> [u8; VAULT_KEY_LEN] {
        blake3::derive_key(purpose.context(), &self.key)
    }

    /// Keyed BLAKE3 of a blob's plaintext, as its storage id.
    ///
    /// Keyed, not plain, so identical bytes in two different drives produce
    /// different ids: a plain content hash would let the vault operator learn
    /// that two users hold the same file. Derived from the drive key rather
    /// than the epoch key so ids stay stable across re-keying — otherwise every
    /// re-key would orphan every blob.
    pub fn blob_id(&self, plaintext: &[u8]) -> [u8; 32] {
        let subkey = self.subkey(Purpose::BlobId);
        *blake3::keyed_hash(&subkey, plaintext).as_bytes()
    }
}

impl std::fmt::Debug for DriveVaultKey {
    /// Never print key material, not even truncated: debug output ends up in
    /// logs, and a partial key is still a meaningful search-space reduction.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DriveVaultKey")
            .field("epoch", &self.epoch)
            .field("key", &"<redacted>")
            .finish()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn subkeys_differ_per_purpose() {
        let key = DriveVaultKey::generate(1);
        let pack = key.subkey(Purpose::Pack);
        let blob = key.subkey(Purpose::Blob);
        let blob_id = key.subkey(Purpose::BlobId);
        let index = key.subkey(Purpose::Index);

        // Every pair must differ, or a compromise of one purpose leaks another.
        let all = [pack, blob, blob_id, index];
        for (i, a) in all.iter().enumerate() {
            for b in all.iter().skip(i + 1) {
                assert_ne!(a, b, "subkeys for different purposes must not collide");
            }
            assert_ne!(a, key.expose_secret(), "a subkey must not be the root key");
        }
    }

    #[test]
    fn subkey_derivation_is_deterministic() {
        let raw = [7u8; VAULT_KEY_LEN];
        let a = DriveVaultKey::from_bytes(raw, 1);
        let b = DriveVaultKey::from_bytes(raw, 1);
        assert_eq!(a.subkey(Purpose::Pack), b.subkey(Purpose::Pack));
    }

    #[test]
    fn different_drive_keys_derive_different_subkeys() {
        let a = DriveVaultKey::generate(1);
        let b = DriveVaultKey::generate(1);
        assert_ne!(a.subkey(Purpose::Pack), b.subkey(Purpose::Pack));
    }

    #[test]
    fn generate_does_not_repeat_itself() {
        let a = DriveVaultKey::generate(1);
        let b = DriveVaultKey::generate(1);
        assert_ne!(a.expose_secret(), b.expose_secret());
    }

    /// Blob ids must be stable across epochs, or re-keying orphans every file
    /// chunk already uploaded.
    #[test]
    fn blob_ids_survive_a_key_epoch_bump() {
        let raw = [3u8; VAULT_KEY_LEN];
        let epoch1 = DriveVaultKey::from_bytes(raw, 1);
        let epoch2 = DriveVaultKey::from_bytes(raw, 2);
        assert_eq!(
            epoch1.blob_id(b"file contents"),
            epoch2.blob_id(b"file contents")
        );
    }

    /// Two drives holding identical bytes must not produce the same id, or the
    /// vault operator can detect shared files across users.
    #[test]
    fn blob_ids_are_drive_scoped() {
        let a = DriveVaultKey::generate(1);
        let b = DriveVaultKey::generate(1);
        assert_ne!(a.blob_id(b"same bytes"), b.blob_id(b"same bytes"));
    }

    #[test]
    fn blob_ids_distinguish_content() {
        let key = DriveVaultKey::generate(1);
        assert_ne!(key.blob_id(b"one"), key.blob_id(b"two"));
    }

    #[test]
    fn debug_never_prints_key_material() {
        let key = DriveVaultKey::from_bytes([0xAB; VAULT_KEY_LEN], 4);
        let rendered = format!("{key:?}");
        assert!(rendered.contains("epoch: 4"), "{rendered}");
        assert!(rendered.contains("redacted"), "{rendered}");
        assert!(!rendered.contains("ab"), "key bytes leaked: {rendered}");
        assert!(!rendered.contains("171"), "key bytes leaked: {rendered}");
    }
}
