//! Serialises writers that read-modify-write a single subject's state.
//!
//! Persisting a resource is a read-modify-write: read the stored Loro snapshot,
//! apply something to it, write the result back. The write is a *replace*, and
//! two writers doing that concurrently lose each other's work — the second to
//! write wins wholesale. A local commit racing a peer's update lost roughly a
//! third of all operations before this existed
//! (`lib/tests/concurrent_commit_and_peer_apply.rs`).
//!
//! The lock is per subject, so writes to different resources still run in
//! parallel; only the writers that would actually clobber each other wait.
//! Replace semantics are deliberately preserved rather than changed to a merge:
//! a Loro import never removes operations, so a history checkout can *only* be
//! expressed by replacing the stored snapshot. Merging would silently turn
//! every rollback into a no-op.
//!
//! The registry belongs to a [`crate::Db`] rather than being global, so two
//! independent stores never wait on each other. They otherwise would: subjects
//! seeded by `populate()` are well-known URLs, identical in every store, so a
//! global registry would couple unrelated stores — including unrelated tests
//! sharing a process — through locks they have no reason to share.
//!
//! **Invariant for callers:** do not acquire a subject's lock while already
//! holding it. In particular a `before_commit` class extender must not commit
//! the subject whose commit it is inspecting — that would deadlock the write
//! path, since `before_commit` handlers run before `Db::apply_commit` releases
//! its guard. `after_commit` handlers run *after* the guard is released
//! precisely so they're exempt from this: a plugin's `after_commit` may issue
//! its own follow-up commit to the same subject (`atomic_plugin::commit`, via
//! the `commit` host function in `server/src/plugins/wasm.rs`) without
//! deadlocking, because by then there is nothing left to re-enter.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use tokio::sync::{Mutex as AsyncMutex, OwnedMutexGuard};

/// Above this many entries, drop the ones nobody is using before adding more.
/// Without it the registry grows by one entry per subject ever written, which
/// on a long-lived server is a slow leak.
const PRUNE_THRESHOLD: usize = 1024;

/// One store's per-subject write locks. Cheap to clone — every clone of a
/// [`crate::Db`] shares the same registry, which is what makes the exclusion
/// hold across the clones a server hands out per connection.
#[derive(Clone, Default)]
pub(crate) struct SubjectLocks {
    entries: Arc<Mutex<HashMap<String, Arc<AsyncMutex<()>>>>>,
}

impl SubjectLocks {
    /// Wait for exclusive access to `subject_key`, which must be a
    /// [`crate::Subject::pure_id`] so every writer agrees on the name.
    ///
    /// Hold the guard across the whole read-modify-write, not just the write.
    pub(crate) async fn lock(&self, subject_key: &str) -> OwnedMutexGuard<()> {
        let entry = {
            let mut map = self
                .entries
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());

            if map.len() > PRUNE_THRESHOLD {
                // Only the registry holds it, so nobody is waiting on or using
                // it — checked while holding the registry lock that every
                // acquirer must also take to clone one, so this cannot race an
                // acquisition.
                map.retain(|_, lock| Arc::strong_count(lock) > 1);
            }

            map.entry(subject_key.to_string())
                .or_insert_with(|| Arc::new(AsyncMutex::new(())))
                .clone()
        };

        entry.lock_owned().await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn blocks(locks: &SubjectLocks, key: &str) -> bool {
        tokio::time::timeout(std::time::Duration::from_millis(50), locks.lock(key))
            .await
            .is_err()
    }

    #[tokio::test]
    async fn the_same_subject_is_exclusive() {
        let locks = SubjectLocks::default();
        let held = locks.lock("did:ad:one").await;

        assert!(
            blocks(&locks, "did:ad:one").await,
            "the same subject must serialise"
        );

        drop(held);
        assert!(
            !blocks(&locks, "did:ad:one").await,
            "releasing must let the next writer in"
        );
    }

    #[tokio::test]
    async fn different_subjects_do_not_block_each_other() {
        let locks = SubjectLocks::default();
        let _one = locks.lock("did:ad:alpha").await;

        assert!(
            !blocks(&locks, "did:ad:beta").await,
            "writes to unrelated resources must still run in parallel"
        );
    }

    /// The reason this is per store rather than global: `populate()` seeds
    /// well-known subjects that are identical in every store, so a shared
    /// registry would make unrelated stores — and unrelated tests sharing a
    /// process — wait on each other.
    #[tokio::test]
    async fn separate_stores_never_wait_on_each_other() {
        let one = SubjectLocks::default();
        let two = SubjectLocks::default();

        let _held = one.lock("https://atomicdata.dev/properties/name").await;

        assert!(
            !blocks(&two, "https://atomicdata.dev/properties/name").await,
            "a lock in one store must not block the same subject in another"
        );
    }

    /// The registry must not grow without bound. Entries nobody holds are
    /// dropped once it gets large; entries in use are kept.
    #[tokio::test]
    async fn unused_entries_are_pruned_but_held_ones_survive() {
        let locks = SubjectLocks::default();
        let held = locks.lock("did:ad:kept").await;

        for n in 0..PRUNE_THRESHOLD + 16 {
            drop(locks.lock(&format!("did:ad:transient-{n}")).await);
        }

        let map = locks.entries.lock().unwrap();
        assert!(
            map.len() <= PRUNE_THRESHOLD + 16,
            "the registry should have been pruned, holds {}",
            map.len()
        );
        assert!(
            map.contains_key("did:ad:kept"),
            "a lock still held must never be pruned"
        );
        drop(map);
        drop(held);
    }
}
