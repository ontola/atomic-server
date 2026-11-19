//! Content-addressed Class identifiers: `atomic:class:{blake3-hex}`.
//!
//! A Class's ID is a hash of exactly three fields: its ontology, its shortname
//! and the set of Properties it `requires`. `recommends`, labels, descriptions
//! and every constraint stay outside the hash, so adding a recommended field
//! or fixing a description never mints a new Class.
//!
//! The recipe is the one of [`crate::property_identity`]: RFC 8785 (JCS)
//! canonical JSON, then BLAKE3 in derive-key mode with its own context string.
//! There is no `did:ad:class:` spelling.
//!
//! See `docs/src/schema/class-identity.md`. The shared vectors live in
//! `lib/tests/fixtures/class-identity.json`.

use crate::{
    errors::AtomicResult,
    identifiers::{self, ATOMIC_CLASS_PREFIX},
    property_identity::is_property_id,
    values::SLUG_REGEX,
};
use regex::Regex;
use serde_json::json;

/// Domain separation for class IDs. Keeps them apart from property IDs and
/// blob hashes.
const CLASS_CONTEXT: &str = "atomic class identity v1";

/// Normalize and sort the `requires` members for hashing.
///
/// A member is an `atomic:prop:` ID (`did:ad:prop:` is rewritten) or an
/// `http(s)` term used as it is. Anything else is rejected, as is a member
/// listed twice.
pub fn normalize_requires<S: AsRef<str>>(requires: &[S]) -> AtomicResult<Vec<String>> {
    let mut members = Vec::with_capacity(requires.len());
    for member in requires {
        let member = member.as_ref();
        let normalized = if identifiers::is_prop_id(member) {
            if !is_property_id(member) {
                return Err(format!("Not a valid property identifier: '{member}'").into());
            }
            identifiers::canonicalize_scheme(member)
        } else if member.starts_with("https://") || member.starts_with("http://") {
            member.to_string()
        } else {
            return Err(format!(
                "A class can only require atomic:prop: IDs or http(s) properties, got '{member}'"
            )
            .into());
        };
        members.push(normalized);
    }
    members.sort();
    if let Some(pair) = members.windows(2).find(|w| w[0] == w[1]) {
        return Err(format!("Property '{}' is required more than once", pair[0]).into());
    }
    Ok(members)
}

/// The `atomic:class:{hex}` ID for the given ontology, shortname and required
/// properties. The order of `requires` does not matter.
pub fn class_id<S: AsRef<str>>(
    ontology: &str,
    shortname: &str,
    requires: &[S],
) -> AtomicResult<String> {
    if !Regex::new(SLUG_REGEX).unwrap().is_match(shortname) {
        return Err(format!("Not a valid shortname: '{shortname}'").into());
    }
    if ontology.is_empty() {
        return Err("A class needs an ontology".into());
    }
    let ontology = identifiers::canonicalize_scheme(ontology);
    let requires = normalize_requires(requires)?;
    // serde_json maps sort their keys; JCS orders them again regardless.
    let canonical = serde_jcs::to_string(&json!({
        "ontology": ontology,
        "requires": requires,
        "shortname": shortname,
    }))
    .map_err(|e| format!("Could not canonicalize class identity: {e}"))?;
    let mut hasher = blake3::Hasher::new_derive_key(CLASS_CONTEXT);
    hasher.update(canonical.as_bytes());
    Ok(format!(
        "{ATOMIC_CLASS_PREFIX}{}",
        hasher.finalize().to_hex()
    ))
}

/// Check that `subject` is the ID of this ontology, shortname and required
/// properties.
pub fn verify_class_id<S: AsRef<str>>(
    subject: &str,
    ontology: &str,
    shortname: &str,
    requires: &[S],
) -> AtomicResult<()> {
    if !is_class_id(subject) {
        return Err(format!("Not a class identifier: '{subject}'").into());
    }
    let expected = class_id(ontology, shortname, requires)?;
    if subject != expected {
        return Err(format!(
            "Class ID mismatch: '{subject}' is not the hash of its ontology, shortname and required properties (expected '{expected}')"
        )
        .into());
    }
    Ok(())
}

/// True for a well-formed `atomic:class:{64 lowercase hex}` identifier.
pub fn is_class_id(subject: &str) -> bool {
    subject.starts_with(ATOMIC_CLASS_PREFIX)
        && identifiers::class_hash_hex(subject).is_some_and(|hex| {
            hex.len() == 64 && hex.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value as Json;

    const ONTOLOGY: &str = "atomic:ontologyGenesis";
    const A: &str = "atomic:prop:5a939a7ca63806573c204c88e8994252ef6e14f125f8bd258bce672344b2ba74";
    const B: &str = "atomic:prop:d744c0c58cf42bff6246a015b5e1429c93f1ca505c3355dd84c695c8da6e6626";

    /// Runs the shared fixture `lib/tests/fixtures/class-identity.json`.
    #[test]
    fn shared_fixture() {
        let fixture: Json =
            serde_json::from_str(include_str!("../tests/fixtures/class-identity.json")).unwrap();
        let strings = |v: &Json| -> Vec<String> {
            v.as_array()
                .unwrap()
                .iter()
                .map(|s| s.as_str().unwrap().to_string())
                .collect()
        };
        for case in fixture["valid"].as_array().unwrap() {
            let name = case["name"].as_str().unwrap();
            let got = class_id(
                case["ontology"].as_str().unwrap(),
                case["shortname"].as_str().unwrap(),
                &strings(&case["requires"]),
            )
            .unwrap_or_else(|e| panic!("{name}: {e}"));
            assert_eq!(got, case["id"].as_str().unwrap(), "{name}");
        }
        for case in fixture["invalid"].as_array().unwrap() {
            let name = case["name"].as_str().unwrap();
            let got = class_id(
                case["ontology"].as_str().unwrap(),
                case["shortname"].as_str().unwrap(),
                &strings(&case["requires"]),
            );
            assert!(got.is_err(), "{name} should be rejected");
        }
    }

    #[test]
    fn order_of_requires_does_not_matter() {
        assert_eq!(
            class_id(ONTOLOGY, "task", &[A, B]).unwrap(),
            class_id(ONTOLOGY, "task", &[B, A]).unwrap()
        );
    }

    #[test]
    fn did_forms_normalize() {
        let legacy = A.replace("atomic:prop:", "did:ad:prop:");
        assert_eq!(
            class_id("did:ad:ontologyGenesis", "task", &[legacy]).unwrap(),
            class_id(ONTOLOGY, "task", &[A]).unwrap()
        );
    }

    #[test]
    fn requires_ontology_and_shortname_change_the_id() {
        let base = class_id(ONTOLOGY, "task", &[A]).unwrap();
        assert_ne!(base, class_id(ONTOLOGY, "task", &[A, B]).unwrap());
        assert_ne!(base, class_id(ONTOLOGY, "task", &[] as &[&str]).unwrap());
        assert_ne!(base, class_id(ONTOLOGY, "todo", &[A]).unwrap());
        assert_ne!(base, class_id("atomic:other", "task", &[A]).unwrap());
    }

    #[test]
    fn class_and_property_ids_do_not_collide() {
        // Same ontology and shortname never yield the same hex: the contexts differ.
        let class = class_id(ONTOLOGY, "name", &[] as &[&str]).unwrap();
        let prop =
            crate::property_identity::property_id(ONTOLOGY, "name", crate::urls::STRING).unwrap();
        assert_ne!(
            class.strip_prefix("atomic:class:"),
            prop.strip_prefix("atomic:prop:")
        );
    }

    #[test]
    fn rejects_bad_input() {
        for bad in ["", "Name", "my name", "-a", "a-", "a--b", "a_b"] {
            assert!(class_id(ONTOLOGY, bad, &[A]).is_err(), "{bad}");
        }
        assert!(class_id("", "task", &[A]).is_err());
        // Duplicates, also across spellings.
        assert!(class_id(ONTOLOGY, "task", &[A, A]).is_err());
        let legacy = A.replace("atomic:prop:", "did:ad:prop:");
        assert!(class_id(ONTOLOGY, "task", &[A, legacy.as_str()]).is_err());
        // Other kinds of identifier, and malformed property IDs.
        for bad in [
            "atomic:lens:5a939a7ca63806573c204c88e8994252ef6e14f125f8bd258bce672344b2ba74",
            "atomic:class:5a939a7ca63806573c204c88e8994252ef6e14f125f8bd258bce672344b2ba74",
            "atomic:prop:ABCD",
            "atomic:prop:",
            "internal:/name",
            "name",
            "",
        ] {
            assert!(class_id(ONTOLOGY, "task", &[bad]).is_err(), "{bad}");
        }
    }

    #[test]
    fn http_members_are_hashed_as_is() {
        let core = "https://atomicdata.dev/properties/name";
        class_id(ONTOLOGY, "task", &[core, A]).unwrap();
        assert_ne!(
            class_id(ONTOLOGY, "task", &[core]).unwrap(),
            class_id(ONTOLOGY, "task", &[A]).unwrap()
        );
    }

    #[test]
    fn verify_accepts_match_and_rejects_mismatch() {
        let id = class_id(ONTOLOGY, "task", &[A, B]).unwrap();
        assert!(is_class_id(&id));
        verify_class_id(&id, ONTOLOGY, "task", &[B, A]).unwrap();
        assert!(verify_class_id(&id, ONTOLOGY, "task", &[A]).is_err());
        assert!(verify_class_id(&id, ONTOLOGY, "todo", &[A, B]).is_err());
        assert!(verify_class_id(A, ONTOLOGY, "task", &[A, B]).is_err());
    }

    #[test]
    fn is_class_id_is_strict() {
        assert!(!is_class_id("atomic:class:"));
        assert!(!is_class_id("atomic:class:ABCD"));
        assert!(!is_class_id(&format!("atomic:class:{}", "A".repeat(64))));
        assert!(!is_class_id(&format!("atomic:prop:{}", "a".repeat(64))));
        assert!(is_class_id(&format!("atomic:class:{}", "a".repeat(64))));
        // No legacy spelling.
        assert!(!is_class_id(&format!("did:ad:class:{}", "a".repeat(64))));
    }
}
