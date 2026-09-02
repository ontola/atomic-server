//! Argon2id key derivation for envelope-v2 wrappers (recovery code, and the
//! discouraged password wrapper). AES-GCM itself runs natively via WebCrypto
//! in the browser and needs no Rust/WASM support — this module exists only
//! because Argon2id is the one primitive missing from the Web platform's
//! crypto API. See `planning/BACKUP_SECURITY.md` in atomic-saas.

use argon2::{Algorithm, Argon2, Params, Version};

/// KEK length in bytes — matches AES-256-GCM's key size.
pub const KEK_LEN: usize = 32;

#[derive(Debug, Clone, Copy)]
pub struct Argon2Params {
    pub mem_kib: u32,
    pub iterations: u32,
    pub parallelism: u32,
}

impl Default for Argon2Params {
    /// ~64 MiB / 3 iterations / 1 lane: memory-hard enough that GPU
    /// parallelism doesn't help an attacker the way it does against PBKDF2,
    /// while staying under a second to decrypt on low-end mobile. Revisit
    /// against real device measurements — open question #5 in
    /// `planning/BACKUP_SECURITY.md`.
    fn default() -> Self {
        Self {
            mem_kib: 64 * 1024,
            iterations: 3,
            parallelism: 1,
        }
    }
}

/// Derive a 32-byte key-encryption-key (KEK) from a secret (a generated
/// recovery code, or a discouraged password) and a random salt. This is the
/// only place such a secret ever turns into key material — wrapping the DEK
/// with the result is plain AES-GCM, no further KDF involved.
pub fn argon2id_derive_key(
    secret: &[u8],
    salt: &[u8],
    params: Argon2Params,
) -> Result<[u8; KEK_LEN], argon2::Error> {
    let argon2_params = Params::new(
        params.mem_kib,
        params.iterations,
        params.parallelism,
        Some(KEK_LEN),
    )?;
    let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, argon2_params);

    let mut out = [0u8; KEK_LEN];
    argon2.hash_password_into(secret, salt, &mut out)?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    // Small params so the test suite stays fast; production defaults are
    // calibrated separately (see `Argon2Params::default`).
    fn test_params() -> Argon2Params {
        Argon2Params {
            mem_kib: 8 * 1024,
            iterations: 1,
            parallelism: 1,
        }
    }

    #[test]
    fn same_secret_and_salt_derive_the_same_key() {
        let secret = b"XXXXX-XXXXX-XXXXX-XXXXX-XXXXX";
        let salt = b"0123456789abcdef";
        let a = argon2id_derive_key(secret, salt, test_params()).unwrap();
        let b = argon2id_derive_key(secret, salt, test_params()).unwrap();
        assert_eq!(a, b);
    }

    #[test]
    fn different_salts_derive_different_keys() {
        let secret = b"XXXXX-XXXXX-XXXXX-XXXXX-XXXXX";
        let a = argon2id_derive_key(secret, b"0123456789abcdef", test_params()).unwrap();
        let b = argon2id_derive_key(secret, b"fedcba9876543210", test_params()).unwrap();
        assert_ne!(a, b);
    }

    #[test]
    fn different_secrets_derive_different_keys() {
        let salt = b"0123456789abcdef";
        let a = argon2id_derive_key(b"correct-code", salt, test_params()).unwrap();
        let b = argon2id_derive_key(b"wrong-code", salt, test_params()).unwrap();
        assert_ne!(a, b);
    }

    #[test]
    fn derives_a_full_length_key() {
        let key = argon2id_derive_key(b"secret", b"0123456789abcdef", test_params()).unwrap();
        assert_eq!(key.len(), KEK_LEN);
    }
}
