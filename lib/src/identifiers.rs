//! Canonical `atomic:` identifier scheme and the `did:ad:` alias.
//!
//! New identifiers are emitted as `atomic:`. Parsers accept both prefixes
//! forever. Equality and storage keys use [`canonicalize_scheme`] so the two
//! spellings name the same resource. Verification of signed material always
//! uses the bytes as stored — never a rewritten prefix.
//!
//! See `docs/src/identifiers.md` and `planning/atomic-scheme.md`.

use crate::subject::DidKind;

/// Canonical scheme for Atomic identifiers.
pub const ATOMIC_PREFIX: &str = "atomic:";

/// Prefix for Agent identifiers: `atomic:agent:`.
pub const ATOMIC_AGENT_PREFIX: &str = "atomic:agent:";

/// Prefix for Commit identifiers: `atomic:commit:`.
pub const ATOMIC_COMMIT_PREFIX: &str = "atomic:commit:";

/// Prefix for Blob identifiers: `atomic:blob:`.
pub const ATOMIC_BLOB_PREFIX: &str = "atomic:blob:";

/// Prefix for Node identifiers: `atomic:node:`.
pub const ATOMIC_NODE_PREFIX: &str = "atomic:node:";

/// Legacy scheme accepted forever. New code emits [`ATOMIC_PREFIX`].
pub const DID_AD_PREFIX: &str = "did:ad:";

/// Legacy agent prefix. New code emits [`ATOMIC_AGENT_PREFIX`].
pub const DID_AD_AGENT_PREFIX: &str = "did:ad:agent:";

/// Legacy commit prefix. New code emits [`ATOMIC_COMMIT_PREFIX`].
pub const DID_AD_COMMIT_PREFIX: &str = "did:ad:commit:";

/// Legacy blob prefix. New code emits [`ATOMIC_BLOB_PREFIX`].
pub const DID_AD_BLOB_PREFIX: &str = "did:ad:blob:";

/// Legacy node prefix. New code emits [`ATOMIC_NODE_PREFIX`].
pub const DID_AD_NODE_PREFIX: &str = "did:ad:node:";

/// Capability a peer lists when it understands `atomic:` on the wire.
/// A peer that does not list it receives [`to_legacy_scheme`] subjects.
pub const CAP_CANONICAL_SCHEME: &str = "canonical-scheme";

/// True for the hierarchical `atomic://…` form (`pair` / `open`), which is
/// not an [`ATOMIC_PREFIX`] identifier.
pub fn is_legacy_atomic_link(raw: &str) -> bool {
    raw.starts_with("atomic://")
}

/// True when `raw` uses the `atomic:` identifier scheme (not `atomic://` links).
pub fn starts_with_atomic_scheme(raw: &str) -> bool {
    raw.starts_with(ATOMIC_PREFIX) && !is_legacy_atomic_link(raw)
}

/// True when `raw` uses the legacy `did:ad:` scheme.
pub fn starts_with_legacy_scheme(raw: &str) -> bool {
    raw.starts_with(DID_AD_PREFIX)
}

/// True when `raw` is an Atomic identifier under either accepted scheme.
pub fn is_atomic_identifier(raw: &str) -> bool {
    starts_with_atomic_scheme(raw) || starts_with_legacy_scheme(raw)
}

/// HTTP endpoints that resolve an identifier via `?subject=`.
pub fn is_identifier_http_endpoint(path: &str) -> bool {
    matches!(path, "/did" | "/resource" | "/atomic")
}

/// Path-form identifier: `/atomic:{genesis}` or `/did:ad:{genesis}`.
pub fn is_identifier_path_form(path: &str) -> bool {
    path.strip_prefix('/')
        .is_some_and(|rest| !rest.contains('/') && is_atomic_identifier(rest))
}

/// True when this request path resolves an Atomic identifier rather than an
/// Internal subject. Strips query/fragment before matching.
pub fn is_identifier_resolution_path(path: &str) -> bool {
    let path = path.split(['?', '#']).next().unwrap_or(path);
    is_identifier_http_endpoint(path) || is_identifier_path_form(path)
}

/// The identifier body after either scheme prefix, including query/fragment.
pub fn identifier_rest(raw: &str) -> Option<&str> {
    if starts_with_atomic_scheme(raw) {
        raw.strip_prefix(ATOMIC_PREFIX)
    } else if starts_with_legacy_scheme(raw) {
        raw.strip_prefix(DID_AD_PREFIX)
    } else {
        None
    }
}

/// The identifier body after either scheme prefix, with query/fragment stripped.
pub fn identifier_body(raw: &str) -> Option<&str> {
    let rest = identifier_rest(raw)?;
    Some(rest.split(['?', '#']).next().unwrap_or(rest))
}

/// Rewrite `did:ad:` → `atomic:`. Other strings are unchanged. Query/fragment stay.
pub fn canonicalize_scheme(raw: &str) -> String {
    match identifier_rest(raw) {
        Some(rest) if starts_with_legacy_scheme(raw) => format!("{ATOMIC_PREFIX}{rest}"),
        _ => raw.to_string(),
    }
}

/// Rewrite `atomic:` → `did:ad:` for a peer that predates the rename.
pub fn to_legacy_scheme(raw: &str) -> String {
    match identifier_rest(raw) {
        Some(rest) if starts_with_atomic_scheme(raw) => format!("{DID_AD_PREFIX}{rest}"),
        _ => raw.to_string(),
    }
}

/// Keys to try when looking up a stored resource. Canonical form first, then
/// the `did:ad:` alias so a pre-rename store still resolves.
pub fn storage_lookup_keys(subject: &str) -> Vec<String> {
    let canonical = canonicalize_scheme(subject);
    let mut keys = vec![canonical.clone()];
    if let Some(alias) = scheme_alias(&canonical) {
        if alias != canonical {
            keys.push(alias);
        }
    }
    keys
}

/// The other accepted spelling of an Atomic identifier, if `raw` is one.
pub fn scheme_alias(raw: &str) -> Option<String> {
    let rest = identifier_rest(raw)?;
    if starts_with_atomic_scheme(raw) {
        Some(format!("{DID_AD_PREFIX}{rest}"))
    } else {
        Some(format!("{ATOMIC_PREFIX}{rest}"))
    }
}

/// Emit `atomic:` when the peer listed [`CAP_CANONICAL_SCHEME`], else `did:ad:`.
pub fn emit_subject_for_caps(subject: &str, caps: &[impl AsRef<str>]) -> String {
    if caps.iter().any(|c| c.as_ref() == CAP_CANONICAL_SCHEME) {
        canonicalize_scheme(subject)
    } else {
        to_legacy_scheme(subject)
    }
}

/// Classify an Atomic identifier. `None` for non-Atomic strings.
pub fn identifier_kind(raw: &str) -> Option<DidKind> {
    let body = identifier_body(raw)?;
    if let Some(rest) = body.strip_prefix("agent:") {
        return Some(if rest.is_empty() {
            DidKind::Other
        } else {
            DidKind::Agent
        });
    }
    if let Some(rest) = body.strip_prefix("commit:") {
        return Some(if rest.is_empty() {
            DidKind::Other
        } else {
            DidKind::Commit
        });
    }
    if let Some(rest) = body.strip_prefix("blob:") {
        return Some(if rest.is_empty() {
            DidKind::Other
        } else {
            DidKind::Blob
        });
    }
    if let Some(rest) = body.strip_prefix("node:") {
        return Some(if rest.is_empty() {
            DidKind::Other
        } else {
            DidKind::Node
        });
    }
    if !body.is_empty() && !body.contains(':') {
        Some(DidKind::Resource)
    } else {
        Some(DidKind::Other)
    }
}

pub fn is_agent_id(raw: &str) -> bool {
    identifier_kind(raw) == Some(DidKind::Agent)
}

pub fn is_commit_id(raw: &str) -> bool {
    identifier_kind(raw) == Some(DidKind::Commit)
}

pub fn is_blob_id(raw: &str) -> bool {
    identifier_kind(raw) == Some(DidKind::Blob)
}

pub fn is_node_id(raw: &str) -> bool {
    identifier_kind(raw) == Some(DidKind::Node)
}

pub fn is_resource_id(raw: &str) -> bool {
    identifier_kind(raw) == Some(DidKind::Resource)
}

/// Public key of an `atomic:agent:` / `did:ad:agent:` identifier.
pub fn agent_public_key(raw: &str) -> Option<&str> {
    identifier_body(raw)?
        .strip_prefix("agent:")
        .filter(|s| !s.is_empty())
}

/// Signature of an `atomic:commit:` / `did:ad:commit:` identifier.
pub fn commit_signature(raw: &str) -> Option<&str> {
    identifier_body(raw)?
        .strip_prefix("commit:")
        .filter(|s| !s.is_empty())
}

/// Hex BLAKE3 of an `atomic:blob:` / `did:ad:blob:` identifier.
pub fn blob_hash_hex(raw: &str) -> Option<&str> {
    identifier_body(raw)?
        .strip_prefix("blob:")
        .filter(|s| !s.is_empty())
}

/// Node id of an `atomic:node:` / `did:ad:node:` identifier.
pub fn node_id(raw: &str) -> Option<&str> {
    identifier_body(raw)?
        .strip_prefix("node:")
        .filter(|s| !s.is_empty())
}

pub fn agent_subject(pubkey: &str) -> String {
    format!("{ATOMIC_AGENT_PREFIX}{pubkey}")
}

pub fn resource_subject(genesis_sig: &str) -> String {
    format!("{ATOMIC_PREFIX}{genesis_sig}")
}

pub fn commit_subject(signature: &str) -> String {
    format!("{ATOMIC_COMMIT_PREFIX}{signature}")
}

pub fn blob_subject(hash_hex: &str) -> String {
    format!("{ATOMIC_BLOB_PREFIX}{hash_hex}")
}

pub fn node_subject(node_id: &str) -> String {
    format!("{ATOMIC_NODE_PREFIX}{node_id}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn both_schemes_are_the_same_resource() {
        assert_eq!(
            canonicalize_scheme("did:ad:abc"),
            canonicalize_scheme("atomic:abc")
        );
        assert_eq!(
            canonicalize_scheme("did:ad:abc?drive=x"),
            "atomic:abc?drive=x"
        );
        assert_eq!(scheme_alias("atomic:abc").as_deref(), Some("did:ad:abc"));
        assert_eq!(scheme_alias("did:ad:abc").as_deref(), Some("atomic:abc"));
    }

    #[test]
    fn kinds_match_across_schemes() {
        for (raw, kind) in [
            ("atomic:genesisSig", DidKind::Resource),
            ("did:ad:genesisSig", DidKind::Resource),
            ("atomic:agent:pk", DidKind::Agent),
            ("did:ad:agent:pk", DidKind::Agent),
            ("atomic:commit:sig", DidKind::Commit),
            ("atomic:blob:ab", DidKind::Blob),
            ("atomic:node:ff", DidKind::Node),
            ("atomic:future:x", DidKind::Other),
            ("did:ad:future:x", DidKind::Other),
        ] {
            assert_eq!(identifier_kind(raw), Some(kind), "{raw}");
        }
        assert_eq!(identifier_kind("https://example.com"), None);
        assert_eq!(identifier_kind("did:key:abc"), None);
        assert_eq!(identifier_kind("atomic://pair?v=1"), None);
    }

    #[test]
    fn identifier_resolution_paths() {
        assert!(is_identifier_http_endpoint("/did"));
        assert!(is_identifier_http_endpoint("/resource"));
        assert!(is_identifier_http_endpoint("/atomic"));
        assert!(!is_identifier_http_endpoint("/diddle"));
        assert!(!is_identifier_http_endpoint("/resources"));

        assert!(is_identifier_path_form("/atomic:abc"));
        assert!(is_identifier_path_form("/did:ad:abc"));
        assert!(!is_identifier_path_form("/did:key:abc"));
        assert!(!is_identifier_path_form("/atomic://pair"));
        assert!(!is_identifier_path_form("/foo/atomic:abc"));

        assert!(is_identifier_resolution_path("/did?subject=atomic:abc"));
        assert!(is_identifier_resolution_path("/atomic:abc#x"));
        assert!(!is_identifier_resolution_path("/search"));
    }

    #[test]
    fn emit_respects_capability() {
        assert_eq!(
            emit_subject_for_caps("atomic:abc", &["canonical-scheme"]),
            "atomic:abc"
        );
        assert_eq!(
            emit_subject_for_caps("atomic:abc", &["commit-ok-slim"]),
            "did:ad:abc"
        );
    }
}
