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
