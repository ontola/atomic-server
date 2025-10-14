use crate::{
    actor_messages::{Subscribe, Unsubscribe, YAwarenessUpdate},
    errors::AtomicServerResult,
    handlers::web_sockets::WebSocketConnection,
};

use actix::{
    prelude::{Actor, Context, Handler},
    Addr,
};
use atomic_lib::{agents::ForAgent, Db, Storelike};
use std::collections::{HashMap, HashSet};

pub struct YAwarenessBroadcaster {
    subscriptions: HashMap<String, HashSet<Addr<WebSocketConnection>>>,
    store: Db,
}

impl Actor for YAwarenessBroadcaster {
    type Context = Context<Self>;

    fn started(&mut self, _ctx: &mut Context<Self>) {
        tracing::debug!("YAwarenessBroadcaster started");
    }
}

impl Handler<Subscribe> for YAwarenessBroadcaster {
    type Result = ();

    fn handle(&mut self, msg: Subscribe, _ctx: &mut Context<Self>) {
        if !msg.subject.starts_with(&self.store.get_self_url().unwrap()) {
            tracing::warn!("can't subscribe to external resource");
            return;
        }

        match self.store.get_resource(&msg.subject) {
            Ok(resource) => {
                match atomic_lib::hierarchy::check_read(
                    &self.store,
                    &resource,
                    &ForAgent::AgentSubject(msg.agent.clone()),
                ) {
                    Ok(_explanation) => {
                        let mut set = self
                            .subscriptions
                            .get(&msg.subject)
                            .unwrap_or(&HashSet::new())
                            .clone();

                        set.insert(msg.addr);
                        tracing::debug!("handle subscribe {} ", msg.subject);
                        self.subscriptions.insert(msg.subject.clone(), set);
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
            Err(e) => {
                tracing::debug!(
                    "Subscribe failed for {} by {}: {}",
                    &msg.subject,
                    msg.agent,
                    e
                );
            }
        }
    }
}

impl Handler<Unsubscribe> for YAwarenessBroadcaster {
    type Result = ();

    fn handle(&mut self, msg: Unsubscribe, _ctx: &mut Context<Self>) {
        let Some(subscriber) = self.subscriptions.get(&msg.subject) else {
            tracing::warn!("no subscribers for {}", msg.subject);
            return;
        };

        let mut new_subscriber = subscriber.clone();
        new_subscriber.remove(&msg.addr);
        self.subscriptions
            .insert(msg.subject.clone(), new_subscriber);
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

impl Handler<YAwarenessUpdate> for YAwarenessBroadcaster {
    type Result = ();

    fn handle(&mut self, msg: YAwarenessUpdate, _ctx: &mut Context<Self>) {
        let Some(subscribers) = self.subscriptions.get(&msg.subject) else {
            tracing::warn!("no subscribers for {}", msg.subject);
            return ();
        };

        for subscriber in subscribers {
            subscriber.do_send(msg.clone());
        }
    }
}

pub fn create_y_awareness_broadcaster(store: Db) -> Addr<YAwarenessBroadcaster> {
    YAwarenessBroadcaster::create(|_ctx: &mut Context<YAwarenessBroadcaster>| {
        YAwarenessBroadcaster {
            subscriptions: HashMap::new(),
            store,
        }
    })
}
