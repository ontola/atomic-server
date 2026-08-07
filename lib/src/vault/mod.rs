//! Shared crypto for client-side envelope encryption: a random DEK encrypts
//! the protected secret once, wrapped independently per enrolled credential
//! (a generated recovery code today; a WebAuthn PRF wrapper is a planned
//! addition). Consumed today by atomic-saas's recovery-secret backup
//! (`planning/BACKUP_SECURITY.md`); the same module is the intended home for
//! the drive-level Cloud Vault key material later
//! (`planning/CLOUD_VAULT_ARCHITECTURE.md`, Phase 0).
//!
//! Nothing here ever runs server-side against real secrets — only the
//! browser (via the `atomic-wasm` bindings) calls these functions. The
//! server only ever stores the opaque output.

pub mod keys;

// Phase 0/1 of the Cloud Vault build: the drive key hierarchy and the object
// envelope. Gated on `db-redb` because that is the feature carrying
// `chacha20poly1305`, and every host that can run a vault client already
// enables it (see the host table in CLOUD_VAULT_ARCHITECTURE.md).
#[cfg(feature = "db-redb")]
pub mod dek;
#[cfg(feature = "db-redb")]
pub mod envelope;
