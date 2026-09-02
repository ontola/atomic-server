//! Diagnostic: derive the ed25519 public key from a base64 private key, so a
//! DID that embeds a public key can be checked against the key it claims.
//!
//! ```sh
//! cargo run -p atomic_lib --example derive_pubkey -- <base64-private-key>
//! ```
use base64::Engine;

fn decode(s: &str) -> Vec<u8> {
    let padded = {
        let mut p = s.to_string();
        while p.len() % 4 != 0 {
            p.push('=');
        }
        p
    };
    base64::engine::general_purpose::URL_SAFE
        .decode(&padded)
        .or_else(|_| base64::engine::general_purpose::STANDARD.decode(&padded))
        .expect("could not base64-decode")
}

fn main() {
    let priv_b64 = std::env::args()
        .nth(1)
        .expect("usage: derive_pubkey <priv>");
    let bytes = decode(&priv_b64);
    let seed: [u8; 32] = bytes.as_slice().try_into().expect("expected 32 bytes");

    let signing = ed25519_dalek::SigningKey::from_bytes(&seed);
    let public = signing.verifying_key();

    let url_safe = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(public.as_bytes());
    let standard = base64::engine::general_purpose::STANDARD.encode(public.as_bytes());

    println!("derived public key (url-safe): {url_safe}");
    println!("derived public key (standard): {standard}");
    println!("implied DID: did:ad:agent:{url_safe}");
}
