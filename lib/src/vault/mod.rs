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
