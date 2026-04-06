use crate::{
    actor_messages::{LoroEphemeralUpdate, LoroSyncUpdate, SubscribeLoroSync, UnsubscribeLoroSync},
    handlers::web_sockets::WebSocketConnection,
};

use actix::{
    prelude::{Actor, Context, Handler},
    ActorFutureExt, Addr, ResponseActFuture, WrapFuture,
};
use atomic_lib::{agents::ForAgent, Db, Storelike};
use std::collections::{HashMap, HashSet};

#[derive(Eq, Hash, PartialEq, Clone)]
struct Subscription {
    addr: Addr<WebSocketConnection>,
    can_write: bool,
}

/// Loro CRDT sync broadcaster.
/// Handles real-time document sync updates and ephemeral updates (cursors, presence).
/// Persistent changes go through Commits with loroUpdate — this broadcaster handles
/// only the fast, non-persisted real-time channel.
pub struct LoroSyncBroadcaster {
    /// Subscriptions keyed by resource subject (not per-property — Loro is per-document)
    subscriptions: HashMap<atomic_lib::Subject, HashSet<Subscription>>,
    store: Db,
}

impl Actor for LoroSyncBroadcaster {
    type Context = Context<Self>;

    fn started(&mut self, _ctx: &mut Context<Self>) {
        tracing::debug!("LoroSyncBroadcaster started");
    }
}

impl Handler<SubscribeLoroSync> for LoroSyncBroadcaster {
    type Result = ResponseActFuture<Self, ()>;

    fn handle(&mut self, msg: SubscribeLoroSync, _ctx: &mut Context<Self>) -> Self::Result {
        let store = self.store.clone();
        Box::pin(
            async move {
                if !msg.subject.is_local() {
                    tracing::warn!("can't subscribe to external resource: {}", msg.subject);
                    return None;
                }

                let resource = match store.get_resource(&msg.subject).await {
                    Ok(resource) => resource,
                    Err(e) => {
                        tracing::debug!(
                            "LoroSync subscribe failed for {} by {}: {}",
                            &msg.subject,
                            msg.agent,
                            e
                        );
                        return None;
                    }
                };

                let mut can_write = false;

                match atomic_lib::hierarchy::check_write(
                    &store,
                    &resource,
                    &ForAgent::AgentSubject(msg.agent.clone().into()),
                )
                .await
                {
                    Ok(_) => {
                        can_write = true;
                    }
                    Err(_) => {
                        match atomic_lib::hierarchy::check_read(
                            &store,
                            &resource,
                            &ForAgent::AgentSubject(msg.agent.clone().into()),
                        )
                        .await
                        {
                            Ok(_) => {}
                            Err(unauthorized_err) => {
                                tracing::debug!(
                                    "Not allowed {} to subscribe to LoroSync for {}: {}",
                                    &msg.agent,
                                    &msg.subject,
                                    unauthorized_err
                                );
                                return None;
                            }
                        }
                    }
                }
                Some((msg.subject.clone(), msg.addr, can_write))
            }
            .into_actor(self)
            .map(|res, actor, _ctx| {
                if let Some((subject, addr, can_write)) = res {
                    let set = actor
                        .subscriptions
                        .entry(subject.clone())
                        .or_insert_with(HashSet::new);
                    set.insert(Subscription { addr, can_write });
                    tracing::debug!("LoroSync subscribed to {}", subject);
                }
            }),
        )
    }
}

impl Handler<UnsubscribeLoroSync> for LoroSyncBroadcaster {
    type Result = ();

    fn handle(&mut self, msg: UnsubscribeLoroSync, _ctx: &mut Context<Self>) {
        if let Some(subscribers) = self.subscriptions.get_mut(&msg.subject) {
            subscribers.retain(|s| s.addr != msg.addr);

            if subscribers.is_empty() {
                self.subscriptions.remove(&msg.subject);
            }
        }
    }
}

impl Handler<LoroSyncUpdate> for LoroSyncBroadcaster {
    type Result = ();

    fn handle(&mut self, msg: LoroSyncUpdate, _ctx: &mut Context<Self>) {
        let Some(subscribers) = self.subscriptions.get(&msg.subject) else {
            return;
        };

        let Some(addr) = &msg.addr else {
            tracing::warn!("no addr in LoroSync update for {}", msg.subject);
            return;
        };

        if !subscribers.iter().any(|s| s.addr == *addr && s.can_write) {
            tracing::warn!("not allowed to send LoroSync update to {}", msg.subject);
            return;
        }

        // Broadcast to all subscribers except the sender
        for subscriber in subscribers {
            if subscriber.addr == *addr {
                continue;
            }

            subscriber.addr.do_send(msg.clone());
        }
    }
}

impl Handler<LoroEphemeralUpdate> for LoroSyncBroadcaster {
    type Result = ();

    fn handle(&mut self, msg: LoroEphemeralUpdate, _ctx: &mut Context<Self>) {
        let Some(subscribers) = self.subscriptions.get(&msg.subject) else {
            return;
        };

        let sender = msg.addr.as_ref();

        // Broadcast to all subscribers except the sender
        for subscriber in subscribers {
            if let Some(sender_addr) = sender {
                if subscriber.addr == *sender_addr {
                    continue;
                }
            }
            subscriber.addr.do_send(msg.clone());
        }
    }
}

pub fn create_loro_sync_broadcaster(store: Db) -> Addr<LoroSyncBroadcaster> {
    LoroSyncBroadcaster::create(|_ctx: &mut Context<LoroSyncBroadcaster>| LoroSyncBroadcaster {
        subscriptions: HashMap::new(),
        store,
    })
}
