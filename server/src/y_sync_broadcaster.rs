use crate::{
    actor_messages::{SubscribeYSync, UnsubscribeYSync, YSyncUpdate},
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

pub struct YSyncBroadcaster {
    subscriptions: HashMap<(String, String), HashSet<Subscription>>,
    store: Db,
}

impl Actor for YSyncBroadcaster {
    type Context = Context<Self>;

    fn started(&mut self, _ctx: &mut Context<Self>) {
        tracing::debug!("YAwarenessBroadcaster started");
    }
}

impl Handler<SubscribeYSync> for YSyncBroadcaster {
    type Result = ResponseActFuture<Self, ()>;

    fn handle(&mut self, msg: SubscribeYSync, _ctx: &mut Context<Self>) -> Self::Result {
        let store = self.store.clone();
        Box::pin(
            async move {
                let self_url = store.get_self_url().unwrap();
                if !msg.subject.starts_with(&self_url) {
                    tracing::warn!("can't subscribe to external resource");
                    return None;
                }
                let key = (msg.subject.clone(), msg.property.clone());

                let resource = match store.get_resource(&msg.subject).await {
                    Ok(resource) => resource,
                    Err(e) => {
                        tracing::debug!(
                            "Subscribe failed for {} by {}: {}",
                            &msg.subject,
                            msg.agent,
                            e
                        );
                        return None;
                    }
                };

                let mut can_write = false;

                // First check if the agent has write rights, if not, check for read rights, if not, don't subscribe.
                match atomic_lib::hierarchy::check_write(
                    &store,
                    &resource,
                    &ForAgent::AgentSubject(msg.agent.clone()),
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
                            &ForAgent::AgentSubject(msg.agent.clone()),
                        )
                        .await
                        {
                            Ok(_) => {}
                            Err(unauthorized_err) => {
                                tracing::debug!(
                                    "Not allowed {} to subscribe to {}: {}",
                                    &msg.agent,
                                    &msg.subject,
                                    unauthorized_err
                                );
                                return None;
                            }
                        }
                    }
                }
                Some((key, msg.addr, can_write, msg.subject))
            }
            .into_actor(self)
            .map(|res, actor, _ctx| {
                if let Some((key, addr, can_write, subject)) = res {
                    let mut set = actor
                        .subscriptions
                        .get(&key)
                        .unwrap_or(&HashSet::new())
                        .clone();

                    set.insert(Subscription { addr, can_write });
                    tracing::debug!("handle subscribe {} ", subject);
                    actor.subscriptions.insert(key, set);
                }
            }),
        )
    }
}

impl Handler<UnsubscribeYSync> for YSyncBroadcaster {
    type Result = ();

    fn handle(&mut self, msg: UnsubscribeYSync, _ctx: &mut Context<Self>) {
        let key = (msg.subject.clone(), msg.property.clone());

        let Some(subscriber) = self.subscriptions.get(&key) else {
            tracing::warn!("no subscribers for {}", msg.subject);
            return;
        };

        let mut new_subscriber = subscriber.clone();
        new_subscriber.retain(|s| s.addr != msg.addr);
        self.subscriptions.insert(key.clone(), new_subscriber);
    }
}

impl Handler<YSyncUpdate> for YSyncBroadcaster {
    type Result = ();

    fn handle(&mut self, msg: YSyncUpdate, _ctx: &mut Context<Self>) {
        let key = (msg.subject.clone(), msg.property.clone());

        let Some(subscribers) = self.subscriptions.get(&key) else {
            tracing::warn!("no subscribers for {}", msg.subject);
            return ();
        };

        // Check if msg.addr is in the subscibers and has write rights, if not, don't send the update.
        let Some(addr) = &msg.addr else {
            tracing::warn!("no addr in update for {}", msg.subject);
            return ();
        };

        if subscribers
            .iter()
            .find(|s| s.addr == *addr && s.can_write)
            .is_none()
        {
            tracing::warn!("not allowed to send update to {}", msg.subject);
            return ();
        }

        for subscriber in subscribers {
            subscriber.addr.do_send(msg.clone());
        }
    }
}

pub fn create_y_sync_broadcaster(store: Db) -> Addr<YSyncBroadcaster> {
    YSyncBroadcaster::create(|_ctx: &mut Context<YSyncBroadcaster>| YSyncBroadcaster {
        subscriptions: HashMap::new(),
        store,
    })
}
