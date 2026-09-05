//! Tombstones for resources destroyed locally. Used during Iroh/WS bulk sync so
//! peers delete instead of re-uploading or resurrecting deleted subjects.
//!
//! The value is either a one-byte marker (`[1]`) for an unsigned tombstone
//! (cascade delete, cache eviction, a peer that sent `remove[]` without an
//! envelope) or the signed destroy commit's JSON-AD. The latter is what
//! `SYNC_DIFF.removeCommits` carries so a replica can apply the destroy
//! with the same signature + rights check as a live `COMMIT`. Full
//! envelope-on-resource storage (`Tree::Envelopes`) is still the commit
//! retention floor; this is destroy-only evidence on the existing
//! `PluginMeta` tombstone key.

use crate::db::trees::Tree;
use crate::Db;

const PREFIX: &[u8] = b"tombstone:";
const UNSIGNED_MARKER: &[u8] = &[1];

fn tombstone_key(subject: &str) -> Vec<u8> {
    let pure = crate::Subject::from_raw(subject, None).pure_id();
    let mut key = Vec::with_capacity(PREFIX.len() + pure.len());
    key.extend_from_slice(PREFIX);
    key.extend_from_slice(pure.as_bytes());
    key
}

/// Remember that this subject was intentionally destroyed on this device.
/// Does not overwrite a stored destroy envelope — a later unsigned path
/// (cascade, `apply_destroy`) must not drop the signed evidence.
pub fn record_tombstone(store: &Db, subject: &str) {
    if destroy_envelope(store, subject).is_some() {
        return;
    }
    let key = tombstone_key(subject);
    let _ = store.kv.insert(Tree::PluginMeta, &key, UNSIGNED_MARKER);
}

/// Store (or replace) the signed destroy commit that authorises this
/// tombstone. Overwrites an unsigned marker.
pub fn record_destroy_envelope(store: &Db, subject: &str, commit_json: &str) {
    if commit_json.is_empty() {
        record_tombstone(store, subject);
        return;
    }
    let key = tombstone_key(subject);
    let _ = store
        .kv
        .insert(Tree::PluginMeta, &key, commit_json.as_bytes());
}

/// The signed destroy commit JSON stored with this tombstone, if any.
/// `None` for an unsigned marker or a missing tombstone.
pub fn destroy_envelope(store: &Db, subject: &str) -> Option<String> {
    let key = tombstone_key(subject);
    let bytes = store.kv.get(Tree::PluginMeta, &key).ok().flatten()?;
    if bytes.is_empty() || bytes == UNSIGNED_MARKER {
        return None;
    }
    let json = String::from_utf8(bytes).ok()?;
    json.starts_with('{').then_some(json)
}

/// True if we previously destroyed this subject here (do not re-import from peers).
pub fn is_tombstoned(store: &Db, subject: &str) -> bool {
    let key = tombstone_key(subject);
    store
        .kv
        .get(Tree::PluginMeta, &key)
        .ok()
        .flatten()
        .is_some()
}

/// Clear a tombstone — the subject was legitimately re-created (F11,
/// planning/unified-sync.md). A tombstone only means "don't resurrect this
/// deleted subject"; once a rights-checked genesis commit re-creates it,
/// that invariant is stale and must not keep suppressing it from future
/// bulk-sync imports (`is_tombstoned` gates `import_sync_push` and the
/// `SYNC_VV` remove-list) or the newly-recreated resource silently never
/// reaches other replicas. No-op if there was no tombstone to clear.
pub fn clear_tombstone(store: &Db, subject: &str) {
    let key = tombstone_key(subject);
    let _ = store.kv.remove(Tree::PluginMeta, &key);
}

#[cfg(test)]
mod key_normalization_tests {
    use super::*;

    /// `tombstone_key` normalizes via `Subject::pure_id()`, which strips query
    /// params/fragments. This matters in practice: `apply_destroy_unchecked`
    /// (ws_apply.rs) used to mis-key Loro snapshot lookups by the raw subject
    /// and miss `?drive=`-suffixed forms — the same class of bug would silently
    /// split one subject's tombstone into two never-consulted-together keys if
    /// `record_tombstone`/`is_tombstoned` didn't normalize consistently.
    #[tokio::test]
    async fn drive_suffixed_and_bare_subject_share_a_tombstone() {
        let db = Db::init_temp("tombstone_key_norm_query").await.unwrap();
        let bare = "https://example.test/some-resource";
        let drive_suffixed = "https://example.test/some-resource?drive=https://example.test/";

        record_tombstone(&db, bare);

        assert!(
            is_tombstoned(&db, drive_suffixed),
            "a `?drive=`-suffixed and bare form of the same subject must normalize to the same tombstone key"
        );
    }

    /// Companion: a trailing-slash variant of the same subject must also hit
    /// the same key.
    #[tokio::test]
    async fn trailing_slash_and_bare_subject_share_a_tombstone() {
        let db = Db::init_temp("tombstone_key_norm_slash").await.unwrap();
        let bare = "https://example.test/some-resource";
        let trailing_slash = "https://example.test/some-resource/";

        record_tombstone(&db, bare);

        assert!(
            is_tombstoned(&db, trailing_slash),
            "a trailing-slash and bare form of the same subject must normalize to the same tombstone key"
        );
    }

    #[tokio::test]
    async fn unsigned_tombstone_has_no_envelope() {
        let db = Db::init_temp("tombstone_unsigned_no_envelope")
            .await
            .unwrap();
        let subject = "did:ad:example";
        record_tombstone(&db, subject);
        assert!(is_tombstoned(&db, subject));
        assert_eq!(destroy_envelope(&db, subject), None);
    }

    #[tokio::test]
    async fn destroy_envelope_round_trips_and_survives_unsigned_rerecord() {
        let db = Db::init_temp("tombstone_envelope_roundtrip").await.unwrap();
        let subject = "did:ad:example";
        let json = r#"{"https://atomicdata.dev/properties/destroy":true}"#;
        record_destroy_envelope(&db, subject, json);
        assert!(is_tombstoned(&db, subject));
        assert_eq!(destroy_envelope(&db, subject).as_deref(), Some(json));
        record_tombstone(&db, subject);
        assert_eq!(
            destroy_envelope(&db, subject).as_deref(),
            Some(json),
            "an unsigned rerecord must not drop a stored destroy envelope"
        );
    }
}
