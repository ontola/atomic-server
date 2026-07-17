//! Resource version history (time-travel reads), backed by the resource's Loro
//! oplog. This is the versioning story: every edit is a Loro change, so the
//! history is already in the document and needs no separate log to replay.
//!
//! Prefer this over [crate::loro] in app code — it keeps the CRDT details here.

use base64::{engine::general_purpose, Engine};

pub use crate::loro::{VersionID, VersionMetadata};
use crate::{errors::AtomicResult, Resource};

/// A [VersionID] as a URL-safe string, for addressing a version over HTTP.
/// The id is opaque (encoded Loro Frontiers), so it is carried as base64url
/// rather than given a readable structure clients might parse.
pub fn encode_version_id(id: &VersionID) -> String {
    general_purpose::URL_SAFE_NO_PAD.encode(id.bytes())
}

pub fn decode_version_id(encoded: &str) -> AtomicResult<VersionID> {
    let bytes = general_purpose::URL_SAFE_NO_PAD
        .decode(encoded)
        .map_err(|e| format!("Not a valid version id: {e}"))?;

    Ok(VersionID::from_bytes(bytes))
}

/// The resource's document, as a value this module may read freely.
fn doc_of(resource: &Resource) -> AtomicResult<crate::loro::AtomicLoroDoc> {
    let Some(snapshot) = resource.materialized_state() else {
        return Err(format!(
            "Resource {} has no Loro history to read versions from.",
            resource.get_subject()
        )
        .into());
    };

    crate::loro::AtomicLoroDoc::from_snapshot(&snapshot)
}

/// Every version of a resource, newest first.
///
/// One version per Loro change, so history is exactly as granular as the
/// changes its authors committed: Loro merges adjacent changes by the same peer
/// within the same second, and only a commit boundary (in practice a message —
/// clients tag every edit) keeps them apart. Code writing to a document it
/// wants history for should commit each edit with
/// [crate::loro::AtomicLoroDoc::commit_with_message].
pub fn versions(resource: &Resource) -> AtomicResult<Vec<VersionMetadata>> {
    Ok(doc_of(resource)?.get_history())
}

/// The resource as it was at `version`.
///
/// Reads a fork, so `resource` is left where it is. The returned resource keeps
/// its own subject; callers addressing it by a version URL set that themselves.
pub fn at_version(resource: &Resource, version: &VersionID) -> AtomicResult<Resource> {
    let past = doc_of(resource)?.fork_at(version)?;

    let mut at = Resource::new(resource.get_subject().to_string());
    at.apply_state_doc(past)?;

    Ok(at)
}

#[cfg(test)]
mod test {
    use super::*;
    use crate::{urls, Value};

    /// Two edits, authored the way a client authors them — each committed with
    /// its own message, which is what keeps them separate changes rather than
    /// one merged one. Reading the older version must give the older value and
    /// leave the live resource where it was.
    #[test]
    fn reads_a_past_version_without_stranding_the_live_resource() {
        let doc = crate::loro::AtomicLoroDoc::new();
        doc.set_property(urls::DESCRIPTION, &Value::String("first".into()))
            .unwrap();
        doc.commit_with_message("e-1");
        let first_id = doc.current_version();

        doc.set_property(urls::DESCRIPTION, &Value::String("second".into()))
            .unwrap();
        doc.commit_with_message("e-2");

        let mut resource = Resource::new("did:ad:versiontest".into());
        resource.apply_state_doc(doc).unwrap();

        assert_eq!(
            versions(&resource).unwrap().len(),
            2,
            "two edits, two versions"
        );

        let past = at_version(&resource, &first_id).unwrap();
        assert_eq!(
            past.get(urls::DESCRIPTION).unwrap().to_string(),
            "first",
            "should read the value as of the first version"
        );
        assert_eq!(
            resource.get(urls::DESCRIPTION).unwrap().to_string(),
            "second",
            "the live resource must still be at the latest version"
        );
    }

    /// The ids [versions] hands out must read back as the state their change
    /// produced. A change is identified by its first op, so an id built from
    /// that reads the change half-applied — for the oldest change, an almost
    /// empty resource.
    #[test]
    fn every_listed_version_reads_back_the_state_it_names() {
        let doc = crate::loro::AtomicLoroDoc::new();
        doc.set_property(urls::NAME, &Value::String("resource".into()))
            .unwrap();
        doc.set_property(urls::DESCRIPTION, &Value::String("first".into()))
            .unwrap();
        doc.commit_with_message("e-1");

        doc.set_property(urls::DESCRIPTION, &Value::String("second".into()))
            .unwrap();
        doc.commit_with_message("e-2");

        let mut resource = Resource::new("did:ad:versiontest".into());
        resource.apply_state_doc(doc).unwrap();

        let listed = versions(&resource).unwrap();
        assert_eq!(listed.len(), 2);

        // Newest first: the last is the resource as first written — whole, with
        // every property that change set.
        let oldest = at_version(&resource, &listed.last().unwrap().id).unwrap();
        assert_eq!(oldest.get(urls::DESCRIPTION).unwrap().to_string(), "first");
        assert_eq!(
            oldest.get(urls::NAME).unwrap().to_string(),
            "resource",
            "the whole change must be applied, not just its first op"
        );

        let newest = at_version(&resource, &listed[0].id).unwrap();
        assert_eq!(newest.get(urls::DESCRIPTION).unwrap().to_string(), "second");
    }

    /// Consecutive edits with no commit boundary between them are one Loro
    /// change, so they are one version. Clients tag each edit (see the `e-`
    /// tokens in `getLoroHistory`), which is what gives history its grain —
    /// history is only as granular as the changes the author committed.
    #[test]
    fn unseparated_edits_are_one_version() {
        let doc = crate::loro::AtomicLoroDoc::new();
        doc.set_property(urls::DESCRIPTION, &Value::String("first".into()))
            .unwrap();
        doc.set_property(urls::DESCRIPTION, &Value::String("second".into()))
            .unwrap();
        doc.commit();

        let mut resource = Resource::new("did:ad:versiontest".into());
        resource.apply_state_doc(doc).unwrap();

        assert_eq!(versions(&resource).unwrap().len(), 1);
    }

    #[test]
    fn version_ids_survive_a_url() {
        let id = VersionID::from_bytes(vec![0, 1, 2, 250, 255]);
        let encoded = encode_version_id(&id);
        assert!(
            !encoded.contains('+') && !encoded.contains('/') && !encoded.contains('='),
            "must be URL-safe without padding: {encoded}"
        );
        assert_eq!(decode_version_id(&encoded).unwrap(), id);
    }
}
