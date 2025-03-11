/*!
## WebSockets

For every Connection to `/ws`, the [web_socket_handler] creates a [WebSocketConnection].
This keeps track of the Agent and handles messages.

For information about the protocol, see https://docs.atomicdata.dev/websockets.html
 */
use actix::{
    Actor, ActorContext, ActorFutureExt, Addr, AsyncContext, Handler, StreamHandler, WrapFuture,
};
use actix_web::{web, HttpRequest, HttpResponse};
use actix_web_actors::ws::{self, WsResponseBuilder};
use atomic_lib::{
    agents::ForAgent,
    authentication::{get_agent_from_auth_values_and_check, AuthValues},
    errors::AtomicResult,
    Db, Storelike,
};
use std::time::{Duration, Instant};

use crate::{
    actor_messages::{CommitMessage, YSubscriptionJSON, YSyncUpdate},
    appstate::AppState,
    commit_monitor::CommitMonitor,
    errors::AtomicServerResult,
    helpers::get_auth_headers,
    y_sync_broadcaster::YSyncBroadcaster,
};

/// Get an HTTP request, upgrade it to a Websocket connection
#[tracing::instrument(skip(appstate, stream))]
pub async fn web_socket_handler(
    req: HttpRequest,
    stream: web::Payload,
    appstate: web::Data<AppState>,
    context: crate::context::RequestContext,
) -> AtomicServerResult<HttpResponse> {
    // Authentication check. If the user has no headers, continue with the Public Agent.
    let auth_header_values = get_auth_headers(req.headers(), "ws".into())?;
    let for_agent = atomic_lib::authentication::get_agent_from_auth_values_and_check(
        auth_header_values,
        &appstate.store,
    )
    .await?;
    tracing::debug!("Starting websocket for {}", for_agent);

    tracing::debug!("Starting websocket for {}", for_agent);

    let store = appstate.store.clone();

    let result = WsResponseBuilder::new(
        WebSocketConnection::new(
            appstate.commit_monitor.clone(),
            appstate.y_sync_broadcaster.clone(),
            for_agent,
            // We need to make sure this is easily clone-able
            store,
        ),
        &req,
        stream,
    )
    .protocols(&["atomicdata-ws.v0.1"])
    .start()?;

    Ok(result)
}

const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(5);
const CLIENT_TIMEOUT: Duration = Duration::from_secs(10);

pub struct WebSocketConnection {
    /// Client must send ping at least once per 10 seconds (CLIENT_TIMEOUT),
    /// otherwise we drop connection.
    hb: Instant,
    /// The Subjects that the client is subscribed to
    subscribed: std::collections::HashSet<String>,
    /// The CommitMonitor Actor that receives and sends messages for Commits
    commit_monitor_addr: Addr<CommitMonitor>,
    y_sync_broadcaster_addr: Addr<YSyncBroadcaster>,
    /// The Agent who is connected.
    /// If it's not specified, it's the Public Agent.
    agent: ForAgent,
    store: Db,
}

impl Actor for WebSocketConnection {
    type Context = ws::WebsocketContext<Self>;

    fn started(&mut self, ctx: &mut Self::Context) {
        self.hb(ctx);
    }
}

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
            Ok(ws::Message::Text(text)) => {
                let text = text.to_string();
                tracing::debug!("Incoming websocket text message: {:?}", text);

                if text.starts_with("GET ") {
                    let mut parts = text.split("GET ");
                    if let Some(subject) = parts.nth(1) {
                        let subject = subject.to_string();
                        let store = self.store.clone();
                        let agent = self.agent.clone();
                        ctx.spawn(
                            async move {
                                (
                                    store
                                        .get_resource_extended(
                                            &subject.clone().into(),
                                            false,
                                            &agent,
                                        )
                                        .await,
                                    subject,
                                    store,
                                )
                            }
                            .into_actor(self)
                            .map(
                                |(res, subject, store), _actor, ctx| match res {
                                    Ok(r) => {
                                        let serialized = r
                                            .to_json_ad(store.get_base_domain().as_deref())
                                            .expect("Can't serialize Resource to JSON-AD");
                                        ctx.text(format!("RESOURCE {serialized}"));
                                    }
                                    Err(e) => {
                                        let r = e.into_resource(subject);
                                        let serialized_err = r
                                            .to_json_ad(store.get_base_domain().as_deref())
                                            .expect("Can't serialize Resource to JSON-AD");
                                        ctx.text(format!("RESOURCE {serialized_err}"));
                                    }
                                },
                            ),
                        );
                    } else {
                        ctx.text("ERROR GET needs a subject");
                    }
                    return;
                }

                if text.starts_with("AUTHENTICATE ") {
                    let mut parts = text.split("AUTHENTICATE ");
                    if let Some(json) = parts.nth(1) {
                        let json = json.to_string();
                        let store = self.store.clone();
                        ctx.spawn(
                            async move {
                                let auth_header_values: AuthValues = serde_json::from_str(&json)
                                    .map_err(|err| format!("Invalid AUTHENTICATE JSON: {}", err))?;
                                get_agent_from_auth_values_and_check(
                                    Some(auth_header_values),
                                    &store,
                                )
                                .await
                                .map_err(|e| format!("Authentication failed: {}", e))
                            }
                            .into_actor(self)
                            .map(|res, actor, ctx| match res {
                                Ok(a) => {
                                    tracing::debug!("Authenticated websocket for {}", a);
                                    actor.agent = a;
                                    ctx.text("AUTHENTICATED");
                                }
                                Err(e) => ctx.text(format!("ERROR {}", e)),
                            }),
                        );
                    } else {
                        ctx.text("ERROR AUTHENTICATE needs a JSON object");
                    }
                    return;
                }

                if let Err(e) = handle_ws_message_sync(text, ctx, self) {
                    ctx.text(format!("ERROR {e}"));
                    tracing::error!("Error handling WebSocket message: {}", e);
                }
            }
            Ok(ws::Message::Binary(_bin)) => {
                ctx.text("ERROR Binary not supported");
            }
            Ok(ws::Message::Close(reason)) => {
                ctx.close(reason);
                ctx.stop();
            }
            _ => {
                ctx.stop();
            }
        }
    }
}

fn handle_ws_message_sync(
    text: String,
    ctx: &mut ws::WebsocketContext<WebSocketConnection>,
    conn: &mut WebSocketConnection,
) -> AtomicResult<()> {
    match text.as_str() {
        s if s.starts_with("SUBSCRIBE ") => {
            let mut parts = s.split("SUBSCRIBE ");
            if let Some(subject) = parts.nth(1) {
                conn.commit_monitor_addr
                    .do_send(crate::actor_messages::Subscribe {
                        addr: ctx.address(),
                        subject: subject.to_string(),
                        agent: conn.agent.to_string(),
                    });
                conn.subscribed.insert(subject.into());
                Ok(())
            } else {
                Err("SUBSCRIBE needs a subject".into())
            }
        }
        s if s.starts_with("UNSUBSCRIBE ") => {
            let mut parts = s.split("UNSUBSCRIBE ");
            if let Some(subject) = parts.nth(1) {
                conn.subscribed.remove(subject);
                Ok(())
            } else {
                Err("UNSUBSCRIBE needs a subject".into())
            }
        }
        s if s.starts_with("Y_SYNC_SUBSCRIBE ") => {
            let mut parts = s.split("Y_SYNC_SUBSCRIBE ");

            let Some(json) = parts.nth(1) else {
                return Err("Y_SYNC_SUBSCRIBE needs a JSON object".into());
            };

            let message: YSubscriptionJSON = serde_json::from_str(json)?;

            conn.y_sync_broadcaster_addr
                .do_send(crate::actor_messages::SubscribeYSync {
                    addr: ctx.address(),
                    subject: message.subject.to_string(),
                    property: message.property.to_string(),
                    agent: conn.agent.to_string(),
                });
            Ok(())
        }
        s if s.starts_with("Y_SYNC_UNSUBSCRIBE ") => {
            let mut parts = s.split("Y_SYNC_UNSUBSCRIBE ");

            let Some(json) = parts.nth(1) else {
                return Err("Y_SYNC_UNSUBSCRIBE needs a JSON object".into());
            };

            let message: YSubscriptionJSON = serde_json::from_str(json)?;

            conn.y_sync_broadcaster_addr
                .do_send(crate::actor_messages::UnsubscribeYSync {
                    addr: ctx.address(),
                    subject: message.subject.to_string(),
                    property: message.property.to_string(),
                });

            Ok(())
        }
        s if s.starts_with("Y_SYNC_UPDATE ") => {
            let mut parts = s.split("Y_SYNC_UPDATE ");
            let Some(json) = parts.nth(1) else {
                return Err("Y_SYNC_UPDATE needs a JSON object".into());
            };

            let mut update: YSyncUpdate = match serde_json::from_str(json) {
                Ok(update) => update,
                Err(err) => return Err(format!("Invalid Y_SYNC_UPDATE JSON: {}", err).into()),
            };

            update.addr = Some(ctx.address());
            conn.y_sync_broadcaster_addr.do_send(update);
            Ok(())
        }
        other => {
            tracing::warn!("Unknown websocket message: {}", other);
            Err(format!("Unknown message: {}", other).into())
        }
    }
}

impl WebSocketConnection {
    fn new(
        commit_monitor_addr: Addr<CommitMonitor>,
        y_sync_broadcaster_addr: Addr<YSyncBroadcaster>,
        agent: ForAgent,
        store: Db,
    ) -> Self {
        let size = std::mem::size_of::<Db>();
        if size > 10000 {
            tracing::warn!(
                "Cloned Store is over 10kB, this will hurt performance: {:?} bytes",
                size
            );
        }

        Self {
            hb: Instant::now(),
            // Maybe this should be stored only in the CommitMonitor, and not here.
            subscribed: std::collections::HashSet::new(),
            commit_monitor_addr,
            y_sync_broadcaster_addr,
            agent,
            store,
        }
    }

    /// Sends ping to client every second. If there is no response, the Actor is stopped.
    fn hb(&self, ctx: &mut <Self as Actor>::Context) {
        ctx.run_interval(HEARTBEAT_INTERVAL, |act, ctx| {
            // check client heartbeats
            if Instant::now().duration_since(act.hb) > CLIENT_TIMEOUT {
                // heartbeat timed out
                tracing::info!("Websocket Client heartbeat failed, disconnecting!");

                // We need to kill the Actor responsible for Commit monitoring, too
                // act.lobby_addr.do_send(Disconnect { id: act.id, room_id: act.room });

                // stop actor
                ctx.stop();

                // don't try to send a ping
                return;
            }
            ctx.ping(b"");
        });
    }
}

impl Handler<CommitMessage> for WebSocketConnection {
    type Result = ();

    #[tracing::instrument(name = "handle_commit", skip_all)]
    fn handle(&mut self, msg: CommitMessage, ctx: &mut ws::WebsocketContext<Self>) {
        let resource = msg.commit_response.commit_resource;
        let formatted_commit = format!(
            "COMMIT {}",
            resource
                .to_json_ad(self.store.get_base_domain().as_deref())
                .unwrap()
        );
        ctx.text(formatted_commit);
    }
}

impl Handler<YSyncUpdate> for WebSocketConnection {
    type Result = ();

    #[tracing::instrument(name = "handle_y_awareness_update", skip_all)]
    fn handle(&mut self, msg: YSyncUpdate, ctx: &mut ws::WebsocketContext<Self>) {
        ctx.text(format!(
            "Y_SYNC_UPDATE {}",
            serde_json::to_string(&msg).unwrap()
        ));
    }
}
