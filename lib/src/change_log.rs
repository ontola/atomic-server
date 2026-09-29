//! Per-table change list: which rows of a table changed since a cursor,
//! including rows that left it (tombstones). #1850.
//!
//! Plugins that sync a table two ways ("hook for speed, change list for
//! correctness", ontola/atomic-plugins#177) ask "what changed in table T
//! since C?" and get every created, updated or deleted row, with each row's
//! Loro version so they can diff fields against their own baseline. Nothing
//! is missed across restarts or while the plugin is off: the log is written
//! in the same transaction as the state it describes.
//!
//! # What a table and a row are
//!
//! The data browser's definition (`useTableData`): a **table** is a resource
//! whose `isA` includes [`urls::TABLE`] and that names a
//! [`urls::CLASSTYPE_PROP`]. A **row** of it is a resource whose `parent` is
//! the table and whose `isA` includes that classtype. Other children (the
//! table's own View resources) are not rows.
//!
//! A row *enters* a table when it is created there, moved in (parent
//! changed) or given the class; it *leaves* when destroyed, moved out or
//! stripped of the class. Leaving is a `deleted` entry for that table.
//!
//! # Storage ([`Tree::TableChanges`])
//!
//! Four key families, all under the table's pure id (subjects never contain
//! a NUL byte, so `\0` separates unambiguously):
//!
//! - `m\0{table}` → [`TableMeta`] JSON: epoch, last sequence number, floor,
//!   whether the one-time backfill ran.
//! - `e\0{table}\0{seq u64 BE}` → [`StoredEntry`] JSON. Sorted by `seq`.
//! - `r\0{table}\0{row}` → `seq` (u64 BE) of the row's latest entry.
//! - `d\0{table}\0{seq u64 BE}` → `at` (i64 BE): the tombstone index, so
//!   pruning expired tombstones never scans live entries.
//!
//! Only the latest entry per row per table is kept: writing a new entry for
//! a row deletes its previous one (via the `r` key), in the same
//! transaction. So the log is always compact, at most one entry per row
//! that ever was in the table, and a reader never needs a separate
//! compaction pass. A reader holding a cursor between the old and new entry
//! still sees the row, because its new `seq` is higher than any cursor.
//!
//! Sequence numbers are allocated under [`ChangeLog::lock`], held from
//! allocation until the transaction carrying the entry is applied, so
//! entries become visible in `seq` order and a reader can never skip one
//! that lands later with a lower number.
//!
//! # Cursors
//!
//! Opaque to clients: base64url of `{"v":1,"t":table,"e":epoch,"s":seq,"f":full}`.
//! `seq` is the last sequence number the client has seen. `epoch` changes
//! when the log is rebuilt (the table's `classtype` changed, which changes
//! which children are rows), which expires every older cursor. `full` marks
//! the pages of a first listing (no `since`): those are not expired by
//! tombstone pruning, see below.
//!
//! # Retention
//!
//! Tombstones are kept for [`ChangeLog::tombstone_retention`] (30 days by
//! default, `--table-change-retention-days` on the server). Expired ones are
//! pruned when the table's list is read, and the table's `floor` is raised
//! to the highest pruned `seq`. A cursor below the floor could have missed a
//! deletion, so it gets [`ChangeListError::CursorExpired`] and the client
//! resyncs from scratch (no `since`). Live entries are never pruned: they
//! are the current state of the row.
//!
//! This is unrelated to `db::compaction`, which reclaims redb file pages.
//! Pruning tombstones frees pages that a later file compaction gives back;
//! the two never touch each other's data.
//!
//! # Backfill
//!
//! Tables older than this log, or rows that arrived by sync before their
//! table did, have no entries. The first read of a table enumerates its
//! current rows and writes a `created` entry for each row that has no entry
//! yet, then marks the table backfilled. It is idempotent: a row that
//! already has an entry (any change since the log existed) keeps it.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::{Mutex, RwLock};
use std::time::Duration;

use base64::Engine;
use serde::{Deserialize, Serialize};

use crate::agents::ForAgent;
use crate::db::trees::{Method, Operation, Transaction, Tree};
use crate::errors::{AtomicError, AtomicResult};
use crate::resources::PropVals;
use crate::{urls, Db, Storelike, Subject};

/// Tombstones are kept this long unless configured otherwise.
pub const DEFAULT_TOMBSTONE_RETENTION: Duration = Duration::from_secs(30 * 24 * 60 * 60);
/// Page size when the caller names none.
pub const DEFAULT_PAGE_SIZE: usize = 100;
/// Upper bound for a caller-supplied page size.
pub const MAX_PAGE_SIZE: usize = 500;

const CURSOR_VERSION: u8 = 1;

/// A Loro version vector as JSON: peer id (decimal string, as `loro-crdt`'s
/// `PeerID`) to the exclusive end counter. What `doc.version().toJSON()`
/// gives in JS, and what `VersionVector` / `export({mode: "update", from})`
/// take.
pub type VersionMap = BTreeMap<String, i32>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ChangeKind {
    /// The row entered the table: created there, moved in or given the class.
    Created,
    /// The row was edited and stayed in the table.
    Updated,
    /// The row left the table: destroyed, moved out or lost the class.
    Deleted,
}

/// One entry of a table's change list.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableChange {
    /// The row's subject (pure id; the HTTP layer resolves it).
    pub subject: String,
    /// What the latest change did to the row's membership. A client treats
    /// `created` and `updated` alike (upsert): only the latest entry per row
    /// is kept, so a row created and then edited since the cursor reads as
    /// `updated`.
    pub kind: ChangeKind,
    /// The row's Loro version after the change. For `deleted`, the last
    /// version this node held. `None` only when no snapshot existed.
    pub version: Option<VersionMap>,
    /// When this node recorded the change, ms since the epoch.
    pub at: i64,
}

/// A page of changes.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangePage {
    pub changes: Vec<TableChange>,
    /// Pass back as `since` to continue. Always present.
    pub cursor: String,
    /// More entries follow; ask again with `cursor` right away.
    pub has_more: bool,
}

#[derive(Debug)]
pub enum ChangeListError {
    /// The cursor predates the retention window or a rebuild of the log.
    /// Resync: list again without `since`.
    CursorExpired,
    /// Not a cursor this node issued for this table.
    InvalidCursor(String),
    /// The subject is not a table (no `Table` class or no `classtype`).
    NotATable,
    /// Anything else, including not found and unauthorized.
    Atomic(AtomicError),
}

impl From<AtomicError> for ChangeListError {
    fn from(e: AtomicError) -> Self {
        ChangeListError::Atomic(e)
    }
}

impl std::fmt::Display for ChangeListError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::CursorExpired => {
                write!(
                    f,
                    "The cursor has expired; list the table again without `since`"
                )
            }
            Self::InvalidCursor(why) => write!(f, "Invalid cursor: {why}"),
            Self::NotATable => write!(f, "Not a table"),
            Self::Atomic(e) => write!(f, "{e}"),
        }
    }
}

impl ChangeListError {
    /// The stable code clients match on.
    pub fn code(&self) -> &'static str {
        match self {
            Self::CursorExpired => "CURSOR_EXPIRED",
            Self::InvalidCursor(_) => "INVALID_CURSOR",
            Self::NotATable => "NOT_A_TABLE",
            Self::Atomic(_) => "ERROR",
        }
    }
}

/// Per-store state: the writer lock and the retention setting. Shared by
/// every clone of a [`Db`].
#[derive(Debug)]
pub struct ChangeLog {
    /// Held from `seq` allocation until the entry's transaction is applied.
    /// Never held across an `.await`.
    pub(crate) lock: Mutex<()>,
    tombstone_retention: RwLock<Duration>,
    /// Table → ids of the `afterCommit` wake-up markers a change to it
    /// upserts (#1851, `crate::after_commit_wake`). Empty unless the server
    /// turned the hook on.
    pub(crate) wakes: RwLock<HashMap<String, Vec<String>>>,
}

impl Default for ChangeLog {
    fn default() -> Self {
        Self {
            lock: Mutex::new(()),
            tombstone_retention: RwLock::new(DEFAULT_TOMBSTONE_RETENTION),
            wakes: RwLock::new(HashMap::new()),
        }
    }
}

impl ChangeLog {
    pub fn tombstone_retention(&self) -> Duration {
        self.tombstone_retention
            .read()
            .map(|d| *d)
            .unwrap_or(DEFAULT_TOMBSTONE_RETENTION)
    }

    pub fn set_tombstone_retention(&self, retention: Duration) {
        if let Ok(mut guard) = self.tombstone_retention.write() {
            *guard = retention;
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct TableMeta {
    /// Changes when the log is rebuilt; older cursors expire.
    epoch: u64,
    /// The last sequence number handed out. 0 = none yet.
    last: u64,
    /// Highest `seq` of a pruned tombstone. Cursors below it are expired.
    floor: u64,
    /// The one-time enumeration of existing rows ran for this epoch.
    backfilled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredEntry {
    subject: String,
    kind: ChangeKind,
    #[serde(default)]
    version: Option<VersionMap>,
    at: i64,
}

/// A change the write paths want recorded. Built before the lock is taken
/// (it needs reads), staged under it.
#[derive(Debug, Clone)]
pub(crate) enum LogOp {
    Row {
        table: String,
        row: String,
        kind: ChangeKind,
        version: Option<VersionMap>,
    },
    /// The table's rows are now a different set (its `classtype` changed):
    /// drop the log and start a new epoch. The next read backfills.
    Reset { table: String },
    /// The table is gone.
    Drop { table: String },
}

// ---------------------------------------------------------------- keys

fn meta_key(table: &str) -> Vec<u8> {
    [b"m\0", table.as_bytes()].concat()
}
fn entry_prefix(table: &str) -> Vec<u8> {
    [b"e\0", table.as_bytes(), b"\0"].concat()
}
fn entry_key(table: &str, seq: u64) -> Vec<u8> {
    [entry_prefix(table), seq.to_be_bytes().to_vec()].concat()
}
fn row_prefix(table: &str) -> Vec<u8> {
    [b"r\0", table.as_bytes(), b"\0"].concat()
}
fn row_key(table: &str, row: &str) -> Vec<u8> {
    [row_prefix(table), row.as_bytes().to_vec()].concat()
}
fn tomb_prefix(table: &str) -> Vec<u8> {
    [b"d\0", table.as_bytes(), b"\0"].concat()
}
fn tomb_key(table: &str, seq: u64) -> Vec<u8> {
    [tomb_prefix(table), seq.to_be_bytes().to_vec()].concat()
}

fn seq_suffix(key: &[u8], prefix_len: usize) -> Option<u64> {
    let bytes: [u8; 8] = key.get(prefix_len..prefix_len + 8)?.try_into().ok()?;
    Some(u64::from_be_bytes(bytes))
}

/// The end of a prefix range: the prefix with its last byte incremented.
/// All our prefixes end in `\0`, so this is safe.
fn prefix_end(prefix: &[u8]) -> Vec<u8> {
    let mut end = prefix.to_vec();
    if let Some(last) = end.last_mut() {
        *last += 1;
    }
    end
}

// ------------------------------------------------------------- cursors

#[derive(Serialize, Deserialize)]
struct CursorData {
    v: u8,
    t: String,
    e: u64,
    s: u64,
    #[serde(default)]
    f: bool,
}

fn encode_cursor(table: &str, epoch: u64, seq: u64, full: bool) -> String {
    let data = CursorData {
        v: CURSOR_VERSION,
        t: table.to_string(),
        e: epoch,
        s: seq,
        f: full,
    };
    let json = serde_json::to_vec(&data).expect("cursor serializes");
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(json)
}

fn decode_cursor(cursor: &str) -> Result<CursorData, ChangeListError> {
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(cursor.trim())
        .map_err(|_| ChangeListError::InvalidCursor("not base64url".into()))?;
    let data: CursorData = serde_json::from_slice(&bytes)
        .map_err(|_| ChangeListError::InvalidCursor("unreadable".into()))?;
    if data.v != CURSOR_VERSION {
        // A cursor from another format version: the client must resync.
        return Err(ChangeListError::CursorExpired);
    }
    Ok(data)
}

// ------------------------------------------------------ membership rules

impl Db {
    /// The key a subject is stored under here: normalized against this
    /// node's base domain, then its pure id. Rows, tables and classes are
    /// compared in this one spelling.
    pub(crate) fn canonical_id(&self, subject: &str) -> String {
        self.normalize_subject(&Subject::from(subject)).pure_id()
    }

    fn subjects_of(&self, propvals: &PropVals, prop: &str) -> Vec<String> {
        match propvals.get(prop) {
            Some(v) => v
                .to_subjects(None)
                .unwrap_or_default()
                .iter()
                .map(|s| self.canonical_id(s))
                .collect(),
            None => vec![],
        }
    }

    /// The classtype a table's rows have, if `propvals` describe a table.
    pub(crate) fn table_class_of(&self, propvals: &PropVals) -> Option<String> {
        let table_class = self.canonical_id(urls::TABLE);
        if !self
            .subjects_of(propvals, urls::IS_A)
            .contains(&table_class)
        {
            return None;
        }
        let class = propvals.get(urls::CLASSTYPE_PROP)?.to_string();
        if class.is_empty() {
            return None;
        }
        Some(self.canonical_id(&class))
    }
}

impl Db {
    /// The table (pure id) `propvals` is a row of, if any. Reads the parent.
    pub(crate) fn row_table_of(&self, propvals: &PropVals) -> Option<String> {
        // Cheap checks first: most resources are not rows of anything.
        let classes = self.subjects_of(propvals, urls::IS_A);
        if classes.is_empty() {
            return None;
        }
        let parent = propvals.get(urls::PARENT)?.to_string();
        let parent = self.canonical_id(&parent);
        let (_, parent_props) = self.get_propvals_canonical(&parent).ok()?;
        let class = self.table_class_of(&parent_props)?;
        classes.contains(&class).then_some(parent)
    }

    /// Log ops for a resource going from `old` to `new` (either may be
    /// `None` for create / remove). `version` is `new`'s Loro version, or
    /// `old`'s when `new` is `None`.
    pub(crate) fn change_log_ops(
        &self,
        old: Option<&PropVals>,
        new: Option<&PropVals>,
        row: &str,
        version: Option<VersionMap>,
    ) -> Vec<LogOp> {
        let mut ops = Vec::new();
        let old_table = old.and_then(|p| self.row_table_of(p));
        let new_table = new.and_then(|p| self.row_table_of(p));
        match (old_table, new_table) {
            (None, None) => {}
            (None, Some(t)) => ops.push(LogOp::Row {
                table: t,
                row: row.to_string(),
                kind: ChangeKind::Created,
                version,
            }),
            (Some(t), None) => ops.push(LogOp::Row {
                table: t,
                row: row.to_string(),
                kind: ChangeKind::Deleted,
                version,
            }),
            (Some(a), Some(b)) if a == b => ops.push(LogOp::Row {
                table: a,
                row: row.to_string(),
                kind: ChangeKind::Updated,
                version,
            }),
            (Some(a), Some(b)) => {
                ops.push(LogOp::Row {
                    table: a,
                    row: row.to_string(),
                    kind: ChangeKind::Deleted,
                    version: version.clone(),
                });
                ops.push(LogOp::Row {
                    table: b,
                    row: row.to_string(),
                    kind: ChangeKind::Created,
                    version,
                });
            }
        }
        // The resource may itself be a table whose row definition changed.
        let old_class = old.and_then(|p| self.table_class_of(p));
        let new_class = new.and_then(|p| self.table_class_of(p));
        match (old_class, new_class) {
            (Some(a), Some(b)) if a != b => ops.push(LogOp::Reset {
                table: row.to_string(),
            }),
            (Some(_), None) => ops.push(LogOp::Drop {
                table: row.to_string(),
            }),
            _ => {}
        }
        ops
    }

    /// Log ops for subjects a destroy removed (the resource and cascaded
    /// children). Must run before the removal is applied: it reads them.
    pub(crate) fn change_log_ops_for_removed<'a>(
        &self,
        removed: impl IntoIterator<Item = &'a Subject>,
    ) -> Vec<LogOp> {
        let removed: Vec<String> = removed
            .into_iter()
            .map(|s| self.canonical_id(s.as_str()))
            .collect();
        let gone: HashSet<&str> = removed.iter().map(String::as_str).collect();
        let mut ops = Vec::new();
        for subject in &removed {
            let Ok((_, props)) = self.get_propvals_canonical(subject) else {
                continue;
            };
            if self.table_class_of(&props).is_some() {
                ops.push(LogOp::Drop {
                    table: subject.clone(),
                });
            }
            if let Some(table) = self.row_table_of(&props) {
                // Rows of a table destroyed in the same cascade: the whole
                // log goes, there is nobody to tell.
                if gone.contains(table.as_str()) {
                    continue;
                }
                ops.push(LogOp::Row {
                    table,
                    row: subject.clone(),
                    kind: ChangeKind::Deleted,
                    version: self.stored_version(subject),
                });
            }
        }
        ops
    }

    /// The Loro version of the snapshot stored for `subject`.
    pub(crate) fn stored_version(&self, subject: &str) -> Option<VersionMap> {
        let bytes = self.get_loro_snapshot_bytes(subject)?;
        version_of_snapshot(&bytes)
    }

    fn read_meta(&self, table: &str) -> AtomicResult<Option<TableMeta>> {
        match self.kv.get(Tree::TableChanges, &meta_key(table))? {
            Some(bytes) => Ok(Some(serde_json::from_slice(&bytes).map_err(|e| {
                AtomicError::from(format!("Corrupt table change meta for {table}: {e}"))
            })?)),
            None => Ok(None),
        }
    }

    /// Queue the writes for `ops` into `tx`. Call with [`ChangeLog::lock`]
    /// held, and keep it held until `tx` is applied.
    pub(crate) fn stage_change_log(&self, ops: &[LogOp], tx: &mut Transaction) -> AtomicResult<()> {
        if ops.is_empty() {
            return Ok(());
        }
        // Wake-up markers of plugins following these tables (#1851), in the
        // same transaction as the entries they announce.
        self.stage_after_commit_wakes(ops, tx)?;
        let now = crate::utils::now();
        let mut metas: HashMap<String, TableMeta> = HashMap::new();
        // Rows staged in this batch: their `r` key in the kv is stale.
        let mut staged_rows: HashMap<(String, String), u64> = HashMap::new();
        let mut dropped: HashSet<String> = HashSet::new();

        for op in ops {
            match op {
                LogOp::Drop { table } | LogOp::Reset { table } => {
                    self.clear_table_log(table, tx);
                    metas.remove(table);
                    staged_rows.retain(|(t, _), _| t != table);
                    if matches!(op, LogOp::Drop { .. }) {
                        dropped.insert(table.clone());
                        tx.push(Operation {
                            tree: Tree::TableChanges,
                            method: Method::Delete,
                            key: meta_key(table),
                            val: None,
                        });
                    } else {
                        let old_epoch = self.read_meta(table)?.map(|m| m.epoch).unwrap_or(0);
                        metas.insert(
                            table.clone(),
                            TableMeta {
                                epoch: (old_epoch + 1).max(now as u64),
                                ..Default::default()
                            },
                        );
                        // Entries in the kv are being cleared: treat every
                        // row as having none.
                        dropped.remove(table);
                    }
                }
                LogOp::Row {
                    table,
                    row,
                    kind,
                    version,
                } => {
                    if dropped.contains(table) {
                        continue;
                    }
                    if !metas.contains_key(table) {
                        let meta = match self.read_meta(table)? {
                            Some(m) => m,
                            None => TableMeta {
                                epoch: now as u64,
                                ..Default::default()
                            },
                        };
                        metas.insert(table.clone(), meta);
                    }
                    let meta = metas.get_mut(table).expect("inserted above");
                    // A reset in this batch cleared the kv entries; don't
                    // look them up.
                    let reset_here = ops
                        .iter()
                        .any(|o| matches!(o, LogOp::Reset { table: t } if t == table));
                    let previous = match staged_rows.get(&(table.clone(), row.clone())) {
                        Some(seq) => Some(*seq),
                        None if reset_here => None,
                        None => self
                            .kv
                            .get(Tree::TableChanges, &row_key(table, row))?
                            .and_then(|b| {
                                <[u8; 8]>::try_from(b.as_slice())
                                    .ok()
                                    .map(u64::from_be_bytes)
                            }),
                    };
                    if let Some(prev) = previous {
                        tx.push(delete(entry_key(table, prev)));
                        tx.push(delete(tomb_key(table, prev)));
                    }
                    meta.last += 1;
                    let seq = meta.last;
                    let entry = StoredEntry {
                        subject: row.clone(),
                        kind: *kind,
                        version: version.clone(),
                        at: now,
                    };
                    tx.push(insert(entry_key(table, seq), serde_json::to_vec(&entry)?));
                    tx.push(insert(row_key(table, row), seq.to_be_bytes().to_vec()));
                    if *kind == ChangeKind::Deleted {
                        tx.push(insert(tomb_key(table, seq), now.to_be_bytes().to_vec()));
                    }
                    staged_rows.insert((table.clone(), row.clone()), seq);
                }
            }
        }
        for (table, meta) in metas {
            tx.push(insert(meta_key(&table), serde_json::to_vec(&meta)?));
        }
        Ok(())
    }

    fn clear_table_log(&self, table: &str, tx: &mut Transaction) {
        for prefix in [entry_prefix(table), row_prefix(table), tomb_prefix(table)] {
            for (key, _) in self.kv.scan_prefix(Tree::TableChanges, &prefix).flatten() {
                tx.push(delete(key.to_vec()));
            }
        }
    }

    /// Stage `ops` and apply them together with `tx` as one transaction,
    /// under the change-log lock.
    pub(crate) fn apply_with_change_log(
        &self,
        ops: &[LogOp],
        tx: &mut Transaction,
        source_id: Option<&str>,
    ) -> AtomicResult<()> {
        if ops.is_empty() {
            return self.apply_transaction_with_source(tx, source_id);
        }
        let _guard = self
            .change_log
            .lock
            .lock()
            .map_err(|_| AtomicError::from("change log lock poisoned"))?;
        self.stage_change_log(ops, tx)?;
        self.apply_transaction_with_source(tx, source_id)
    }

    /// How long tombstones are kept.
    pub fn table_change_retention(&self) -> Duration {
        self.change_log.tombstone_retention()
    }

    /// Set how long tombstones are kept. Takes effect on the next read.
    pub fn set_table_change_retention(&self, retention: Duration) {
        self.change_log.set_tombstone_retention(retention)
    }

    /// Remove tombstones older than the retention window and raise the
    /// floor. Call with the lock held.
    fn prune_tombstones(&self, table: &str, meta: &mut TableMeta) -> AtomicResult<bool> {
        let retention = self.table_change_retention().as_millis() as i64;
        let cutoff = crate::utils::now().saturating_sub(retention);
        let prefix = tomb_prefix(table);
        let mut tx: Transaction = Vec::new();
        for item in self.kv.scan_prefix(Tree::TableChanges, &prefix) {
            let (key, val) = item?;
            let at = <[u8; 8]>::try_from(val.as_ref())
                .map(i64::from_be_bytes)
                .unwrap_or(i64::MIN);
            // Entries are in `seq` order, which is recording order, so `at`
            // only grows. Stop at the first one still inside the window.
            if at > cutoff {
                break;
            }
            let Some(seq) = seq_suffix(&key, prefix.len()) else {
                continue;
            };
            if let Some(bytes) = self.kv.get(Tree::TableChanges, &entry_key(table, seq))? {
                if let Ok(entry) = serde_json::from_slice::<StoredEntry>(&bytes) {
                    tx.push(delete(row_key(table, &entry.subject)));
                }
            }
            tx.push(delete(entry_key(table, seq)));
            tx.push(delete(key.to_vec()));
            meta.floor = meta.floor.max(seq);
        }
        if tx.is_empty() {
            return Ok(false);
        }
        tx.push(insert(meta_key(table), serde_json::to_vec(&meta)?));
        self.apply_transaction_with_source(&mut tx, None)?;
        Ok(true)
    }

    /// Write `created` entries for current rows that have none, and mark the
    /// table backfilled. `rows` was enumerated before the lock was taken.
    fn backfill(
        &self,
        table: &str,
        class: &str,
        rows: Vec<(String, Option<VersionMap>)>,
    ) -> AtomicResult<()> {
        let _guard = self
            .change_log
            .lock
            .lock()
            .map_err(|_| AtomicError::from("change log lock poisoned"))?;
        // The rows were enumerated for this classtype. If it changed since,
        // the reset that came with it wins; the next read backfills again.
        let (_, props) = self.get_propvals_canonical(table)?;
        if self.table_class_of(&props).as_deref() != Some(class) {
            return Ok(());
        }
        let mut meta = self.read_meta(table)?.unwrap_or(TableMeta {
            epoch: crate::utils::now() as u64,
            ..Default::default()
        });
        if meta.backfilled {
            return Ok(());
        }
        let now = crate::utils::now();
        let mut tx: Transaction = Vec::new();
        for (row, version) in rows {
            if self
                .kv
                .contains_key(Tree::TableChanges, &row_key(table, &row))?
            {
                continue;
            }
            meta.last += 1;
            let entry = StoredEntry {
                subject: row.clone(),
                kind: ChangeKind::Created,
                version,
                at: now,
            };
            tx.push(insert(
                entry_key(table, meta.last),
                serde_json::to_vec(&entry)?,
            ));
            tx.push(insert(
                row_key(table, &row),
                meta.last.to_be_bytes().to_vec(),
            ));
        }
        meta.backfilled = true;
        tx.push(insert(meta_key(table), serde_json::to_vec(&meta)?));
        self.apply_transaction_with_source(&mut tx, None)
    }
}

fn insert(key: Vec<u8>, val: Vec<u8>) -> Operation {
    Operation {
        tree: Tree::TableChanges,
        method: Method::Insert,
        key,
        val: Some(val),
    }
}

fn delete(key: Vec<u8>) -> Operation {
    Operation {
        tree: Tree::TableChanges,
        method: Method::Delete,
        key,
        val: None,
    }
}

pub(crate) fn version_map(vv: &loro::VersionVector) -> VersionMap {
    vv.iter()
        .map(|(peer, counter)| (peer.to_string(), *counter))
        .collect()
}

/// The oplog version of a Loro snapshot, read from its header.
pub(crate) fn version_of_snapshot(bytes: &[u8]) -> Option<VersionMap> {
    if bytes.is_empty() {
        return None;
    }
    let meta = loro::LoroDoc::decode_import_blob_meta(bytes, false).ok()?;
    Some(version_map(&meta.partial_end_vv))
}

/// Rows changed in `table` since `since`, at most `limit` entries (bounded
/// by [`MAX_PAGE_SIZE`]).
///
/// Rights: `for_agent` must be able to read the table, else the error says
/// so and no subject is revealed. Each live row is also checked for read;
/// one the agent cannot read is left out of the page (the cursor still
/// moves past it). Tombstones are shown to anyone who can read the table:
/// the row no longer exists here to check, and while it was a row, the
/// table's readers could read it (rights are inherited from the parent).
///
/// `since: None` lists everything: every current row, plus the tombstones
/// still retained (a client that has nothing ignores those).
pub async fn table_changes(
    store: &Db,
    table: &Subject,
    since: Option<&str>,
    limit: Option<usize>,
    for_agent: &ForAgent,
) -> Result<ChangePage, ChangeListError> {
    let limit = limit.unwrap_or(DEFAULT_PAGE_SIZE).clamp(1, MAX_PAGE_SIZE);
    let table_resource = store.get_resource(table).await?;
    crate::hierarchy::check_read(store, &table_resource, for_agent).await?;
    let table_id = store.canonical_id(table.as_str());
    let class = store
        .table_class_of(table_resource.get_propvals())
        .ok_or(ChangeListError::NotATable)?;

    // Decode first: a malformed cursor should not cost a backfill.
    let cursor = since.map(decode_cursor).transpose()?;
    if let Some(c) = &cursor {
        if c.t != table_id {
            return Err(ChangeListError::InvalidCursor(
                "issued for another table".into(),
            ));
        }
    }

    if !store.read_meta(&table_id)?.is_some_and(|m| m.backfilled) {
        let mut rows = Vec::new();
        for child in table_resource.get_children(store).await? {
            let classes = store.subjects_of(child.get_propvals(), urls::IS_A);
            if classes.contains(&class) {
                let id = store.canonical_id(child.get_subject().as_str());
                let version = store.stored_version(&id);
                rows.push((id, version));
            }
        }
        store.backfill(&table_id, &class, rows)?;
    }

    let meta = {
        let _guard = store
            .change_log
            .lock
            .lock()
            .map_err(|_| AtomicError::from("change log lock poisoned"))?;
        let mut meta = store.read_meta(&table_id)?.unwrap_or_default();
        store.prune_tombstones(&table_id, &mut meta)?;
        meta
    };

    let (after, full) = match &cursor {
        None => (0, true),
        Some(c) => {
            if c.e != meta.epoch {
                return Err(ChangeListError::CursorExpired);
            }
            if c.s > meta.last {
                return Err(ChangeListError::InvalidCursor("from the future".into()));
            }
            // A first listing already skips nothing it needs: tombstones of
            // rows it never had are noise to it. Only a cursor that has seen
            // rows can have missed a pruned deletion.
            if !c.f && c.s < meta.floor {
                return Err(ChangeListError::CursorExpired);
            }
            (c.s, c.f)
        }
    };

    let prefix = entry_prefix(&table_id);
    let start = entry_key(&table_id, after.saturating_add(1));
    let rows = store
        .kv
        .range_page(Tree::TableChanges, start, prefix_end(&prefix), limit + 1)?;
    let has_more = rows.len() > limit;

    let rights_cache = std::sync::Mutex::new(crate::hierarchy::RightsCache::default());
    let mut changes = Vec::new();
    let mut last_seen = after;
    for (key, val) in rows.into_iter().take(limit) {
        let Some(seq) = seq_suffix(&key, prefix.len()) else {
            continue;
        };
        last_seen = seq;
        let entry: StoredEntry = serde_json::from_slice(&val)
            .map_err(|e| AtomicError::from(format!("Corrupt table change entry: {e}")))?;
        if entry.kind != ChangeKind::Deleted {
            let Ok(row) = store
                .get_resource(&Subject::from(entry.subject.as_str()))
                .await
            else {
                // Removed after this page's read; its tombstone follows.
                continue;
            };
            if crate::hierarchy::check_rights_cached(
                store,
                &row,
                for_agent,
                crate::hierarchy::Right::Read,
                Some(&rights_cache),
            )
            .await
            .is_err()
            {
                continue;
            }
        }
        changes.push(TableChange {
            subject: entry.subject,
            kind: entry.kind,
            version: entry.version,
            at: entry.at,
        });
    }

    let cursor = if has_more {
        encode_cursor(&table_id, meta.epoch, last_seen, full)
    } else {
        // Caught up: everything up to the last seq handed out has been
        // scanned, which also lifts a first listing to a normal cursor.
        encode_cursor(&table_id, meta.epoch, meta.last.max(last_seen), false)
    };
    Ok(ChangePage {
        changes,
        cursor,
        has_more,
    })
}

/// A cursor at the head of `table`'s change list: reading from it returns
/// only changes made after this call. Runs the one-time backfill first, so
/// rows that predate the log are behind the head rather than ahead of it.
/// Same rights as [`table_changes`].
pub async fn table_changes_head(
    store: &Db,
    table: &Subject,
    for_agent: &ForAgent,
) -> Result<String, ChangeListError> {
    let table_resource = store.get_resource(table).await?;
    crate::hierarchy::check_read(store, &table_resource, for_agent).await?;
    let table_id = store.canonical_id(table.as_str());
    let class = store
        .table_class_of(table_resource.get_propvals())
        .ok_or(ChangeListError::NotATable)?;
    if !store.read_meta(&table_id)?.is_some_and(|m| m.backfilled) {
        let mut rows = Vec::new();
        for child in table_resource.get_children(store).await? {
            let classes = store.subjects_of(child.get_propvals(), urls::IS_A);
            if classes.contains(&class) {
                let id = store.canonical_id(child.get_subject().as_str());
                let version = store.stored_version(&id);
                rows.push((id, version));
            }
        }
        store.backfill(&table_id, &class, rows)?;
    }
    let _guard = store
        .change_log
        .lock
        .lock()
        .map_err(|_| AtomicError::from("change log lock poisoned"))?;
    let meta = store.read_meta(&table_id)?.unwrap_or_default();
    Ok(encode_cursor(&table_id, meta.epoch, meta.last, false))
}

#[cfg(test)]
#[path = "change_log_test.rs"]
mod tests;
