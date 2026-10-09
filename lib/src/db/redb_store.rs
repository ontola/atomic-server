//! RedbStore: KvStore backed by redb — works natively and in WASM.
//! Uses InMemoryBackend by default. Can be swapped to OPFS backend for persistence.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};

use redb::{
    backends::InMemoryBackend, Database, ReadableDatabase, ReadableTable, ReadableTableMetadata,
    TableDefinition,
};

use crate::errors::AtomicResult;

use super::{
    kv_store::{KvIter, KvPair, KvStore},
    trees::{Method, Operation, Tree},
};

/// redb table definition: all our trees are `&[u8] -> &[u8]`, named after
/// [`Tree::name`] so redb and sled can never disagree on a tree's version.
fn table_def(tree: Tree) -> TableDefinition<'static, &'static [u8], &'static [u8]> {
    TableDefinition::new(tree.name())
}

/// Tables redb used to open under names that had drifted from `Tree::name`.
/// The query-members and watched-query layouts moved to v6 and v5 while
/// redb kept writing both into their v3 tables, so a store from before
/// this fix can hold rows in an older key layout. Both are caches that
/// rebuild on the next query, so dropping them is safe.
///
/// The search layout moved to v2 (document ids in the postings, no separate
/// token list); the v1 tables are rebuilt into it and only take up room.
const STALE_TABLES: [&str; 6] = [
    "members_index_v3",
    "watched_queries_v3",
    "search_postings_v1",
    "search_docs_v1",
    "search_doc_tokens_v1",
    "search_trigrams_v1",
];

fn create_all_tables(tx: &redb::WriteTransaction) {
    for tree in Tree::ALL {
        let _ = tx.open_table(table_def(tree));
    }
    for name in STALE_TABLES {
        let _ = tx.delete_table(TableDefinition::<&[u8], &[u8]>::new(name));
    }
}

/// The server-side floor for when a write is acknowledged relative to the
/// fsync that makes it survive a crash (`kill -9`, power loss).
///
/// * [`Durability::None`] (default): a write returns at once and becomes
///   durable on the next periodic [`KvStore::flush`] (100 ms in the server), so
///   an acknowledged write can be lost in a crash. A caller that needs more
///   asks per write with [`KvStore::flush_durable`], which joins a shared
///   group-commit fsync and returns once everything written so far is on disk.
/// * [`Durability::Always`]: every write returns only after the fsync of the
///   transaction that holds it, and concurrent writers share one transaction
///   and one fsync (group commit). Spelled `group` in releases before the
///   per-commit flag; still accepted.
/// * [`Durability::Immediate`]: every write pays its own fsync, without group
///   commit. Kept for tests and benchmarks; there is no reason to run it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Durability {
    Immediate,
    Always,
    #[default]
    None,
}

impl std::str::FromStr for Durability {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.trim().to_ascii_lowercase().as_str() {
            "immediate" => Ok(Durability::Immediate),
            "always" | "group" => Ok(Durability::Always),
            "none" => Ok(Durability::None),
            other => Err(format!(
                "unknown durability '{other}', expected none or always (or immediate)"
            )),
        }
    }
}

impl std::fmt::Display for Durability {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Durability::Immediate => "immediate",
            Durability::Always => "always",
            Durability::None => "none",
        })
    }
}

/// Write transactions committed with an fsync, process wide. Group commit makes
/// this smaller than the number of acknowledged writes; benchmarks and tests
/// read it to see how much sharing happened.
pub static DURABLE_TRANSACTIONS: AtomicU64 = AtomicU64::new(0);

/// Group-commit state, behind one mutex. `queued` holds writers waiting for a
/// leader (id, operations); a leader moves their outcome to `done`, where each
/// writer collects its own. `leader_active` is true while one writer runs the
/// fsync for everyone queued.
#[derive(Default)]
struct GroupState {
    next_id: u64,
    queued: Vec<(u64, Vec<Operation>)>,
    done: std::collections::HashMap<u64, Result<(), String>>,
    leader_active: bool,
}

/// A KvStore backed by redb.
/// Supports InMemoryBackend (default) or OPFS backend (WASM persistent).
/// Thread-safe via redb's internal locking (MVCC).
pub struct RedbStore {
    db: Arc<Database>,
    /// When Some, operations are buffered instead of committed immediately.
    /// Reads consult the buffer first (read-your-writes within a batch).
    /// Call `commit_batch()` to flush all buffered ops in a single transaction.
    batch_buffer: std::sync::Mutex<Option<BatchBuffer>>,
    /// Set by every `Durability::None` commit, cleared by `flush`. Lets the
    /// durable-flush tick skip the fsync (and the sentinel write) when nothing
    /// changed, which is most ticks on an idle node or a phone in a pocket.
    dirty: AtomicBool,
    durability: Durability,
    /// Group commit (see [`RedbStore::group_write`]).
    group: Mutex<GroupState>,
    group_cv: Condvar,
}

/// Per-tree map of pending operations. Used for fast read-your-writes lookups.
#[derive(Default)]
struct BatchBuffer {
    /// Insertion-ordered list of all operations (for the final transaction).
    ops: Vec<Operation>,
    /// Per-tree most-recent value for each key. None means deleted.
    /// Keyed by (tree_name, key_bytes).
    latest: std::collections::HashMap<(String, Vec<u8>), Option<Vec<u8>>>,
}

impl BatchBuffer {
    fn push(&mut self, op: Operation) {
        let key = (op.tree.to_string(), op.key.clone());
        let val = match op.method {
            Method::Insert => op.val.clone(),
            Method::Delete => None,
        };
        self.latest.insert(key, val);
        self.ops.push(op);
    }

    fn get(&self, tree: &Tree, key: &[u8]) -> Option<Option<Vec<u8>>> {
        self.latest.get(&(tree.to_string(), key.to_vec())).cloned()
    }
}

/// Open a redb file, run `Database::compact()`, close. Returns
/// `(size_before, size_after, did_compact)`. Designed for the
/// admin-triggered `atomic-server compact` CLI subcommand — the
/// caller MUST guarantee no atomic-server process is running against
/// the same file (redb takes an exclusive lock).
///
/// Compaction itself is `O(file size)` and intentionally slow; for a
/// multi-GB store expect several minutes. The win is that subsequent
/// boots `fsync` a much smaller file, which on macOS is the dominant
/// cost of `Database::create` (see redb `begin_writable()` at
/// `page_manager.rs:361-367`).
#[cfg(all(feature = "db", not(target_arch = "wasm32")))]
pub fn compact_file(path: &std::path::Path) -> AtomicResult<(u64, u64, bool)> {
    let size_before = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    let mut db = redb::Database::create(path)
        .map_err(|e| format!("Failed to open redb at {}: {e}", path.display()))?;
    let did_compact = super::compaction::compact_database(&mut db)?;
    drop(db);
    let size_after = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    Ok((size_before, size_after, did_compact))
}

/// Rows copied per write transaction while scrubbing, bounding memory.
#[cfg(all(feature = "db", not(target_arch = "wasm32")))]
const SCRUB_CHUNK_ROWS: usize = 20_000;

/// Rewrite the redb file at `path` into a fresh file that holds only live
/// rows, overwrite the old file with zeros, and move the new one into place.
/// Returns `(size_before, size_after)`.
///
/// This is what makes a purge physical. redb never zeroes a page it frees,
/// and `Database::compact` moves live pages but leaves the freed ones that
/// stay below the new end of the file as they were, so deleted rows remain
/// readable in the file (measured: see `lib/tests/purge.rs`). A copy into a
/// new file carries nothing but live data; zeroing the old file before it is
/// released removes the rest. The caller must guarantee no other handle on
/// the file (redb's own lock enforces it). On a crash the old file is intact
/// until the zeroing starts, and the new file is complete before it does.
///
/// Limits: a copy-on-write filesystem, a snapshotting volume or an SSD's
/// wear leveling may keep old blocks that an in-place overwrite never
/// reaches; this works at the file level only.
#[cfg(all(feature = "db", not(target_arch = "wasm32")))]
pub fn scrub_file(path: &std::path::Path) -> AtomicResult<(u64, u64)> {
    use std::io::Write;

    let size_before = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    let tmp = path.with_extension("redb.scrub");
    let _ = std::fs::remove_file(&tmp);
    let copy = || -> AtomicResult<()> {
        let old = Database::create(path)
            .map_err(|e| format!("Failed to open redb at {}: {e}", path.display()))?;
        let new = Database::create(&tmp)
            .map_err(|e| format!("Failed to create redb at {}: {e}", tmp.display()))?;
        let read = old.begin_read().map_err(|e| format!("redb read tx: {e}"))?;
        for tree in Tree::ALL {
            let source = match read.open_table(table_def(tree)) {
                Ok(table) => table,
                Err(redb::TableError::TableDoesNotExist(_)) => continue,
                Err(e) => return Err(format!("redb open table {}: {e}", tree.name()).into()),
            };
            let mut rows = source
                .iter()
                .map_err(|e| format!("redb iter {}: {e}", tree.name()))?
                .peekable();
            // An empty tree still gets its table in the new file.
            loop {
                let tx = new
                    .begin_write()
                    .map_err(|e| format!("redb write tx: {e}"))?;
                {
                    let mut table = tx
                        .open_table(table_def(tree))
                        .map_err(|e| format!("redb open table {}: {e}", tree.name()))?;
                    for _ in 0..SCRUB_CHUNK_ROWS {
                        let Some(row) = rows.next() else { break };
                        let (key, value) = row.map_err(|e| format!("redb read row: {e}"))?;
                        table
                            .insert(key.value(), value.value())
                            .map_err(|e| format!("redb insert row: {e}"))?;
                    }
                }
                tx.commit().map_err(|e| format!("redb commit scrub: {e}"))?;
                if rows.peek().is_none() {
                    break;
                }
            }
        }
        // The last commit is Immediate: the new file is durable before the
        // old one is touched.
        Ok(())
    };
    if let Err(e) = copy() {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }

    // Overwrite the old file in place, then release it.
    {
        let mut old = std::fs::OpenOptions::new()
            .write(true)
            .open(path)
            .map_err(|e| format!("Failed to open {} for scrubbing: {e}", path.display()))?;
        let zeros = vec![0u8; 1 << 20];
        let mut remaining = size_before;
        while remaining > 0 {
            let n = remaining.min(zeros.len() as u64) as usize;
            old.write_all(&zeros[..n])
                .map_err(|e| format!("Failed to zero {}: {e}", path.display()))?;
            remaining -= n as u64;
        }
        old.sync_all()
            .map_err(|e| format!("Failed to sync {}: {e}", path.display()))?;
    }
    std::fs::rename(&tmp, path)
        .map_err(|e| format!("Failed to move {} into place: {e}", tmp.display()))?;
    let size_after = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    Ok((size_before, size_after))
}

impl RedbStore {
    /// Create a RedbStore backed by a file on disk. No startup compaction;
    /// see `new_file_with_policy` for the path `Db::init_redb_file` takes.
    #[cfg(not(target_arch = "wasm32"))]
    pub fn new_file(path: &std::path::Path) -> AtomicResult<Self> {
        Self::new_file_with_policy(path, &super::compaction::CompactionPolicy::disabled())
            .map(|(store, _)| store)
    }

    /// `new_file` with an explicit [`Durability`].
    #[cfg(not(target_arch = "wasm32"))]
    pub fn new_file_with_durability(
        path: &std::path::Path,
        durability: Durability,
    ) -> AtomicResult<Self> {
        Self::new_file_with_policy_and_durability(
            path,
            &super::compaction::CompactionPolicy::disabled(),
            durability,
        )
        .map(|(store, _)| store)
    }

    /// Open (or create) the file, log its size and open duration, and run
    /// the startup compaction `policy` on it before any table is touched.
    /// The second value says whether a compaction ran; a failure there is a
    /// `Skip::Failed`, never an error, so a store that cannot be compacted
    /// still opens.
    #[cfg(not(target_arch = "wasm32"))]
    pub fn new_file_with_policy(
        path: &std::path::Path,
        policy: &super::compaction::CompactionPolicy,
    ) -> AtomicResult<(
        Self,
        Result<super::compaction::CompactionRecord, super::compaction::Skip>,
    )> {
        Self::new_file_with_policy_and_durability(path, policy, Durability::default())
    }

    /// `new_file_with_policy` with an explicit [`Durability`].
    #[cfg(not(target_arch = "wasm32"))]
    pub fn new_file_with_policy_and_durability(
        path: &std::path::Path,
        policy: &super::compaction::CompactionPolicy,
        durability: Durability,
    ) -> AtomicResult<(
        Self,
        Result<super::compaction::CompactionRecord, super::compaction::Skip>,
    )> {
        // `Database::create` with defaults uses a 1 GiB cache and the
        // slow full-scan repair path on any unclean shutdown. On a
        // multi-GB store that's 40+ seconds added to every boot
        // (see redb issue #1055). The Builder lets us drop the cache
        // to fit-for-purpose; per-transaction `set_quick_repair(true)`
        // below persists the allocator state on every commit so the
        // next open is "almost instant" (redb transactions.rs:1246-1258
        // describes the mechanism).
        let t = std::time::Instant::now();
        let mut db = Database::create(path)
            .map_err(|e| format!("Failed to create redb at {}: {e}", path.display()))?;
        let open_duration = t.elapsed();
        tracing::info!(
            "RedbStore::new_file: Database::create in {:?}",
            open_duration
        );

        // On the handle we already hold: the file lock is taken once, and
        // a bloated store is not opened a second time just to measure it.
        let compaction =
            super::compaction::run_startup_policy(&mut db, path, open_duration, policy);

        // Create all tables upfront
        let t = std::time::Instant::now();
        {
            let mut tx = db
                .begin_write()
                .map_err(|e| format!("Failed to begin write tx: {e}"))?;
            // 2-phase commit persists redb's allocator state alongside
            // each transaction. Without it, an unclean shutdown (SIGKILL,
            // crash, power loss) forces a full file scan + repair on next
            // open — measured at 44s on a 3.6 GiB store, all of it spent
            // in `Database::create` before the actor system even starts.
            // With 2PC the next open loads the allocator state and skips
            // the repair entirely. Trade-off: each write pays one extra
            // fsync; on a server doing a handful of commits/sec that's
            // imperceptible, and the boot-time win is dramatic.
            tx.set_quick_repair(true);
            create_all_tables(&tx);
            tx.commit()
                .map_err(|e| format!("Failed to commit initial tables: {e}"))?;
        }
        tracing::info!("RedbStore::new_file: table-create tx in {:?}", t.elapsed());

        Ok((RedbStore::with_db(db, durability), compaction))
    }

    /// Create a new in-memory RedbStore.
    pub fn new_memory() -> AtomicResult<Self> {
        let backend = InMemoryBackend::new();
        let db = Database::builder()
            .create_with_backend(backend)
            .map_err(|e| format!("Failed to create redb: {e}"))?;

        // Create all tables upfront so reads don't fail on missing tables
        {
            let mut tx = db
                .begin_write()
                .map_err(|e| format!("Failed to begin write tx: {e}"))?;
            tx.set_quick_repair(true);
            create_all_tables(&tx);
            tx.commit()
                .map_err(|e| format!("Failed to commit initial tables: {e}"))?;
        }

        // Nothing to fsync in memory.
        Ok(RedbStore::with_db(db, Durability::None))
    }

    fn with_db(db: Database, durability: Durability) -> Self {
        RedbStore {
            db: Arc::new(db),
            batch_buffer: std::sync::Mutex::new(None),
            dirty: AtomicBool::new(false),
            durability,
            group: Mutex::new(GroupState::default()),
            group_cv: Condvar::new(),
        }
    }

    /// Create a RedbStore backed by OPFS for persistent storage in WASM Workers.
    /// The file is created/opened in the Origin Private File System.
    ///
    /// With `encryption_key` set, all data is encrypted at rest via
    /// [`super::encrypted_backend::EncryptedBackend`]. Opening an encrypted
    /// file without the key (or with the wrong one) fails instead of exposing
    /// or corrupting data, as does opening a plaintext file with a key.
    #[cfg(target_arch = "wasm32")]
    pub async fn new_opfs(filename: &str, encryption_key: Option<&[u8; 32]>) -> AtomicResult<Self> {
        let backend = super::opfs_backend::OpfsBackend::open(filename)
            .await
            .map_err(|e| format!("Failed to open OPFS backend: {:?}", e))?;

        let db = match encryption_key {
            Some(key) => {
                let encrypted = super::encrypted_backend::EncryptedBackend::new(backend, key)
                    .map_err(|e| format!("Failed to open encrypted OPFS backend: {e}"))?;
                Database::builder()
                    .create_with_backend(encrypted)
                    .map_err(|e| format!("Failed to create encrypted redb with OPFS: {e}"))?
            }
            None => Database::builder()
                .create_with_backend(backend)
                .map_err(|e| format!("Failed to create redb with OPFS: {e}"))?,
        };

        // Create all tables upfront
        {
            let mut tx = db
                .begin_write()
                .map_err(|e| format!("Failed to begin write tx: {e}"))?;
            tx.set_quick_repair(true);
            create_all_tables(&tx);
            tx.commit()
                .map_err(|e| format!("Failed to commit initial tables: {e}"))?;
        }

        // One thread in the browser: nothing can wait for a leader's fsync.
        Ok(RedbStore::with_db(db, Durability::None))
    }

    /// The durability this store acknowledges writes at.
    pub fn durability(&self) -> Durability {
        self.durability
    }

    /// Applies `ops` and returns once the write is as durable as
    /// `self.durability` promises.
    fn write_ops(&self, ops: &[Operation]) -> AtomicResult<()> {
        match self.durability {
            Durability::Always => self.group_write(ops),
            Durability::Immediate => self.write_batches(&[ops], true),
            Durability::None => {
                self.write_batches(&[ops], false)?;
                self.dirty.store(true, Ordering::SeqCst);
                Ok(())
            }
        }
    }

    /// One write transaction holding every list in `batches`, in order.
    /// `durable` commits with an fsync (and redb's two-phase commit, which
    /// persists the allocator state so the next open after a crash skips the
    /// full repair scan); otherwise the commit is only persisted by a later
    /// durable one.
    fn write_batches(&self, batches: &[&[Operation]], durable: bool) -> AtomicResult<()> {
        let mut tx = self
            .db
            .begin_write()
            .map_err(|e| format!("redb write tx: {e}"))?;
        if durable {
            tx.set_quick_repair(true);
        } else {
            tx.set_durability(redb::Durability::None)
                .map_err(|e| format!("redb set_durability: {e}"))?;
        }
        for ops in batches {
            for op in *ops {
                let mut table = tx
                    .open_table(table_def(op.tree))
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
        tx.commit().map_err(|e| format!("redb commit batch: {e}"))?;
        if durable {
            DURABLE_TRANSACTIONS.fetch_add(1, Ordering::Relaxed);
        }
        Ok(())
    }

    /// Group commit. redb runs one write transaction at a time and every
    /// durable one ends in an fsync, so N concurrent durable writes would pay N
    /// fsyncs back to back. Instead each writer queues its operations; the
    /// first one that finds no leader running becomes the leader and commits
    /// *everything queued* in one transaction with one fsync, then hands each
    /// writer its result. Writers that arrive while that fsync runs queue up
    /// behind it and form the next group, so batches grow with load and a lone
    /// writer pays exactly one plain durable commit. A write is acknowledged
    /// only after the transaction holding it was fsynced.
    fn group_write(&self, ops: &[Operation]) -> AtomicResult<()> {
        let mut state = self.group.lock().unwrap_or_else(|e| e.into_inner());
        let id = state.next_id;
        state.next_id += 1;
        state.queued.push((id, ops.to_vec()));
        loop {
            if let Some(outcome) = state.done.remove(&id) {
                return outcome.map_err(Into::into);
            }
            if state.leader_active {
                state = self.group_cv.wait(state).unwrap_or_else(|e| e.into_inner());
                continue;
            }
            // Lead: take everything queued so far (our own write included).
            state.leader_active = true;
            let group = std::mem::take(&mut state.queued);
            drop(state);

            let batches: Vec<&[Operation]> = group.iter().map(|(_, ops)| ops.as_slice()).collect();
            // A panic must not leave `leader_active` set and the group hanging.
            let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                self.write_batches(&batches, true)
                    .map_err(|e| e.to_string())
            }))
            .unwrap_or_else(|_| Err("redb group commit panicked".to_string()));

            state = self.group.lock().unwrap_or_else(|e| e.into_inner());
            for (writer, _) in &group {
                state.done.insert(*writer, outcome.clone());
            }
            state.leader_active = false;
            self.group_cv.notify_all();
        }
    }

    /// An `Immediate` commit: redb fsyncs it and, with it, every earlier
    /// `Durability::None` commit.
    fn sync_commit_point(&self) -> AtomicResult<()> {
        let mut tx = self
            .db
            .begin_write()
            .map_err(|e| format!("redb flush begin_write: {e}"))?;
        tx.set_quick_repair(true);
        // Touch a sentinel key so the transaction is non-empty and redb
        // definitely writes (and fsyncs) a new commit point.
        {
            let mut table = tx
                .open_table(table_def(Tree::DriveMapping))
                .map_err(|e| format!("redb flush open table: {e}"))?;
            table
                .insert(b"__flush_sentinel__".as_slice(), b"".as_slice())
                .map_err(|e| format!("redb flush sentinel: {e}"))?;
        }
        tx.commit().map_err(|e| format!("redb flush commit: {e}"))?;
        Ok(())
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
        // Read-your-writes: check the batch buffer first
        {
            let buf = self.batch_buffer.lock().unwrap();
            if let Some(buffer) = buf.as_ref() {
                if let Some(val) = buffer.get(&tree, key) {
                    return Ok(val);
                }
            }
        }
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
        self.apply_batch(&[Operation {
            tree,
            method: Method::Insert,
            key: key.to_vec(),
            val: Some(val.to_vec()),
        }])
    }

    fn remove(&self, tree: Tree, key: &[u8]) -> AtomicResult<()> {
        // Removing a key that is not there changes nothing, so it must not
        // cost a write transaction and an fsync. The commit path clears a
        // tombstone this way before every single commit.
        let batching = self.batch_buffer.lock().unwrap().is_some();
        if !batching && !self.contains_key(tree, key)? {
            return Ok(());
        }
        self.apply_batch(&[Operation {
            tree,
            method: Method::Delete,
            key: key.to_vec(),
            val: None,
        }])
    }

    fn contains_key(&self, tree: Tree, key: &[u8]) -> AtomicResult<bool> {
        let tx = self
            .db
            .begin_read()
            .map_err(|e| format!("redb read tx: {e}"))?;
        let table = tx
            .open_table(table_def(tree))
            .map_err(|e| format!("redb open table: {e}"))?;

        let result = table
            .get(key)
            .map_err(|e| format!("redb contains_key: {e}"))?;

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
                return Box::new(std::iter::once(Err(format!("redb open table: {e}").into())))
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
                return Box::new(std::iter::once(Err(format!("redb open table: {e}").into())))
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

    fn range_page(
        &self,
        tree: Tree,
        start: Vec<u8>,
        end: Vec<u8>,
        limit: usize,
    ) -> crate::errors::AtomicResult<Vec<KvPair>> {
        let tx = self
            .db
            .begin_read()
            .map_err(|e| format!("redb read tx: {e}"))?;
        let table = tx
            .open_table(table_def(tree))
            .map_err(|e| format!("redb open table: {e}"))?;
        let rows = table
            .range(start.as_slice()..end.as_slice())
            .map_err(|e| format!("redb range: {e}"))?;
        rows.take(limit)
            .map(|row| {
                let (k, v) = row.map_err(|e| format!("redb range entry: {e}"))?;
                Ok((k.value().to_vec(), v.value().to_vec()))
            })
            .collect()
    }

    fn first_entry(&self, tree: Tree) -> AtomicResult<Option<KvPair>> {
        let tx = self
            .db
            .begin_read()
            .map_err(|e| format!("redb read tx: {e}"))?;
        let table = tx
            .open_table(table_def(tree))
            .map_err(|e| format!("redb open table: {e}"))?;
        let first = table
            .first()
            .map_err(|e| format!("redb first entry: {e}"))?;
        Ok(first.map(|(key, value)| (key.value().to_vec(), value.value().to_vec())))
    }

    fn iter_tree(&self, tree: Tree) -> KvIter {
        let tx = match self.db.begin_read() {
            Ok(tx) => tx,
            Err(e) => return Box::new(std::iter::once(Err(format!("redb read tx: {e}").into()))),
        };
        let table = match tx.open_table(table_def(tree)) {
            Ok(t) => t,
            Err(e) => {
                return Box::new(std::iter::once(Err(format!("redb open table: {e}").into())))
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
        let mut tx = self
            .db
            .begin_write()
            .map_err(|e| format!("redb write tx: {e}"))?;
        tx.set_quick_repair(true);
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
        tx.commit().map_err(|e| format!("redb commit clear: {e}"))?;
        Ok(())
    }

    fn apply_batch(&self, operations: &[Operation]) -> AtomicResult<()> {
        if operations.is_empty() {
            return Ok(());
        }

        // If in batch mode, buffer the operations instead of committing
        {
            let mut buf = self.batch_buffer.lock().unwrap();
            if let Some(buffer) = buf.as_mut() {
                for op in operations {
                    buffer.push(op.clone());
                }
                return Ok(());
            }
        }

        self.write_ops(operations)
    }

    fn flush(&self) -> AtomicResult<()> {
        // Nothing committed since the last durable point: skip. A write that
        // lands between this swap and the commit below sets the flag again
        // and is picked up by the next flush.
        if !self.dirty.swap(false, Ordering::SeqCst) {
            return Ok(());
        }
        // `Durability::None` writes are only persisted by a *subsequent*
        // Immediate commit, so this flush is what makes them durable. The
        // server calls it on a periodic tick (see `serve.rs`). In group mode
        // writers run the same commit point themselves, so this is a
        // harmless no-op unless something was left dirty.
        match self.sync_commit_point() {
            Ok(()) => Ok(()),
            Err(e) => {
                self.dirty.store(true, Ordering::SeqCst);
                Err(e)
            }
        }
    }

    fn flush_durable(&self) -> AtomicResult<()> {
        // `Always` and `Immediate` already fsynced every write before it
        // returned: nothing is pending.
        if self.durability != Durability::None {
            return Ok(());
        }
        // Everything written so far, by any thread, is covered by the next
        // durable commit. Run it through group commit so concurrent durable
        // requests share one fsync. The sentinel makes the transaction
        // non-empty, so redb really writes and fsyncs a commit point.
        self.dirty.store(false, Ordering::SeqCst);
        let sentinel = Operation {
            tree: Tree::DriveMapping,
            method: Method::Insert,
            key: b"__flush_sentinel__".to_vec(),
            val: Some(Vec::new()),
        };
        self.group_write(&[sentinel]).inspect_err(|_| {
            self.dirty.store(true, Ordering::SeqCst);
        })
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

    fn begin_batch(&self) {
        let mut buf = self.batch_buffer.lock().unwrap();
        if buf.is_none() {
            *buf = Some(BatchBuffer::default());
        }
    }

    fn commit_batch(&self) -> AtomicResult<()> {
        let ops = {
            let mut buf = self.batch_buffer.lock().unwrap();
            buf.take().map(|b| b.ops).unwrap_or_default()
        };
        if ops.is_empty() {
            return Ok(());
        }
        // Apply all buffered operations in a single transaction
        self.write_ops(&ops)
    }
}

#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests {
    use super::*;
    use redb::TableHandle;

    fn temp_path(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "atomic-redb-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("atomic.redb")
    }

    /// A store written before redb's table names followed `Tree::name`
    /// kept query members and watched queries in `*_v3` tables, possibly in
    /// an older key layout. Opening it must switch to the current tables and
    /// drop the old ones rather than read their rows.
    #[test]
    fn opening_drops_tables_from_drifted_names() {
        let path = temp_path("stale-tables");
        {
            let db = Database::create(&path).unwrap();
            let tx = db.begin_write().unwrap();
            for name in STALE_TABLES {
                let mut table = tx
                    .open_table(TableDefinition::<&[u8], &[u8]>::new(name))
                    .unwrap();
                table
                    .insert(b"old-layout".as_slice(), b"".as_slice())
                    .unwrap();
            }
            tx.commit().unwrap();
        }

        let store = RedbStore::new_file(&path).unwrap();
        assert_eq!(store.get(Tree::QueryMembers, b"old-layout").unwrap(), None);
        assert_eq!(
            store.get(Tree::WatchedQueries, b"old-layout").unwrap(),
            None
        );

        let tx = store.db.begin_read().unwrap();
        let names: Vec<String> = tx
            .list_tables()
            .unwrap()
            .map(|t| t.name().to_string())
            .collect();
        for name in STALE_TABLES {
            assert!(!names.iter().any(|n| n == name), "{name} should be gone");
        }
        for tree in Tree::ALL {
            assert!(names.iter().any(|n| n == tree.name()), "{tree} missing");
        }
    }

    const ABORT_CHILD_ENV: &str = "ATOMIC_REDB_ABORT_CHILD_PATH";
    const ABORT_TEST_NAME: &str =
        "db::redb_store::tests::unflushed_writes_are_lost_on_abort_and_flushed_ones_survive";

    /// With `Durability::None`, per-commit writes are not fsynced; only `flush` makes them
    /// survive an unclean exit. A clean `drop` closes redb durably, so the
    /// loss only shows when the process dies mid-flight: the Android app
    /// kill that motivated the library-owned flush tick. This test re-runs
    /// itself as a child that writes one flushed and one unflushed key, then
    /// aborts (no destructors), and checks what the parent can read back.
    #[test]
    fn unflushed_writes_are_lost_on_abort_and_flushed_ones_survive() {
        if let Ok(path) = std::env::var(ABORT_CHILD_ENV) {
            let store =
                RedbStore::new_file_with_durability(std::path::Path::new(&path), Durability::None)
                    .unwrap();
            store.insert(Tree::PluginMeta, b"kept", b"1").unwrap();
            assert!(store.dirty.load(Ordering::SeqCst));
            store.flush().unwrap();
            assert!(!store.dirty.load(Ordering::SeqCst));
            store.insert(Tree::PluginMeta, b"lost", b"1").unwrap();
            std::process::abort();
        }

        let path = temp_path("abort");
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                ABORT_TEST_NAME,
                "--nocapture",
                "--test-threads=1",
            ])
            .env(ABORT_CHILD_ENV, &path)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .unwrap();
        assert!(!status.success(), "the child must abort, not exit cleanly");

        let store = RedbStore::new_file(&path).unwrap();
        assert_eq!(
            store.get(Tree::PluginMeta, b"kept").unwrap(),
            Some(b"1".to_vec()),
            "a flushed write must survive an abort"
        );
        assert_eq!(
            store.get(Tree::PluginMeta, b"lost").unwrap(),
            None,
            "a Durability::None commit must not survive an abort without flush"
        );
        drop(store);
        std::fs::remove_dir_all(path.parent().unwrap()).ok();
    }

    #[test]
    fn flush_is_a_no_op_when_nothing_changed() {
        let path = temp_path("noop");
        let store = RedbStore::new_file_with_durability(&path, Durability::None).unwrap();
        store.insert(Tree::PluginMeta, b"k", b"v").unwrap();
        store.flush().unwrap();
        let size_after_first_flush = std::fs::metadata(&path).unwrap().len();
        // The sentinel write would grow or rewrite the file; a clean store
        // must not touch it at all.
        for _ in 0..10 {
            store.flush().unwrap();
        }
        assert!(!store.dirty.load(Ordering::SeqCst));
        assert_eq!(
            std::fs::metadata(&path).unwrap().len(),
            size_after_first_flush
        );
        drop(store);
        std::fs::remove_dir_all(path.parent().unwrap()).ok();
    }

    #[test]
    fn parse_durability() {
        assert_eq!("group".parse(), Ok(Durability::Always));
        assert_eq!("always".parse(), Ok(Durability::Always));
        assert_eq!("Immediate".parse(), Ok(Durability::Immediate));
        assert_eq!(" none ".parse(), Ok(Durability::None));
        assert!("maybe".parse::<Durability>().is_err());
        assert_eq!(Durability::default(), Durability::None);
    }

    /// Every concurrent group write is applied exactly once and acknowledged,
    /// whichever writer ended up leading.
    #[test]
    fn group_commit_applies_every_concurrent_write() {
        let store = Arc::new(
            RedbStore::new_file_with_durability(&temp_path("group"), Durability::Always).unwrap(),
        );
        assert_eq!(store.durability(), Durability::Always);
        let handles: Vec<_> = (0..8)
            .map(|w| {
                let store = store.clone();
                std::thread::spawn(move || {
                    for i in 0..50 {
                        let key = format!("w{w}-{i}");
                        store
                            .insert(Tree::PluginMeta, key.as_bytes(), b"v")
                            .unwrap();
                        // Acknowledged means visible.
                        assert!(store
                            .contains_key(Tree::PluginMeta, key.as_bytes())
                            .unwrap());
                    }
                })
            })
            .collect();
        for h in handles {
            h.join().unwrap();
        }
        assert_eq!(store.len(Tree::PluginMeta).unwrap(), 400);
    }

    #[test]
    fn removing_a_missing_key_costs_no_write_transaction() {
        let store =
            RedbStore::new_file_with_durability(&temp_path("remove-missing"), Durability::None)
                .unwrap();
        store.insert(Tree::PluginMeta, b"k", b"v").unwrap();
        assert!(store.dirty.swap(false, Ordering::SeqCst));
        store.remove(Tree::PluginMeta, b"absent").unwrap();
        assert!(
            !store.dirty.load(Ordering::SeqCst),
            "removing an absent key must not write"
        );
        store.remove(Tree::PluginMeta, b"k").unwrap();
        assert!(store.dirty.load(Ordering::SeqCst));
        assert_eq!(store.get(Tree::PluginMeta, b"k").unwrap(), None);
    }
}
