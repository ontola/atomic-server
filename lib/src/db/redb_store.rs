//! RedbStore: KvStore backed by redb — works natively and in WASM.
//! Uses InMemoryBackend by default. Can be swapped to OPFS backend for persistence.

use std::sync::Arc;

use redb::{backends::InMemoryBackend, Database, ReadableDatabase, ReadableTable, ReadableTableMetadata, TableDefinition};

use crate::errors::AtomicResult;

use super::{
    kv_store::{KvIter, KvPair, KvStore},
    trees::{Method, Operation, Tree},
};

/// redb table definition: all our trees are `&[u8] -> &[u8]`.
const TABLE_RESOURCES: TableDefinition<&[u8], &[u8]> = TableDefinition::new("resources_v3");
const TABLE_PROP_VAL_SUB: TableDefinition<&[u8], &[u8]> = TableDefinition::new("prop_val_sub_index");
const TABLE_VAL_PROP_SUB: TableDefinition<&[u8], &[u8]> =
    TableDefinition::new("reference_index_v1");
const TABLE_QUERY_MEMBERS: TableDefinition<&[u8], &[u8]> =
    TableDefinition::new("members_index_v2");
const TABLE_WATCHED_QUERIES: TableDefinition<&[u8], &[u8]> =
    TableDefinition::new("watched_queries_v2");
const TABLE_PLUGIN_META: TableDefinition<&[u8], &[u8]> = TableDefinition::new("plugin_meta");
const TABLE_DRIVE_MAPPING: TableDefinition<&[u8], &[u8]> = TableDefinition::new("drive_mapping");
const TABLE_DID_MAPPING: TableDefinition<&[u8], &[u8]> = TableDefinition::new("did_mapping");
const TABLE_LORO_SNAPSHOTS: TableDefinition<&[u8], &[u8]> = TableDefinition::new("loro_snapshots");

fn table_def(tree: Tree) -> TableDefinition<'static, &'static [u8], &'static [u8]> {
    match tree {
        Tree::Resources => TABLE_RESOURCES,
        Tree::PropValSub => TABLE_PROP_VAL_SUB,
        Tree::ValPropSub => TABLE_VAL_PROP_SUB,
        Tree::QueryMembers => TABLE_QUERY_MEMBERS,
        Tree::WatchedQueries => TABLE_WATCHED_QUERIES,
        Tree::PluginMeta => TABLE_PLUGIN_META,
        Tree::DriveMapping => TABLE_DRIVE_MAPPING,
        Tree::DidMapping => TABLE_DID_MAPPING,
        Tree::LoroSnapshots => TABLE_LORO_SNAPSHOTS,
    }
}

/// A KvStore backed by redb.
/// Supports InMemoryBackend (default) or OPFS backend (WASM persistent).
/// Thread-safe via redb's internal locking (MVCC).
pub struct RedbStore {
    db: Arc<Database>,
}

impl RedbStore {
    /// Create a new in-memory RedbStore.
    pub fn new_memory() -> AtomicResult<Self> {
        let backend = InMemoryBackend::new();
        let db = Database::builder()
            .create_with_backend(backend)
            .map_err(|e| format!("Failed to create redb: {e}"))?;

        // Create all tables upfront so reads don't fail on missing tables
        {
            let tx = db
                .begin_write()
                .map_err(|e| format!("Failed to begin write tx: {e}"))?;
            // Opening a table in a write transaction creates it if it doesn't exist
            let _ = tx.open_table(TABLE_RESOURCES);
            let _ = tx.open_table(TABLE_PROP_VAL_SUB);
            let _ = tx.open_table(TABLE_VAL_PROP_SUB);
            let _ = tx.open_table(TABLE_QUERY_MEMBERS);
            let _ = tx.open_table(TABLE_WATCHED_QUERIES);
            let _ = tx.open_table(TABLE_PLUGIN_META);
            let _ = tx.open_table(TABLE_DRIVE_MAPPING);
            let _ = tx.open_table(TABLE_DID_MAPPING);
            let _ = tx.open_table(TABLE_LORO_SNAPSHOTS);
            tx.commit()
                .map_err(|e| format!("Failed to commit initial tables: {e}"))?;
        }

        Ok(RedbStore { db: Arc::new(db) })
    }

    /// Create a RedbStore backed by OPFS for persistent storage in WASM Workers.
    /// The file is created/opened in the Origin Private File System.
    #[cfg(target_arch = "wasm32")]
    pub async fn new_opfs(filename: &str) -> AtomicResult<Self> {
        let backend = super::opfs_backend::OpfsBackend::open(filename)
            .await
            .map_err(|e| format!("Failed to open OPFS backend: {:?}", e))?;

        let db = Database::builder()
            .create_with_backend(backend)
            .map_err(|e| format!("Failed to create redb with OPFS: {e}"))?;

        // Create all tables upfront
        {
            let tx = db
                .begin_write()
                .map_err(|e| format!("Failed to begin write tx: {e}"))?;
            let _ = tx.open_table(TABLE_RESOURCES);
            let _ = tx.open_table(TABLE_PROP_VAL_SUB);
            let _ = tx.open_table(TABLE_VAL_PROP_SUB);
            let _ = tx.open_table(TABLE_QUERY_MEMBERS);
            let _ = tx.open_table(TABLE_WATCHED_QUERIES);
            let _ = tx.open_table(TABLE_PLUGIN_META);
            let _ = tx.open_table(TABLE_DRIVE_MAPPING);
            let _ = tx.open_table(TABLE_DID_MAPPING);
            let _ = tx.open_table(TABLE_LORO_SNAPSHOTS);
            tx.commit()
                .map_err(|e| format!("Failed to commit initial tables: {e}"))?;
        }

        Ok(RedbStore { db: Arc::new(db) })
    }
}

/// Compute the exclusive upper bound for a prefix scan.
fn prefix_upper_bound(prefix: &[u8]) -> Option<Vec<u8>> {
    let mut end = prefix.to_vec();

    while let Some(last) = end.last_mut() {
        if *last < 0xff {
            *last += 1;

            return Some(end);
        }

        end.pop();
    }

    None
}

impl KvStore for RedbStore {
    fn get(&self, tree: Tree, key: &[u8]) -> AtomicResult<Option<Vec<u8>>> {
        let tx = self
            .db
            .begin_read()
            .map_err(|e| format!("redb read tx: {e}"))?;
        let table = tx
            .open_table(table_def(tree))
            .map_err(|e| format!("redb open table: {e}"))?;

        let result = table.get(key).map_err(|e| format!("redb get: {e}"))?;

        Ok(result.map(|guard| guard.value().to_vec()))
    }

    fn insert(&self, tree: Tree, key: &[u8], val: &[u8]) -> AtomicResult<()> {
        let tx = self
            .db
            .begin_write()
            .map_err(|e| format!("redb write tx: {e}"))?;
        {
            let mut table = tx
                .open_table(table_def(tree))
                .map_err(|e| format!("redb open table: {e}"))?;
            table
                .insert(key, val)
                .map_err(|e| format!("redb insert: {e}"))?;
        }
        tx.commit()
            .map_err(|e| format!("redb commit: {e}"))?;
        Ok(())
    }

    fn remove(&self, tree: Tree, key: &[u8]) -> AtomicResult<()> {
        let tx = self
            .db
            .begin_write()
            .map_err(|e| format!("redb write tx: {e}"))?;
        {
            let mut table = tx
                .open_table(table_def(tree))
                .map_err(|e| format!("redb open table: {e}"))?;
            table
                .remove(key)
                .map_err(|e| format!("redb remove: {e}"))?;
        }
        tx.commit()
            .map_err(|e| format!("redb commit: {e}"))?;
        Ok(())
    }

    fn contains_key(&self, tree: Tree, key: &[u8]) -> AtomicResult<bool> {
        let tx = self
            .db
            .begin_read()
            .map_err(|e| format!("redb read tx: {e}"))?;
        let table = tx
            .open_table(table_def(tree))
            .map_err(|e| format!("redb open table: {e}"))?;

        let result = table.get(key).map_err(|e| format!("redb contains_key: {e}"))?;

        Ok(result.is_some())
    }

    fn scan_prefix(&self, tree: Tree, prefix: &[u8]) -> KvIter {
        let tx = match self.db.begin_read() {
            Ok(tx) => tx,
            Err(e) => return Box::new(std::iter::once(Err(format!("redb read tx: {e}").into()))),
        };
        let table = match tx.open_table(table_def(tree)) {
            Ok(t) => t,
            Err(e) => {
                return Box::new(std::iter::once(Err(
                    format!("redb open table: {e}").into()
                )))
            }
        };

        // Collect results to avoid lifetime issues with the read transaction
        let results: Vec<KvPair> = if let Some(end) = prefix_upper_bound(prefix) {
            table
                .range(prefix..end.as_slice())
                .map(|iter| {
                    iter.filter_map(|r| r.ok())
                        .map(|(k, v)| (k.value().to_vec(), v.value().to_vec()))
                        .collect()
                })
                .unwrap_or_default()
        } else {
            table
                .range(prefix..)
                .map(|iter| {
                    iter.filter_map(|r| r.ok())
                        .map(|(k, v)| (k.value().to_vec(), v.value().to_vec()))
                        .collect()
                })
                .unwrap_or_default()
        };

        Box::new(results.into_iter().map(Ok))
    }

    fn range(&self, tree: Tree, start: Vec<u8>, end: Vec<u8>, reverse: bool) -> KvIter {
        let tx = match self.db.begin_read() {
            Ok(tx) => tx,
            Err(e) => return Box::new(std::iter::once(Err(format!("redb read tx: {e}").into()))),
        };
        let table = match tx.open_table(table_def(tree)) {
            Ok(t) => t,
            Err(e) => {
                return Box::new(std::iter::once(Err(
                    format!("redb open table: {e}").into()
                )))
            }
        };

        let results: Vec<KvPair> = table
            .range(start.as_slice()..end.as_slice())
            .map(|iter| {
                iter.filter_map(|r| r.ok())
                    .map(|(k, v)| (k.value().to_vec(), v.value().to_vec()))
                    .collect()
            })
            .unwrap_or_default();

        if reverse {
            let mut reversed = results;
            reversed.reverse();
            Box::new(reversed.into_iter().map(Ok))
        } else {
            Box::new(results.into_iter().map(Ok))
        }
    }

    fn iter_tree(&self, tree: Tree) -> KvIter {
        let tx = match self.db.begin_read() {
            Ok(tx) => tx,
            Err(e) => return Box::new(std::iter::once(Err(format!("redb read tx: {e}").into()))),
        };
        let table = match tx.open_table(table_def(tree)) {
            Ok(t) => t,
            Err(e) => {
                return Box::new(std::iter::once(Err(
                    format!("redb open table: {e}").into()
                )))
            }
        };

        let results: Vec<KvPair> = table
            .iter()
            .map(|iter| {
                iter.filter_map(|r| r.ok())
                    .map(|(k, v)| (k.value().to_vec(), v.value().to_vec()))
                    .collect()
            })
            .unwrap_or_default();

        Box::new(results.into_iter().map(Ok))
    }

    fn clear_tree(&self, tree: Tree) -> AtomicResult<()> {
        let tx = self
            .db
            .begin_write()
            .map_err(|e| format!("redb write tx: {e}"))?;
        {
            // Delete and recreate the table
            let mut table = tx
                .open_table(table_def(tree))
                .map_err(|e| format!("redb open table: {e}"))?;
            // redb doesn't have a clear() — we drain the table
            let keys: Vec<Vec<u8>> = table
                .iter()
                .map(|iter| {
                    iter.filter_map(|r| r.ok())
                        .map(|(k, _)| k.value().to_vec())
                        .collect()
                })
                .unwrap_or_default();

            for key in keys {
                table
                    .remove(key.as_slice())
                    .map_err(|e| format!("redb remove in clear: {e}"))?;
            }
        }
        tx.commit()
            .map_err(|e| format!("redb commit clear: {e}"))?;
        Ok(())
    }

    fn apply_batch(&self, operations: &[Operation]) -> AtomicResult<()> {
        if operations.is_empty() {
            return Ok(());
        }

        let tx = self
            .db
            .begin_write()
            .map_err(|e| format!("redb write tx: {e}"))?;
        {
            for op in operations {
                let mut table = tx
                    .open_table(table_def(op.tree.clone()))
                    .map_err(|e| format!("redb open table: {e}"))?;

                match op.method {
                    Method::Insert => {
                        let val = op.val.as_deref().unwrap_or(b"");
                        table
                            .insert(op.key.as_slice(), val)
                            .map_err(|e| format!("redb batch insert: {e}"))?;
                    }
                    Method::Delete => {
                        table
                            .remove(op.key.as_slice())
                            .map_err(|e| format!("redb batch remove: {e}"))?;
                    }
                }
            }
        }
        tx.commit()
            .map_err(|e| format!("redb commit batch: {e}"))?;
        Ok(())
    }

    fn flush(&self) -> AtomicResult<()> {
        // redb with InMemoryBackend: no-op. With OPFS: would sync_data.
        Ok(())
    }

    fn len(&self, tree: Tree) -> AtomicResult<usize> {
        let tx = self
            .db
            .begin_read()
            .map_err(|e| format!("redb read tx: {e}"))?;
        let table = tx
            .open_table(table_def(tree))
            .map_err(|e| format!("redb open table: {e}"))?;
        Ok(table.len().map_err(|e| format!("redb len: {e}"))? as usize)
    }
}
