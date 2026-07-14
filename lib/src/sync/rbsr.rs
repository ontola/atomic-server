//! Range-based set reconciliation (RBSR) core.
//!
//! The flat whole-drive hash (`engine::compute_drive_hash`) can only answer
//! "are these two drives identical?" — on any difference it forces exchanging
//! the entire version-vector set to find the delta (O(drive)). RBSR instead
//! finds *where* two sorted `(subject → version vector)` sets differ by
//! recursively comparing **range fingerprints**, transferring only the items in
//! the ranges that actually differ. Cost tracks the divergence, not the drive.
//! See `planning/drive-reconciliation.md` (Phase 2).
//!
//! This module is the transport-free, storage-free algorithm core: fingerprint
//! primitives + the recursive reconcile driver, driven through callbacks that
//! stand in for "ask the remote node". Wiring it onto the WS/Iroh transports
//! and backing the range queries with an incrementally-maintained tree (so a
//! range fingerprint is O(log n) rather than O(range)) are later steps; the
//! algorithm and its convergence are pinned here first.
//!
//! **Fingerprint = XOR of per-item SHA-256 hashes.** XOR is an order-independent,
//! incremental monoid: a range's fingerprint is the XOR of its items' hashes in
//! any order, matching items cancel out, and an item can be added/removed by
//! XORing its hash in/out. Like all RBSR, this is probabilistic — two different
//! item sets could XOR to the same fingerprint with probability ~2⁻²⁵⁶, which
//! we treat as never.

use std::collections::BTreeMap;

use sha2::{Digest, Sha256};

/// A per-item or per-range fingerprint.
pub type Fingerprint = [u8; 32];

/// The empty-range fingerprint (identity for XOR).
pub const EMPTY: Fingerprint = [0u8; 32];

/// One reconciliation item: a subject and its version vector (peer → counter).
pub type Item = (String, BTreeMap<String, i32>);

/// Canonical per-item fingerprint: SHA-256 of `"{subject}={peer:counter,…}"`
/// with the `(peer, counter)` pairs sorted by peer (a `BTreeMap` iterates
/// sorted). Self-contained — it depends only on this item, not on any global
/// peer index — so two nodes fingerprint the same item identically. Same hash
/// family as the Phase 1 drive hash (SHA-256), reproducible byte-for-byte in
/// TypeScript when this is wired to the browser transport.
pub fn item_fingerprint(subject: &str, vv: &BTreeMap<String, i32>) -> Fingerprint {
    let pairs = vv
        .iter()
        .map(|(peer, counter)| format!("{peer}:{counter}"))
        .collect::<Vec<_>>()
        .join(",");

    let mut hasher = Sha256::new();
    hasher.update(subject.as_bytes());
    hasher.update(b"=");
    hasher.update(pairs.as_bytes());
    hasher.finalize().into()
}

fn xor_into(acc: &mut Fingerprint, x: &Fingerprint) {
    for (a, b) in acc.iter_mut().zip(x.iter()) {
        *a ^= *b;
    }
}

/// Fingerprint of the items whose subject falls in `[lo, hi)` (half-open;
/// `hi == None` means "unbounded above"). `items` MUST be sorted by subject.
/// O(range) — the incremental tree that makes this O(log n) is a later step.
pub fn range_fingerprint(items: &[Item], lo: &str, hi: Option<&str>) -> Fingerprint {
    let mut fp = EMPTY;
    for (subject, vv) in items_in_range(items, lo, hi) {
        let item = item_fingerprint(subject, vv);
        xor_into(&mut fp, &item);
    }
    fp
}

fn items_in_range<'a>(
    items: &'a [Item],
    lo: &str,
    hi: Option<&str>,
) -> impl Iterator<Item = &'a Item> {
    let lo = lo.to_string();
    let hi = hi.map(|h| h.to_string());
    items.iter().filter(move |(s, _)| {
        s.as_str() >= lo.as_str() && hi.as_deref().map(|h| s.as_str() < h).unwrap_or(true)
    })
}

/// The subjects that differ between the local and remote sets.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Diff {
    /// Present locally, absent remotely.
    pub only_local: Vec<String>,
    /// Present remotely, absent locally.
    pub only_remote: Vec<String>,
    /// Present on both, but with different version vectors.
    pub differ: Vec<String>,
}

impl Diff {
    pub fn is_empty(&self) -> bool {
        self.only_local.is_empty() && self.only_remote.is_empty() && self.differ.is_empty()
    }
}

/// What the remote node answers when asked about a subject range.
pub trait RemoteRange {
    /// The remote's fingerprint for `[lo, hi)`.
    fn fingerprint(&mut self, lo: &str, hi: Option<&str>) -> Fingerprint;
    /// The remote's items in `[lo, hi)` — requested only for a small range.
    fn items(&mut self, lo: &str, hi: Option<&str>) -> Vec<Item>;
}

/// Reconcile the local set against a remote (accessed via `remote`), returning
/// the subjects that differ. `split` is the branching factor for a mismatched
/// range; `leaf` is the item count at or below which a range's items are
/// fetched and diffed directly instead of split further.
pub fn reconcile(local: &[Item], remote: &mut impl RemoteRange, split: usize, leaf: usize) -> Diff {
    let split = split.max(2);
    let leaf = leaf.max(1);
    let mut diff = Diff::default();
    reconcile_range(local, "", None, remote, split, leaf, &mut diff);
    diff
}

#[allow(clippy::too_many_arguments)]
fn reconcile_range(
    local: &[Item],
    lo: &str,
    hi: Option<&str>,
    remote: &mut impl RemoteRange,
    split: usize,
    leaf: usize,
    out: &mut Diff,
) {
    let local_fp = range_fingerprint(local, lo, hi);
    let remote_fp = remote.fingerprint(lo, hi);

    if local_fp == remote_fp {
        // This whole range matches — prune it, transferring nothing.
        return;
    }

    let local_slice: Vec<&Item> = items_in_range(local, lo, hi).collect();

    if local_slice.len() <= leaf {
        // Small enough (or empty locally): fetch the remote's items for this
        // range and diff directly. An empty local slice against a non-empty
        // remote range is the "we have nothing here" bootstrap — everything the
        // remote has is `only_remote`, which is correct.
        let remote_slice = remote.items(lo, hi);
        diff_slices(&local_slice, &remote_slice, out);
        return;
    }

    // Split the local slice into `split` roughly-equal chunks and recurse into
    // each, using the local keys as boundaries. Ranges that match on both sides
    // prune immediately at the top of the recursion.
    let chunk = local_slice.len().div_ceil(split);
    let mut idx = 0;
    while idx < local_slice.len() {
        let chunk_lo = local_slice[idx].0.as_str();
        let next = (idx + chunk).min(local_slice.len());
        // The chunk's upper bound is the next chunk's first key (open above for
        // the final chunk), so [chunk_lo, chunk_hi) tiles the parent range.
        let chunk_hi = if next < local_slice.len() {
            Some(local_slice[next].0.as_str())
        } else {
            hi
        };
        reconcile_range(local, chunk_lo, chunk_hi, remote, split, leaf, out);
        idx = next;
    }
}

/// Merge-walk two subject-sorted slices, classifying each subject.
fn diff_slices(local: &[&Item], remote: &[Item], out: &mut Diff) {
    let mut i = 0;
    let mut j = 0;
    while i < local.len() && j < remote.len() {
        let (ls, lvv) = local[i];
        let (rs, rvv) = &remote[j];
        match ls.as_str().cmp(rs.as_str()) {
            std::cmp::Ordering::Less => {
                out.only_local.push(ls.clone());
                i += 1;
            }
            std::cmp::Ordering::Greater => {
                out.only_remote.push(rs.clone());
                j += 1;
            }
            std::cmp::Ordering::Equal => {
                if lvv != rvv {
                    out.differ.push(ls.clone());
                }
                i += 1;
                j += 1;
            }
        }
    }
    for (ls, _) in &local[i..] {
        out.only_local.push(ls.clone());
    }
    for (rs, _) in &remote[j..] {
        out.only_remote.push(rs.clone());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vv(pairs: &[(&str, i32)]) -> BTreeMap<String, i32> {
        pairs.iter().map(|(p, c)| (p.to_string(), *c)).collect()
    }

    fn item(subject: &str, pairs: &[(&str, i32)]) -> Item {
        (subject.to_string(), vv(pairs))
    }

    /// A remote node backed by an in-memory item set — stands in for the wire.
    /// Counts fingerprint queries so tests can assert the reconcile is
    /// logarithmic (doesn't degrade to scanning every item).
    struct MemRemote {
        items: Vec<Item>,
        fp_calls: usize,
    }

    impl MemRemote {
        fn new(mut items: Vec<Item>) -> Self {
            items.sort_by(|a, b| a.0.cmp(&b.0));
            Self { items, fp_calls: 0 }
        }
    }

    impl RemoteRange for MemRemote {
        fn fingerprint(&mut self, lo: &str, hi: Option<&str>) -> Fingerprint {
            self.fp_calls += 1;
            range_fingerprint(&self.items, lo, hi)
        }
        fn items(&mut self, lo: &str, hi: Option<&str>) -> Vec<Item> {
            items_in_range(&self.items, lo, hi).cloned().collect()
        }
    }

    fn sorted(mut items: Vec<Item>) -> Vec<Item> {
        items.sort_by(|a, b| a.0.cmp(&b.0));
        items
    }

    #[test]
    fn identical_sets_reconcile_with_a_single_root_comparison() {
        let items = sorted(vec![
            item("a", &[("p1", 1)]),
            item("b", &[("p1", 2)]),
            item("c", &[("p2", 3)]),
        ]);
        let mut remote = MemRemote::new(items.clone());
        let diff = reconcile(&items, &mut remote, 4, 2);
        assert!(
            diff.is_empty(),
            "identical sets must produce no diff: {diff:?}"
        );
        assert_eq!(
            remote.fp_calls, 1,
            "a matching root fingerprint must end the reconcile in one comparison"
        );
    }

    #[test]
    fn detects_a_single_changed_version_vector() {
        let local = sorted(vec![item("a", &[("p1", 1)]), item("b", &[("p1", 2)])]);
        // Same subjects; b's counter advanced remotely.
        let mut remote = MemRemote::new(vec![item("a", &[("p1", 1)]), item("b", &[("p1", 5)])]);
        let diff = reconcile(&local, &mut remote, 4, 2);
        assert_eq!(diff.differ, vec!["b".to_string()]);
        assert!(diff.only_local.is_empty() && diff.only_remote.is_empty());
    }

    #[test]
    fn detects_local_only_and_remote_only_subjects() {
        let local = sorted(vec![item("a", &[("p1", 1)]), item("local", &[("p1", 1)])]);
        let mut remote =
            MemRemote::new(vec![item("a", &[("p1", 1)]), item("remote", &[("p1", 1)])]);
        let diff = reconcile(&local, &mut remote, 4, 2);
        assert_eq!(diff.only_local, vec!["local".to_string()]);
        assert_eq!(diff.only_remote, vec!["remote".to_string()]);
        assert!(diff.differ.is_empty());
    }

    #[test]
    fn empty_local_pulls_every_remote_subject() {
        let local: Vec<Item> = vec![];
        let mut remote = MemRemote::new(vec![item("a", &[("p1", 1)]), item("b", &[("p1", 2)])]);
        let diff = reconcile(&local, &mut remote, 4, 2);
        assert_eq!(diff.only_remote, vec!["a".to_string(), "b".to_string()]);
        assert!(diff.only_local.is_empty() && diff.differ.is_empty());
    }

    #[test]
    fn finds_one_change_in_a_large_set_without_scanning_everything() {
        // 256 subjects; exactly one differs. The whole point of RBSR: the
        // number of fingerprint comparisons must be logarithmic in the set
        // size, NOT linear (which is what the flat hash forces).
        let n = 256usize;
        let mut base: Vec<Item> = (0..n)
            .map(|i| item(&format!("subject-{i:04}"), &[("p1", i as i32)]))
            .collect();
        base = sorted(base);

        let local = base.clone();
        let mut remote_items = base.clone();
        // Advance one subject's counter on the remote side.
        let target = "subject-0123".to_string();
        for (s, v) in remote_items.iter_mut() {
            if *s == target {
                v.insert("p1".to_string(), 9999);
            }
        }
        let mut remote = MemRemote::new(remote_items);

        let diff = reconcile(&local, &mut remote, 4, 4);
        assert_eq!(diff.differ, vec![target]);
        assert!(diff.only_local.is_empty() && diff.only_remote.is_empty());
        // With split=4 over 256 items, a full scan would be ~O(256) fingerprint
        // calls; a logarithmic descent is a few dozen. Assert well under linear.
        assert!(
            remote.fp_calls < 40,
            "expected a logarithmic number of fingerprint comparisons, got {} for {n} items",
            remote.fp_calls
        );
    }

    /// Golden cross-implementation vector for `item_fingerprint`. The TS client
    /// asserts the SAME hex for the SAME item (`canonical-drive-hash.test.ts`).
    /// The reconcile only converges if both sides fingerprint an item
    /// identically, so a drift in the string format or hash fails one of the
    /// two golden tests instead of silently mis-diffing.
    #[test]
    fn item_fingerprint_matches_golden_vector() {
        // "s=p1:1,p2:2" → SHA-256.
        assert_eq!(
            hex::encode(item_fingerprint("s", &vv(&[("p1", 1), ("p2", 2)]))),
            "8b6067440e370aeaf5e85936d9d67477224a664f8b2811a2008309b590edd5d8",
        );
    }

    #[test]
    fn item_fingerprint_is_deterministic_and_order_independent_in_vv() {
        // Two VV maps built in different insertion orders must fingerprint the
        // same (BTreeMap canonicalizes), and different content must differ.
        let a = item_fingerprint("s", &vv(&[("p1", 1), ("p2", 2)]));
        let b = item_fingerprint("s", &vv(&[("p2", 2), ("p1", 1)]));
        assert_eq!(a, b);
        let c = item_fingerprint("s", &vv(&[("p1", 1), ("p2", 3)]));
        assert_ne!(a, c);
    }
}
