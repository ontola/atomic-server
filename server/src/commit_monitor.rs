//! The Commit Monitor checks for new commits and notifies listeners.
//! It is used for WebSockets to notify front-end clients of changes in Resources,
//! and to update the Search index.

use crate::{
    actor_messages::{CommitMessage, Subscribe},
    errors::AtomicServerResult,
    handlers::web_sockets::WebSocketConnection,
    search::SearchState,
};
use actix::{
    prelude::{Actor, Context, Handler},
    ActorFutureExt, ActorStreamExt, Addr, ContextFutureSpawner, ResponseActFuture, WrapFuture,
};
use atomic_lib::{agents::ForAgent, Db, Storelike};
use chrono::Local;
use std::collections::{HashMap, HashSet};

/// The Commit Monitor is an Actor that manages subscriptions for subjects and sends Commits to listeners.
/// It's also responsible for checking whether the rights are present
pub struct CommitMonitor {
    /// Maintains a list of all the resources that are being subscribed to, and maps these to websocket connections.
    subscriptions: HashMap<String, HashSet<Addr<WebSocketConnection>>>,
    store: Db,
    search_state: SearchState,
    vector_search_state: crate::vector_search::VectorSearchState,
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

        // spawn an interval stream into our context
        actix::utils::IntervalFunc::new(REBUILD_INDEX_TIME, Self::tick)
            .finish()
            .spawn(ctx);
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
                let self_url = store
                    .get_self_url()
                    .expect("No self url set in Commit Monitor");
                if !msg.subject.starts_with(&self_url) {
                    tracing::warn!("can't subscribe to external resource");
                    return None;
                }
                match store.get_resource(&msg.subject).await {
                    Ok(resource) => {
                        match atomic_lib::hierarchy::check_read(
                            &store,
                            &resource,
                            &ForAgent::AgentSubject(msg.agent.clone()),
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
        // polarisdb writes are auto-flushed, but we can flush here to be safe
        // let _ = futures::executor::block_on(self.vector_search_state.collection.write()).flush();
        self.last_search_commit = chrono::Local::now();
        self.run_expensive_next_tick = false;
        Ok(())
    }
}

impl Handler<CommitMessage> for CommitMonitor {
    type Result = ResponseActFuture<Self, ()>;

    #[tracing::instrument(name = "handle_commit_message", skip_all, fields(subscriptions = &self.subscriptions.len(), s = %msg.commit_response.commit_resource.get_subject()))]
    fn handle(&mut self, msg: CommitMessage, _: &mut Context<Self>) -> Self::Result {
        let target = msg.commit_response.commit.subject.clone();

        // Notify websocket listeners
        if let Some(subscribers) = self.subscriptions.get(&target) {
            tracing::debug!(
                "Sending commit {} to {} subscribers",
                target,
                subscribers.len()
            );
            for connection in subscribers {
                connection.do_send(msg.clone());
            }
        } else {
            tracing::debug!("No subscribers for {}", target);
        }

        let store = self.store.clone();
        let search_state = self.search_state.clone();
        let vector_search_state = self.vector_search_state.clone();
        let resource_new = msg.commit_response.resource_new.clone();

        Box::pin(
            async move {
                search_state.remove_resource(&target).map_err(|e| {
                    format!(
                        "Handling commit in CommitMonitor failed, cache may not be fully updated: {}",
                        e
                    )
                })?;
                vector_search_state.remove_resource(&target).await.map_err(|e| {
                    format!(
                        "Handling commit in CommitMonitor failed for vector search: {}",
                        e
                    )
                })?;
                if let Some(resource) = resource_new {
                    // We could one day re-(allow) to keep old resources,
                    // but then we also should index the older versions when re-indexing.
                    // Add new resource to search index
                    search_state
                        .add_resource(&resource, &store)
                        .await
                        .map_err(|e| {
                            format!(
                    "Handling commit in CommitMonitor failed, cache may not be fully updated: {}",
                    e
                )
                        })?;
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
pub fn create_commit_monitor(store: Db, search_state: SearchState, vector_search_state: crate::vector_search::VectorSearchState) -> Addr<CommitMonitor> {
    tracing::info!("spawning commit monitor");
    crate::commit_monitor::CommitMonitor::create(|_ctx: &mut Context<CommitMonitor>| {
        CommitMonitor {
            subscriptions: HashMap::new(),
            store,
            search_state,
            vector_search_state,
            run_expensive_next_tick: false,
            last_search_commit: chrono::Local::now(),
        }
    })
}
