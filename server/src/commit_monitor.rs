//! The Commit Monitor checks for new commits and notifies listeners.
//! It is used for WebSockets to notify front-end clients of changes in Resources,
//! and to update the Search index.

use crate::{
    actor_messages::{CommitMessage, QueryUpdate, Subscribe, SubscribeQuery, UnsubscribeQuery},
    errors::AtomicServerResult,
    handlers::web_sockets::WebSocketConnection,
    search::SearchState,
};
use actix::{
    prelude::{Actor, AsyncContext, Context, Handler},
    ActorFutureExt, Addr, ResponseActFuture, WrapFuture,
};
use atomic_lib::{agents::ForAgent, Db, Storelike};
use chrono::Local;
use std::collections::{HashMap, HashSet};

/// The Commit Monitor is an Actor that manages subscriptions for subjects and sends Commits to listeners.
/// It's also responsible for checking whether the rights are present
#[allow(clippy::mutable_key_type)]

/// A query subscription entry: the filter + connections watching it.
struct QuerySubscription {
    property: Option<String>,
    value: Option<String>,
    drive: Option<String>,
    connections: HashSet<Addr<WebSocketConnection>>,
}

pub struct CommitMonitor {
    /// Maintains a list of all the resources that are being subscribed to, and maps these to websocket connections.
    subscriptions: HashMap<atomic_lib::Subject, HashSet<Addr<WebSocketConnection>>>,
    /// Query subscriptions: clients watching for new/removed resources matching a filter.
    query_subscriptions: Vec<QuerySubscription>,
    store: Db,
    search_state: SearchState,
    last_search_commit: chrono::DateTime<Local>,
    run_expensive_next_tick: bool,
}

// Only runs expensive index operation (tantivy) once every x seconds
const REBUILD_INDEX_TIME: std::time::Duration = std::time::Duration::from_secs(5);

// Since his Actor only starts once, there is no need to handle its lifecycle
impl Actor for CommitMonitor {
    type Context = Context<Self>;

    fn started(&mut self, ctx: &mut Context<Self>) {
        tracing::debug!("CommitMonitor started");
        if tokio::runtime::Handle::try_current().is_ok() {
            ctx.run_interval(REBUILD_INDEX_TIME, |actor, ctx| {
                actor.tick(ctx);
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
    type Result = ();

    fn handle(&mut self, msg: SubscribeQuery, _ctx: &mut Context<Self>) {
        tracing::info!(
            property = ?msg.query.property,
            value = ?msg.query.value,
            drive = ?msg.query.drive,
            agent = %msg.agent,
            "Query subscription registered"
        );

        // Check if a subscription with the same filter already exists
        for sub in &mut self.query_subscriptions {
            if sub.property == msg.query.property
                && sub.value == msg.query.value
                && sub.drive == msg.query.drive
            {
                sub.connections.insert(msg.addr);
                return;
            }
        }

        let mut connections = HashSet::new();
        connections.insert(msg.addr);
        self.query_subscriptions.push(QuerySubscription {
            property: msg.query.property,
            value: msg.query.value,
            drive: msg.query.drive,
            connections,
        });
    }
}

impl Handler<UnsubscribeQuery> for CommitMonitor {
    type Result = ();

    fn handle(&mut self, msg: UnsubscribeQuery, _ctx: &mut Context<Self>) {
        for sub in &mut self.query_subscriptions {
            sub.connections.remove(&msg.addr);
        }
        // Clean up empty subscriptions
        self.query_subscriptions
            .retain(|sub| !sub.connections.is_empty());
    }
}

impl CommitMonitor {
    /// Runs every X seconds to perform expensive operations.
    fn tick(&mut self, _ctx: &mut Context<Self>) {
        if self.run_expensive_next_tick {
            _ = self.update_expensive().map_err(|e| {
                tracing::error!(
                    "Error during expensive update in Commit Monitor: {}",
                    e.to_string()
                )
            });
        }
    }

    /// Run expensive updates that should not be run after every single Commit
    fn update_expensive(&mut self) -> AtomicServerResult<()> {
        tracing::debug!("Update expensive");
        self.search_state.writer.write()?.commit()?;
        self.last_search_commit = chrono::Local::now();
        self.run_expensive_next_tick = false;
        Ok(())
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

        // Check if any query subscriptions match the commit's atoms.
        if !self.query_subscriptions.is_empty() {
            let commit_subject = msg.commit_response.commit.subject.to_string();

            for sub in &self.query_subscriptions {
                // Drive scope check
                if let Some(drive) = &sub.drive {
                    if !commit_subject.starts_with(drive.as_str())
                        && !commit_subject.starts_with("did:")
                    {
                        continue;
                    }
                }

                let mut matched_add = false;
                let mut matched_remove = false;

                // If no property/value filter, match everything in the drive (drive-wide subscription)
                if sub.property.is_none() && sub.value.is_none() {
                    if sub.drive.is_some() {
                        // Drive-wide: any commit in this drive is a match
                        matched_add = !msg.commit_response.add_atoms.is_empty();
                        matched_remove = !msg.commit_response.remove_atoms.is_empty();
                    }
                } else {
                    // Check added atoms
                    for atom in &msg.commit_response.add_atoms {
                        let prop_matches = sub
                            .property
                            .as_ref()
                            .map(|p| p == &atom.property)
                            .unwrap_or(true);
                        let val_matches = sub
                            .value
                            .as_ref()
                            .map(|v| v == &atom.value.to_string())
                            .unwrap_or(true);
                        if prop_matches && val_matches {
                            matched_add = true;
                            break;
                        }
                    }

                    // Check removed atoms
                    for atom in &msg.commit_response.remove_atoms {
                        let prop_matches = sub
                            .property
                            .as_ref()
                            .map(|p| p == &atom.property)
                            .unwrap_or(true);
                        let val_matches = sub
                            .value
                            .as_ref()
                            .map(|v| v == &atom.value.to_string())
                            .unwrap_or(true);
                        if prop_matches && val_matches {
                            matched_remove = true;
                            break;
                        }
                    }
                }

                if matched_add || matched_remove {
                    let update = QueryUpdate {
                        property: sub.property.clone(),
                        value: sub.value.clone(),
                        added: if matched_add {
                            vec![commit_subject.clone()]
                        } else {
                            vec![]
                        },
                        removed: if matched_remove {
                            vec![commit_subject.clone()]
                        } else {
                            vec![]
                        },
                    };
                    for conn in &sub.connections {
                        conn.do_send(update.clone());
                    }
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
                actor.run_expensive_next_tick = true;
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
            query_subscriptions: Vec::new(),
            store,
            search_state,
            run_expensive_next_tick: false,
            last_search_commit: chrono::Local::now(),
        }
    })
}
