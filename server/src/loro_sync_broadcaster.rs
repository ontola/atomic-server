use crate::{
    actor_messages::{
        LoroEphemeralUpdate, LoroSyncUpdate, PresenceUpdate, SubscribeLoroSync, SubscribePresence,
        UnsubscribeAll, UnsubscribeLoroSync, UnsubscribePresence,
    },
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
///
/// Also hosts the drive-scoped presence channel (`PRESENCE_*` frames):
/// same opaque-relay model, but keyed by drive instead of resource, and
/// with each connection's latest state cached so late joiners are brought
/// up to date at subscribe time.
pub struct LoroSyncBroadcaster {
    /// Subscriptions keyed by resource subject (not per-property — Loro is per-document)
    subscriptions: HashMap<atomic_lib::Subject, HashSet<Subscription>>,
    /// Presence subscriptions keyed by drive subject. The value per
    /// connection is its most recent `PRESENCE_UPDATE` payload (base64
    /// `EphemeralStore.encodeAll()`), replayed to new subscribers. `None`
    /// until the connection first broadcasts.
    #[allow(clippy::mutable_key_type)]
    presence: HashMap<atomic_lib::Subject, HashMap<Addr<WebSocketConnection>, Option<String>>>,
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

    #[allow(clippy::mutable_key_type)]
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

impl Handler<UnsubscribeAll> for LoroSyncBroadcaster {
    type Result = ();

    /// Sent on WebSocket close: remove this connection from every
    /// subject's subscriber set. See `planning/connection-close-cleanup.md`.
    fn handle(&mut self, msg: UnsubscribeAll, _ctx: &mut Context<Self>) {
        for subscribers in self.subscriptions.values_mut() {
            subscribers.retain(|s| s.addr != msg.addr);
        }
        self.subscriptions
            .retain(|_, subscribers| !subscribers.is_empty());

        for subscribers in self.presence.values_mut() {
            subscribers.remove(&msg.addr);
        }
        self.presence
            .retain(|_, subscribers| !subscribers.is_empty());
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
        // Relay to peers before the local fan-out below, and only for presence
        // that originated here (`addr` is the websocket it came from; a frame
        // we relayed IN from a peer has none, and must not be sent back out or
        // two nodes trade cursors forever).
        if msg.addr.is_some() {
            if let Ok(agent) = self.store.get_default_agent() {
                atomic_lib::sync::peer::broadcast_ephemeral(
                    atomic_lib::sync::protocol::ephemeral_kind::LORO,
                    msg.subject.as_str(),
                    &agent.subject.to_string(),
                    msg.update.as_bytes(),
                    None,
                );
            }
        }

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

impl Handler<SubscribePresence> for LoroSyncBroadcaster {
    type Result = ResponseActFuture<Self, ()>;

    #[allow(clippy::mutable_key_type)]
    fn handle(&mut self, msg: SubscribePresence, _ctx: &mut Context<Self>) -> Self::Result {
        let store = self.store.clone();
        Box::pin(
            async move {
                if !msg.drive.is_local() {
                    tracing::warn!(
                        "can't subscribe to presence of external drive: {}",
                        msg.drive
                    );
                    return None;
                }

                let resource = match store.get_resource(&msg.drive).await {
                    Ok(resource) => resource,
                    Err(e) => {
                        tracing::debug!(
                            "Presence subscribe failed for {} by {}: {}",
                            &msg.drive,
                            msg.agent,
                            e
                        );
                        return None;
                    }
                };

                if let Err(unauthorized_err) = atomic_lib::hierarchy::check_read(
                    &store,
                    &resource,
                    &ForAgent::AgentSubject(msg.agent.clone().into()),
                )
                .await
                {
                    tracing::debug!(
                        "Not allowed {} to subscribe to presence for {}: {}",
                        &msg.agent,
                        &msg.drive,
                        unauthorized_err
                    );
                    return None;
                }

                Some((msg.drive, msg.addr))
            }
            .into_actor(self)
            .map(|res, actor, _ctx| {
                if let Some((drive, addr)) = res {
                    let subscribers = actor.presence.entry(drive.clone()).or_default();

                    // Bring the newcomer up to date: replay every other
                    // connection's cached state. LWW timestamps inside the
                    // EphemeralStore payloads make duplicate replays
                    // harmless.
                    for cached in subscribers
                        .iter()
                        .filter(|(peer, _)| **peer != addr)
                        .filter_map(|(_, state)| state.clone())
                    {
                        addr.do_send(PresenceUpdate {
                            subject: drive.clone(),
                            update: cached,
                            addr: None,
                        });
                    }

                    subscribers.entry(addr).or_insert(None);
                    tracing::debug!("Presence subscribed to {}", drive);
                }
            }),
        )
    }
}

impl Handler<UnsubscribePresence> for LoroSyncBroadcaster {
    type Result = ();

    fn handle(&mut self, msg: UnsubscribePresence, _ctx: &mut Context<Self>) {
        if let Some(subscribers) = self.presence.get_mut(&msg.drive) {
            subscribers.remove(&msg.addr);

            if subscribers.is_empty() {
                self.presence.remove(&msg.drive);
            }
        }
    }
}

impl Handler<PresenceUpdate> for LoroSyncBroadcaster {
    type Result = ();

    fn handle(&mut self, msg: PresenceUpdate, _ctx: &mut Context<Self>) {
        let Some(subscribers) = self.presence.get_mut(&msg.subject) else {
            return;
        };

        let Some(sender) = msg.addr.as_ref() else {
            tracing::warn!("no addr in presence update for {}", msg.subject);
            return;
        };

        // Only subscribers may broadcast — subscribing is where the drive
        // read-access check happens, so this is the auth gate.
        let Some(cached) = subscribers.get_mut(sender) else {
            tracing::warn!("presence update from non-subscriber for {}", msg.subject);
            return;
        };
        *cached = Some(msg.update.clone());

        // Relay to peers. Only local presence reaches here (the handler above
        // requires a sender address), so there is no echo to guard against.
        if let Ok(agent) = self.store.get_default_agent() {
            atomic_lib::sync::peer::broadcast_ephemeral(
                atomic_lib::sync::protocol::ephemeral_kind::PRESENCE,
                msg.subject.as_str(),
                &agent.subject.to_string(),
                msg.update.as_bytes(),
                None,
            );
        }

        for subscriber in subscribers.keys() {
            if subscriber == sender {
                continue;
            }

            subscriber.do_send(msg.clone());
        }
    }
}

impl Handler<crate::actor_messages::RemotePresenceUpdate> for LoroSyncBroadcaster {
    type Result = ();

    /// Fan a peer's presence out to everyone watching that drive here.
    ///
    /// No sender to exclude and no subscriber check: the frame came from
    /// another node, which applied its own read gate before relaying it, and
    /// there is no local connection it could be attributed to.
    fn handle(
        &mut self,
        msg: crate::actor_messages::RemotePresenceUpdate,
        _ctx: &mut Context<Self>,
    ) {
        let Some(subscribers) = self.presence.get(&msg.subject) else {
            return;
        };

        let local = PresenceUpdate {
            subject: msg.subject.clone(),
            update: msg.update,
            addr: None,
        };

        for subscriber in subscribers.keys() {
            subscriber.do_send(local.clone());
        }
    }
}

pub fn create_loro_sync_broadcaster(store: Db) -> Addr<LoroSyncBroadcaster> {
    LoroSyncBroadcaster::create(
        |_ctx: &mut Context<LoroSyncBroadcaster>| LoroSyncBroadcaster {
            subscriptions: HashMap::new(),
            presence: HashMap::new(),
            store,
        },
    )
}
