//! Compresses the biggest values in the store.
//!
//! A chat message cost about 10 KB on disk, and a third of that was three
//! trees whose values are base64 and msgpack: the stored resource, the Loro
//! snapshot and the signed commit envelope. Their property URLs and Loro
//! structure repeat within one value, so deflate takes roughly 40% off them.
//!
//! [`CompressedKv`] wraps any [`KvStore`] and does this per tree, so every
//! reader and writer (sync, vault, WASM) sees the plain bytes.
//!
//! Layout of a compressed value: `0x00`, a codec byte, then the payload.
//! `0x00` is the marker because no value these trees held before can start
//! with it: msgpack maps open with `0x80..=0x8f`, `0xde` or `0xdf`, Loro
//! snapshots with `loro` and envelopes with `{`. A value without the marker
//! is a row an older store wrote and is returned as it is. Writing never
//! rewrites old rows by itself; a row is recompressed the next time its
//! resource changes.

use crate::errors::AtomicResult;

use super::{
    kv_store::{KvIter, KvPair, KvStore},
    trees::{Method, Operation, Tree},
};
use std::sync::Arc;

const MARKER: u8 = 0;
const CODEC_RAW: u8 = 0;
const CODEC_DEFLATE: u8 = 1;
/// miniz_oxide level 6, the usual speed/size trade.
const LEVEL: u8 = 6;
/// Below this a value is not worth the extra step.
const MIN_LEN: usize = 128;

pub(super) fn is_compressed_tree(tree: Tree) -> bool {
    matches!(
        tree,
        Tree::Resources | Tree::LoroSnapshots | Tree::Envelopes
    )
}

pub(super) fn encode(value: &[u8]) -> Vec<u8> {
    if value.len() >= MIN_LEN {
        let packed = miniz_oxide::deflate::compress_to_vec(value, LEVEL);
        if packed.len() + 2 < value.len() {
            let mut out = Vec::with_capacity(packed.len() + 2);
            out.extend_from_slice(&[MARKER, CODEC_DEFLATE]);
            out.extend_from_slice(&packed);
            return out;
        }
    }
    if value.first() == Some(&MARKER) {
        // Cannot happen for today's values, but a raw value that looks like
        // the marker would be misread, so say it is raw.
        let mut out = Vec::with_capacity(value.len() + 2);
        out.extend_from_slice(&[MARKER, CODEC_RAW]);
        out.extend_from_slice(value);
        return out;
    }
    value.to_vec()
}

fn decode(value: Vec<u8>) -> AtomicResult<Vec<u8>> {
    if value.first() != Some(&MARKER) {
        return Ok(value);
    }
    match value.get(1) {
        Some(&CODEC_RAW) => Ok(value[2..].to_vec()),
        Some(&CODEC_DEFLATE) => miniz_oxide::inflate::decompress_to_vec(&value[2..])
            .map_err(|e| format!("Could not decompress a stored value: {e:?}").into()),
        other => Err(format!("Unknown storage codec {other:?}").into()),
    }
}

fn decode_pair(pair: AtomicResult<KvPair>) -> AtomicResult<KvPair> {
    let (key, value) = pair?;
    Ok((key, decode(value)?))
}

pub struct CompressedKv {
    inner: Arc<dyn KvStore>,
}

impl CompressedKv {
    pub fn new(inner: Arc<dyn KvStore>) -> Self {
        Self { inner }
    }

    fn decoded(&self, tree: Tree, iter: KvIter) -> KvIter {
        if is_compressed_tree(tree) {
            Box::new(iter.map(decode_pair))
        } else {
            iter
        }
    }
}

impl KvStore for CompressedKv {
    fn get(&self, tree: Tree, key: &[u8]) -> AtomicResult<Option<Vec<u8>>> {
        let found = self.inner.get(tree, key)?;
        match found {
            Some(value) if is_compressed_tree(tree) => Ok(Some(decode(value)?)),
            other => Ok(other),
        }
    }

    fn insert(&self, tree: Tree, key: &[u8], val: &[u8]) -> AtomicResult<()> {
        if is_compressed_tree(tree) {
            self.inner.insert(tree, key, &encode(val))
        } else {
            self.inner.insert(tree, key, val)
        }
    }

    fn remove(&self, tree: Tree, key: &[u8]) -> AtomicResult<()> {
        self.inner.remove(tree, key)
    }

    fn contains_key(&self, tree: Tree, key: &[u8]) -> AtomicResult<bool> {
        self.inner.contains_key(tree, key)
    }

    fn scan_prefix(&self, tree: Tree, prefix: &[u8]) -> KvIter {
        self.decoded(tree, self.inner.scan_prefix(tree, prefix))
    }

    fn range(&self, tree: Tree, start: Vec<u8>, end: Vec<u8>, reverse: bool) -> KvIter {
        self.decoded(tree, self.inner.range(tree, start, end, reverse))
    }

    fn range_page(
        &self,
        tree: Tree,
        start: Vec<u8>,
        end: Vec<u8>,
        limit: usize,
    ) -> AtomicResult<Vec<KvPair>> {
        let page = self.inner.range_page(tree, start, end, limit)?;
        if is_compressed_tree(tree) {
            page.into_iter().map(|(k, v)| Ok((k, decode(v)?))).collect()
        } else {
            Ok(page)
        }
    }

    fn iter_tree(&self, tree: Tree) -> KvIter {
        self.decoded(tree, self.inner.iter_tree(tree))
    }

    fn first_entry(&self, tree: Tree) -> AtomicResult<Option<KvPair>> {
        match self.inner.first_entry(tree)? {
            Some((key, value)) if is_compressed_tree(tree) => Ok(Some((key, decode(value)?))),
            other => Ok(other),
        }
    }

    fn clear_tree(&self, tree: Tree) -> AtomicResult<()> {
        self.inner.clear_tree(tree)
    }

    fn apply_batch(&self, operations: &[Operation]) -> AtomicResult<()> {
        if !operations
            .iter()
            .any(|op| is_compressed_tree(op.tree) && op.val.is_some())
        {
            return self.inner.apply_batch(operations);
        }
        let encoded: Vec<Operation> = operations
            .iter()
            .map(|op| Operation {
                tree: op.tree,
                method: match op.method {
                    Method::Insert => Method::Insert,
                    Method::Delete => Method::Delete,
                },
                key: op.key.clone(),
                val: match (&op.val, is_compressed_tree(op.tree)) {
                    (Some(val), true) => Some(encode(val)),
                    (val, _) => val.clone(),
                },
            })
            .collect();
        self.inner.apply_batch(&encoded)
    }

    fn flush(&self) -> AtomicResult<()> {
        self.inner.flush()
    }

    fn begin_batch(&self) {
        self.inner.begin_batch()
    }

    fn commit_batch(&self) -> AtomicResult<()> {
        self.inner.commit_batch()
    }

    fn len(&self, tree: Tree) -> AtomicResult<usize> {
        self.inner.len(tree)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn values_round_trip_and_old_rows_pass_through() {
        let json = br#"{"@id":"atomic:commit:abc","https://atomicdata.dev/properties/isA":["https://atomicdata.dev/classes/Commit"]}"#
            .repeat(8);
        let packed = encode(&json);
        assert_eq!(&packed[..2], &[MARKER, CODEC_DEFLATE]);
        assert!(packed.len() < json.len());
        assert_eq!(decode(packed).unwrap(), json);

        // A row an older store wrote has no marker and is returned as it is.
        assert_eq!(decode(json.clone()).unwrap(), json);
        let snapshot = b"loro\x00\x00\x00".to_vec();
        assert_eq!(decode(snapshot.clone()).unwrap(), snapshot);

        // Short values stay raw, and a raw value that opens with the marker
        // byte is wrapped so it is not misread.
        assert_eq!(encode(b"{}"), b"{}".to_vec());
        let odd = vec![0u8, 1, 2];
        assert_eq!(decode(encode(&odd)).unwrap(), odd);
    }
}
