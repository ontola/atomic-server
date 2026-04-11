/*!
## WebSockets

Binary-first WebSocket protocol (v2). All resource data travels as raw Loro bytes.
Text messages are only used for Loro collaborative editing sync (LORO_SYNC_*) and
query subscription updates (QUERY_UPDATE), which will migrate to binary later.

For protocol docs, see https://docs.atomicdata.dev/websockets.html
 */
use actix::{
    Actor, ActorContext, ActorFutureExt, Addr, AsyncContext, Handler, StreamHandler, WrapFuture,
};
use actix_web::{web, HttpRequest, HttpResponse};
use actix_web_actors::ws::{self, WsResponseBuilder};
use atomic_lib::{
    agents::ForAgent,
    authentication::{get_agent_from_auth_values_and_check, AuthValues},
    Db, Storelike,
};
use std::time::{Duration, Instant};

use crate::{
    actor_messages::CommitMessage, appstate::AppState, commit_monitor::CommitMonitor,
    errors::AtomicServerResult, handlers::ws_v2, helpers::get_auth_headers,
    loro_sync_broadcaster::LoroSyncBroadcaster,
};

const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(5);
const CLIENT_TIMEOUT: Duration = Duration::from_secs(10);

/// Upgrade an HTTP request to a WebSocket connection.
#[tracing::instrument(skip(appstate, stream))]
pub async fn web_socket_handler(
    req: HttpRequest,
    stream: web::Payload,
    appstate: web::Data<AppState>,
    context: crate::context::RequestContext,
) -> AtomicServerResult<HttpResponse> {
    let auth_header_values = get_auth_headers(req.headers(), "ws".into())?;
    let for_agent = get_agent_from_auth_values_and_check(auth_header_values, &appstate.store).await?;

    let result = WsResponseBuilder::new(
        WebSocketConnection {
            hb: Instant::now(),
            subscribed: std::collections::HashSet::new(),
            commit_monitor_addr: appstate.commit_monitor.clone(),
            loro_sync_broadcaster_addr: appstate.loro_sync_broadcaster.clone(),
            agent: for_agent,
            store: appstate.store.clone(),
        },
        &req,
        stream,
    )
    .protocols(&["atomicdata-ws.v2"])
    .start()?;

    Ok(result)
}

pub struct WebSocketConnection {
    hb: Instant,
    subscribed: std::collections::HashSet<atomic_lib::Subject>,
    commit_monitor_addr: Addr<CommitMonitor>,
    loro_sync_broadcaster_addr: Addr<LoroSyncBroadcaster>,
    agent: ForAgent,
    store: Db,
}

impl Actor for WebSocketConnection {
    type Context = ws::WebsocketContext<Self>;

    fn started(&mut self, ctx: &mut Self::Context) {
        ctx.run_interval(HEARTBEAT_INTERVAL, |act, ctx| {
            if Instant::now().duration_since(act.hb) > CLIENT_TIMEOUT {
                tracing::info!("Websocket heartbeat failed, disconnecting");
                ctx.stop();

                return;
            }

            ctx.ping(b"");
        });
    }
}

// ---- Incoming message routing ----

impl StreamHandler<Result<ws::Message, ws::ProtocolError>> for WebSocketConnection {
    fn handle(&mut self, msg: Result<ws::Message, ws::ProtocolError>, ctx: &mut Self::Context) {
        match msg {
            Ok(ws::Message::Ping(msg)) => {
                self.hb = Instant::now();
                ctx.pong(&msg);
            }
            Ok(ws::Message::Pong(_)) => {
                self.hb = Instant::now();
            }
            Ok(ws::Message::Binary(bin)) => {
                self.handle_binary(&bin, ctx);
            }
            Ok(ws::Message::Text(text)) => {
                // Remaining text messages: Loro sync, SYNC_VV/SYNC_DELTAS, query subscriptions
                self.handle_text(&text, ctx);
            }
            Ok(ws::Message::Close(reason)) => {
                ctx.close(reason);
                ctx.stop();
            }
            _ => ctx.stop(),
        }
    }
}

impl WebSocketConnection {
    /// Handle a binary v2 frame.
    fn handle_binary(&mut self, bin: &[u8], ctx: &mut ws::WebsocketContext<Self>) {
        if bin.is_empty() {
            return;
        }

        match bin[0] {
            ws_v2::tag::AUTH => {
                let Ok(json) = std::str::from_utf8(&bin[1..]) else {
                    return;
                };
                let json = json.to_string();
                let store = self.store.clone();
                ctx.spawn(
                    async move {
                        let auth: AuthValues = serde_json::from_str(&json)
                            .map_err(|e| format!("Invalid AUTH JSON: {e}"))?;
                        get_agent_from_auth_values_and_check(Some(auth), &store)
                            .await
                            .map_err(|e| format!("Auth failed: {e}"))
                    }
                    .into_actor(self)
                    .map(|res, actor, ctx| match res {
                        Ok(a) => {
                            actor.agent = a;
                            ctx.binary(ws_v2::encode_auth_ok());
                        }
                        Err(e) => ctx.binary(ws_v2::encode_error(0, &e)),
                    }),
                );
            }

            ws_v2::tag::GET => {
                let Some(decoded) = ws_v2::decode_get(&bin[1..]) else {
                    return;
                };
                let subject_str = decoded.subject.to_string();
                let request_id = decoded.request_id;
                let store = self.store.clone();
                let agent = self.agent.clone();
                ctx.spawn(
                    async move {
                        let subject = atomic_lib::Subject::from_raw(
                            &subject_str,
                            store.get_base_domain().as_deref(),
                        );
                        (store.get_resource_extended(&subject, false, &agent).await, request_id)
                    }
                    .into_actor(self)
                    .map(|(res, rid), _actor, ctx| match res {
                        Ok(r) => {
                            let resource = r.to_single();

                            // Use stored Loro snapshot, or build one from propvals
                            let snapshot = resource.get_loro_snapshot().unwrap_or_else(|| {
                                match resource.build_loro_doc_from_state() {
                                    Ok(doc) => doc.export_snapshot(),
                                    Err(_) => Vec::new(),
                                }
                            });

                            if snapshot.is_empty() {
                                ctx.binary(ws_v2::encode_error(rid, "Cannot build resource state"));
                            } else {
                                ctx.binary(ws_v2::encode_update(
                                    ws_v2::flags::SNAPSHOT,
                                    rid,
                                    resource.get_subject().as_str(),
                                    None,
                                    &snapshot,
                                ));
                            }
                        }
                        Err(e) => ctx.binary(ws_v2::encode_error(rid, &e.to_string())),
                    }),
                );
            }

            ws_v2::tag::SUB => {
                if let Ok(subject_str) = std::str::from_utf8(&bin[1..]) {
                    let subject = atomic_lib::Subject::from_raw(
                        subject_str,
                        self.store.get_base_domain().as_deref(),
                    );
                    // Subscribe to drive-level query updates
                    self.commit_monitor_addr
                        .do_send(crate::actor_messages::SubscribeQuery {
                            addr: ctx.address(),
                            query: crate::actor_messages::QuerySubscriptionJSON {
                                property: None,
                                value: None,
                                sort_by: None,
                                drive: Some(subject_str.to_string()),
                            },
                            agent: self.agent.to_string(),
                        });
                    // Also subscribe to resource-level commits on the drive itself
                    self.commit_monitor_addr
                        .do_send(crate::actor_messages::Subscribe {
                            addr: ctx.address(),
                            subject: subject.clone(),
                            agent: self.agent.to_string(),
                        });
                    self.subscribed.insert(subject);
                }
            }

            ws_v2::tag::UNSUB => {
                if let Ok(subject_str) = std::str::from_utf8(&bin[1..]) {
                    let subject = atomic_lib::Subject::from_raw(
                        subject_str,
                        self.store.get_base_domain().as_deref(),
                    );
                    self.subscribed.remove(&subject);
                }
            }

            _ => {
                tracing::debug!("Unhandled binary tag: 0x{:02x}", bin[0]);
            }
        }
    }

    /// Handle remaining text messages (Loro sync, SYNC_VV/DELTAS, query subs).
    fn handle_text(&mut self, text: &str, ctx: &mut ws::WebsocketContext<Self>) {
        if let Some(json) = text.strip_prefix("LORO_SYNC_SUBSCRIBE ") {
            if let Ok(msg) = serde_json::from_str::<crate::actor_messages::LoroSubscriptionJSON>(json) {
                self.loro_sync_broadcaster_addr
                    .do_send(crate::actor_messages::SubscribeLoroSync {
                        addr: ctx.address(),
                        subject: msg.subject,
                        agent: self.agent.to_string(),
                    });
            }
        } else if let Some(json) = text.strip_prefix("LORO_SYNC_UNSUBSCRIBE ") {
            if let Ok(msg) = serde_json::from_str::<crate::actor_messages::LoroSubscriptionJSON>(json) {
                self.loro_sync_broadcaster_addr
                    .do_send(crate::actor_messages::UnsubscribeLoroSync {
                        addr: ctx.address(),
                        subject: msg.subject,
                    });
            }
        } else if let Some(json) = text.strip_prefix("LORO_SYNC_UPDATE ") {
            if let Ok(mut update) = serde_json::from_str::<crate::actor_messages::LoroSyncUpdate>(json) {
                update.addr = Some(ctx.address());
                self.loro_sync_broadcaster_addr.do_send(update);
            }
        } else if let Some(json) = text.strip_prefix("LORO_EPHEMERAL_UPDATE ") {
            if let Ok(mut update) = serde_json::from_str::<crate::actor_messages::LoroEphemeralUpdate>(json) {
                update.addr = Some(ctx.address());
                self.loro_sync_broadcaster_addr.do_send(update);
            }
        } else if let Some(json) = text.strip_prefix("SUBSCRIBE_QUERY ") {
            if let Ok(query) = serde_json::from_str::<crate::actor_messages::QuerySubscriptionJSON>(json) {
                self.commit_monitor_addr
                    .do_send(crate::actor_messages::SubscribeQuery {
                        addr: ctx.address(),
                        query,
                        agent: self.agent.to_string(),
                    });
            }
        } else if let Some(json) = text.strip_prefix("SUBSCRIBE ") {
            let subject = atomic_lib::Subject::from_raw(json, self.store.get_base_domain().as_deref());
            self.commit_monitor_addr
                .do_send(crate::actor_messages::Subscribe {
                    addr: ctx.address(),
                    subject: subject.clone(),
                    agent: self.agent.to_string(),
                });
            self.subscribed.insert(subject);
        } else if let Some(json) = text.strip_prefix("SYNC_VV ") {
            if let Ok(request) = serde_json::from_str::<SyncVVRequest>(json) {
                let store = self.store.clone();
                let agent = self.agent.clone();
                ctx.spawn(
                    async move { handle_sync_vv(request, store, agent).await }
                        .into_actor(self)
                        .map(|frames, _actor, ctx| {
                            for frame in frames {
                                ctx.binary(frame);
                            }
                        }),
                );
            }
        } else if let Some(json) = text.strip_prefix("SYNC_DELTAS ") {
            if let Ok(request) = serde_json::from_str::<SyncDeltasRequest>(json) {
                let store = self.store.clone();
                let agent = self.agent.clone();
                ctx.spawn(
                    async move { handle_sync_deltas(request, store, agent).await }
                        .into_actor(self)
                        .map(|_, _, _| {}),
                );
            }
        } else {
            tracing::debug!("Unknown text message: {}", &text[..text.len().min(50)]);
        }
    }
}

// ---- Outgoing message handlers (Actor → WebSocket) ----

impl Handler<CommitMessage> for WebSocketConnection {
    type Result = ();

    fn handle(&mut self, msg: CommitMessage, ctx: &mut ws::WebsocketContext<Self>) {
        let commit = &msg.commit_response.commit;
        let commit_id = commit.url.as_deref().or(commit.signature.as_deref()).unwrap_or("");

        if let Some(loro_update) = &commit.loro_update {
            ctx.binary(ws_v2::encode_update(
                ws_v2::flags::HAS_COMMIT_ID | ws_v2::flags::PUSH,
                0,
                &commit.subject.to_string(),
                Some(commit_id),
                loro_update,
            ));
        } else if commit.destroy.unwrap_or(false) {
            ctx.binary(ws_v2::encode_destroy(0, &commit.subject.to_string()));
        }
    }
}

impl Handler<crate::actor_messages::LoroSyncUpdate> for WebSocketConnection {
    type Result = ();

    fn handle(&mut self, msg: crate::actor_messages::LoroSyncUpdate, ctx: &mut ws::WebsocketContext<Self>) {
        ctx.text(format!("LORO_SYNC_UPDATE {}", serde_json::to_string(&msg).unwrap()));
    }
}

impl Handler<crate::actor_messages::LoroEphemeralUpdate> for WebSocketConnection {
    type Result = ();

    fn handle(&mut self, msg: crate::actor_messages::LoroEphemeralUpdate, ctx: &mut ws::WebsocketContext<Self>) {
        ctx.text(format!("LORO_EPHEMERAL_UPDATE {}", serde_json::to_string(&msg).unwrap()));
    }
}

impl Handler<crate::actor_messages::QueryUpdate> for WebSocketConnection {
    type Result = ();

    fn handle(&mut self, msg: crate::actor_messages::QueryUpdate, ctx: &mut ws::WebsocketContext<Self>) {
        ctx.text(format!("QUERY_UPDATE {}", serde_json::to_string(&msg).unwrap()));
    }
}

// ---- Sync protocol ----

#[derive(serde::Deserialize)]
struct SyncVVRequest {
    drive: String,
    #[serde(rename = "driveHash")]
    drive_hash: String,
    peers: Vec<String>,
    resources: std::collections::HashMap<String, Vec<i32>>,
}

#[derive(serde::Deserialize)]
struct SyncDeltasRequest {
    drive: String,
    deltas: std::collections::HashMap<String, String>,
}

/// Delegate to atomic_lib sync engine.
async fn handle_sync_vv(
    request: SyncVVRequest,
    store: Db,
    agent: ForAgent,
) -> Vec<Vec<u8>> {
    atomic_lib::sync::engine::handle_sync_vv(
        &request.drive,
        &request.drive_hash,
        &request.peers,
        &request.resources,
        &store,
        &agent,
    )
    .await
}

/// Delegate to atomic_lib sync engine.
async fn handle_sync_deltas(request: SyncDeltasRequest, store: Db, _agent: ForAgent) {
    atomic_lib::sync::engine::handle_sync_deltas(
        &request.drive,
        &request.deltas,
        &store,
    )
    .await;
}
