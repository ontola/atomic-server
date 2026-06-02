//! Content-addressed `did:ad:frozen` resources.
//!
//! A frozen resource is identified by `did:ad:frozen:{blake3-hex}` over the
//! RFC 8785 (JCS) canonicalization of its JSON-AD body. This is the exact hash
//! the TypeScript producer computes
//! (`browser/lib/src/freeze.ts#frozenIdFor`), so ids are byte-for-byte
//! reproducible across languages. The shared contract is pinned by
//! `test-vectors/frozen.json`.
//!
//! Frozen objects are immutable and signatureless: they are verified by
//! re-hashing, never by a commit signature. See `planning/did-ad-frozen-server.md`.

use crate::errors::AtomicResult;
use crate::subject::DID_AD_FROZEN_PREFIX;

/// Reserved top-level key marking a frozen **unit** object: the materialized form
/// of a reference cycle, whose value is an ordered array of member bodies that
/// reference each other by `did:ad:frozen:self:{index}`. Matches
/// `browser/lib/src/freeze.ts#UNIT_MEMBERS_KEY`.
pub const FROZEN_UNIT_KEY: &str = "urn:atomic-freeze:unit";

/// True if a frozen body is a cycle unit (vs. a single resource body).
pub fn is_unit(body: &serde_json::Value) -> bool {
    body.get(FROZEN_UNIT_KEY).is_some()
}

/// Computes the `did:ad:frozen:{blake3-hex}` id for a JSON-AD body.
pub fn frozen_id(body: &serde_json::Value) -> AtomicResult<String> {
    let canonical = serde_jcs::to_string(body)
        .map_err(|e| format!("Failed to JCS-canonicalize frozen body: {}", e))?;
    let hash = blake3::hash(canonical.as_bytes());

    Ok(format!("{}{}", DID_AD_FROZEN_PREFIX, hash.to_hex()))
}

/// Returns `Ok(())` when `body` hashes to `id`, otherwise an error. This is the
/// verify-by-rehash check the server runs on store and serve; no signature or
/// trust in the source is required.
pub fn verify_frozen(id: &str, body: &serde_json::Value) -> AtomicResult<()> {
    let actual = frozen_id(body)?;

    if actual == id {
        Ok(())
    } else {
        Err(format!(
            "Frozen body hashes to {} but was addressed as {}",
            actual, id
        )
        .into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(serde::Deserialize)]
    struct Vector {
        name: String,
        body: serde_json::Value,
        id: String,
    }

    #[derive(serde::Deserialize)]
    struct Vectors {
        vectors: Vec<Vector>,
    }

    /// Proves the Rust frozen id matches the TypeScript producer for every
    /// shared vector. A failure here is a cross-language identity break.
    #[test]
    fn matches_cross_language_vectors() {
        let raw = include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../test-vectors/frozen.json"
        ));
        let parsed: Vectors = serde_json::from_str(raw).expect("valid fixture");

        assert!(!parsed.vectors.is_empty(), "fixture has no vectors");

        for vector in parsed.vectors {
            assert_eq!(
                frozen_id(&vector.body).unwrap(),
                vector.id,
                "frozen id mismatch for vector {}",
                vector.name
            );
        }
    }

    #[test]
    fn verify_frozen_rejects_a_mismatch() {
        let body = serde_json::json!({ "a": 1 });
        let wrong =
            "did:ad:frozen:0000000000000000000000000000000000000000000000000000000000000000";

        assert!(verify_frozen(&frozen_id(&body).unwrap(), &body).is_ok());
        assert!(verify_frozen(wrong, &body).is_err());
    }
}
