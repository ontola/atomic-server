//! One-time rewrite of `did:ad:` storage keys and reference values to `atomic:`.
//!
//! Reads already alias both spellings. Writes key by [`crate::Subject::pure_id`],
//! which is canonical. Without this pass a store that was filled before the
//! rename keeps `did:ad:` rows, so the first edit of an old resource forks it
//! and parent/drive queries split the children. See #1584 / PR #1585.
//!
//! Every subject-keyed tree is covered, not only the three a resource is
//! read from: retained envelopes, tombstones and the outbox are scanned by
//! canonical prefix after the rename, so a legacy key in any of them is a
//! row nothing will ever find again (no envelopes to ship, a destroyed
//! subject a peer can resurrect, an offline commit never flushed).
//!
//! The pass streams each tree: it keeps only the keys it has to touch in
//! memory, never a tree's values. A large snapshot table on a phone or in
//! the browser worker would otherwise be materialized in full on every open.

use crate::errors::AtomicResult;
use crate::identifiers::{canonicalize_scheme, starts_with_legacy_scheme};
use crate::resources::PropVals;

use super::encoding::{decode_propvals, encode_propvals};
use super::trees::Tree;
use super::Db;

/// `Tree::PluginMeta` flag: this store's subject-keyed trees have been
/// rewritten to the canonical scheme.
pub const SCHEME_REWRITE_KEY: &[u8] = b"canonical-scheme-v1";
/// Persisted before the first indexed row moves, cleared only after rebuilding.
pub const INDEX_REBUILD_PENDING_KEY: &[u8] = b"canonical-scheme-index-pending";

/// Prefix of a tombstone marker in `Tree::PluginMeta`; must match
/// `crate::sync::tombstones`.
const TOMBSTONE_PREFIX: &[u8] = b"tombstone:";

/// Rewrite legacy identifier keys and reference values, then rebuild indexes
/// until the completion marker is persisted. Idempotent: a store that already ran this
/// is a no-op.
pub fn migrate_if_needed(store: &Db) -> AtomicResult<()> {
    if store
        .kv
        .get(Tree::PluginMeta, SCHEME_REWRITE_KEY)?
        .is_some()
    {
        return Ok(());
    }

    // Trees the query and search indexes are built from.
    let mut indexed = 0u64;
    indexed += rewrite_subject_keys(store, Tree::Resources, ValueRewrite::Propvals)?;
    indexed += rewrite_subject_keys(store, Tree::LoroSnapshots, ValueRewrite::None)?;

    // Trees nothing indexes, but everything looks up by canonical key.
    let mut other = 0u64;
    other += rewrite_subject_keys(store, Tree::DidMapping, ValueRewrite::Identifier)?;
    other += rewrite_prefixed_keys(store, Tree::Envelopes, b"", 0)?;
    other += rewrite_prefixed_keys(store, Tree::PluginMeta, TOMBSTONE_PREFIX, 0)?;
    other += rewrite_outbox_keys(store)?;

    // This marker precedes the first indexed write. A restart must finish the
    // rebuild even when there are no legacy rows left to move.
    if store
        .kv
        .get(Tree::PluginMeta, INDEX_REBUILD_PENDING_KEY)?
        .is_some()
    {
        tracing::info!(
            rewritten = indexed,
            "Rebuilding indexes for the canonical scheme"
        );
        store.clear_index()?;
        store.build_index(true)?;
        crate::search::rebuild_search_index(store)?;
    }
    if other > 0 {
        tracing::info!(
            rewritten = other,
            "Rewrote did:ad: mapping / envelope / tombstone / outbox keys to atomic:"
        );
    }

    store
        .kv
        .insert(Tree::PluginMeta, SCHEME_REWRITE_KEY, b"1")?;
    store
        .kv
        .remove(Tree::PluginMeta, INDEX_REBUILD_PENDING_KEY)?;
    Ok(())
}

/// What to do with a row's value when its key is (or is not) moved.
#[derive(Clone, Copy)]
enum ValueRewrite {
    /// Opaque bytes (a Loro snapshot): copied verbatim.
    None,
    /// Encoded propvals: identifier-shaped values are canonicalized, so an
    /// unmoved row can still change.
    Propvals,
    /// A bare identifier string (a `?drive=` routing hint): canonicalized.
    Identifier,
}

/// Rewrite a tree whose keys are whole subjects. Streams the tree once to
/// collect the keys that need attention, then touches those rows one by one.
fn rewrite_subject_keys(store: &Db, tree: Tree, values: ValueRewrite) -> AtomicResult<u64> {
    // Only keys are retained. With `Propvals` every row has to be inspected
    // (an `atomic:` row can still hold a `did:ad:` parent), so every key is
    // kept; otherwise only the keys that move.
    let mut keys: Vec<Vec<u8>> = Vec::new();
    for row in store.kv.iter_tree(tree) {
        let (key, _) = row?;
        let legacy = std::str::from_utf8(&key).is_ok_and(starts_with_legacy_scheme);
        if legacy || matches!(values, ValueRewrite::Propvals) {
            keys.push(key);
        }
    }

    let mut changed = 0u64;
    for key in keys {
        let Ok(key_str) = std::str::from_utf8(&key) else {
            continue;
        };
        let canonical = canonicalize_scheme(key_str);
        let key_moved = canonical.as_bytes() != key.as_slice();

        let Some(val) = store.kv.get(tree, &key)? else {
            continue;
        };
        let (new_val, val_changed) = rewrite_value(&val, values)?;
        if (key_moved || val_changed) && !matches!(values, ValueRewrite::Identifier) {
            store
                .kv
                .insert(Tree::PluginMeta, INDEX_REBUILD_PENDING_KEY, b"1")?;
        }

        if !key_moved {
            if val_changed {
                store.kv.insert(tree, &key, &new_val)?;
                changed += 1;
            }
            continue;
        }

        // Prefer a row already stored under the canonical key (a fork from
        // the first post-rename edit). Drop the legacy alias.
        if !store.kv.contains_key(tree, canonical.as_bytes())? {
            store.kv.insert(tree, canonical.as_bytes(), &new_val)?;
        }
        store.kv.remove(tree, &key)?;
        changed += 1;
    }

    Ok(changed)
}

fn rewrite_value(val: &[u8], values: ValueRewrite) -> AtomicResult<(Vec<u8>, bool)> {
    match values {
        ValueRewrite::None => Ok((val.to_vec(), false)),
        ValueRewrite::Propvals => match decode_propvals(val) {
            Ok(mut propvals) => {
                if canonicalize_propvals(&mut propvals) {
                    Ok((encode_propvals(&propvals)?, true))
                } else {
                    Ok((val.to_vec(), false))
                }
            }
            Err(_) => Ok((val.to_vec(), false)),
        },
        ValueRewrite::Identifier => match std::str::from_utf8(val) {
            Ok(s) => {
                let canonical = canonicalize_scheme(s);
                if canonical != s {
                    Ok((canonical.into_bytes(), true))
                } else {
                    Ok((val.to_vec(), false))
                }
            }
            Err(_) => Ok((val.to_vec(), false)),
        },
    }
}

/// Rewrite a tree whose keys are `{prefix}{subject}{rest}`, where `subject`
/// runs from `prefix` up to the first `\0` (or the end). Values are copied
/// verbatim: an envelope is signed material and a tombstone is a marker.
/// `skip` leading bytes of the subject are left alone (unused today).
fn rewrite_prefixed_keys(store: &Db, tree: Tree, prefix: &[u8], skip: usize) -> AtomicResult<u64> {
    let mut moves: Vec<(Vec<u8>, Vec<u8>)> = Vec::new();
    for row in store.kv.scan_prefix(tree, prefix) {
        let (key, _) = row?;
        let Some(new_key) = canonical_key_after_prefix(&key, prefix.len() + skip) else {
            continue;
        };
        moves.push((key, new_key));
    }

    let mut changed = 0u64;
    for (old_key, new_key) in moves {
        let Some(val) = store.kv.get(tree, &old_key)? else {
            continue;
        };
        if !store.kv.contains_key(tree, &new_key)? {
            store.kv.insert(tree, &new_key, &val)?;
        }
        store.kv.remove(tree, &old_key)?;
        changed += 1;
    }
    Ok(changed)
}

/// `Tree::Outbox` keys are `{agent pure id}\0{subject pure id}`: both halves
/// can carry the legacy scheme.
fn rewrite_outbox_keys(store: &Db) -> AtomicResult<u64> {
    let mut moves: Vec<(Vec<u8>, Vec<u8>)> = Vec::new();
    for row in store.kv.iter_tree(Tree::Outbox) {
        let (key, _) = row?;
        let Some(sep) = key.iter().position(|b| *b == 0) else {
            continue;
        };
        let agent = canonical_segment(&key[..sep]);
        let subject = canonical_segment(&key[sep + 1..]);
        if agent.is_none() && subject.is_none() {
            continue;
        }
        let mut new_key = agent.unwrap_or_else(|| key[..sep].to_vec());
        new_key.push(0);
        new_key.extend(subject.unwrap_or_else(|| key[sep + 1..].to_vec()));
        moves.push((key, new_key));
    }

    let mut changed = 0u64;
    for (old_key, new_key) in moves {
        let Some(val) = store.kv.get(Tree::Outbox, &old_key)? else {
            continue;
        };
        if !store.kv.contains_key(Tree::Outbox, &new_key)? {
            store.kv.insert(Tree::Outbox, &new_key, &val)?;
        }
        store.kv.remove(Tree::Outbox, &old_key)?;
        changed += 1;
    }
    Ok(changed)
}

/// The canonical spelling of a key segment, or `None` when it is not legacy.
fn canonical_segment(segment: &[u8]) -> Option<Vec<u8>> {
    let s = std::str::from_utf8(segment).ok()?;
    if !starts_with_legacy_scheme(s) {
        return None;
    }
    Some(canonicalize_scheme(s).into_bytes())
}

/// For a key of the form `{head}{subject}{\0rest}`, the same key with the
/// subject canonicalized, or `None` when nothing has to move.
fn canonical_key_after_prefix(key: &[u8], head: usize) -> Option<Vec<u8>> {
    let tail = key.get(head..)?;
    let subject_end = tail.iter().position(|b| *b == 0).unwrap_or(tail.len());
    let subject = canonical_segment(&tail[..subject_end])?;
    let mut new_key = Vec::with_capacity(key.len());
    new_key.extend_from_slice(&key[..head]);
    new_key.extend(subject);
    new_key.extend_from_slice(&tail[subject_end..]);
    Some(new_key)
}

/// Rewrite identifier-shaped values in a materialized propval map. Returns
/// whether anything changed.
pub fn canonicalize_propvals(propvals: &mut PropVals) -> bool {
    let mut changed = false;
    for value in propvals.values_mut() {
        if value.canonicalize_identifier_refs() {
            changed = true;
        }
    }
    changed
}
