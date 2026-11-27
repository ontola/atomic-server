//! A log of which subjects were written, and the cache the sync probe builds on it.
//!
//! A hash-first `SYNC` probe over a drive that did not change used to walk the
//! whole drive just to say "same hash". [`WriteLog`] sits at the KV choke point
//! ([`super::compressed_kv::CompressedKv`]) and records every write to a
//! resource row or snapshot as `(generation, subject)` in a bounded ring.
//! [`ProbeCache`] keeps the last hash per (drive, agent, wire, version) with the
//! generation it was computed at, and re-validates it against the writes since.

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use super::trees::Tree;
use crate::sync::engine::WalkedSubject;

const RING_CAP: usize = 4096;
const CACHE_CAP: usize = 128;
/// How many entries keep their walk (a big drive's is megabytes).
const WALK_CAP: usize = 8;

#[derive(Default)]
struct LogState {
    generation: u64,
    ring: VecDeque<(u64, String)>,
    /// Writes at or below this generation are no longer in the ring.
    floor: u64,
}

/// Monotonic write counter plus the last [`RING_CAP`] written subjects.
#[derive(Default)]
pub struct WriteLog {
    state: Mutex<LogState>,
    blob_generation: AtomicU64,
    blob_writers: AtomicU64,
    confirmation: Mutex<ConfirmationEpoch>,
}

#[derive(Default)]
struct ConfirmationEpoch {
    epoch: u64,
    writers: usize,
}

/// Marks an in-flight KV mutation so a confirmation cannot observe a partial write.
pub(super) struct MutationGuard<'a>(&'a WriteLog);

impl Drop for MutationGuard<'_> {
    fn drop(&mut self) {
        if let Ok(mut state) = self.0.confirmation.lock() {
            state.epoch = state.epoch.wrapping_add(1);
            state.writers -= 1;
        }
    }
}

/// The subject a `Tree::Resources` / `Tree::LoroSnapshots` key names, if a
/// write to it can change a drive's inventory. Commit rows never do.
pub(super) fn logged_subject(tree: Tree, key: &[u8]) -> Option<String> {
    if !matches!(tree, Tree::Resources | Tree::LoroSnapshots) {
        return None;
    }
    let key = std::str::from_utf8(key).ok()?;
    if key.starts_with(crate::identifiers::ATOMIC_COMMIT_PREFIX)
        || key.starts_with(crate::identifiers::DID_AD_COMMIT_PREFIX)
    {
        return None;
    }
    Some(key.to_string())
}

/// Marks an in-progress byte mutation, including failed writes and open commits.
pub struct BlobWrite<'a>(&'a WriteLog);
impl Drop for BlobWrite<'_> {
    fn drop(&mut self) {
        self.0.blob_generation.fetch_add(1, Ordering::SeqCst);
        self.0.blob_writers.fetch_sub(1, Ordering::SeqCst);
    }
}
impl WriteLog {
    /// Enter before a KV mutation and leave only after its publication.
    pub(super) fn mutation(&self) -> Option<MutationGuard<'_>> {
        let mut state = self.confirmation.lock().ok()?;
        state.epoch = state.epoch.wrapping_add(1);
        state.writers += 1;
        Some(MutationGuard(self))
    }

    /// An idle epoch suitable for comparing before and after a proof walk.
    /// A poisoned lock or an active writer is never a valid token.
    pub fn confirmation_token(&self) -> Option<u64> {
        let state = self.confirmation.lock().ok()?;
        (state.writers == 0).then_some(state.epoch)
    }

    pub fn blob_generation(&self) -> Option<u64> {
        let generation = self.blob_generation.load(Ordering::SeqCst);
        (self.blob_writers.load(Ordering::SeqCst) == 0).then_some(generation)
    }
    pub fn blob_write(&self, writing: bool) -> Option<BlobWrite<'_>> {
        if !writing {
            return None;
        }
        self.blob_writers.fetch_add(1, Ordering::SeqCst);
        self.blob_generation.fetch_add(1, Ordering::SeqCst);
        Some(BlobWrite(self))
    }

    pub fn generation(&self) -> u64 {
        self.state.lock().map(|s| s.generation).unwrap_or(0)
    }

    /// Log writes that have already succeeded.
    pub fn record(&self, subjects: impl IntoIterator<Item = String>) {
        let Ok(mut s) = self.state.lock() else { return };
        for subject in subjects {
            s.generation += 1;
            let generation = s.generation;
            s.ring.push_back((generation, subject));
            if s.ring.len() > RING_CAP {
                if let Some((dropped, _)) = s.ring.pop_front() {
                    s.floor = dropped;
                }
            }
        }
    }

    /// A whole tree changed at once: nothing cached before this is trusted.
    pub fn invalidate_all(&self) {
        let Ok(mut s) = self.state.lock() else { return };
        s.generation += 1;
        s.floor = s.generation;
        s.ring.clear();
    }

    /// Subjects written after `generation`, or `None` if the ring no longer
    /// reaches back that far.
    fn since(&self, generation: u64) -> Option<(u64, Vec<String>)> {
        let s = self.state.lock().ok()?;
        if generation < s.floor {
            return None;
        }
        let written = s
            .ring
            .iter()
            .filter(|(g, _)| *g > generation)
            .map(|(_, subject)| subject.clone())
            .collect();
        Some((s.generation, written))
    }
}

#[derive(Clone, PartialEq, Eq, Hash)]
pub struct ProbeKey {
    pub drive: String,
    pub agent: String,
    pub wire: crate::sync::engine::WireScheme,
    pub hash_version: u8,
}

struct ProbeEntry {
    generation: u64,
    hash: String,
    /// Every subject the walk found under the drive (readable or not).
    subjects: HashSet<String>,
    /// Subjects outside the drive that the read decision consulted: the
    /// drive root's ancestors and the `drive` stamps of its resources.
    externals: HashSet<String>,
    /// The walk's result, kept for the reconcile that follows a probe miss.
    /// Only the newest [`WALK_CAP`] entries hold one.
    walked: Option<Arc<Vec<WalkedSubject>>>,
}

#[derive(Default)]
struct Entries {
    map: HashMap<ProbeKey, ProbeEntry>,
    order: VecDeque<ProbeKey>,
}

#[derive(Default)]
pub struct ProbeCache {
    entries: Mutex<Entries>,
    hits: AtomicU64,
}

impl ProbeCache {
    /// How many probes were served without recomputing.
    pub fn hits(&self) -> u64 {
        self.hits.load(Ordering::Relaxed)
    }

    #[cfg(test)]
    pub fn clear(&self) {
        if let Ok(mut entries) = self.entries.lock() {
            *entries = Entries::default();
        }
    }

    /// The cached hash if no write since it was computed can have changed it.
    pub fn lookup(
        &self,
        log: &WriteLog,
        key: &ProbeKey,
        parent_of: impl Fn(&str) -> Option<String>,
    ) -> Option<(String, usize)> {
        self.valid(log, key, parent_of, |e| {
            Some((e.hash.clone(), e.subjects.len()))
        })
    }

    /// The walk behind the cached hash, on the same terms as [`Self::lookup`].
    pub fn walked(
        &self,
        log: &WriteLog,
        key: &ProbeKey,
        parent_of: impl Fn(&str) -> Option<String>,
    ) -> Option<Arc<Vec<WalkedSubject>>> {
        self.valid(log, key, parent_of, |e| e.walked.clone())
    }

    /// `read` of the entry if no write since it was computed can have changed
    /// it. A logged subject invalidates when it was in the drive (edited,
    /// moved out, destroyed, rights changed), was consulted for rights, or now
    /// has a parent inside the drive (new child, or a subtree moved in).
    fn valid<T>(
        &self,
        log: &WriteLog,
        key: &ProbeKey,
        parent_of: impl Fn(&str) -> Option<String>,
        read: impl FnOnce(&ProbeEntry) -> Option<T>,
    ) -> Option<T> {
        let mut entries = self.entries.lock().ok()?;
        let entry = entries.map.get_mut(key)?;
        let (now, written) = log.since(entry.generation)?;
        for subject in &written {
            if entry.subjects.contains(subject) || entry.externals.contains(subject) {
                return None;
            }
            if parent_of(subject).is_some_and(|p| entry.subjects.contains(&p)) {
                return None;
            }
        }
        entry.generation = now;
        let found = read(entry)?;
        self.hits.fetch_add(1, Ordering::Relaxed);
        Some(found)
    }

    /// Remember `hash`, computed from reads made after `generation` was read.
    pub fn store(
        &self,
        key: ProbeKey,
        generation: u64,
        hash: String,
        subjects: HashSet<String>,
        externals: HashSet<String>,
        walked: Arc<Vec<WalkedSubject>>,
    ) {
        let Ok(mut entries) = self.entries.lock() else {
            return;
        };
        if entries.map.remove(&key).is_some() {
            entries.order.retain(|k| k != &key);
        }
        while entries.map.len() >= CACHE_CAP {
            match entries.order.pop_front() {
                Some(oldest) => {
                    entries.map.remove(&oldest);
                }
                None => break,
            }
        }
        entries.order.push_back(key.clone());
        entries.map.insert(
            key,
            ProbeEntry {
                generation,
                hash,
                subjects,
                externals,
                walked: Some(walked),
            },
        );
        let stale = entries.order.len().saturating_sub(WALK_CAP);
        let Entries { map, order } = &mut *entries;
        for old in order.iter().take(stale) {
            if let Some(entry) = map.get_mut(old) {
                entry.walked = None;
            }
        }
    }
}

/// The probe-hash cache (`db::write_log`): a repeat probe of an unchanged
/// drive is served from the cache, and every kind of write that could change
/// the answer invalidates it.
#[cfg(test)]
mod tests {
    use crate::db::trees::{Method, Operation, Tree};
    use crate::sync::engine::{drive_sync_hash_for_wire_version, WireScheme};
    use crate::{agents::ForAgent, urls, Db, Storelike, Value};

    async fn probe(db: &Db, drive: &str, agent: &ForAgent) -> Result<String, String> {
        drive_sync_hash_for_wire_version(db, drive, agent, WireScheme::CANONICAL, 2).await
    }

    /// A probe through a brand-new `ProbeCache` state: the ground truth.
    async fn fresh(db: &Db, drive: &str) -> String {
        db.probe_cache().clear();
        probe(db, drive, &ForAgent::Sudo).await.unwrap()
    }

    async fn child(db: &Db, parent: &str, name: &str) -> String {
        let props = vec![
            (urls::DESCRIPTION, Value::Markdown("x".into())),
            (urls::SHORTNAME, Value::Slug(name.into())),
        ];
        db.create_resource(urls::CLASS, parent, name, Some(props))
            .await
            .unwrap()
    }

    async fn edit(db: &Db, subject: &str, text: &str) {
        let mut r = db.get_resource(&subject.into()).await.unwrap();
        r.set(urls::DESCRIPTION.into(), Value::Markdown(text.into()), db)
            .await
            .unwrap();
        r.save_locally(db).await.unwrap();
    }

    async fn reparent(db: &Db, subject: &str, parent: &str) {
        let mut r = db.get_resource(&subject.into()).await.unwrap();
        r.set(urls::PARENT.into(), Value::AtomicUrl(parent.into()), db)
            .await
            .unwrap();
        r.save_locally(db).await.unwrap();
    }

    /// Probe with the cache warm, assert the hash equals a cold computation.
    async fn warm(db: &Db, drive: &str) -> String {
        let hash = probe(db, drive, &ForAgent::Sudo).await.unwrap();
        assert_eq!(hash, fresh(db, drive).await);
        probe(db, drive, &ForAgent::Sudo).await.unwrap()
    }

    #[tokio::test]
    async fn unchanged_drive_is_served_from_cache() {
        let db = Db::init_temp("probe_cache_hit").await.unwrap();
        let (_a, drive) = db.setup("Alice").await.unwrap();
        child(&db, &drive, "one").await;
        let first = probe(&db, &drive, &ForAgent::Sudo).await.unwrap();
        let hits = db.probe_cache().hits();
        assert_eq!(probe(&db, &drive, &ForAgent::Sudo).await.unwrap(), first);
        assert_eq!(db.probe_cache().hits(), hits + 1);
        assert_eq!(fresh(&db, &drive).await, first);
    }

    #[tokio::test]
    async fn editing_a_resource_invalidates() {
        let db = Db::init_temp("probe_cache_edit").await.unwrap();
        let (_a, drive) = db.setup("Alice").await.unwrap();
        let doc = child(&db, &drive, "one").await;
        let before = warm(&db, &drive).await;
        edit(&db, &doc, "changed").await;
        let after = probe(&db, &drive, &ForAgent::Sudo).await.unwrap();
        assert_ne!(before, after);
        assert_eq!(after, fresh(&db, &drive).await);
    }

    #[tokio::test]
    async fn a_new_child_invalidates() {
        let db = Db::init_temp("probe_cache_child").await.unwrap();
        let (_a, drive) = db.setup("Alice").await.unwrap();
        let folder = child(&db, &drive, "folder").await;
        let before = warm(&db, &drive).await;
        child(&db, &folder, "nested").await;
        let after = probe(&db, &drive, &ForAgent::Sudo).await.unwrap();
        assert_ne!(before, after);
        assert_eq!(after, fresh(&db, &drive).await);
    }

    #[tokio::test]
    async fn moving_out_and_in_invalidates() {
        let db = Db::init_temp("probe_cache_move").await.unwrap();
        let (_a, drive) = db.setup("Alice").await.unwrap();
        let other = db.create_drive("Other").await.unwrap();
        let doc = child(&db, &drive, "mover").await;
        let before = warm(&db, &drive).await;
        reparent(&db, &doc, &other).await;
        let out = probe(&db, &drive, &ForAgent::Sudo).await.unwrap();
        assert_ne!(before, out);
        assert_eq!(out, fresh(&db, &drive).await);

        // And back in: the moved resource's parent is now in the drive.
        let before_in = warm(&db, &drive).await;
        reparent(&db, &doc, &drive).await;
        let back = probe(&db, &drive, &ForAgent::Sudo).await.unwrap();
        assert_ne!(before_in, back);
        assert_eq!(back, fresh(&db, &drive).await);
    }

    #[tokio::test]
    async fn a_write_in_another_drive_keeps_the_entry() {
        let db = Db::init_temp("probe_cache_other").await.unwrap();
        let (_a, drive) = db.setup("Alice").await.unwrap();
        let other = db.create_drive("Other").await.unwrap();
        child(&db, &drive, "mine").await;
        let theirs = child(&db, &other, "theirs").await;
        let before = warm(&db, &drive).await;
        let hits = db.probe_cache().hits();
        edit(&db, &theirs, "elsewhere").await;
        child(&db, &other, "more").await;
        assert_eq!(probe(&db, &drive, &ForAgent::Sudo).await.unwrap(), before);
        assert_eq!(db.probe_cache().hits(), hits + 1, "served from cache");
        assert_eq!(fresh(&db, &drive).await, before);
    }

    #[tokio::test]
    async fn ring_overflow_forces_a_recompute() {
        let db = Db::init_temp("probe_cache_overflow").await.unwrap();
        let (_a, drive) = db.setup("Alice").await.unwrap();
        warm(&db, &drive).await;
        let hits = db.probe_cache().hits();
        // Unrelated writes, more than the ring holds.
        db.write_log()
            .record((0..5000).map(|i| format!("did:ad:unrelated{i}")));
        probe(&db, &drive, &ForAgent::Sudo).await.unwrap();
        assert_eq!(db.probe_cache().hits(), hits, "recomputed, not served");
        // The recompute re-stored it, so the next one is a hit again.
        probe(&db, &drive, &ForAgent::Sudo).await.unwrap();
        assert_eq!(db.probe_cache().hits(), hits + 1);
    }

    #[tokio::test]
    async fn clearing_a_tree_forces_a_recompute() {
        let db = Db::init_temp("probe_cache_clear").await.unwrap();
        let (_a, drive) = db.setup("Alice").await.unwrap();
        warm(&db, &drive).await;
        let hits = db.probe_cache().hits();
        db.kv.clear_tree(Tree::LoroSnapshots).unwrap();
        let _ = probe(&db, &drive, &ForAgent::Sudo).await;
        assert_eq!(db.probe_cache().hits(), hits);
    }

    #[tokio::test]
    async fn a_batch_counts_only_after_commit() {
        let db = Db::init_temp("probe_cache_batch").await.unwrap();
        let (_a, drive) = db.setup("Alice").await.unwrap();
        warm(&db, &drive).await;
        let generation = db.write_log().generation();
        db.kv.begin_batch();
        db.kv
            .insert(Tree::Resources, drive.as_bytes(), b"{}")
            .unwrap();
        db.kv
            .apply_batch(&[Operation {
                tree: Tree::LoroSnapshots,
                method: Method::Delete,
                key: drive.as_bytes().to_vec(),
                val: None,
            }])
            .unwrap();
        assert_eq!(db.write_log().generation(), generation, "buffered");
        db.kv.commit_batch().unwrap();
        assert!(db.write_log().generation() > generation, "logged on commit");
        let hits = db.probe_cache().hits();
        let _ = probe(&db, &drive, &ForAgent::Sudo).await;
        assert_eq!(db.probe_cache().hits(), hits, "the drive was written");
    }

    #[tokio::test]
    async fn agents_get_separate_entries() {
        let db = Db::init_temp("probe_cache_agents").await.unwrap();
        let (alice, drive) = db.setup("Alice").await.unwrap();
        child(&db, &drive, "secret").await;
        let owner = ForAgent::AgentSubject(alice.subject.clone());
        let as_owner = probe(&db, &drive, &owner).await.unwrap();
        assert_eq!(probe(&db, &drive, &owner).await.unwrap(), as_owner);
        // A cached owner entry must not answer for Public or a stranger.
        assert!(probe(&db, &drive, &ForAgent::Public).await.is_err());
        let mallory = db.create_agent(Some("Mallory")).await.unwrap();
        let stranger = ForAgent::AgentSubject(mallory.subject.clone());
        assert!(probe(&db, &drive, &stranger).await.is_err());
        assert_eq!(probe(&db, &drive, &owner).await.unwrap(), as_owner);
    }
    use crate::sync::engine::handle_sync_vv_reconcile;
    use crate::sync::protocol::{decode_sync_diff, tag};
    use std::collections::HashMap;

    type Vvs = HashMap<String, HashMap<String, i32>>;

    /// A full `SYNC` after a probe that missed, as the hash-first client sends it.
    async fn reconcile(db: &Db, drive: &str, agent: &ForAgent, client: &Vvs) -> Vec<Vec<u8>> {
        handle_sync_vv_reconcile(
            drive,
            "stale-client-hash",
            2,
            || client.clone(),
            None,
            db,
            agent,
            WireScheme::CANONICAL,
            false,
        )
        .await
    }

    /// The reconcile as a cold server would answer it.
    async fn cold(db: &Db, drive: &str, agent: &ForAgent, client: &Vvs) -> Vec<Vec<u8>> {
        db.probe_cache().clear();
        reconcile(db, drive, agent, client).await
    }

    async fn server_vvs(db: &Db, drive: &str) -> Vvs {
        let drive = crate::Subject::from_raw(drive, db.get_base_domain().as_deref());
        let subjects = crate::sync::engine::collect_drive_subjects(db, &drive).await;
        crate::sync::engine::build_drive_vvs(db, &subjects)
    }

    fn diff(frames: &[Vec<u8>]) -> crate::sync::protocol::DecodedSyncDiff {
        assert_eq!(frames[0][0], tag::SYNC_DIFF);
        decode_sync_diff(&frames[0][1..]).unwrap()
    }

    /// What the cache must not change: the frames, down to the byte.
    #[tokio::test]
    async fn a_reconcile_after_a_probe_answers_as_a_cold_one() {
        let db = Db::init_temp("walk_cache_same").await.unwrap();
        let (alice, drive) = db.setup("Alice").await.unwrap();
        let owner = ForAgent::AgentSubject(alice.subject.clone());
        let ahead = child(&db, &drive, "ahead").await;
        let behind = child(&db, &drive, "behind").await;
        let unknown = child(&db, &drive, "unknown-to-client").await;
        let gone = child(&db, &drive, "gone").await;
        let blob = child(&db, &drive, "file").await;
        let mut file = db.get_resource(&blob.as_str().into()).await.unwrap();
        let missing = crate::identifiers::blob_subject(&"ab".repeat(32));
        file.set(urls::BLOB.into(), Value::AtomicUrl(missing.into()), &db)
            .await
            .unwrap();
        file.save_locally(&db).await.unwrap();

        // The client holds everything except `unknown`, is empty-handed on
        // `ahead`, holds a subject the server never had, and still has `gone`.
        let mut client = server_vvs(&db, &drive).await;
        let pure = |s: &str| crate::Subject::from_raw(s, db.get_base_domain().as_deref()).pure_id();
        let gone_vv = client[&pure(&gone)].clone();
        client.remove(&pure(&unknown));
        client.insert(pure(&ahead), HashMap::new());
        client.insert(pure(&behind), HashMap::from([("1".to_string(), 99)]));
        client.insert(
            "did:ad:only-on-the-client".into(),
            HashMap::from([("7".into(), 1)]),
        );
        db.remove_resource(&crate::Subject::from_raw(&gone, None))
            .await
            .unwrap();
        client.insert(pure(&gone), gone_vv);

        for agent in [&owner, &ForAgent::Sudo] {
            db.probe_cache().clear();
            probe(&db, &drive, agent).await.unwrap();
            let hits = db.probe_cache().hits();
            let cached = reconcile(&db, &drive, agent, &client).await;
            assert_eq!(db.probe_cache().hits(), hits + 1, "walk reused");
            let uncached = cold(&db, &drive, agent, &client).await;
            assert_eq!(cached, uncached);
            let d = diff(&cached);
            assert!(d.push.contains(&pure(&ahead)) && d.push.contains(&pure(&unknown)));
            assert!(d.pull.contains(&pure(&behind)) && d.pull.contains(&pure(&blob)));
            assert_eq!(d.remove, vec![pure(&gone)]);
        }
    }

    /// The classic stale-cache bug: a write between the probe and the full
    /// `SYNC` must show in the answer, whatever kind of write it is.
    #[tokio::test]
    async fn a_write_between_the_probe_and_the_sync_is_not_missed() {
        let db = Db::init_temp("walk_cache_stale").await.unwrap();
        let (alice, drive) = db.setup("Alice").await.unwrap();
        let owner = ForAgent::AgentSubject(alice.subject.clone());
        let folder = child(&db, &drive, "folder").await;
        let doc = child(&db, &drive, "doc").await;
        let other = db.create_drive("Other").await.unwrap();
        let pure = |s: &str| crate::Subject::from_raw(s, db.get_base_domain().as_deref()).pure_id();
        let client = server_vvs(&db, &drive).await;

        // Nothing written: the cached walk is used, and says "in sync".
        probe(&db, &drive, &owner).await.unwrap();
        let hits = db.probe_cache().hits();
        let same = reconcile(&db, &drive, &owner, &client).await;
        assert_eq!(db.probe_cache().hits(), hits + 1);
        assert!(diff(&same).push.is_empty() && diff(&same).pull.is_empty());

        // An edit of a subject in the drive.
        probe(&db, &drive, &owner).await.unwrap();
        edit(&db, &doc, "edited after the probe").await;
        let hits = db.probe_cache().hits();
        let frames = reconcile(&db, &drive, &owner, &client).await;
        assert_eq!(db.probe_cache().hits(), hits, "the entry was dropped");
        assert_eq!(diff(&frames).push, vec![pure(&doc)]);
        assert_eq!(frames, cold(&db, &drive, &owner, &client).await);

        // A new child, deep in the tree.
        probe(&db, &drive, &owner).await.unwrap();
        let fresh = child(&db, &folder, "fresh").await;
        let frames = reconcile(&db, &drive, &owner, &client).await;
        assert!(diff(&frames).push.contains(&pure(&fresh)));
        assert_eq!(frames, cold(&db, &drive, &owner, &client).await);

        // A destroy of a subject the client still holds.
        let held = server_vvs(&db, &drive).await;
        probe(&db, &drive, &owner).await.unwrap();
        db.remove_resource(&crate::Subject::from_raw(&doc, None))
            .await
            .unwrap();
        let frames = reconcile(&db, &drive, &owner, &held).await;
        assert_eq!(diff(&frames).remove, vec![pure(&doc)]);
        assert_eq!(frames, cold(&db, &drive, &owner, &held).await);

        // A move out of the drive.
        probe(&db, &drive, &owner).await.unwrap();
        reparent(&db, &folder, &other).await;
        let frames = reconcile(&db, &drive, &owner, &held).await;
        assert_eq!(frames, cold(&db, &drive, &owner, &held).await);
        assert!(
            diff(&frames).pull.contains(&pure(&folder)),
            "no longer in the drive"
        );

        // A write in another drive leaves the walk usable.
        probe(&db, &drive, &owner).await.unwrap();
        let theirs = child(&db, &other, "theirs").await;
        edit(&db, &theirs, "elsewhere").await;
        let hits = db.probe_cache().hits();
        let frames = reconcile(&db, &drive, &owner, &held).await;
        assert_eq!(db.probe_cache().hits(), hits + 1);
        assert_eq!(frames, cold(&db, &drive, &owner, &held).await);
    }
}

#[cfg(test)]
mod confirmation_epoch_tests {
    use super::WriteLog;

    #[test]
    fn active_and_overlapping_writers_invalidate_receipts() {
        let log = WriteLog::default();
        let before = log.confirmation_token().unwrap();
        let first = log.mutation().unwrap();
        assert_eq!(log.confirmation_token(), None);
        let second = log.mutation().unwrap();
        drop(first);
        assert_eq!(log.confirmation_token(), None);
        drop(second);
        assert_ne!(log.confirmation_token(), Some(before));
    }
}
