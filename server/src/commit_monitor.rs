//! The Commit Monitor checks for new commits and notifies listeners.
//! It is used for WebSockets to notify front-end clients of changes in Resources,
//! and to update the Search index.

use crate::{
    actor_messages::{
        CommitMessage, DriveNotification, MembershipNotification, QueryUpdate, Subscribe,
        SubscribeQuery, UnsubscribeQuery,
    },
    handlers::web_sockets::WebSocketConnection,
    search::SearchState,
};
use actix::{
    prelude::{Actor, AsyncContext, Context, Handler},
    ActorFutureExt, Addr, ResponseActFuture, WrapFuture,
};
use atomic_lib::{agents::ForAgent, db::QueryFilter, Db, DbEvent, Storelike, Value};
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

/// The Commit Monitor is an Actor that manages subscriptions for subjects and sends Commits to listeners.
/// It's also responsible for checking whether the rights are present.
///
/// Every query subscription requires a drive (auth boundary). Two
/// dispatch shapes follow from the filter shape:
///
/// - **Filter subscriptions** (`query_subscriptions`): property + value +
///   drive. Encoded as a [`QueryFilter`], registered in
///   `Tree::WatchedQueries`. Membership changes surface as
///   [`DbEvent::QueryMembershipChanged`] events; the listener task in
///   [`Actor::started`] forwards them as [`MembershipNotification`].
/// - **Drive subscriptions** (`drive_subscriptions`): drive only, no
///   property/value. Match every change in that drive. Notifications come
///   from `DbEvent::Changed` / `Destroyed` events forwarded as
///   [`DriveNotification`].
///
/// Both flow through the same `db_events` listener; the actor's
/// `CommitMessage` handler no longer scans subscriptions itself.
#[allow(clippy::mutable_key_type)]
pub struct CommitMonitor {
    /// Maintains a list of all the resources that are being subscribed to, and maps these to websocket connections.
    subscriptions: HashMap<atomic_lib::Subject, HashSet<Addr<WebSocketConnection>>>,
    /// Filter subscriptions: keyed by encoded `QueryFilter` bytes.
    query_subscriptions: HashMap<Vec<u8>, HashSet<Addr<WebSocketConnection>>>,
    /// Drive-wide subscriptions: keyed by drive subject string.
    drive_subscriptions: HashMap<String, HashSet<Addr<WebSocketConnection>>>,
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

// Only runs expensive index operation (tantivy) once every x seconds
const REBUILD_INDEX_TIME: std::time::Duration = std::time::Duration::from_secs(5);

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
            tokio::spawn(async move {
                let mut interval = tokio::time::interval(REBUILD_INDEX_TIME);
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
                                tracing::error!(
                                    "Tantivy commit failed: {}",
                                    e
                                );
                                // Re-arm so the next pass retries.
                                flag.store(true, Ordering::Release);
                            }
                        }
                        Err(e) => {
                            tracing::error!(
                                "Tantivy writer lock poisoned: {}",
                                e
                            );
                            flag.store(true, Ordering::Release);
                        }
                    }
                }
            });

            // Bridge DbEvents to actor messages. All query-subscription
            // notifications flow through this listener:
            // - `QueryMembershipChanged` → `MembershipNotification` for
            //   filter subscriptions (property+value+drive).
            // - `Changed` / `Destroyed` → `DriveNotification` for drive-wide
            //   subscriptions.
            let mut events_rx = self.store.subscribe_events();
            let addr = ctx.address();
            tokio::spawn(async move {
                while let Ok(event) = events_rx.recv().await {
                    match event {
                        DbEvent::QueryMembershipChanged {
                            filter_bytes,
                            subject,
                            added,
                        } => {
                            addr.do_send(MembershipNotification {
                                filter_bytes,
                                subject,
                                added,
                            });
                        }
                        DbEvent::Changed { subject, .. } => {
                            // `did:ad:commit:<sig>` resources are write-time
                            // metadata: each successful commit stores one,
                            // which fires its own `DbEvent::Changed`. Clients
                            // never need to fetch them through the
                            // drive-wide subscription channel — the UI
                            // doesn't render commits, and the per-resource
                            // `lastCommit` reference reaches the client
                            // alongside the resource the commit applies to.
                            // Forwarding them was producing redundant
                            // `QUERY_UPDATE` frames per row save (one for
                            // the commit, one for the resource), each
                            // triggering its own GET on the client.
                            if subject.is_commit_did() {
                                continue;
                            }
                            addr.do_send(DriveNotification {
                                subject: subject.to_string(),
                                removed: false,
                            });
                        }
                        DbEvent::Destroyed { subject } => {
                            if subject.is_commit_did() {
                                continue;
                            }
                            addr.do_send(DriveNotification {
                                subject: subject.to_string(),
                                removed: true,
                            });
                        }
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
                    let set = actor
                        .subscriptions
                        .entry(msg.subject.clone())
                        .or_insert_with(HashSet::new);
                    set.insert(msg.addr);
                    tracing::debug!("handle subscribe {} ", msg.subject);
                }
            }),
        )
    }
}

impl Handler<SubscribeQuery> for CommitMonitor {
    type Result = ResponseActFuture<Self, ()>;

    /// Auth gate: the filter must name a drive, and the requesting agent
    /// must have read access on that drive. Without this, any authenticated
    /// agent could receive `QUERY_UPDATE`s for resources they can't read —
    /// see `server/tests/query_subscribe.rs::query_subscribe_requires_read_permission`.
    fn handle(&mut self, msg: SubscribeQuery, _ctx: &mut Context<Self>) -> Self::Result {
        tracing::info!(
            property = ?msg.query.property,
            value = ?msg.query.value,
            drive = ?msg.query.drive,
            agent = %msg.agent,
            "Query subscription requested"
        );

        let store = self.store.clone();
        let agent = msg.agent.clone();
        let drive_opt = msg.query.drive.clone();

        Box::pin(
            async move {
                let drive_str = match drive_opt {
                    Some(s) => s,
                    None => {
                        tracing::debug!(
                            "Rejecting query subscription: filter has no drive scope (agent={agent})"
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
                            "Rejecting query subscription: drive {drive_subject} not found: {e}"
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
                            "Rejecting query subscription: {agent} cannot read drive {drive_subject}: {e}"
                        );
                        None
                    }
                }
            }
            .into_actor(self)
            .map(|maybe_msg, actor, _ctx| {
                #[allow(clippy::mutable_key_type)]
                if let Some(msg) = maybe_msg {
                    let registered_agent = msg.agent.clone();
                    actor.register_subscription(msg);
                    tracing::debug!("Query subscription registered for {registered_agent}");
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
        for conns in self.drive_subscriptions.values_mut() {
            conns.remove(&msg.addr);
        }
        self.query_subscriptions
            .retain(|_, conns| !conns.is_empty());
        self.drive_subscriptions
            .retain(|_, conns| !conns.is_empty());
    }
}

/// `DbEvent::Changed` / `Destroyed` arriving via the listener task. Match the
/// subject's drive prefix against drive-wide subscriptions and push a
/// minimal `QueryUpdate` (subject only — empty filter). DID-form subjects
/// can't be prefix-matched, so they fan out to every drive subscriber. The
/// client uses this purely to learn that a subject exists and fetches it,
/// at which point `Store.addResources` fires `ResourceUpdated` and each
/// `useCollection` decides locally whether the change is relevant — no more
/// drive-wide `/query` refetch storm.
impl Handler<DriveNotification> for CommitMonitor {
    type Result = ();

    fn handle(&mut self, msg: DriveNotification, _ctx: &mut Context<Self>) {
        if self.drive_subscriptions.is_empty() {
            return;
        }
        let is_did = msg.subject.starts_with("did:");
        for (drive, subscribers) in &self.drive_subscriptions {
            if !is_did && !msg.subject.starts_with(drive.as_str()) {
                continue;
            }
            let update = QueryUpdate {
                property: None,
                value: None,
                added: if !msg.removed {
                    vec![msg.subject.clone()]
                } else {
                    vec![]
                },
                removed: if msg.removed {
                    vec![msg.subject.clone()]
                } else {
                    vec![]
                },
            };
            for addr in subscribers {
                addr.do_send(update.clone());
            }
        }
    }
}

/// `DbEvent::QueryMembershipChanged` arriving via the listener task. Look up
/// listener-path subscribers by `filter_bytes`, decode the filter for the
/// outbound payload, and push to each subscriber as a `QueryUpdate`.
impl Handler<MembershipNotification> for CommitMonitor {
    type Result = ();

    fn handle(&mut self, msg: MembershipNotification, _ctx: &mut Context<Self>) {
        let Some(subscribers) = self.query_subscriptions.get(&msg.filter_bytes) else {
            return;
        };
        if subscribers.is_empty() {
            return;
        }

        // Decode the filter so the wire payload carries the (property, value)
        // the client subscribed with. Subjects with no encoded value flow
        // through as `None`.
        let (property, value) = match QueryFilter::from_bytes(&msg.filter_bytes) {
            Ok(qf) => {
                let v: Option<String> = qf.value.map(|v: Value| format!("{v}"));
                (qf.property, v)
            }
            Err(e) => {
                tracing::debug!("MembershipNotification: skip un-decodable filter: {e}");
                return;
            }
        };

        let (added, removed) = if msg.added {
            (vec![msg.subject], vec![])
        } else {
            (vec![], vec![msg.subject])
        };
        let update = QueryUpdate {
            property,
            value,
            added,
            removed,
        };
        for addr in subscribers {
            addr.do_send(update.clone());
        }
    }
}

impl CommitMonitor {
    /// Dispatch a passed-auth subscription into the right map based on
    /// filter shape. Drive is guaranteed to be set by the auth gate above.
    fn register_subscription(&mut self, msg: SubscribeQuery) {
        let SubscribeQuery {
            addr,
            query,
            agent: _,
        } = msg;

        let drive_str = match query.drive.as_ref() {
            Some(d) => d.clone(),
            None => {
                tracing::debug!("register_subscription: drive missing, dropping");
                return;
            }
        };

        // Filter subscription: property + value + drive → encode as
        // QueryFilter and watch in Tree::WatchedQueries.
        if let (Some(prop), Some(val_str)) = (query.property.as_ref(), query.value.as_ref()) {
            let drive_subject =
                atomic_lib::Subject::from_raw(&drive_str, self.store.get_base_domain().as_deref());
            let q_filter = QueryFilter {
                property: Some(prop.clone()),
                value: Some(Value::String(val_str.clone())),
                sort_by: query.sort_by.clone(),
                drive: drive_subject,
            };
            match q_filter.encode() {
                Ok(filter_bytes) => {
                    if let Err(e) = q_filter.watch(&self.store) {
                        tracing::warn!("Failed to register filter in Tree::WatchedQueries: {e}");
                    }
                    #[allow(clippy::mutable_key_type)]
                    let entry = self
                        .query_subscriptions
                        .entry(filter_bytes)
                        .or_insert_with(HashSet::new);
                    entry.insert(addr);
                    return;
                }
                Err(e) => {
                    tracing::warn!("Failed to encode QueryFilter, dropping subscription: {e}");
                    return;
                }
            }
        }

        // Drive-wide subscription: drive only (no property/value).
        #[allow(clippy::mutable_key_type)]
        let entry = self
            .drive_subscriptions
            .entry(drive_str)
            .or_insert_with(HashSet::new);
        entry.insert(addr);
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

        // Notify websocket listeners
        if let Some(subscribers) = self.subscriptions.get(&target_subject) {
            tracing::debug!(
                "Sending commit {} to {} subscribers",
                target_subject,
                subscribers.len()
            );
            for connection in subscribers {
                connection.do_send(msg.clone());
            }
        } else {
            tracing::debug!("No subscribers for {}", target_subject);
        }

        // Query-subscription notifications now flow through the DbEvents
        // listener task spawned in `started()`, not from this handler.
        // See `Handler<MembershipNotification>` and `Handler<DriveNotification>`.

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

/// Spawns a commit monitor actor
pub fn create_commit_monitor(store: Db, search_state: SearchState) -> Addr<CommitMonitor> {
    tracing::info!("spawning commit monitor");
    crate::commit_monitor::CommitMonitor::create(|_ctx: &mut Context<CommitMonitor>| {
        CommitMonitor {
            subscriptions: HashMap::new(),
            query_subscriptions: HashMap::new(),
            drive_subscriptions: HashMap::new(),
            store,
            search_state,
            pending_commit: Arc::new(AtomicBool::new(false)),
        }
    })
}
