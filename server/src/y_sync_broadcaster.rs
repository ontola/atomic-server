use crate::{
    actor_messages::{SubscribeYSync, UnsubscribeYSync, YSyncUpdate},
    handlers::web_sockets::WebSocketConnection,
};

use actix::{
    prelude::{Actor, Context, Handler},
    Addr,
};
use atomic_lib::{agents::ForAgent, Db, Storelike};
use std::collections::{HashMap, HashSet};

pub struct YSyncBroadcaster {
    subscriptions: HashMap<(String, String), HashSet<Addr<WebSocketConnection>>>,
    store: Db,
}

impl Actor for YSyncBroadcaster {
    type Context = Context<Self>;

    fn started(&mut self, _ctx: &mut Context<Self>) {
        tracing::debug!("YAwarenessBroadcaster started");
    }
}

impl Handler<SubscribeYSync> for YSyncBroadcaster {
    type Result = ();

    fn handle(&mut self, msg: SubscribeYSync, _ctx: &mut Context<Self>) {
        if !msg.subject.starts_with(&self.store.get_self_url().unwrap()) {
            tracing::warn!("can't subscribe to external resource");
            return;
        }
        let key = (msg.subject.clone(), msg.property.clone());

        let resource = match self.store.get_resource(&msg.subject) {
            Ok(resource) => resource,
            Err(e) => {
                tracing::debug!(
                    "Subscribe failed for {} by {}: {}",
                    &msg.subject,
                    msg.agent,
                    e
                );
                return;
            }
        };

        match atomic_lib::hierarchy::check_read(
            &self.store,
            &resource,
            &ForAgent::AgentSubject(msg.agent.clone()),
        ) {
            Ok(_explanation) => {
                let mut set = self
                    .subscriptions
                    .get(&key)
                    .unwrap_or(&HashSet::new())
                    .clone();

                set.insert(msg.addr);
                tracing::debug!("handle subscribe {} ", msg.subject);
                self.subscriptions.insert(key.clone(), set);
            }
            Err(unauthorized_err) => {
                tracing::debug!(
                    "Not allowed {} to subscribe to {}: {}",
                    &msg.agent,
                    &msg.subject,
                    unauthorized_err
                );
            }
        }
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
        new_subscriber.remove(&msg.addr);
        self.subscriptions.insert(key.clone(), new_subscriber);
    }
}

// impl YAwarenessBroadcaster {
//     fn broadcast_awareness_update(&mut self, msg: YAwarenessUpdate) -> AtomicServerResult<()> {
//         let Some(subscribers) = self.subscriptions.get(&msg.subject) else {
//             tracing::warn!("no subscribers for {}", msg.subject);
//             return Ok(());
//         };

//         for subscriber in subscribers {
//             subscriber.do_send(msg.clone());
//         }

//         Ok(())
//     }
// }

impl Handler<YSyncUpdate> for YSyncBroadcaster {
    type Result = ();

    fn handle(&mut self, msg: YSyncUpdate, _ctx: &mut Context<Self>) {
        let key = (msg.subject.clone(), msg.property.clone());

        let Some(subscribers) = self.subscriptions.get(&key) else {
            tracing::warn!("no subscribers for {}", msg.subject);
            return ();
        };

        for subscriber in subscribers {
            subscriber.do_send(msg.clone());
        }
    }
}

pub fn create_y_sync_broadcaster(store: Db) -> Addr<YSyncBroadcaster> {
    YSyncBroadcaster::create(|_ctx: &mut Context<YSyncBroadcaster>| YSyncBroadcaster {
        subscriptions: HashMap::new(),
        store,
    })
}
