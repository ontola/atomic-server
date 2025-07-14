//! BTreeMapStore: In-memory KvStore backed by BTreeMap.
//! Useful for tests and WASM targets where sled is not available.

use std::{
    collections::{BTreeMap, HashMap},
    sync::RwLock,
};

use crate::errors::AtomicResult;

use super::{
    kv_store::{KvIter, KvPair, KvStore},
    trees::{Method, Operation, Tree},
};

type TreeData = BTreeMap<Vec<u8>, Vec<u8>>;

/// An in-memory KvStore using BTreeMap for ordered key-value storage.
/// Thread-safe via RwLock. All iterators collect results eagerly
/// to avoid holding locks across iterator boundaries.
pub struct BTreeMapStore {
    trees: RwLock<HashMap<String, TreeData>>,
}

impl BTreeMapStore {
    pub fn new() -> Self {
        BTreeMapStore {
            trees: RwLock::new(HashMap::new()),
        }
    }

    fn tree_name(tree: Tree) -> String {
        tree.to_string()
    }

    fn with_tree_read<F, R>(&self, tree: Tree, f: F) -> R
    where
        F: FnOnce(&TreeData) -> R,
    {
        let trees = self.trees.read().unwrap();
        let name = Self::tree_name(tree);
        if let Some(data) = trees.get(&name) {
            f(data)
        } else {
            // Return result for empty tree
            let empty = TreeData::new();
            f(&empty)
        }
    }

    fn with_tree_write<F, R>(&self, tree: Tree, f: F) -> R
    where
        F: FnOnce(&mut TreeData) -> R,
    {
        let mut trees = self.trees.write().unwrap();
        let name = Self::tree_name(tree);
        let data = trees.entry(name).or_default();
        f(data)
    }
}

impl Default for BTreeMapStore {
    fn default() -> Self {
        Self::new()
    }
}

/// Compute the exclusive upper bound for a prefix scan.
/// Increments the last non-0xff byte. Returns None if all bytes are 0xff (scan to end).
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

impl KvStore for BTreeMapStore {
    fn get(&self, tree: Tree, key: &[u8]) -> AtomicResult<Option<Vec<u8>>> {
        Ok(self.with_tree_read(tree, |data| data.get(key).cloned()))
    }

    fn insert(&self, tree: Tree, key: &[u8], val: &[u8]) -> AtomicResult<()> {
        self.with_tree_write(tree, |data| {
            data.insert(key.to_vec(), val.to_vec());
        });
        Ok(())
    }

    fn remove(&self, tree: Tree, key: &[u8]) -> AtomicResult<()> {
        self.with_tree_write(tree, |data| {
            data.remove(key);
        });
        Ok(())
    }

    fn contains_key(&self, tree: Tree, key: &[u8]) -> AtomicResult<bool> {
        Ok(self.with_tree_read(tree, |data| data.contains_key(key)))
    }

    fn scan_prefix(&self, tree: Tree, prefix: &[u8]) -> KvIter {
        let results: Vec<KvPair> = self.with_tree_read(tree, |data| {
            let start = prefix.to_vec();
            if let Some(end) = prefix_upper_bound(prefix) {
                data.range(start..end)
                    .map(|(k, v)| (k.clone(), v.clone()))
                    .collect()
            } else {
                data.range(start..)
                    .map(|(k, v)| (k.clone(), v.clone()))
                    .collect()
            }
        });
        Box::new(results.into_iter().map(Ok))
    }

    fn range(&self, tree: Tree, start: Vec<u8>, end: Vec<u8>, reverse: bool) -> KvIter {
        let results: Vec<KvPair> = self.with_tree_read(tree, |data| {
            if reverse {
                data.range(start..end)
                    .rev()
                    .map(|(k, v)| (k.clone(), v.clone()))
                    .collect()
            } else {
                data.range(start..end)
                    .map(|(k, v)| (k.clone(), v.clone()))
                    .collect()
            }
        });
        Box::new(results.into_iter().map(Ok))
    }

    fn iter_tree(&self, tree: Tree) -> KvIter {
        let results: Vec<KvPair> = self.with_tree_read(tree, |data| {
            data.iter().map(|(k, v)| (k.clone(), v.clone())).collect()
        });
        Box::new(results.into_iter().map(Ok))
    }

    fn clear_tree(&self, tree: Tree) -> AtomicResult<()> {
        self.with_tree_write(tree, |data| data.clear());
        Ok(())
    }

    fn apply_batch(&self, operations: &[Operation]) -> AtomicResult<()> {
        // Take a single write lock to apply all operations atomically
        let mut trees = self.trees.write().unwrap();
        for op in operations {
            let name = Self::tree_name(op.tree.clone());
            let data = trees.entry(name).or_default();
            match op.method {
                Method::Insert => {
                    data.insert(op.key.clone(), op.val.clone().unwrap_or_default());
                }
                Method::Delete => {
                    data.remove(&op.key);
                }
            }
        }
        Ok(())
    }

    fn flush(&self) -> AtomicResult<()> {
        // No-op for in-memory store
        Ok(())
    }

    fn len(&self, tree: Tree) -> AtomicResult<usize> {
        Ok(self.with_tree_read(tree, |data| data.len()))
    }
}
