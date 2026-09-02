//! Tombstones for resources destroyed locally. Used during Iroh/WS bulk sync so
//! peers delete instead of re-uploading or resurrecting deleted subjects.

use crate::db::trees::Tree;
use crate::Db;

const PREFIX: &[u8] = b"tombstone:";

fn tombstone_key(subject: &str) -> Vec<u8> {
    let pure = crate::Subject::from_raw(subject, None).pure_id();
    let mut key = Vec::with_capacity(PREFIX.len() + pure.len());
    key.extend_from_slice(PREFIX);
    key.extend_from_slice(pure.as_bytes());
    key
}

/// Remember that this subject was intentionally destroyed on this device.
pub fn record_tombstone(store: &Db, subject: &str) {
    let key = tombstone_key(subject);
    let _ = store.kv.insert(Tree::PluginMeta, &key, &[1]);
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
}
