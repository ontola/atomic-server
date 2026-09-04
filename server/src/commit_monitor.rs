//! The Commit Monitor checks for new commits and notifies listeners.
//! It is used for WebSockets to notify front-end clients of changes in Resources,
//! and to update the Search index.

use crate::{
    actor_messages::{
        CommitMessage, ExternalChange, RebindAgent, SendFrame, Subscribe, Unsubscribe,
        UnsubscribeAll,
    },
    handlers::{web_sockets::WebSocketConnection, ws_v2},
    search::SearchState,
    vector_search::VectorSearchState,
};
use actix::{
    prelude::{Actor, AsyncContext, Context, Handler},
    ActorFutureExt, Addr, ResponseActFuture, WrapFuture,
};
use atomic_lib::{agents::ForAgent, Db, DbEvent, Storelike};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

/// One connection's registration on a subject, drive or filter.
#[derive(Debug, Clone)]
pub struct Subscriber {
    /// Connection id; a change this connection originated is not echoed back
    /// to it (see [`skip_same_source`]).
    source_id: String,
    /// The identity the subscription was admitted under, as a subject
    /// string. Kept so [`Handler<RebindAgent>`] can re-evaluate the
    /// registration when the connection's `AUTH` changes it.
    agent: String,
}

type Subscribers = HashMap<Addr<WebSocketConnection>, Subscriber>;

/// The Commit Monitor is an Actor that manages subscriptions for subjects and sends Commits to listeners.
/// It's also responsible for checking whether the rights are present.
///
/// Two subscription maps, both fed by the one `SUB <subject>` frame
/// (`Handler<Subscribe>`):
///
/// - **Resource subscriptions** (`subscriptions`): one subject each. Match
///   commits whose target matches exactly. The `CommitMessage` handler scans
///   this map directly.
/// - **Drive subscriptions** (`drive_subscriptions`): a `SUB` whose subject
///   is a drive. Match every commit on resources that belong to that drive —
///   a resource's owning drive is its genesis-stamped `drive` propval (DID
///   subjects) or its own URL under the drive (HTTP subjects), tested via
///   [`atomic_lib::Subject::is_within_drive`]. A commit only ever reaches
///   subscribers of its OWN drive — never others (no cross-drive leak).
///   Subscribers receive a `SendFrame` carrying the pre-encoded `UPDATE` /
///   `DESTROY` wire bytes, encoded once at the fanout site and Arc-shared.
#[allow(clippy::mutable_key_type)]
pub struct CommitMonitor {
    /// Maintains a list of all the resources that are being subscribed to, and maps these to websocket connections.
    /// Inner map: subscriber `Addr` → [`Subscriber`] (its `source_id` is used
    /// to suppress broadcasts back to the connection that originated the change).
    subscriptions: HashMap<atomic_lib::Subject, Subscribers>,
    /// Drive-wide subscriptions: keyed by drive subject string.
    drive_subscriptions: HashMap<String, Subscribers>,
    store: Db,
    search_state: SearchState,
    vector_search_state: VectorSearchState,
    /// Set by every commit handler that adds a doc to the tantivy
    /// writer. A standalone `tokio::spawn` task drains this flag and
    /// calls `writer.commit()` to flush. The actor itself never owns
    /// the flush — that decoupling matters because the actor mailbox
    /// is shared with `CommitMessage` / `Subscribe` / drive-broadcast
    /// notifications, all of which can back up under suite load and
    /// stall a `run_interval` callback. With the flush off-actor the
    /// search-index visibility window is bounded by `REBUILD_INDEX_TIME`
    /// regardless of mailbox depth.
    pending_commit: Arc<AtomicBool>,
}

// Only runs expensive index operation (tantivy) once every x seconds.
const DEFAULT_REBUILD_INDEX_MS: u64 = 5000;

/// Search-index flush cadence. Defaults to 5s (keeps tantivy commit churn low
/// in production), but `ATOMIC_SEARCH_INDEX_INTERVAL_MS` can lower it so the
/// e2e suite sees freshly-created resources become searchable in well under a
/// second instead of waiting out a 5s batch window.
fn rebuild_index_interval() -> std::time::Duration {
    let ms = std::env::var("ATOMIC_SEARCH_INDEX_INTERVAL_MS")
        .ok()
        .and_then(|s| s.parse::<u64>().ok())
        .filter(|ms| *ms > 0)
        .unwrap_or(DEFAULT_REBUILD_INDEX_MS);

    std::time::Duration::from_millis(ms)
}

// Since his Actor only starts once, there is no need to handle its lifecycle
impl Actor for CommitMonitor {
    type Context = Context<Self>;

    fn started(&mut self, ctx: &mut Context<Self>) {
        tracing::debug!("CommitMonitor started");
        if tokio::runtime::Handle::try_current().is_ok() {
            // Tantivy flush runs OFF the actor on its own tokio task.
            // The previous design used `ctx.run_interval(...)` which
            // queued a `tick()` message on the actor mailbox — and the
            // mailbox is shared with every `CommitMessage`,
            // `Subscribe`, drive/membership notification, etc., so
            // under suite-wide load (multiple Playwright workers
            // hammering commits) the tick fired well after its 5s
            // schedule, leaving the search index 30s+ behind. This
            // task holds clones of the writer + flag and is
            // unaffected by mailbox depth.
            let flag = self.pending_commit.clone();
            let writer = self.search_state.writer.clone();
            let reader = self.search_state.reader.clone();
            let vector_search_state = self.vector_search_state.clone();
            tokio::spawn(async move {
                let mut interval = tokio::time::interval(rebuild_index_interval());
                // `interval.tick()` returns immediately on first call;
                // skip it so we don't commit an empty writer at boot.
                interval.tick().await;
                loop {
                    interval.tick().await;
                    if !flag.swap(false, Ordering::AcqRel) {
                        continue;
                    }
                    match writer.write() {
                        Ok(mut guard) => {
                            if let Err(e) = guard.commit() {
                                tracing::error!("Tantivy commit failed: {}", e);
                                // Re-arm so the next pass retries.
                                flag.store(true, Ordering::Release);
                                continue;
                            }
                            drop(guard);
                            if let Err(e) = reader.reload() {
                                tracing::error!("Tantivy reader reload failed: {}", e);
                                flag.store(true, Ordering::Release);
                            }
                        }
                        Err(e) => {
                            tracing::error!("Tantivy writer lock poisoned: {}", e);
                            flag.store(true, Ordering::Release);
                        }
                    }
                    if let Err(e) = vector_search_state.flush_pending().await {
                        tracing::error!("Vector index periodic flush failed: {}", e);
                    }
                }
            });

            // Bridge DbEvents to actor messages. Commits already route
            // through `Handler<CommitMessage>` (set via `set_handle_commit`
            // in `appstate.rs`); what this listener carries is the
            // commit-less change (a peer sync writing straight into the
            // store) that would otherwise never reach a subscriber.
            let mut events_rx = self.store.subscribe_events();
            let addr = ctx.address();
            let store_for_listener = self.store.clone();
            tokio::spawn(async move {
                while let Ok(event) = events_rx.recv().await {
                    // Changes that no commit produced. `handle_commit` — the
                    // usual route from "the store moved" to "tell the clients"
                    // — never runs for these, so without this arm a device that
                    // receives a peer's data holds it on disk and keeps
                    // rendering what it had before.
                    match &event {
                        DbEvent::Changed {
                            subject,
                            source_id,
                            from_commit: false,
                            ..
                        } => {
                            if let Some(msg) =
                                external_change(&store_for_listener, subject, source_id.clone())
                                    .await
                            {
                                addr.do_send(msg);
                            }
                            continue;
                        }
                        DbEvent::Destroyed {
                            subject,
                            drive,
                            source_id,
                            from_commit: false,
                            ..
                        } => {
                            addr.do_send(ExternalChange {
                                subject: subject.to_string(),
                                // Without this the removal reaches only
                                // subscribers of the subject itself, and the
                                // client subscribes per drive — so a
                                // cascade-deleted child was announced to
                                // nobody and stayed in every open tab, and in
                                // the local database across a reload.
                                drive: drive.clone(),
                                loro_snapshot: None,
                                commit_id: None,
                                destroyed: true,
                                source_id: source_id.clone(),
                            });
                            continue;
                        }
                        _ => {}
                    }
                }
            });
        } else {
            tracing::warn!("No Tokio runtime available; skipping CommitMonitor interval");
        }
    }
}

impl Handler<Subscribe> for CommitMonitor {
    type Result = ResponseActFuture<Self, ()>;

    /// The one registration frame, `SUB <subject>`. Auth gate: the agent must
    /// have read access on the subject. What gets registered depends on what
    /// the subject is:
    ///
    /// - a **drive** (`isA` includes `Drive`): the connection joins
    ///   `drive_subscriptions` so [`Handler<CommitMessage>`] fans every
    ///   commit under the drive to it, *and* `subscriptions` for the drive
    ///   resource itself (renames, ACL edits), which a DID drive subject
    ///   would otherwise never prefix-match;
    /// - anything else: `subscriptions` for that one subject.
    ///
    /// Until 2026-09-04 the second case was a separate text frame
    /// (`SUBSCRIBE <subject>`) with its own actor message and handler, and a
    /// `SUB` on a non-drive subject registered a drive fan-out entry that
    /// delivered every commit twice for URL subjects.
    #[tracing::instrument(
        name = "handle_subscribe",
        skip_all,
        fields(subject = %msg.subject, agent = %msg.agent)
    )]
    fn handle(&mut self, msg: Subscribe, _ctx: &mut Context<Self>) -> Self::Result {
        let store = self.store.clone();
        Box::pin(
            async move {
                let subject =
                    atomic_lib::Subject::from_raw(&msg.subject, store.get_base_domain().as_deref());
                if !subject.is_local() {
                    tracing::warn!("can't subscribe to external resource: {subject}");
                    return None;
                }
                let resource = match store.get_resource(&subject).await {
                    Ok(r) => r,
                    Err(e) => {
                        tracing::debug!("Subscribe: {subject} not found: {e}");
                        // Same frame as a rights failure: whether the subject
                        // is unreadable or absent is not something an agent
                        // without read rights gets to learn here, any more
                        // than a GET would tell it.
                        crate::actor_messages::refuse_subscription(
                            &msg.addr,
                            "SUB",
                            &subject.to_string(),
                            "not readable",
                        );
                        return None;
                    }
                };
                if let Err(e) = atomic_lib::hierarchy::check_read(
                    &store,
                    &resource,
                    &ForAgent::from(msg.agent.clone()),
                )
                .await
                {
                    tracing::debug!("Subscribe: {} cannot read {subject}: {e}", msg.agent);
                    crate::actor_messages::refuse_subscription(
                        &msg.addr,
                        "SUB",
                        &subject.to_string(),
                        &e.to_string(),
                    );
                    return None;
                }
                let is_drive = resource
                    .get(atomic_lib::urls::IS_A)
                    .ok()
                    .and_then(|classes| classes.to_subjects(None).ok())
                    .is_some_and(|classes| classes.iter().any(|c| c == atomic_lib::urls::DRIVE));
                Some((msg, subject, is_drive))
            }
            .into_actor(self)
            .map(|admitted, actor, _ctx| {
                #[allow(clippy::mutable_key_type)]
                if let Some((msg, subject, is_drive)) = admitted {
                    let subscriber = Subscriber {
                        source_id: msg.source_id,
                        agent: msg.agent,
                    };
                    if is_drive {
                        actor
                            .drive_subscriptions
                            .entry(msg.subject)
                            .or_default()
                            .insert(msg.addr.clone(), subscriber.clone());
                    }
                    actor
                        .subscriptions
                        .entry(subject)
                        .or_default()
                        .insert(msg.addr, subscriber);
                }
            }),
        )
    }
}

impl Handler<Unsubscribe> for CommitMonitor {
    type Result = ();

    /// The inverse of [`Handler<Subscribe>`] (`UNSUB <subject>`): drops both
    /// the drive fan-out entry (keyed by the raw subject string `SUB`
    /// registered under) and the per-resource entry. Until 2026-09 the
    /// `UNSUB` frame only edited a set on the connection actor that nothing
    /// read, so the fan-out kept firing for the life of the socket.
    #[allow(clippy::mutable_key_type)]
    fn handle(&mut self, msg: Unsubscribe, _ctx: &mut Context<Self>) {
        if let Some(subs) = self.drive_subscriptions.get_mut(&msg.subject) {
            subs.remove(&msg.addr);
            if subs.is_empty() {
                self.drive_subscriptions.remove(&msg.subject);
            }
        }
        let subject =
            atomic_lib::Subject::from_raw(&msg.subject, self.store.get_base_domain().as_deref());
        if let Some(subs) = self.subscriptions.get_mut(&subject) {
            subs.remove(&msg.addr);
            if subs.is_empty() {
                self.subscriptions.remove(&subject);
            }
        }
    }
}

/// True iff a `DbEvent`/`CommitResponse` with `event_source` should NOT be
/// delivered to a subscriber registered with `subscriber_source`. Same
/// connection on both sides means the client originated this change and
/// already has it locally — sending it back is the self-echo we want to
/// suppress. Missing event source (`None`) means a non-WS origin (HTTP
/// commit, internal write) and we deliver to everyone.
fn skip_same_source(event_source: Option<&str>, subscriber_source: &str) -> bool {
    event_source.is_some_and(|s| s == subscriber_source)
}

impl Handler<UnsubscribeAll> for CommitMonitor {
    type Result = ();

    /// Sent on WebSocket close: remove this connection from every map so
    /// future fanouts don't iterate over a dead `Addr`. Without it, every
    /// reconnect leaks an entry per subscription primitive used.
    #[allow(clippy::mutable_key_type)]
    fn handle(&mut self, msg: UnsubscribeAll, _ctx: &mut Context<Self>) {
        for conns in self.subscriptions.values_mut() {
            conns.remove(&msg.addr);
        }
        self.subscriptions.retain(|_, conns| !conns.is_empty());

        for conns in self.drive_subscriptions.values_mut() {
            conns.remove(&msg.addr);
        }
        self.drive_subscriptions
            .retain(|_, conns| !conns.is_empty());
    }
}

/// Gather what a subscriber needs to render a change that arrived without a
/// commit: the resource's full Loro state (there is no delta to send — the
/// writer had none), its `lastCommit`, and the drive it belongs to.
///
/// Returns `None` when there is no state worth sending; the client can still
/// GET the subject explicitly.
async fn external_change(
    store: &Db,
    subject: &atomic_lib::Subject,
    source_id: Option<String>,
) -> Option<ExternalChange> {
    let snapshot = store
        .kv
        .get(
            atomic_lib::db::trees::Tree::LoroSnapshots,
            subject.pure_id().as_bytes(),
        )
        .ok()
        .flatten()
        .filter(|bytes| !bytes.is_empty())?;

    // Present locally by construction — this event fired because it was just
    // written — so this reads the store rather than reaching for the network.
    let resource = store.get_resource(subject).await.ok();
    let commit_id = resource
        .as_ref()
        .and_then(|r| r.get(atomic_lib::urls::LAST_COMMIT).ok())
        .map(|v| v.to_string())
        .filter(|s| !s.is_empty());

    Some(ExternalChange {
        subject: subject.to_string(),
        drive: resource.as_ref().and_then(|r| r.get_drive()),
        loro_snapshot: Some(Arc::from(snapshot.into_boxed_slice())),
        commit_id,
        destroyed: false,
        source_id,
    })
}

impl Handler<ExternalChange> for CommitMonitor {
    type Result = ();

    /// Fan a commit-less change out to the subject's subscribers and to the
    /// subscribers of its drive — the same two audiences, and the same
    /// drive-boundary check, that `Handler<CommitMessage>` serves.
    fn handle(&mut self, msg: ExternalChange, _ctx: &mut Context<Self>) {
        // Keep search in step with the store. A change that no commit produced
        // — a peer sync writing straight through `add_resource_opts` — never
        // reaches `Handler<CommitMessage>`, which is where indexing lives. So
        // resources arriving over Iroh were stored and listed (the query index
        // IS updated) but invisible to search: 49 resources synced, zero
        // INDEXING events. Someone who reaches for search first concludes their
        // data never arrived.
        if !msg.destroyed {
            let search_state = self.search_state.clone();
            let store = self.store.clone();
            let subject_for_index = msg.subject.clone();
            tokio::spawn(async move {
                let subject = atomic_lib::Subject::from_raw(
                    &subject_for_index,
                    store.get_base_domain().as_deref(),
                );

                match store.get_resource(&subject).await {
                    Ok(resource) => {
                        let _ = search_state.remove_resource(&subject_for_index);

                        if let Err(e) = search_state.add_resource(&resource, &store).await {
                            tracing::warn!(
                                "CommitMonitor: could not index peer-synced {}: {e}",
                                &subject_for_index[..subject_for_index.len().min(40)]
                            );
                        }
                    }
                    Err(e) => tracing::debug!(
                        "CommitMonitor: peer-synced {} not indexable: {e}",
                        &subject_for_index[..subject_for_index.len().min(40)]
                    ),
                }
            });
        }

        let base_domain = self.store.get_base_domain();
        let subject = atomic_lib::Subject::from_raw(&msg.subject, base_domain.as_deref());

        // `external_change` reads the payload straight out of
        // `Tree::LoroSnapshots`: full state, so a SNAPSHOT.
        let change = if msg.destroyed {
            ws_v2::Change::Destroyed
        } else {
            let Some(snapshot) = msg.loro_snapshot.as_ref() else {
                return;
            };
            ws_v2::Change::Snapshot {
                bytes: snapshot,
                commit_id: msg.commit_id.as_deref(),
            }
        };
        let frame = ws_v2::encode_change_frame(&self.store, &subject, change);

        let source = msg.source_id.as_deref();

        if let Some(subscribers) = self.subscriptions.get(&subject) {
            for (connection, subscriber) in subscribers {
                if skip_same_source(source, &subscriber.source_id) {
                    continue;
                }
                connection.do_send(SendFrame {
                    frame: frame.clone(),
                });
            }
        }

        // A resource belongs to exactly one drive; a change must only reach
        // that drive's subscribers. No drive, no drive-wide fanout — never a
        // blind broadcast (see `Handler<CommitMessage>`).
        let Some(owner) = msg.drive.as_ref() else {
            return;
        };

        for (drive, subscribers) in &self.drive_subscriptions {
            let drive_subject = atomic_lib::Subject::from_raw(drive, base_domain.as_deref());
            if !owner.is_within_drive(&drive_subject) {
                continue;
            }
            for (connection, subscriber) in subscribers {
                if skip_same_source(source, &subscriber.source_id) {
                    continue;
                }
                connection.do_send(SendFrame {
                    frame: frame.clone(),
                });
            }
        }
    }
}

/// What one connection holds in one of the two subscription maps, for
/// [`Handler<RebindAgent>`]. Carries the map key so the verdict can be
/// applied after the async read checks come back.
enum Held {
    Subject(atomic_lib::Subject),
    Drive(String),
}

/// Apply a re-evaluation verdict to one registration: keep it under the
/// new agent, or drop it (and the key, if that emptied it). Returns whether
/// something was dropped.
#[allow(clippy::mutable_key_type)]
fn rebind_one<K: std::hash::Hash + Eq>(
    map: &mut HashMap<K, Subscribers>,
    key: &K,
    addr: &Addr<WebSocketConnection>,
    agent: &str,
    readable: bool,
) -> bool {
    let Some(subs) = map.get_mut(key) else {
        return false;
    };
    if readable {
        if let Some(sub) = subs.get_mut(addr) {
            sub.agent = agent.to_string();
        }
        return false;
    }
    let dropped = subs.remove(addr).is_some();
    if subs.is_empty() {
        map.remove(key);
    }
    dropped
}

impl Handler<RebindAgent> for CommitMonitor {
    type Result = ResponseActFuture<Self, ()>;

    /// A connection's identity changed (an `AUTH` landed, or a different
    /// agent authenticated on an already-authenticated socket). Until
    /// 2026-09 the agent a subscription was admitted under was checked once
    /// and then forgotten, so a `SUB` accepted as Alice kept delivering
    /// after the socket re-authenticated as Mallory. Every registration this
    /// connection holds is re-checked against the new identity: readable
    /// ones are re-bound to it, the rest are dropped silently (the client
    /// that switched agents re-subscribes on its own, and gets the refusal
    /// then).
    #[allow(clippy::mutable_key_type)]
    fn handle(&mut self, msg: RebindAgent, _ctx: &mut Context<Self>) -> Self::Result {
        let base_domain = self.store.get_base_domain();
        let mut checks: Vec<(Held, atomic_lib::Subject)> = Vec::new();
        for (subject, subs) in &self.subscriptions {
            if subs.contains_key(&msg.addr) {
                checks.push((Held::Subject(subject.clone()), subject.clone()));
            }
        }
        for (drive, subs) in &self.drive_subscriptions {
            if subs.contains_key(&msg.addr) {
                checks.push((
                    Held::Drive(drive.clone()),
                    atomic_lib::Subject::from_raw(drive, base_domain.as_deref()),
                ));
            }
        }
        if checks.is_empty() {
            return Box::pin(async {}.into_actor(self));
        }

        let store = self.store.clone();
        let agent = msg.agent.clone();
        let addr = msg.addr;
        Box::pin(
            async move {
                let for_agent = ForAgent::from(agent.clone());
                let mut verdicts = Vec::with_capacity(checks.len());
                for (held, target) in checks {
                    let readable = match store.get_resource(&target).await {
                        Ok(resource) => {
                            atomic_lib::hierarchy::check_read(&store, &resource, &for_agent)
                                .await
                                .is_ok()
                        }
                        Err(_) => false,
                    };
                    verdicts.push((held, readable));
                }
                (verdicts, agent, addr)
            }
            .into_actor(self)
            .map(|(verdicts, agent, addr), actor, _ctx| {
                let mut dropped = 0usize;
                for (held, readable) in verdicts {
                    let was_dropped = match held {
                        Held::Subject(subject) => {
                            rebind_one(&mut actor.subscriptions, &subject, &addr, &agent, readable)
                        }
                        Held::Drive(drive) => rebind_one(
                            &mut actor.drive_subscriptions,
                            &drive,
                            &addr,
                            &agent,
                            readable,
                        ),
                    };
                    if was_dropped {
                        dropped += 1;
                    }
                }
                if dropped > 0 {
                    tracing::debug!(
                        agent = %agent,
                        dropped,
                        "rebind: dropped subscriptions the new identity cannot read"
                    );
                }
            }),
        )
    }
}

impl Handler<CommitMessage> for CommitMonitor {
    type Result = ResponseActFuture<Self, ()>;

    #[tracing::instrument(name = "handle_commit_message", skip_all, fields(subscriptions = &self.subscriptions.len(), s = %msg.commit_response.commit_resource.get_subject()))]
    fn handle(&mut self, msg: CommitMessage, _: &mut Context<Self>) -> Self::Result {
        // Normalize the subject using the base domain so it matches subscriptions
        let target_subject = atomic_lib::Subject::from_raw(
            msg.commit_response.commit.subject.as_str(),
            self.store.get_base_domain().as_deref(),
        );

        let event_source = msg.commit_response.source_id.as_deref();

        // Encode the wire frame ONCE up front, wrap in `Arc`. Each
        // subscriber `do_send` then clones only the Arc pointer (O(1))
        // instead of cloning the full `CommitMessage` and re-encoding
        // per-connection.
        let frame = encode_commit_frame(&self.store, &msg);

        if let Some(frame) = frame.as_ref() {
            // Per-resource subscribers
            if let Some(subscribers) = self.subscriptions.get(&target_subject) {
                tracing::debug!(
                    "Sending commit {} to {} subscribers",
                    target_subject,
                    subscribers.len()
                );
                for (connection, subscriber) in subscribers {
                    if skip_same_source(event_source, &subscriber.source_id) {
                        continue;
                    }
                    connection.do_send(SendFrame {
                        frame: frame.clone(),
                    });
                }
            } else {
                tracing::debug!("No subscribers for {}", target_subject);
            }

            // Drive-wide subscribers. A resource belongs to exactly ONE drive,
            // and a commit must only ever reach subscribers of THAT drive —
            // never others. Fanning a `did:ad:` commit out to every drive
            // subscriber leaks it to agents with no rights on it (a
            // cross-tenant security hole).
            //
            // We test membership via the resource's OWNING subject: for a DID
            // resource that's its `drive` propval (stamped at genesis); for a
            // URL resource with no such propval it's the subject itself, which
            // lives under its drive's URL. `Subject::is_within_drive` then does
            // the identity / path-boundary check. A DID resource with no drive
            // propval reaches no drive subscriber rather than fanning out
            // blindly.
            let base_domain = self.store.get_base_domain();
            let resource_drive = msg
                .commit_response
                .resource_new
                .as_ref()
                .and_then(|r| r.get_drive());
            let owner = resource_drive.as_ref().unwrap_or(&target_subject);
            for (drive, subscribers) in &self.drive_subscriptions {
                let drive_subject = atomic_lib::Subject::from_raw(drive, base_domain.as_deref());
                if !owner.is_within_drive(&drive_subject) {
                    continue;
                }
                for (connection, subscriber) in subscribers {
                    if skip_same_source(event_source, &subscriber.source_id) {
                        continue;
                    }
                    connection.do_send(SendFrame {
                        frame: frame.clone(),
                    });
                }
            }
        }

        let store = self.store.clone();
        let search_state = self.search_state.clone();
        let vector_search_state = self.vector_search_state.clone();
        let resource_old = msg.commit_response.resource_old.clone();
        let resource_new = msg.commit_response.resource_new.clone();
        let target_str = target_subject.to_string();

        Box::pin(
            async move {
                // Skip vector re-indexing when only non-text properties changed (e.g. parent adding
                // a child to its subResources array). If the indexable text content is identical,
                // neither a remove nor an add is needed — the existing vector entry is still correct.
                // This is important for performance!
                let vector_text_unchanged = resource_old.as_ref().zip(resource_new.as_ref()).is_some_and(
                    |(old, new)| {
                        crate::vector_search::get_resource_text_parts(old)
                            == crate::vector_search::get_resource_text_parts(new)
                    },
                );

                search_state.remove_resource(&target_str).map_err(|e| {
                    format!(
                        "Handling commit in CommitMonitor failed, cache may not be fully updated: {}",
                        e
                    )
                })?;
                if let Some(resource) = resource_new.as_ref() {
                    if let Ok(classes) = resource.get(atomic_lib::urls::IS_A) {
                        if let Ok(subjects) = classes.to_subjects(None) {
                            if subjects.contains(&atomic_lib::urls::DRIVE.to_string()) {
                                crate::metrics::drive_created();
                            }
                        }
                    }
                    // We could one day re-(allow) to keep old resources,
                    // but then we also should index the older versions when re-indexing.
                    // Add new resource to search index
                    tracing::debug!(
                        "CommitMonitor: adding resource to search index: {}",
                        resource.get_subject()
                    );
                    search_state
                        .add_resource(resource, &store)
                        .await
                        .map_err(|e| {
                            tracing::error!(
                                "CommitMonitor: FAILED to add resource {} to search index: {}",
                                resource.get_subject(),
                                e
                            );
                            format!(
                    "Handling commit in CommitMonitor failed, cache may not be fully updated: {}",
                    e
                )
                        })?;
                }

                if vector_search_state.is_enabled() && !vector_text_unchanged {
                    if resource_old.is_some() {
                        vector_search_state.remove_resource(&target_str).await.map_err(|e| {
                            format!(
                                "Handling commit in CommitMonitor failed for vector search: {}",
                                e
                            )
                        })?;
                    }
                    if let Some(resource) = resource_new {
                        vector_search_state
                            .add_resource(&resource, &store)
                            .await
                            .map_err(|e| {
                                format!(
                                    "Handling commit in CommitMonitor failed for vector search: {}",
                                    e
                                )
                            })?;
                    }
                }
                Ok::<_, String>(())
            }
            .into_actor(self)
            .map(|res, actor, _ctx| {
                if let Err(e) = res {
                    tracing::error!("{}", e);
                }
                // Off-actor flush task picks this up on its next tick.
                actor
                    .pending_commit
                    .store(true, Ordering::Release);
            }),
        )
    }
}

/// Encode the wire frame (`UPDATE` or `DESTROY`) for a `CommitMessage`,
/// wrapped in `Arc<[u8]>` for cheap fanout. Returns `None` when the
/// commit produces no frame (neither a Loro update nor a destroy flag).
///
/// Mirrors the per-connection encoding that
/// `WebSocketConnection::Handler<SendFrame>` used to do before this was
/// hoisted up to the fanout site. Origin resolution uses the shared
/// store's base domain — all connections on this server resolve
/// `internal:/…` subjects the same way, so encoding once is correct.
fn encode_commit_frame(store: &Db, msg: &CommitMessage) -> Option<Arc<[u8]>> {
    let commit = &msg.commit_response.commit;

    if let Some(loro_update) = &commit.loro_update {
        // The wire `commit_id` becomes the client's `lastCommit`
        // propval and, on its next commit, its `previousCommit`. The
        // latter is parsed as an AtomicURL by the server's JSON-AD
        // parser — a raw base64 signature isn't a URL and gets
        // rejected. Always emit the full `did:ad:commit:{signature}`
        // DID. (`commit.url` is never populated in practice, so the
        // previous `or(signature)` fallback was always taken —
        // silently dropping the prefix.)
        let commit_id = commit
            .url
            .clone()
            .or_else(|| {
                commit
                    .signature
                    .as_ref()
                    .map(|s| format!("did:ad:commit:{}", s))
            })
            .unwrap_or_default();
        Some(ws_v2::encode_change_frame(
            store,
            &commit.subject,
            ws_v2::Change::Delta {
                bytes: loro_update,
                commit_id: &commit_id,
            },
        ))
    } else if commit.destroy.unwrap_or(false) {
        Some(ws_v2::encode_change_frame(
            store,
            &commit.subject,
            ws_v2::Change::Destroyed,
        ))
    } else {
        None
    }
}

/// Spawns a commit monitor actor
pub fn create_commit_monitor(
    store: Db,
    search_state: SearchState,
    vector_search_state: VectorSearchState,
) -> Addr<CommitMonitor> {
    tracing::info!("spawning commit monitor");
    crate::commit_monitor::CommitMonitor::create(|_ctx: &mut Context<CommitMonitor>| {
        CommitMonitor {
            subscriptions: HashMap::new(),
            drive_subscriptions: HashMap::new(),
            store,
            search_state,
            vector_search_state,
            pending_commit: Arc::new(AtomicBool::new(false)),
        }
    })
}
