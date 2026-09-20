//! One-time rewrite of `did:ad:` storage keys and reference values to `atomic:`.
//!
//! Reads already alias both spellings. Writes key by [`crate::Subject::pure_id`],
//! which is canonical. Without this pass a store that was filled before the
//! rename keeps `did:ad:` rows, so the first edit of an old resource forks it
//! and parent/drive queries split the children. See #1584 / PR #1585.

use crate::errors::AtomicResult;
use crate::identifiers::canonicalize_scheme;
use crate::resources::PropVals;

use super::encoding::{decode_propvals, encode_propvals};
use super::trees::Tree;
use super::Db;

/// `Tree::PluginMeta` flag: this store's resource / snapshot / mapping keys
/// have been rewritten to the canonical scheme.
pub const SCHEME_REWRITE_KEY: &[u8] = b"canonical-scheme-v1";

/// Rewrite legacy identifier keys and reference values, then rebuild indexes
/// if anything moved. Idempotent: a store that already ran this is a no-op.
pub fn migrate_if_needed(store: &Db) -> AtomicResult<()> {
    if store
        .kv
        .get(Tree::PluginMeta, SCHEME_REWRITE_KEY)?
        .is_some()
    {
        return Ok(());
    }

    let mut rewritten = 0u64;
    rewritten += rewrite_tree(store, Tree::Resources, true)?;
    rewritten += rewrite_tree(store, Tree::LoroSnapshots, false)?;
    rewritten += rewrite_tree(store, Tree::DidMapping, false)?;

    if rewritten > 0 {
        tracing::info!(
            rewritten,
            "Rewrote did:ad: storage keys to atomic:; rebuilding indexes"
        );
        store.clear_index()?;
        store.build_index(true)?;
        crate::search::rebuild_search_index(store)?;
    }

    store
        .kv
        .insert(Tree::PluginMeta, SCHEME_REWRITE_KEY, b"1")?;
    Ok(())
}

fn rewrite_tree(store: &Db, tree: Tree, canonicalize_values: bool) -> AtomicResult<u64> {
    // Collect first: inserting/removing while iterating is backend-dependent.
    let entries: Vec<(Vec<u8>, Vec<u8>)> = store.kv.iter_tree(tree).collect::<Result<_, _>>()?;
    let mut changed = 0u64;

    for (key, val) in entries {
        let Ok(key_str) = std::str::from_utf8(&key) else {
            continue;
        };
        let canonical = canonicalize_scheme(key_str);
        let key_moved = canonical.as_bytes() != key.as_slice();

        let new_val = if canonicalize_values {
            match decode_propvals(&val) {
                Ok(mut propvals) => {
                    if canonicalize_propvals(&mut propvals) {
                        encode_propvals(&propvals)?
                    } else {
                        val
                    }
                }
                Err(_) => val,
            }
        } else {
            val
        };

        if !key_moved {
            if canonicalize_values && store.kv.get(tree, &key)? != Some(new_val.clone()) {
                store.kv.insert(tree, &key, &new_val)?;
                changed += 1;
            }
            continue;
        }

        // Prefer a row already stored under the canonical key (a fork from
        // the first post-rename edit). Drop the legacy alias.
        if store.kv.contains_key(tree, canonical.as_bytes())? {
            store.kv.remove(tree, &key)?;
            changed += 1;
            continue;
        }

        store.kv.insert(tree, canonical.as_bytes(), &new_val)?;
        store.kv.remove(tree, &key)?;
        changed += 1;
    }

    Ok(changed)
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
