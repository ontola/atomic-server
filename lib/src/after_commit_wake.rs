//! Wake-up markers for the durable plugin `afterCommit` hook (#1851).
//!
//! A plugin whose view is installed on a table is told when rows of that
//! table change. The server's plugin layer owns the subscriptions; this crate
//! only needs to know, per table, which markers to touch. It is told with
//! [`Db::set_after_commit_index`], and from then on every change-list entry
//! for such a table also upserts the subscription's marker **in the same
//! transaction** (`stage_change_log`). So a commit, a synced resource, an
//! import or a sync removal wakes the plugin, and a crash can never keep the
//! change but lose the wake-up.
//!
//! A marker carries no correctness: the change list and the subscription's
//! cursor do. It only says "something changed since the last claim", so the
//! worker does not have to poll every table. A lost marker is recovered by
//! the plugin layer's periodic sweep, which compares cursors with the head.
//!
//! Keys, in `Tree::PluginMeta`: `after-commit/v1/wake/{id}` where `id` is the
//! subscription's key hash, opaque here.

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};

use crate::change_log::LogOp;
use crate::db::trees::{Method, Operation, Transaction, Tree};
use crate::errors::{AtomicError, AtomicResult};
use crate::Db;

/// Prefix of every wake-up marker.
pub const WAKE_PREFIX: &str = "after-commit/v1/wake/";

/// How many row subjects a marker keeps, for display only.
const HINT_LIMIT: usize = 20;

/// "Rows of the subscribed table changed since the last claim."
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Wake {
    /// First change since the last claim, ms since the epoch.
    pub first_at: i64,
    /// Latest change.
    pub last_at: i64,
    /// Changes coalesced into this marker (saturating).
    pub count: u32,
    /// Up to 20 changed rows, for health display. Not a delivery list.
    #[serde(default)]
    pub hint: Vec<String>,
}

impl Wake {
    fn touch(&mut self, now: i64, row: Option<&str>) {
        if self.count == 0 {
            self.first_at = now;
        }
        self.last_at = now;
        self.count = self.count.saturating_add(1);
        if let Some(row) = row {
            if self.hint.len() < HINT_LIMIT && !self.hint.iter().any(|h| h == row) {
                self.hint.push(row.to_string());
            }
        }
    }
}

fn wake_key(id: &str) -> Vec<u8> {
    format!("{WAKE_PREFIX}{id}").into_bytes()
}

impl Db {
    /// Replace the table → marker index. `tables` maps a table (any spelling;
    /// it is normalized the way the change list keys tables) to the ids of the
    /// markers a change to it wakes. `None` turns the hook off on this store
    /// (the default): no marker is ever written.
    pub fn set_after_commit_index(&self, tables: Option<HashMap<String, Vec<String>>>) {
        let normalized = tables.map(|tables| {
            tables
                .into_iter()
                .map(|(table, ids)| (self.canonical_id(&table), ids))
                .collect::<HashMap<String, Vec<String>>>()
        });
        if let Ok(mut guard) = self.change_log.wakes.write() {
            *guard = normalized;
        }
    }

    /// Whether the server turned the `afterCommit` hook on for this store.
    pub fn after_commit_enabled(&self) -> bool {
        self.change_log
            .wakes
            .read()
            .map(|guard| guard.is_some())
            .unwrap_or(false)
    }

    /// The table key the change list uses for `subject`.
    pub fn change_list_table_key(&self, subject: &str) -> String {
        self.canonical_id(subject)
    }

    /// Stage marker upserts for every subscribed table `ops` touch. Called by
    /// `stage_change_log`, under the change-log lock.
    pub(crate) fn stage_after_commit_wakes(
        &self,
        ops: &[LogOp],
        tx: &mut Transaction,
    ) -> AtomicResult<()> {
        let index = match self.change_log.wakes.read() {
            Ok(guard) => match guard.as_ref() {
                Some(index) if !index.is_empty() => index.clone(),
                _ => return Ok(()),
            },
            Err(_) => return Ok(()),
        };
        let now = crate::utils::now();
        let mut staged: HashMap<String, Wake> = HashMap::new();
        for op in ops {
            let (table, row) = match op {
                LogOp::Row { table, row, .. } => (table, Some(row.as_str())),
                LogOp::Reset { table } | LogOp::Drop { table } => (table, None),
            };
            let Some(ids) = index.get(table) else {
                continue;
            };
            for id in ids {
                if !staged.contains_key(id) {
                    let existing = self.read_wake(id)?.unwrap_or_default();
                    staged.insert(id.clone(), existing);
                }
                staged.get_mut(id).expect("inserted above").touch(now, row);
            }
        }
        for (id, wake) in staged {
            tx.push(Operation {
                tree: Tree::PluginMeta,
                method: Method::Insert,
                key: wake_key(&id),
                val: Some(serde_json::to_vec(&wake)?),
            });
        }
        Ok(())
    }

    fn read_wake(&self, id: &str) -> AtomicResult<Option<Wake>> {
        match self.kv.get(Tree::PluginMeta, &wake_key(id))? {
            Some(bytes) => Ok(serde_json::from_slice(&bytes).ok()),
            None => Ok(None),
        }
    }

    /// The marker `id`, if one is waiting.
    pub fn after_commit_wake(&self, id: &str) -> AtomicResult<Option<Wake>> {
        self.read_wake(id)
    }

    /// Every waiting marker, by id.
    pub fn after_commit_wakes(&self) -> AtomicResult<Vec<(String, Wake)>> {
        let mut found = Vec::new();
        for row in self
            .kv
            .scan_prefix(Tree::PluginMeta, WAKE_PREFIX.as_bytes())
        {
            let (key, val) = row?;
            let Some(id) = key.get(WAKE_PREFIX.len()..) else {
                continue;
            };
            let Ok(id) = std::str::from_utf8(id) else {
                continue;
            };
            if let Ok(wake) = serde_json::from_slice::<Wake>(&val) {
                found.push((id.to_string(), wake));
            }
        }
        Ok(found)
    }

    /// Upsert marker `id` outside a commit: a `hasMore` continuation, a sweep
    /// that found a cursor behind the head, or a proposal that was answered.
    /// Serialized with commit-time upserts by the change-log lock.
    pub fn wake_after_commit(&self, id: &str) -> AtomicResult<()> {
        let _guard = self
            .change_log
            .lock
            .lock()
            .map_err(|_| AtomicError::from("change log lock poisoned"))?;
        let mut wake = self.read_wake(id)?.unwrap_or_default();
        wake.touch(crate::utils::now(), None);
        self.kv
            .insert(Tree::PluginMeta, &wake_key(id), &serde_json::to_vec(&wake)?)?;
        self.flush()
    }

    /// Remove marker `id` and return what it held. Serialized with commit-time
    /// upserts, so a change that lands after this writes a fresh marker and a
    /// change that landed before is in the change list the caller reads next.
    pub fn claim_after_commit_wake(&self, id: &str) -> AtomicResult<Option<Wake>> {
        let _guard = self
            .change_log
            .lock
            .lock()
            .map_err(|_| AtomicError::from("change log lock poisoned"))?;
        let wake = self.read_wake(id)?;
        if wake.is_some() {
            self.kv.remove(Tree::PluginMeta, &wake_key(id))?;
            self.flush()?;
        }
        Ok(wake)
    }

    /// Drop the markers of these ids (a subscription ended).
    pub fn drop_after_commit_wakes(&self, ids: &HashSet<String>) -> AtomicResult<()> {
        for id in ids {
            self.kv.remove(Tree::PluginMeta, &wake_key(id))?;
        }
        Ok(())
    }

    /// The Loro version of the snapshot stored for `subject`, as the change
    /// list reports versions.
    pub fn stored_loro_version(&self, subject: &str) -> Option<crate::change_log::VersionMap> {
        self.stored_version(&self.canonical_id(subject))
    }
}
