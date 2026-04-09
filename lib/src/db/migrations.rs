/*!
# Migrations

Whenever the schema of the database changes, a newer version will not be able to read an older database.
Therefore, we need migrations to convert the old schema to the new one.

## Adding a Migration

- Write a function called `v{OLD}_to_v{NEW} that takes a [SledStore]. Make sure it removed the old `Tree`. Use [assert] to check if the process worked.
- In [migrate_maybe] add the key of the outdated Tree
- Add the function to the [migrate_maybe] `match` statement, select the older version of the Tree
- Update the Tree key used in [crate::db::trees]
 */

use crate::{
    db::{kv_store::KvStore, sled_store::SledStore, trees::Tree, v1_types::propvals_v1_to_v2},
    errors::AtomicResult,
};

/// Checks the current version(s) of the internal Store, and performs migrations if needed.
/// Migrations are sled-specific since they deal with on-disk schema changes.
pub fn migrate_maybe(store: &SledStore) -> AtomicResult<()> {
    for tree in store.raw_db().tree_names() {
        match String::from_utf8_lossy(&tree).as_ref() {
            // Add migrations for outdated Trees to this list
            "resources" => v0_to_v1(store)?,
            "reference_index" => ref_v0_to_v1(store)?,
            "resources_v1" => resources_v1_to_v2(store)?,
            "resources_v2" => resources_v2_to_v3(store)?,
            // QueryFilter gained a `drive` field — old entries are unreadable.
            // These are pure caches; dropping them causes a one-time rebuild on next query.
            "watched_queries" | "members_index" => query_index_v1_to_v2(store)?,
            _other => {}
        }
    }

    Ok(())
}

fn resources_v1_to_v2(store: &SledStore) -> AtomicResult<()> {
    tracing::warn!("Migrating resources from v1 to v2, this may take a while...");
    let old_key = "resources_v1";
    let old = store.raw_db().open_tree(old_key)?;

    let new_key = "resources_v2";
    let new = store.raw_db().open_tree(new_key)?;

    new.clear()?;
    let mut count = 0;

    for item in old.into_iter() {
        let (subject, propvals_bin) = item.expect("Unable to convert into interable");

        let subject: String =
            String::from_utf8(subject.to_vec()).expect("Unable to deserialize subject");
        let propvals: crate::db::v1_types::PropValsV1 = bincode1::deserialize(&propvals_bin)
            .map_err(|e| format!("Migration Error: Failed to deserialize propvals: {}", e))?;

        let new_propvals = propvals_v1_to_v2(propvals);

        new.insert(
            subject.as_bytes(),
            rmp_serde::to_vec(&new_propvals)
                .map_err(|e| format!("Migration Error: Failed to encode propvals: {}", e))?,
        )?;

        count += 1;
    }

    store.raw_db().drop_tree(old_key).map_err(|e| {
        tracing::error!("Migration Error: Failed to drop old tree: {}", e);
        e
    })?;

    tracing::info!("Finished migrating {} resources", count);

    tracing::info!("clearing index...");
    store.clear_tree(Tree::ValPropSub)?;
    store.clear_tree(Tree::PropValSub)?;
    store.clear_tree(Tree::QueryMembers)?;
    store.clear_tree(Tree::WatchedQueries)?;

    // We can't call build_index here since we don't have a Db yet.
    // The index will be rebuilt on the first query.
    tracing::info!("Index cleared. It will be rebuilt on the next query.");

    Ok(())
}

/// Change the subjects from `bincode` to `.as_bytes()`
fn v0_to_v1(store: &SledStore) -> AtomicResult<()> {
    tracing::warn!("Migrating resources schema from v0 to v1...");
    let new = store.raw_db().open_tree("resources_v1")?;
    let old_key = "resources";
    let old = store.raw_db().open_tree(old_key)?;
    let mut count = 0;

    for item in old.into_iter() {
        let (subject, resource_bin) = item.expect("Unable to convert into iterable");
        let subject: String =
            bincode1::deserialize(&subject).expect("Unable to deserialize subject");
        new.insert(subject.as_bytes(), resource_bin)?;
        count += 1;
    }

    let resources_tree_len = store.len(Tree::Resources)?;
    assert_eq!(
        new.len(),
        resources_tree_len,
        "Not all resources were migrated."
    );

    assert!(
        store.raw_db().drop_tree(old_key)?,
        "Old resources tree not properly removed."
    );

    tracing::warn!("Finished migration of {} resources", count);
    Ok(())
}

fn resources_v2_to_v3(store: &SledStore) -> AtomicResult<()> {
    tracing::warn!("Migrating resources from v2 to v3, this may take a while...");
    let old_key = "resources_v2";
    let old = store.raw_db().open_tree(old_key)?;

    let new_key = "resources_v3";
    let new = store.raw_db().open_tree(new_key)?;

    new.clear()?;
    let mut count = 0;
    // No base_domain available at migration time, use a placeholder
    let base_domain = "localhost".to_string();

    for item in old.into_iter() {
        let (subject, propvals_bin) = item.expect("Unable to convert into interable");

        let subject_str: String =
            String::from_utf8(subject.to_vec()).expect("Unable to deserialize subject");
        let new_subject = crate::db::v2_types::string_to_subject(subject_str, &base_domain);
        let new_subject_str = new_subject.to_string();

        let propvals: crate::db::v2_types::PropValsV2 = rmp_serde::from_slice(&propvals_bin)
            .map_err(|e| format!("Migration Error: Failed to deserialize propvals: {}", e))?;

        let new_propvals = crate::db::v2_types::propvals_v2_to_v3(propvals, &base_domain);

        new.insert(
            new_subject_str.as_bytes(),
            rmp_serde::to_vec(&new_propvals)
                .map_err(|e| format!("Migration Error: Failed to encode propvals: {}", e))?,
        )?;

        count += 1;
    }

    store.raw_db().drop_tree(old_key).map_err(|e| {
        tracing::error!("Migration Error: Failed to drop old tree: {}", e);
        e
    })?;

    tracing::info!("Finished migrating {} resources", count);

    tracing::info!("clearing index...");
    store.clear_tree(Tree::ValPropSub)?;
    store.clear_tree(Tree::PropValSub)?;
    store.clear_tree(Tree::QueryMembers)?;
    store.clear_tree(Tree::WatchedQueries)?;

    tracing::info!("Index cleared. It will be rebuilt on the next query.");

    Ok(())
}

/// QueryFilter gained a mandatory `drive` field — old serialized entries are unreadable.
/// These trees are pure caches; dropping them causes a one-time rebuild on next query.
fn query_index_v1_to_v2(store: &SledStore) -> AtomicResult<()> {
    tracing::warn!(
        "Dropping old query index trees (QueryFilter schema changed — drive field added). \
        They will rebuild on next query."
    );
    let _ = store.raw_db().drop_tree("watched_queries");
    let _ = store.raw_db().drop_tree("members_index");
    Ok(())
}

/// Add `prop_val_sub` index
fn ref_v0_to_v1(store: &SledStore) -> AtomicResult<()> {
    tracing::warn!("Rebuilding indexes...");
    store.raw_db().drop_tree("reference_index")?;
    // We can't call build_index here since we don't have a Db yet.
    // The index will be rebuilt on the first query.
    tracing::warn!("Old reference_index dropped. Index will be rebuilt on next query.");
    Ok(())
}
