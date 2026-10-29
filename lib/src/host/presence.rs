//! Who is where in a drive, for a host that keeps its own store.
//!
//! The web app announces itself with a `DrivePresenceManager`
//! (`browser/lib/src/presence.ts`): one Loro `EphemeralStore` per drive in
//! which every session owns exactly one key, its session id, holding a
//! `PresenceEntry` map (`agent`, `resource`, `following`, `session`,
//! `allowFollow`, `data`, `typing`, `updatedAt`). Updates travel as opaque
//! `EphemeralStore` bytes in `EPHEMERAL` frames of kind `PRESENCE`. A key not
//! refreshed within 30 s expires on every peer, so nobody has to say goodbye
//! and a crashed session just fades out.
//!
//! This is the same thing for a native host, with the same value shape and
//! bytes, so a browser and the app see each other with no change on the web.
//! The entry is stored as a Loro map, not as a JSON string: the web reads
//! `getAllStates()` and expects objects.
//!
//! The hub does not own a transport. It talks to the rest of the node through
//! the Db's ephemeral channel ([`Db::publish_ephemeral`] /
//! [`Db::subscribe_ephemeral`]): what it announces is published there with
//! `from_peer` [`LOCAL_PEER`], and transports (a WebRTC link, the server
//! websocket session, Iroh) take it from there and publish what they receive
//! back with their own peer id. One hub per `Db` serves every transport.
//!
//! The host drives time. Loro's Rust `EphemeralStore` never expires anything
//! by itself, and the entry must be re-sent every [`HEARTBEAT_MS`]. [`start`]
//! spawns one task on the current tokio runtime that does both and applies
//! incoming events; a host without a runtime of its own calls [`heartbeat`]
//! from a timer and [`apply_event`] for each event instead.

use crate::{db::EphemeralEvent, errors::AtomicResult, sync::protocol, Db, Storelike};
use loro::awareness::EphemeralStore;
use serde_json::Value as Json;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

/// Keys expire on all peers when not refreshed within this window
/// (`PRESENCE_TTL_MS` in `presence.ts`).
pub const PRESENCE_TTL_MS: i64 = 30_000;
/// How often the local entry is re-sent, well inside the TTL
/// (`HEARTBEAT_MS` in `presence.ts`).
pub const HEARTBEAT_MS: u64 = 10_000;
/// The `from_peer` of presence this node announced itself. Transports forward
/// it; the hub does not apply it again.
pub const LOCAL_PEER: &str = "local";

/// Bumped whenever what [`presence`] would return may have changed, for any
/// drive. A host polls it like the store revision and re-reads on a change.
static REVISION: AtomicU64 = AtomicU64::new(0);

fn bump() {
    REVISION.fetch_add(1, Ordering::Relaxed);
}

/// Changes whenever any drive's presence changed (someone arrived, moved or
/// left, or a session timed out). Not a count of anything.
pub fn presence_revision() -> u64 {
    REVISION.load(Ordering::Relaxed)
}

/// One id per process, shared by every drive it announces in: a session that
/// is in a drive and in a shared resource is one person to anyone reading both.
fn process_session_id() -> &'static str {
    static ID: OnceLock<String> = OnceLock::new();
    ID.get_or_init(|| {
        let mut bytes = [0u8; 8];
        rand::RngCore::fill_bytes(&mut rand::thread_rng(), &mut bytes);
        let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
        format!("app-{hex}")
    })
}

fn drive_key(drive: &str) -> String {
    crate::identifiers::canonicalize_scheme(drive)
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

struct DriveState {
    store: EphemeralStore,
    /// What this session last announced here, re-sent by the heartbeat.
    local: Option<Json>,
}

/// The presence of every drive a node is in. Get the node's one with [`hub`].
pub struct PresenceHub {
    db: Db,
    session_id: String,
    ttl_ms: i64,
    drives: Mutex<HashMap<String, DriveState>>,
    started: AtomicBool,
}

/// The hub of `db`, created on first use. Keyed by the store behind the `Db`,
/// so every clone of it shares one. It lives as long as the process.
pub fn hub(db: &Db) -> Arc<PresenceHub> {
    static HUBS: OnceLock<Mutex<HashMap<usize, Arc<PresenceHub>>>> = OnceLock::new();
    let id = Arc::as_ptr(&db.kv) as *const () as usize;
    let mut hubs = HUBS.get_or_init(Default::default).lock().unwrap();
    hubs.entry(id)
        .or_insert_with(|| {
            Arc::new(PresenceHub::with_session(
                db.clone(),
                process_session_id().to_string(),
                PRESENCE_TTL_MS,
            ))
        })
        .clone()
}

impl PresenceHub {
    /// A hub with its own session id and timeout. [`hub`] is what hosts use;
    /// this is for tests, which need two sessions in one process.
    pub fn with_session(db: Db, session_id: String, ttl_ms: i64) -> Self {
        Self {
            db,
            session_id,
            ttl_ms,
            drives: Mutex::new(HashMap::new()),
            started: AtomicBool::new(false),
        }
    }

    /// This process's session id, the key it announces under.
    pub fn session_id(&self) -> &str {
        &self.session_id
    }

    fn with_drive<T>(&self, drive: &str, f: impl FnOnce(&mut DriveState) -> T) -> T {
        let mut drives = self.drives.lock().unwrap();
        let state = drives
            .entry(drive_key(drive))
            .or_insert_with(|| DriveState {
                store: EphemeralStore::new(self.ttl_ms),
                local: None,
            });
        f(state)
    }

    fn publish(&self, drive: &str, payload: Vec<u8>) {
        // An expired or absent key encodes to nothing; there is nothing to say.
        if payload.is_empty() {
            return;
        }
        let agent = self
            .db
            .get_default_agent()
            .map(|a| a.subject.to_string())
            .unwrap_or_default();
        self.db.publish_ephemeral(EphemeralEvent {
            kind: protocol::ephemeral_kind::PRESENCE,
            drive: drive_key(drive),
            agent,
            payload,
            from_peer: LOCAL_PEER.to_string(),
        });
    }

    /// Announce (or replace) this session's entry in `drive`.
    ///
    /// `entry` is a JSON object with the web's `PresenceEntry` fields. `agent`
    /// and `updatedAt` are stamped here and any given are overwritten; nulls
    /// are dropped, since the web uses a missing field for "unset". Needs the
    /// store's default agent: an anonymous node does not announce.
    pub fn set_presence(&self, drive: &str, entry: Json) -> AtomicResult<()> {
        let Json::Object(mut map) = entry else {
            return Err("A presence entry must be a JSON object".into());
        };
        let agent = self.db.get_default_agent()?.subject.to_string();
        map.retain(|_, v| !v.is_null());
        map.insert("agent".into(), Json::String(agent));
        map.insert("updatedAt".into(), Json::from(now_ms()));
        let entry = Json::Object(map);
        let payload = self.with_drive(drive, |state| {
            state.store.set(&self.session_id, entry.clone());
            state.local = Some(entry);
            state.store.encode(&self.session_id)
        });
        bump();
        self.publish(drive, payload);
        Ok(())
    }

    /// Stop being present in `drive` now, rather than after the TTL. The
    /// deletion travels like an update, so peers drop the session at once.
    pub fn clear_presence(&self, drive: &str) {
        let payload = self.with_drive(drive, |state| {
            state.local = None;
            state.store.delete(&self.session_id);
            state.store.encode(&self.session_id)
        });
        bump();
        self.publish(drive, payload);
    }

    /// Re-send every drive's local entry, so it outlives the TTL on the other
    /// side, and drop sessions that timed out. Called every [`HEARTBEAT_MS`] by
    /// [`start`]'s task, or by the host's own timer. The entry is not
    /// re-stamped: `updatedAt` is the time of the last local write, as on the
    /// web.
    pub fn heartbeat(&self) {
        let mut out = vec![];
        {
            let drives = self.drives.lock().unwrap();
            for (drive, state) in drives.iter() {
                if let Some(local) = &state.local {
                    state.store.set(&self.session_id, local.clone());
                    out.push((drive.clone(), state.store.encode(&self.session_id)));
                }
            }
        }
        for (drive, payload) in out {
            self.publish(&drive, payload);
        }
        self.sweep();
    }

    /// Forget sessions past their TTL, and say so through [`presence_revision`].
    pub fn sweep(&self) {
        let drives = self.drives.lock().unwrap();
        let mut changed = false;
        for state in drives.values() {
            let before = state.store.keys().len();
            state.store.remove_outdated();
            changed |= state.store.keys().len() != before;
        }
        drop(drives);
        if changed {
            bump();
        }
    }

    /// Take one event from the ephemeral channel. Only `PRESENCE` that did not
    /// come from this node is applied; the rest is somebody else's channel.
    pub fn apply_event(&self, event: &EphemeralEvent) {
        if event.kind != protocol::ephemeral_kind::PRESENCE || event.from_peer == LOCAL_PEER {
            return;
        }
        let applied = self.with_drive(&event.drive, |state| state.store.apply(&event.payload));
        // Which way presence arrives first (and how often) is what a slow
        // follow comes down to.
        tracing::info!(
            "[presence] {} bytes for {} from {}",
            event.payload.len(),
            event.drive,
            event.from_peer
        );
        match applied {
            Ok(()) => bump(),
            Err(e) => tracing::debug!("[presence] ignored a bad update: {e}"),
        }
    }

    /// Every other session in `drive`, as the web's `PresenceItem`: the entry
    /// plus `sessionId`. Entries without an `agent` string are skipped, as on
    /// the web. Sorted by session id so the list is stable between reads.
    pub fn presence(&self, drive: &str) -> Vec<Json> {
        self.sweep();
        let states = self.with_drive(drive, |state| state.store.get_all_states());
        let mut items: Vec<(String, Json)> = states
            .into_iter()
            .filter(|(session, _)| *session != self.session_id)
            .filter_map(|(session, value)| {
                let Json::Object(mut map) = Json::from(value) else {
                    return None;
                };
                map.get("agent")?.as_str()?;
                map.insert("sessionId".into(), Json::String(session.clone()));
                Some((session, Json::Object(map)))
            })
            .collect();
        items.sort_by(|a, b| a.0.cmp(&b.0));
        items.into_iter().map(|(_, v)| v).collect()
    }

    /// Run the heartbeat and apply incoming events on the current tokio
    /// runtime. Safe to call twice: the second call does nothing. The task
    /// ends with the process; there is no stop, as the hub lives that long.
    pub fn start(self: &Arc<Self>) {
        // Called from a thread with no runtime (a sync bridge call), spawning
        // would panic: the next call from inside one starts it instead.
        let Ok(runtime) = tokio::runtime::Handle::try_current() else {
            tracing::warn!("[presence] not started: no tokio runtime on this thread");
            return;
        };
        if self.started.swap(true, Ordering::SeqCst) {
            return;
        }
        let hub = self.clone();
        let mut events = self.db.subscribe_ephemeral();
        runtime.spawn(async move {
            let mut beat = tokio::time::interval(std::time::Duration::from_millis(HEARTBEAT_MS));
            let mut sweep = tokio::time::interval(std::time::Duration::from_secs(1));
            loop {
                tokio::select! {
                    received = events.recv() => match received {
                        Ok(event) => hub.apply_event(&event),
                        // Missed updates are re-sent by the next heartbeats.
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {}
                        Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                    },
                    _ = beat.tick() => hub.heartbeat(),
                    _ = sweep.tick() => hub.sweep(),
                }
            }
        });
    }
}

/// [`PresenceHub::set_presence`] on `db`'s hub, starting its task if needed.
pub fn set_presence(db: &Db, drive: &str, entry: Json) -> AtomicResult<()> {
    let hub = hub(db);
    hub.start();
    hub.set_presence(drive, entry)
}

/// [`PresenceHub::clear_presence`] on `db`'s hub.
pub fn clear_presence(db: &Db, drive: &str) {
    hub(db).clear_presence(drive)
}

/// [`PresenceHub::heartbeat`] on `db`'s hub, for a host that runs its own timer.
pub fn heartbeat(db: &Db) {
    hub(db).heartbeat()
}

/// [`PresenceHub::presence`] on `db`'s hub, starting its task if needed so a
/// screen that only watches still receives updates.
pub fn presence(db: &Db, drive: &str) -> Vec<Json> {
    let hub = hub(db);
    hub.start();
    hub.presence(drive)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    async fn node(name: &str) -> Db {
        let db = Db::init_temp(&format!(
            "presence-{name}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
        .await
        .unwrap();
        db.setup(name).await.unwrap();
        db
    }

    const DRIVE: &str = "did:ad:drive1";

    /// Two nodes with the channel between them bridged by hand, as a transport
    /// does: what one publishes locally reaches the other tagged with a peer.
    struct Pair {
        a: PresenceHub,
        b: PresenceHub,
        rx_a: tokio::sync::broadcast::Receiver<EphemeralEvent>,
    }

    impl Pair {
        async fn new(ttl_ms: i64) -> Self {
            let (db_a, db_b) = (node("a").await, node("b").await);
            let rx_a = db_a.subscribe_ephemeral();
            Pair {
                a: PresenceHub::with_session(db_a, "session-a".into(), ttl_ms),
                b: PresenceHub::with_session(db_b, "session-b".into(), ttl_ms),
                rx_a,
            }
        }

        /// Carry everything A announced to B.
        fn bridge(&mut self) {
            while let Ok(mut event) = self.rx_a.try_recv() {
                assert_eq!(event.kind, protocol::ephemeral_kind::PRESENCE);
                assert_eq!(event.from_peer, LOCAL_PEER);
                event.from_peer = "test-link".into();
                self.b.apply_event(&event);
            }
        }
    }

    #[tokio::test]
    async fn a_remote_session_is_listed_with_its_resource_and_agent() {
        let mut pair = Pair::new(PRESENCE_TTL_MS).await;
        pair.a
            .set_presence(DRIVE, json!({"resource": "did:ad:page", "typing": null}))
            .unwrap();
        pair.bridge();
        let list = pair.b.presence(DRIVE);
        assert_eq!(list.len(), 1);
        let agent = pair.a.db.get_default_agent().unwrap().subject.to_string();
        assert_eq!(list[0]["sessionId"], "session-a");
        assert_eq!(list[0]["resource"], "did:ad:page");
        assert_eq!(list[0]["agent"], agent.as_str());
        assert!(list[0]["updatedAt"].as_i64().unwrap() > 0);
        assert!(list[0].get("typing").is_none(), "nulls are unset");
    }

    #[tokio::test]
    async fn clearing_removes_the_session_at_once() {
        let mut pair = Pair::new(PRESENCE_TTL_MS).await;
        pair.a
            .set_presence(DRIVE, json!({"resource": "x"}))
            .unwrap();
        pair.bridge();
        assert_eq!(pair.b.presence(DRIVE).len(), 1);
        // Loro resolves a key by its millisecond timestamp, and a delete in
        // the very millisecond of the set loses the tie. A person cannot
        // announce and leave that fast; a test can.
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        pair.a.clear_presence(DRIVE);
        pair.bridge();
        assert!(pair.b.presence(DRIVE).is_empty());
    }

    #[tokio::test]
    async fn a_session_that_stops_heartbeating_expires() {
        let mut pair = Pair::new(150).await;
        pair.a
            .set_presence(DRIVE, json!({"resource": "x"}))
            .unwrap();
        pair.bridge();
        assert_eq!(pair.b.presence(DRIVE).len(), 1);
        let before = presence_revision();
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        assert!(pair.b.presence(DRIVE).is_empty());
        assert_ne!(presence_revision(), before);
    }

    #[tokio::test]
    async fn the_heartbeat_keeps_a_session_alive() {
        let mut pair = Pair::new(300).await;
        pair.a
            .set_presence(DRIVE, json!({"resource": "x"}))
            .unwrap();
        for _ in 0..4 {
            tokio::time::sleep(std::time::Duration::from_millis(120)).await;
            pair.a.heartbeat();
            pair.bridge();
        }
        assert_eq!(pair.b.presence(DRIVE).len(), 1);
    }

    #[tokio::test]
    async fn the_own_session_is_not_listed_and_is_not_applied_back() {
        let mut pair = Pair::new(PRESENCE_TTL_MS).await;
        pair.a
            .set_presence(DRIVE, json!({"resource": "x"}))
            .unwrap();
        assert!(pair.a.presence(DRIVE).is_empty());
        // Even a transport echoing it back changes nothing.
        let event = pair.rx_a.try_recv().unwrap();
        let mut echoed = event.clone();
        echoed.from_peer = "test-link".into();
        pair.a.apply_event(&echoed);
        assert!(pair.a.presence(DRIVE).is_empty());
    }

    #[tokio::test]
    async fn other_kinds_and_a_local_echo_are_ignored() {
        let mut pair = Pair::new(PRESENCE_TTL_MS).await;
        pair.a
            .set_presence(DRIVE, json!({"resource": "x"}))
            .unwrap();
        let event = pair.rx_a.try_recv().unwrap();
        pair.b.apply_event(&EphemeralEvent {
            kind: protocol::ephemeral_kind::LORO,
            from_peer: "link".into(),
            ..event.clone()
        });
        pair.b.apply_event(&event); // from_peer is "local"
        assert!(pair.b.presence(DRIVE).is_empty());
    }

    #[tokio::test]
    async fn the_task_applies_incoming_events_and_heartbeats() {
        let db = node("task").await;
        let hub = Arc::new(PresenceHub::with_session(db.clone(), "me".into(), 30_000));
        hub.start();
        hub.start();
        // A browser's announcement arrives through some transport.
        let remote = EphemeralStore::new(30_000);
        remote.set("tab-1", json!({"agent": "did:ad:agent:x", "resource": "r"}));
        db.publish_ephemeral(EphemeralEvent {
            kind: protocol::ephemeral_kind::PRESENCE,
            drive: DRIVE.into(),
            agent: "did:ad:agent:x".into(),
            payload: remote.encode("tab-1"),
            from_peer: "ws".into(),
        });
        let mut found = vec![];
        for _ in 0..50 {
            found = hub.presence(DRIVE);
            if !found.is_empty() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        assert_eq!(found[0]["sessionId"], "tab-1");
    }

    /// The web writes `ephemeral.set(sessionId, entry)` with `entry` a plain
    /// object, and reads `getAllStates()` back as objects: the same Loro
    /// crate underneath, so bytes from one side decode on the other. Pin the
    /// shape (a map of scalars, a boolean, a nested `data` map) a browser sends.
    #[tokio::test]
    async fn bytes_made_the_way_presence_ts_makes_them_decode() {
        // The pair first: starting it can take longer than the TTL on a busy
        // runner, and an entry set before that would have expired.
        let pair = Pair::new(PRESENCE_TTL_MS).await;
        let web = EphemeralStore::new(PRESENCE_TTL_MS);
        web.set(
            "tab-7",
            json!({
                "agent": "did:ad:agent:web",
                "resource": "did:ad:page",
                "allowFollow": false,
                "data": {"x": 1.5, "y": 2},
                "updatedAt": 1_775_504_552_928_i64,
            }),
        );
        pair.b.apply_event(&EphemeralEvent {
            kind: protocol::ephemeral_kind::PRESENCE,
            drive: DRIVE.into(),
            agent: "did:ad:agent:web".into(),
            payload: web.encode("tab-7"),
            from_peer: "ws".into(),
        });
        let list = pair.b.presence(DRIVE);
        assert_eq!(list[0]["allowFollow"], false);
        assert_eq!(list[0]["data"]["x"], 1.5);
        assert_eq!(list[0]["updatedAt"], 1_775_504_552_928_i64);
        // And what the app sends decodes to a map a browser reads as an object.
        pair.b
            .set_presence(DRIVE, json!({"resource": "r"}))
            .unwrap();
        let store = EphemeralStore::new(PRESENCE_TTL_MS);
        let mut rx = pair.b.db.subscribe_ephemeral();
        pair.b.heartbeat();
        store.apply(&rx.try_recv().unwrap().payload).unwrap();
        assert!(matches!(
            store.get("session-b"),
            Some(loro::LoroValue::Map(_))
        ));
    }
}
