use rand::RngCore;
use ring::{
    digest,
    signature::{self, KeyPair},
};

const DRIVE_APP_NAME: &str = "atomicdata.drive";

/// Compute the 16-byte drive hash from a public key.
/// drive_hash = truncated_SHA256("atomicdata.drive" || drive_public_key)
pub fn compute_drive_hash(public_key_bytes: &[u8]) -> [u8; 16] {
    let mut data = Vec::with_capacity(DRIVE_APP_NAME.len() + public_key_bytes.len());
    data.extend_from_slice(DRIVE_APP_NAME.as_bytes());
    data.extend_from_slice(public_key_bytes);
    let digest = digest::digest(&digest::SHA256, &data);
    let mut hash = [0u8; 16];
    hash.copy_from_slice(&digest.as_ref()[..16]);
    hash
}

/// Helper to generate a new random Ed25519 keypair for a drive.
/// Returns (public_key, seed) as 32-byte arrays.
/// The seed acts as the private key for signing.
pub fn generate_drive_keypair() -> ([u8; 32], [u8; 32]) {
    let mut seed = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut seed);

    let keypair = signature::Ed25519KeyPair::from_seed_unchecked(&seed)
        .expect("Failed to generate Ed25519 keypair");
    let public_key = keypair
        .public_key()
        .as_ref()
        .try_into()
        .expect("Public key is not 32 bytes");

    (public_key, seed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_drive_hash_consistency() {
        let pubkey = [0u8; 32];
        let hash1 = compute_drive_hash(&pubkey);
        let hash2 = compute_drive_hash(&pubkey);
        assert_eq!(hash1, hash2);
        assert_eq!(hash1.len(), 16);
    }

    #[test]
    fn test_generate_keypair() {
        let (pubkey, seed) = generate_drive_keypair();
        assert_ne!(pubkey, [0u8; 32]);
        assert_ne!(seed, [0u8; 32]);
    }
}
