//! The protected-secret envelope: a random 32-byte key (or any small secret)
//! sealed so that the server storing it can never read it.
//!
//! Not to be confused with `envelope.rs`, which seals vault *objects*, nor with
//! the browser's account-recovery envelope (`recovery.ts`, stored by
//! atomic-saas as `wrapper_type` rows): that one is a separate AES-GCM format
//! with its own recovery-code and passkey wrappers, and it is not read here.
//!
//! A random DEK encrypts the secret once. The DEK is then wrapped once per
//! credential. Adding or removing a credential rewraps a 32-byte key, never the
//! secret itself.
//!
//! Two credentials exist, because two are used:
//!
//! - [`WrapperKind::AgentSecret`] — the drive vault keys the control plane
//!   stores (`vaultWrapKey`), and the browser's local-database key.
//! - [`WrapperKind::NodeKey`] — secrets a node opens unattended (`db.rs`).
//!
//! Recovery-code, password and WebAuthn-PRF wrappers used to live here too.
//! No production path ever wrote one (recovery runs in `recovery.ts`), so they
//! were removed; an envelope carrying a wrapper kind this build does not know
//! still parses, and that wrapper is skipped rather than failing the whole blob.
//!
//! ## Cipher choice
//!
//! XChaCha20-Poly1305 throughout: one AEAD across vault objects and envelopes,
//! and 192-bit random nonces, so one KEK can wrap any number of keys.

use super::keys::KEK_LEN;
use crate::errors::AtomicResult;
use chacha20poly1305::aead::{Aead, KeyInit};
use chacha20poly1305::{Key, XChaCha20Poly1305, XNonce};
use rand::RngCore;
use serde::{Deserialize, Serialize};

/// Envelope format version. v1 (PBKDF2 + AES-GCM, single password wrapper) is
/// deliberately not readable here: it is a different scheme, and this module
/// refusing it is better than appearing to support it.
pub const SECRET_ENVELOPE_VERSION: u32 = 2;

const NONCE_LEN: usize = 24;
const DEK_LEN: usize = 32;

/// How a wrapper's key-encryption key is obtained.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum WrapperKind {
    /// A KEK derived from the agent's signature over a fixed message.
    ///
    /// The wrapper that means a user manages **no new secret**. Whatever
    /// already restores their identity — a passkey, the recovery code on the
    /// identity envelope — also restores every drive key, because holding the
    /// agent secret is sufficient to unwrap them.
    ///
    /// This wraps a random drive key; it does not derive one. Deriving would
    /// weld data encryption to identity permanently: no re-keying a drive
    /// without a new identity, no sharing a drive without sharing the agent
    /// secret. Wrapping keeps the drive key independent while costing the user
    /// nothing — `CLOUD_VAULT_ARCHITECTURE.md`'s key diagram says *wraps* for
    /// exactly this reason.
    AgentSecret,
    /// A key the node itself holds, outside the database it protects.
    ///
    /// The wrapper that lets a secret be used with nobody present — a plugin
    /// importing at 3am cannot be asked for a passkey. It follows that this
    /// wrapper does **not** protect against a compromised running server: the
    /// process can open what it can open. What it does protect is every way a
    /// database leaves the machine intact — a stolen disk, a backup, a copied
    /// store file, a support bundle — which is the realistic path.
    ///
    /// A secret wrapped only by a user credential has no unattended path, by
    /// construction. That is the trade, not a gap to engineer around.
    NodeKey,
    /// A kind this build does not know: written by another client, or one of
    /// the removed recovery-code / password / webauthn-prf kinds. Kept so the
    /// rest of the envelope still opens; never matched by an [`Unlock`].
    #[serde(other)]
    Unknown,
}

/// One credential's route to the DEK.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Wrapper {
    pub kind: WrapperKind,
    /// Stable handle, like "agent-secret". Lets a UI name what it is about to
    /// remove.
    pub id: String,
    pub nonce: String,
    pub wrapped_dek: String,
}

/// The stored blob.
///
/// Serialized as JSON rather than MessagePack: it is small, it is read during
/// account recovery — the worst possible moment to be unable to eyeball a
/// value — and a human staring at it while restoring should be able to tell
/// which wrappers exist.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SecretEnvelope {
    pub format_version: u32,
    pub nonce: String,
    pub ciphertext: String,
    pub wrappers: Vec<Wrapper>,
}

/// How a caller proves it may open the envelope.
pub enum Unlock<'a> {
    /// The node's own key, for [`WrapperKind::NodeKey`].
    Kek([u8; KEK_LEN]),
    /// The agent's vault proof (see [`agent_secret_kek`]), as raw bytes.
    AgentSecret(&'a [u8]),
}

/// What to add when creating an envelope or registering a credential.
pub enum NewWrapper<'a> {
    /// Wrap under the account's agent secret. Raw proof bytes, not a KEK —
    /// the derivation is this module's business so every caller gets the same
    /// domain separation.
    AgentSecret { agent_secret: &'a [u8] },
    /// Wrap under the node's own key, so the host can open this unattended.
    NodeKey { kek: [u8; KEK_LEN] },
}

impl NewWrapper<'_> {
    fn kind(&self) -> WrapperKind {
        match self {
            NewWrapper::AgentSecret { .. } => WrapperKind::AgentSecret,
            NewWrapper::NodeKey { .. } => WrapperKind::NodeKey,
        }
    }

    fn id(&self) -> String {
        match self {
            NewWrapper::AgentSecret { .. } => "agent-secret".to_string(),
            NewWrapper::NodeKey { .. } => "node-key".to_string(),
        }
    }

    fn kek(&self) -> [u8; KEK_LEN] {
        match self {
            // No KDF: the proof is already a full-strength signature, so
            // stretching it would cost time and add nothing.
            NewWrapper::AgentSecret { agent_secret } => agent_secret_kek(agent_secret),
            NewWrapper::NodeKey { kek } => *kek,
        }
    }
}

/// Domain separator for the agent-derived KEK.
const AGENT_SECRET_CONTEXT: &str = "atomic-vault 2026 agent secret wrapper";

/// The message an agent signs to prove it can open its own vault keys.
///
/// Fixed, so the resulting signature is reproducible on any device that holds
/// the agent — Ed25519 signatures are deterministic (RFC 8032), which is what
/// makes a signature usable as key material at all.
pub const AGENT_VAULT_PROOF_MESSAGE: &[u8] = b"atomic-vault-key-derivation-v1";

/// The KEK derived from an agent's proof.
///
/// `proof` is the agent's signature over [`AGENT_VAULT_PROOF_MESSAGE`], not the
/// private key. Two reasons that matters:
///
/// The private key is deliberately not extractable in the browser — the
/// `CryptoProvider` exposes signing, not key bytes — and a scheme that needed
/// the raw key would rule out hardware-backed and non-extractable keys
/// permanently.
///
/// It also removes an ambiguity that caused a real bug: the "agent secret" has
/// several representations (a base64 JSON blob, the `privateKey` inside it, the
/// decoded seed), and wrapping under one while unwrapping with another produced
/// an envelope nothing could open. A signature has exactly one representation.
pub fn agent_secret_kek(proof: &[u8]) -> [u8; KEK_LEN] {
    blake3::derive_key(AGENT_SECRET_CONTEXT, proof)
}

fn b64(bytes: &[u8]) -> String {
    crate::agents::encode_base64(bytes)
}

fn unb64(text: &str) -> AtomicResult<Vec<u8>> {
    crate::agents::decode_base64(text).map_err(|e| format!("malformed envelope field: {e}").into())
}

fn seal(key: &[u8; 32], plaintext: &[u8]) -> AtomicResult<(String, String)> {
    let cipher = XChaCha20Poly1305::new(Key::from_slice(key));
    let mut nonce_bytes = [0u8; NONCE_LEN];
    rand::thread_rng().fill_bytes(&mut nonce_bytes);
    let ciphertext = cipher
        .encrypt(XNonce::from_slice(&nonce_bytes), plaintext)
        .map_err(|_| "failed to seal envelope")?;
    Ok((b64(&nonce_bytes), b64(&ciphertext)))
}

fn unseal(key: &[u8; 32], nonce: &str, ciphertext: &str) -> AtomicResult<Vec<u8>> {
    let nonce_bytes = unb64(nonce)?;
    if nonce_bytes.len() != NONCE_LEN {
        return Err("envelope nonce has the wrong length".into());
    }
    let cipher = XChaCha20Poly1305::new(Key::from_slice(key));
    cipher
        .decrypt(
            XNonce::from_slice(&nonce_bytes),
            unb64(ciphertext)?.as_slice(),
        )
        .map_err(|_| "could not open envelope: wrong credential, or the blob was altered".into())
}

fn wrap_dek(dek: &[u8; DEK_LEN], spec: &NewWrapper) -> AtomicResult<Wrapper> {
    let (nonce, wrapped_dek) = seal(&spec.kek(), dek)?;
    Ok(Wrapper {
        kind: spec.kind(),
        id: spec.id(),
        nonce,
        wrapped_dek,
    })
}

impl SecretEnvelope {
    /// Protect `secret` under the given credentials.
    ///
    /// Requires at least one wrapper — an envelope nobody can open is not a
    /// backup. The stronger product rule (never a lone wrapper, so a lost
    /// passkey is not a lost identity) is enforced at the enrollment call site,
    /// where the UI can actually tell the user what second credential to add.
    pub fn create(secret: &[u8], wrappers: &[NewWrapper]) -> AtomicResult<Self> {
        if wrappers.is_empty() {
            return Err("an envelope needs at least one wrapper, or nothing can open it".into());
        }

        let mut dek = [0u8; DEK_LEN];
        rand::thread_rng().fill_bytes(&mut dek);

        let (nonce, ciphertext) = seal(&dek, secret)?;
        let wrapped = wrappers
            .iter()
            .map(|spec| wrap_dek(&dek, spec))
            .collect::<AtomicResult<Vec<_>>>()?;

        Ok(Self {
            format_version: SECRET_ENVELOPE_VERSION,
            nonce,
            ciphertext,
            wrappers: wrapped,
        })
    }

    /// Recover the DEK using whichever wrapper `unlock` opens.
    ///
    /// Tries every wrapper of a compatible kind rather than requiring the
    /// caller to name one: a user typing a code does not know which wrapper
    /// index it belongs to, and a wrong guess should read as "wrong code", not
    /// "wrong wrapper".
    fn recover_dek(&self, unlock: &Unlock) -> AtomicResult<[u8; DEK_LEN]> {
        self.check_version()?;

        for wrapper in &self.wrappers {
            let kek = match (unlock, wrapper.kind) {
                (Unlock::Kek(kek), WrapperKind::NodeKey) => *kek,
                (Unlock::AgentSecret(secret), WrapperKind::AgentSecret) => agent_secret_kek(secret),
                _ => continue,
            };

            if let Ok(dek) = unseal(&kek, &wrapper.nonce, &wrapper.wrapped_dek) {
                return dek
                    .try_into()
                    .map_err(|_| "envelope contained a malformed DEK".into());
            }
        }

        Err("no wrapper in this envelope accepted that credential".into())
    }

    /// Open the envelope and return the protected secret.
    pub fn unwrap_secret(&self, unlock: &Unlock) -> AtomicResult<Vec<u8>> {
        let dek = self.recover_dek(unlock)?;
        unseal(&dek, &self.nonce, &self.ciphertext)
    }

    /// Register another credential.
    ///
    /// Gated on opening the envelope first: without that, anyone who could
    /// write to the blob could add a wrapper of their own and take the secret
    /// with it. The server never can — it holds ciphertext — but the rule
    /// belongs in the format, not in the storage layer's good intentions.
    pub fn add_wrapper(&mut self, unlock: &Unlock, spec: &NewWrapper) -> AtomicResult<()> {
        self.refuse_rewrite_with_unknown_wrappers()?;
        let dek = self.recover_dek(unlock)?;
        let new_id = spec.id();
        if self.wrappers.iter().any(|w| w.id == new_id) {
            return Err(format!("a wrapper named {new_id} is already registered").into());
        }
        self.wrappers.push(wrap_dek(&dek, spec)?);
        Ok(())
    }

    /// Remove a credential. Refuses to remove the last one — that would leave a
    /// blob nobody can ever open, which is indistinguishable from having
    /// deleted the secret except that it looks like a backup still exists.
    pub fn remove_wrapper(&mut self, id: &str) -> AtomicResult<()> {
        self.refuse_rewrite_with_unknown_wrappers()?;
        if self.wrappers.len() <= 1 {
            return Err("cannot remove the only wrapper: the secret would be unrecoverable".into());
        }
        let before = self.wrappers.len();
        self.wrappers.retain(|w| w.id != id);
        if self.wrappers.len() == before {
            return Err(format!("no wrapper named {id}").into());
        }
        Ok(())
    }

    pub fn has_kind(&self, kind: WrapperKind) -> bool {
        self.wrappers.iter().any(|w| w.kind == kind)
    }

    /// An unknown wrapper parses as [`WrapperKind::Unknown`], and writing the
    /// envelope back would store that placeholder instead of its real kind,
    /// breaking whichever client wrote it. Editing is left to that client.
    fn refuse_rewrite_with_unknown_wrappers(&self) -> AtomicResult<()> {
        if self.has_kind(WrapperKind::Unknown) {
            return Err(
                "this envelope has a wrapper kind this build does not know; refusing to rewrite it"
                    .into(),
            );
        }
        Ok(())
    }

    fn check_version(&self) -> AtomicResult<()> {
        if self.format_version != SECRET_ENVELOPE_VERSION {
            return Err(format!(
                "unsupported envelope format version {}, this build understands {SECRET_ENVELOPE_VERSION}",
                self.format_version
            )
            .into());
        }
        Ok(())
    }

    pub fn to_json(&self) -> AtomicResult<String> {
        serde_json::to_string(self).map_err(|e| format!("failed to serialize envelope: {e}").into())
    }

    pub fn from_json(json: &str) -> AtomicResult<Self> {
        let envelope: Self =
            serde_json::from_str(json).map_err(|e| format!("failed to parse envelope: {e}"))?;
        envelope.check_version()?;
        Ok(envelope)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn node(byte: u8) -> NewWrapper<'static> {
        NewWrapper::NodeKey {
            kek: [byte; KEK_LEN],
        }
    }

    const SECRET: &[u8] = b"an ed25519 agent secret";
    const PROOF: &[u8] = &[7u8; 64];

    #[test]
    fn round_trips_through_a_node_key_wrapper() {
        let envelope = SecretEnvelope::create(SECRET, &[node(1)]).unwrap();
        let opened = envelope.unwrap_secret(&Unlock::Kek([1; KEK_LEN])).unwrap();
        assert_eq!(opened, SECRET);
    }

    #[test]
    fn the_secret_is_not_in_the_blob() {
        let envelope = SecretEnvelope::create(SECRET, &[node(1)]).unwrap();
        let json = envelope.to_json().unwrap();
        assert!(!json.contains("ed25519 agent secret"));
        assert!(!json.as_bytes().windows(SECRET.len()).any(|w| w == SECRET));
    }

    #[test]
    fn any_registered_credential_opens_it() {
        let envelope = SecretEnvelope::create(
            SECRET,
            &[
                NewWrapper::AgentSecret {
                    agent_secret: PROOF,
                },
                node(2),
            ],
        )
        .unwrap();
        assert_eq!(
            envelope.unwrap_secret(&Unlock::AgentSecret(PROOF)).unwrap(),
            SECRET
        );
        assert_eq!(
            envelope.unwrap_secret(&Unlock::Kek([2; KEK_LEN])).unwrap(),
            SECRET
        );
    }

    #[test]
    fn an_unregistered_credential_does_not() {
        let envelope = SecretEnvelope::create(SECRET, &[node(1)]).unwrap();
        assert!(envelope.unwrap_secret(&Unlock::Kek([9; KEK_LEN])).is_err());
        // A node key never opens an agent wrapper, even with matching bytes.
        assert!(envelope
            .unwrap_secret(&Unlock::AgentSecret(&[1; 32]))
            .is_err());
    }

    #[test]
    fn adding_a_credential_requires_opening_the_envelope_first() {
        let mut envelope = SecretEnvelope::create(
            SECRET,
            &[NewWrapper::AgentSecret {
                agent_secret: PROOF,
            }],
        )
        .unwrap();

        // Someone who cannot open it cannot register themselves into it.
        assert!(envelope
            .add_wrapper(&Unlock::AgentSecret(&[9; 64]), &node(3))
            .is_err());

        envelope
            .add_wrapper(&Unlock::AgentSecret(PROOF), &node(2))
            .unwrap();
        assert_eq!(
            envelope.unwrap_secret(&Unlock::Kek([2; KEK_LEN])).unwrap(),
            SECRET
        );
    }

    #[test]
    fn duplicate_wrapper_ids_are_refused() {
        let mut envelope = SecretEnvelope::create(SECRET, &[node(1)]).unwrap();
        assert!(envelope
            .add_wrapper(&Unlock::Kek([1; KEK_LEN]), &node(5))
            .is_err());
    }

    #[test]
    fn removing_a_credential_leaves_the_others_working() {
        let mut envelope = SecretEnvelope::create(
            SECRET,
            &[
                NewWrapper::AgentSecret {
                    agent_secret: PROOF,
                },
                node(2),
            ],
        )
        .unwrap();
        envelope.remove_wrapper("node-key").unwrap();
        assert!(envelope.unwrap_secret(&Unlock::Kek([2; KEK_LEN])).is_err());
        assert_eq!(
            envelope.unwrap_secret(&Unlock::AgentSecret(PROOF)).unwrap(),
            SECRET
        );
    }

    #[test]
    fn the_last_credential_cannot_be_removed() {
        let mut envelope = SecretEnvelope::create(SECRET, &[node(1)]).unwrap();
        let err = envelope.remove_wrapper("node-key").unwrap_err().to_string();
        assert!(err.contains("unrecoverable"), "{err}");
        assert_eq!(
            envelope.unwrap_secret(&Unlock::Kek([1; KEK_LEN])).unwrap(),
            SECRET
        );
    }

    #[test]
    fn an_envelope_with_no_wrappers_is_refused() {
        assert!(SecretEnvelope::create(SECRET, &[]).is_err());
    }

    #[test]
    fn survives_json_storage() {
        let envelope = SecretEnvelope::create(
            SECRET,
            &[
                NewWrapper::AgentSecret {
                    agent_secret: PROOF,
                },
                node(2),
            ],
        )
        .unwrap();
        let restored = SecretEnvelope::from_json(&envelope.to_json().unwrap()).unwrap();
        assert_eq!(restored, envelope);
        assert_eq!(
            restored.unwrap_secret(&Unlock::Kek([2; KEK_LEN])).unwrap(),
            SECRET
        );
    }

    /// The wire names are what the control plane and older builds stored;
    /// removing other kinds must not have renamed these.
    #[test]
    fn wrapper_kinds_keep_their_wire_names() {
        let envelope = SecretEnvelope::create(
            SECRET,
            &[
                NewWrapper::AgentSecret {
                    agent_secret: PROOF,
                },
                node(2),
            ],
        )
        .unwrap();
        let json = envelope.to_json().unwrap();
        assert!(json.contains(r#""kind":"agent-secret""#), "{json}");
        assert!(json.contains(r#""kind":"node-key""#), "{json}");
    }

    /// An envelope written by a build that still had recovery-code, password
    /// and webauthn-prf wrappers (with their `kdf` / `salt` fields) must keep
    /// opening through the wrapper this build does understand.
    #[test]
    fn envelopes_with_removed_wrapper_kinds_still_open() {
        let envelope = SecretEnvelope::create(
            SECRET,
            &[NewWrapper::AgentSecret {
                agent_secret: PROOF,
            }],
        )
        .unwrap();
        let mut value: serde_json::Value =
            serde_json::from_str(&envelope.to_json().unwrap()).unwrap();
        let wrappers = value["wrappers"].as_array_mut().unwrap();
        // Wrapper kinds older builds could write; the extra fields are the
        // Argon2 ones they carried. Placeholder bytes, not credentials.
        const REMOVED_KINDS: [&str; 3] = ["recovery-code", "password", "webauthn-prf"];
        for kind in REMOVED_KINDS {
            wrappers.insert(
                0,
                serde_json::json!({
                    "kind": kind,
                    "id": kind,
                    "kdf": {"mem_kib": 65536, "iterations": 3, "parallelism": 1},
                    "salt": b64(&[0u8; 16]),
                    "nonce": b64(&[0u8; NONCE_LEN]),
                    "wrapped_dek": b64(&[0u8; 3]),
                }),
            );
        }

        let legacy = SecretEnvelope::from_json(&value.to_string()).unwrap();
        assert_eq!(legacy.wrappers[0].kind, WrapperKind::Unknown);
        assert_eq!(
            legacy.unwrap_secret(&Unlock::AgentSecret(PROOF)).unwrap(),
            SECRET
        );
        assert!(legacy
            .unwrap_secret(&Unlock::AgentSecret(&[8; 64]))
            .is_err());

        // Writing it back would lose the unknown kinds, so edits are refused.
        let mut editable = legacy.clone();
        assert!(editable
            .add_wrapper(&Unlock::AgentSecret(PROOF), &node(1))
            .is_err());
        assert!(editable.remove_wrapper(REMOVED_KINDS[0]).is_err());
    }

    /// v1 blobs are a different scheme. Refusing them loudly beats appearing to
    /// support them and returning nonsense.
    #[test]
    fn v1_blobs_are_refused_rather_than_misread() {
        let v1 = r#"{"format_version":1,"nonce":"","ciphertext":"","wrappers":[]}"#;
        let err = SecretEnvelope::from_json(v1).unwrap_err().to_string();
        assert!(err.contains("version"), "{err}");
    }

    #[test]
    fn tampering_with_the_ciphertext_is_detected() {
        let mut envelope = SecretEnvelope::create(SECRET, &[node(1)]).unwrap();
        envelope.ciphertext = b64(b"replaced by an attacker");
        assert!(envelope.unwrap_secret(&Unlock::Kek([1; KEK_LEN])).is_err());
    }

    /// The whole point of the wrapper: a user who can restore their identity can
    /// restore their drive keys, with nothing extra to remember.
    #[test]
    fn an_agent_secret_opens_the_envelope() {
        let drive_key = super::super::dek::DriveVaultKey::generate(1);
        let envelope = SecretEnvelope::create(
            drive_key.expose_secret(),
            &[NewWrapper::AgentSecret {
                agent_secret: PROOF,
            }],
        )
        .unwrap();

        let recovered = envelope.unwrap_secret(&Unlock::AgentSecret(PROOF)).unwrap();
        assert_eq!(recovered, drive_key.expose_secret());
    }

    #[test]
    fn a_different_agent_secret_does_not() {
        let envelope = SecretEnvelope::create(
            SECRET,
            &[NewWrapper::AgentSecret {
                agent_secret: b"mine",
            }],
        )
        .unwrap();
        assert!(envelope
            .unwrap_secret(&Unlock::AgentSecret(b"someone else's"))
            .is_err());
    }

    /// The wrapping key must not be the signing key. If the same bytes both
    /// signed commits and decrypted backups, a flaw in either use would become
    /// a flaw in both.
    #[test]
    fn the_wrapping_key_is_derived_not_the_agent_secret_itself() {
        let agent_secret = [42u8; 32];
        let kek = agent_secret_kek(&agent_secret);
        assert_ne!(kek, agent_secret, "the KEK must not be the secret itself");

        // Deterministic, or a restore on another device could not reproduce it.
        assert_eq!(kek, agent_secret_kek(&agent_secret));
    }

    /// Losing the agent secret must not be survivable *through this wrapper*.
    #[test]
    fn without_the_agent_secret_there_is_no_way_in() {
        let envelope = SecretEnvelope::create(
            SECRET,
            &[NewWrapper::AgentSecret {
                agent_secret: b"lost forever",
            }],
        )
        .unwrap();
        assert!(envelope.unwrap_secret(&Unlock::Kek([0; KEK_LEN])).is_err());
        // The KEK itself is not accepted as a node key either.
        assert!(envelope
            .unwrap_secret(&Unlock::Kek(agent_secret_kek(b"lost forever")))
            .is_err());
    }
}
