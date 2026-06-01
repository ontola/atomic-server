//! The Commit Monitor checks for new commits and notifies listeners.
//! It is used for WebSockets to notify front-end clients of changes in Resources,
//! and to update the Search index.

use crate::{
    actor_messages::{
        CommitMessage, MembershipNotification, SendFrame, Subscribe, SubscribeDrive,
        SubscribeQuery, UnsubscribeAll, UnsubscribeQuery,
    },
    handlers::{web_sockets::WebSocketConnection, ws_v2},
    search::SearchState,
};
use actix::{
    prelude::{Actor, AsyncContext, Context, Handler},
    ActorFutureExt, Addr, ResponseActFuture, WrapFuture,
};
use atomic_lib::{agents::ForAgent, db::QueryFilter, Db, DbEvent, Storelike, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

/// The Commit Monitor is an Actor that manages subscriptions for subjects and sends Commits to listeners.
/// It's also responsible for checking whether the rights are present.
///
/// Three subscription shapes:
///
/// - **Resource subscriptions** (`subscriptions`): one subject per SUB.
///   Match commits whose target matches exactly. The `CommitMessage`
///   handler scans this map directly.
/// - **Drive subscriptions** (`drive_subscriptions`): drive only.
///   Match every commit on resources whose subject is under that drive
///   (HTTP subjects by prefix; DIDs fan out to every drive subscriber
///   because they can't be prefix-matched). Both kinds receive a
///   `SendFrame` carrying the pre-encoded `UPDATE` / `DESTROY` wire
///   bytes, encoded once at the fanout site and Arc-shared.
/// - **Filter subscriptions** (`query_subscriptions`): keyed by encoded
///   `QueryFilter` bytes — registered via the `SUBSCRIBE_QUERY` text
///   frame. When a resource enters / leaves the filter set,
///   [`MembershipNotification`] arrives via the DbEvent listener below;
///   the receiving WebSocketConnection encodes an `UPDATE` for added
///   subjects (with pre-fetched snapshot + commit_id so the receiver
///   doesn't need a follow-up GET) or `DESTROY` for removed ones. The
///   legacy `QUERY_UPDATE (0x36)` binary frame was retired in
///   `planning/drop-query-update.md`; the SUBSCRIBE_QUERY registration
///   primitive itself was kept because it lets a client say "watch this
///   set of resources" without binding to a whole drive.
#[allow(clippy::mutable_key_type)]
pub struct CommitMonitor {
    /// Maintains a list of all the resources that are being subscribed to, and maps these to websocket connections.
    /// Inner map: subscriber `Addr` → `source_id`. The id is used to suppress
    /// broadcasts back to the connection that originated the change.
    subscriptions: HashMap<atomic_lib::Subject, HashMap<Addr<WebSocketConnection>, String>>,
    /// Drive-wide subscriptions: keyed by drive subject string.
    drive_subscriptions: HashMap<String, HashMap<Addr<WebSocketConnection>, String>>,
    /// Filter subscriptions: keyed by encoded `QueryFilter` bytes.
    query_subscriptions: HashMap<Vec<u8>, HashMap<Addr<WebSocketConnection>, String>>,
    store: Db,
    search_state: SearchState,
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
                }
            });

            // Bridge DbEvents to actor messages. Drive-wide and resource
            // subscription notifications no longer need a listener — every
            // commit already routes through `Handler<CommitMessage>` (set
            // via `set_handle_commit` in `appstate.rs`), which fans the
            // full commit (snapshot + commit_id) to those subscribers.
            //
            // What we *do* listen for here is filter-membership changes:
            // `QueryMembershipChanged` events fire when a resource's
            // properties change in a way that affects a watched
            // `SUBSCRIBE_QUERY`. We pre-fetch the resource state for
            // additions so the receiving WebSocketConnection can encode
            // an `UPDATE` (full snapshot + commit_id) directly, without
            // a follow-up store hop. Removals just forward the subject
            // and let the receiver encode `DESTROY`.
            let mut events_rx = self.store.subscribe_events();
            let addr = ctx.address();
            let store_for_listener = self.store.clone();
            tokio::spawn(async move {
                while let Ok(event) = events_rx.recv().await {
                    if let DbEvent::QueryMembershipChanged {
                        filter_bytes,
                        subject,
                        added,
                        source_id,
                    } = event
                    {
                        // Pre-fetch state for additions so the inner
                        // hot path (subscriber fanout in the actor)
                        // stays cheap. For removals we don't need
                        // anything beyond the subject.
                        let (loro_snapshot, commit_id) = if added {
                            match store_for_listener
                                .get_resource(&atomic_lib::Subject::from_raw(
                                    &subject,
                                    store_for_listener.get_base_domain().as_deref(),
                                ))
                                .await
                            {
                                Ok(resource) => {
                                    let snapshot = resource
                                        .materialized_state()
                                        .or_else(|| {
                                            resource
                                                .build_state_doc()
                                                .ok()
                                                .map(|doc| doc.export_snapshot())
                                        })
                                        .unwrap_or_default();
                                    let cid = resource
                                        .get(atomic_lib::urls::LAST_COMMIT)
                                        .ok()
                                        .map(|v| v.to_string())
                                        .filter(|s| !s.is_empty());
                                    (
                                        if snapshot.is_empty() {
                                            None
                                        } else {
                                            Some(Arc::from(snapshot.into_boxed_slice()))
                                        },
                                        cid,
                                    )
                                }
                                Err(_) => (None, None),
                            }
                        } else {
                            (None, None)
                        };

                        addr.do_send(MembershipNotification {
                            filter_bytes,
                            subject,
                            added,
                            loro_snapshot,
                            commit_id,
                            source_id,
                        });
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

    // A message comes in when a client subscribes to a subject.
    #[tracing::instrument(
        name = "handle_subscribe",
        skip_all,
        fields(to = %msg.subject, agent = %msg.agent)
    )]
    fn handle(&mut self, msg: Subscribe, _ctx: &mut Context<Self>) -> Self::Result {
        let store = self.store.clone();
        Box::pin(
            async move {
                // check if the agent has the rights to subscribe to this resource
                if !msg.subject.is_local() {
                    tracing::warn!("can't subscribe to external resource: {}", msg.subject);
                    return None;
                }
                match store.get_resource(&msg.subject).await {
                    Ok(resource) => {
                        match atomic_lib::hierarchy::check_read(
                            &store,
                            &resource,
                            &ForAgent::AgentSubject(msg.agent.clone().into()),
                        )
                        .await
                        {
                            Ok(_explanation) => Some(msg),
                            Err(unauthorized_err) => {
                                tracing::debug!(
                                    "Not allowed {} to subscribe to {}: {}",
                                    &msg.agent,
                                    &msg.subject,
                                    unauthorized_err
                                );
                                None
                            }
                        }
                    }
                    Err(e) => {
                        tracing::debug!(
                            "Subscribe failed for {} by {}: {}",
                            &msg.subject,
                            msg.agent,
                            e
                        );
                        None
                    }
                }
            }
            .into_actor(self)
            .map(|msg, actor, _ctx| {
                #[allow(clippy::mutable_key_type)]
                if let Some(msg) = msg {
                    let set = actor.subscriptions.entry(msg.subject.clone()).or_default();
                    set.insert(msg.addr, msg.source_id);
                    tracing::debug!("handle subscribe {} ", msg.subject);
                }
            }),
        )
    }
}

impl Handler<SubscribeDrive> for CommitMonitor {
    type Result = ResponseActFuture<Self, ()>;

    /// Auth gate: agent must have read access on the drive resource.
    /// Same shape as [`Handler<Subscribe>`] but the result lands in
    /// `drive_subscriptions` so [`Handler<CommitMessage>`] fans every
    /// commit under that drive to this connection.
    #[tracing::instrument(
        name = "handle_subscribe_drive",
        skip_all,
        fields(drive = %msg.drive, agent = %msg.agent)
    )]
    fn handle(&mut self, msg: SubscribeDrive, _ctx: &mut Context<Self>) -> Self::Result {
        let store = self.store.clone();
        Box::pin(
            async move {
                let drive_subject = atomic_lib::Subject::from_raw(
                    &msg.drive,
                    store.get_base_domain().as_deref(),
                );
                let resource = match store.get_resource(&drive_subject).await {
                    Ok(r) => r,
                    Err(e) => {
                        tracing::debug!("SubscribeDrive: drive {drive_subject} not found: {e}");
                        return None;
                    }
                };
                match atomic_lib::hierarchy::check_read(
                    &store,
                    &resource,
                    &ForAgent::AgentSubject(msg.agent.clone().into()),
                )
                .await
                {
                    Ok(_) => Some(msg),
                    Err(e) => {
                        tracing::debug!(
                            "SubscribeDrive: {} cannot read drive {drive_subject}: {e}",
                            msg.agent
                        );
                        None
                    }
                }
            }
            .into_actor(self)
            .map(|maybe_msg, actor, _ctx| {
                #[allow(clippy::mutable_key_type)]
                if let Some(msg) = maybe_msg {
                    let entry = actor.drive_subscriptions.entry(msg.drive).or_default();
                    entry.insert(msg.addr, msg.source_id);
                }
            }),
        )
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

impl Handler<SubscribeQuery> for CommitMonitor {
    type Result = ResponseActFuture<Self, ()>;

    /// Auth gate: the filter must name a drive, and the requesting agent
    /// must have read access on that drive. The filter is encoded as a
    /// `QueryFilter` and watched in `Tree::WatchedQueries`, so
    /// `DbEvent::QueryMembershipChanged` will fire whenever a resource
    /// enters/leaves the result set — see the listener task in
    /// `Actor::started`.
    fn handle(&mut self, msg: SubscribeQuery, _ctx: &mut Context<Self>) -> Self::Result {
        let store = self.store.clone();
        let agent = msg.agent.clone();
        let drive_opt = msg.query.drive.clone();

        Box::pin(
            async move {
                let drive_str = match drive_opt {
                    Some(s) => s,
                    None => {
                        tracing::debug!(
                            "Rejecting SUBSCRIBE_QUERY: filter has no drive scope (agent={agent})"
                        );
                        return None;
                    }
                };
                let drive_subject = atomic_lib::Subject::from_raw(
                    &drive_str,
                    store.get_base_domain().as_deref(),
                );
                let resource = match store.get_resource(&drive_subject).await {
                    Ok(r) => r,
                    Err(e) => {
                        tracing::debug!(
                            "Rejecting SUBSCRIBE_QUERY: drive {drive_subject} not found: {e}"
                        );
                        return None;
                    }
                };
                match atomic_lib::hierarchy::check_read(
                    &store,
                    &resource,
                    &ForAgent::AgentSubject(agent.clone().into()),
                )
                .await
                {
                    Ok(_) => Some(msg),
                    Err(e) => {
                        tracing::debug!(
                            "Rejecting SUBSCRIBE_QUERY: {agent} cannot read drive {drive_subject}: {e}"
                        );
                        None
                    }
                }
            }
            .into_actor(self)
            .map(|maybe_msg, actor, _ctx| {
                #[allow(clippy::mutable_key_type)]
                if let Some(msg) = maybe_msg {
                    actor.register_filter_subscription(msg);
                }
            }),
        )
    }
}

impl Handler<UnsubscribeQuery> for CommitMonitor {
    type Result = ();

    fn handle(&mut self, msg: UnsubscribeQuery, _ctx: &mut Context<Self>) {
        for conns in self.query_subscriptions.values_mut() {
            conns.remove(&msg.addr);
        }
        self.query_subscriptions
            .retain(|_, conns| !conns.is_empty());
    }
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

        for conns in self.query_subscriptions.values_mut() {
            conns.remove(&msg.addr);
        }
        self.query_subscriptions
            .retain(|_, conns| !conns.is_empty());
    }
}

impl Handler<MembershipNotification> for CommitMonitor {
    type Result = ();

    /// Fan a filter membership change out to every subscriber of that
    /// filter. The receiving WebSocketConnection encodes an `UPDATE`
    /// (for `added`, using the pre-fetched snapshot + commit_id) or a
    /// `DESTROY` (for removed).
    fn handle(&mut self, msg: MembershipNotification, _ctx: &mut Context<Self>) {
        let Some(subscribers) = self.query_subscriptions.get(&msg.filter_bytes) else {
            return;
        };
        if subscribers.is_empty() {
            return;
        }

        for (addr, sub_source) in subscribers {
            if skip_same_source(msg.source_id.as_deref(), sub_source) {
                continue;
            }
            addr.do_send(msg.clone());
        }
    }
}

impl CommitMonitor {
    /// Register a filter subscription. Called only after the auth check
    /// in `Handler<SubscribeQuery>` has passed.
    #[allow(clippy::mutable_key_type)]
    fn register_filter_subscription(&mut self, msg: SubscribeQuery) {
        let SubscribeQuery {
            addr,
            query,
            agent: _,
            source_id,
        } = msg;

        let drive_str = match query.drive.as_ref() {
            Some(d) => d.clone(),
            None => return,
        };

        // Property+value filter → encode as QueryFilter and watch.
        // Property-only / drive-only filters aren't supported here; the
        // drive-wide case is already covered by `SUB <drive>`.
        let (Some(prop), Some(val_str)) = (query.property.as_ref(), query.value.as_ref()) else {
            tracing::debug!(
                "SUBSCRIBE_QUERY without both property and value — drive-wide subs use SUB"
            );
            return;
        };

        let drive_subject =
            atomic_lib::Subject::from_raw(&drive_str, self.store.get_base_domain().as_deref());
        let q_filter = QueryFilter {
            property: Some(prop.clone()),
            value: Some(Value::String(val_str.clone())),
            sort_by: query.sort_by.clone(),
            drive: drive_subject,
        };

        let filter_bytes = match q_filter.encode() {
            Ok(b) => b,
            Err(e) => {
                tracing::warn!("SUBSCRIBE_QUERY: failed to encode QueryFilter: {e}");
                return;
            }
        };

        if let Err(e) = q_filter.watch(&self.store) {
            tracing::warn!("SUBSCRIBE_QUERY: failed to register in WatchedQueries: {e}");
        }

        let entry = self.query_subscriptions.entry(filter_bytes).or_default();
        entry.insert(addr, source_id);
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
                for (connection, sub_source) in subscribers {
                    if skip_same_source(event_source, sub_source) {
                        continue;
                    }
                    connection.do_send(SendFrame {
                        frame: frame.clone(),
                    });
                }
            } else {
                tracing::debug!("No subscribers for {}", target_subject);
            }

            // Drive-wide subscribers. HTTP subjects prefix-match the drive
            // URL; DID subjects can't be prefix-matched so they fan out to
            // every drive subscriber (the client's commit-id dedup
            // absorbs the noise). The connection-id source suppression
            // still applies, so the originating tab doesn't get its own
            // commit echoed back.
            let subject_str = target_subject.to_string();
            let is_did = subject_str.starts_with("did:");
            for (drive, subscribers) in &self.drive_subscriptions {
                if !is_did && !subject_str.starts_with(drive.as_str()) {
                    continue;
                }
                for (connection, sub_source) in subscribers {
                    if skip_same_source(event_source, sub_source) {
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
        let resource_new = msg.commit_response.resource_new.clone();
        let target_str = target_subject.to_string();

        Box::pin(
            async move {
                search_state.remove_resource(&target_str).map_err(|e| {
                    format!(
                        "Handling commit in CommitMonitor failed, cache may not be fully updated: {}",
                        e
                    )
                })?;
                if let Some(resource) = resource_new {
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
                        .add_resource(&resource, &store)
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
    let origin = store
        .get_base_domain()
        .unwrap_or_else(|| "http://localhost".to_string());
    let subject_resolved = commit.subject.resolve(&origin);

    if let Some(loro_update) = &commit.loro_update {
        // The wire `commit_id` becomes the client's `lastCommit`
        // propval and, on its next commit, its `previousCommit`. The
        // latter is parsed as an AtomicURL by the server's JSON-AD
        // parser — a raw base64 signature isn't a URL and gets
        // rejected. Always emit the full `did:ad:commit:{signature}`
        // DID. (`commit.url` is never populated in practice, so the
        // previous `or(signature)` fallback was always taken —
        // silently dropping the prefix.)
        let commit_id_owned = commit
            .url
            .clone()
            .or_else(|| {
                commit
                    .signature
                    .as_ref()
                    .map(|s| format!("did:ad:commit:{}", s))
            })
            .unwrap_or_default();
        let frame = ws_v2::encode_update(
            ws_v2::flags::HAS_COMMIT_ID | ws_v2::flags::PUSH,
            0,
            &subject_resolved,
            Some(commit_id_owned.as_str()),
            loro_update,
        );
        Some(Arc::from(frame.into_boxed_slice()))
    } else if commit.destroy.unwrap_or(false) {
        let frame = ws_v2::encode_destroy(0, &subject_resolved);
        Some(Arc::from(frame.into_boxed_slice()))
    } else {
        None
    }
}

/// Spawns a commit monitor actor
pub fn create_commit_monitor(store: Db, search_state: SearchState) -> Addr<CommitMonitor> {
    tracing::info!("spawning commit monitor");
    crate::commit_monitor::CommitMonitor::create(|_ctx: &mut Context<CommitMonitor>| {
        CommitMonitor {
            subscriptions: HashMap::new(),
            drive_subscriptions: HashMap::new(),
            query_subscriptions: HashMap::new(),
            store,
            search_state,
            pending_commit: Arc::new(AtomicBool::new(false)),
        }
    })
}
