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
    actor_messages::CommitMessage,
    appstate::AppState,
    commit_monitor::CommitMonitor,
    errors::AtomicServerResult,
    helpers::get_auth_headers,
    loro_sync_broadcaster::LoroSyncBroadcaster,
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
    let origin = context.origin.clone();

    let result = WsResponseBuilder::new(
        WebSocketConnection::new(
            appstate.commit_monitor.clone(),
            appstate.loro_sync_broadcaster.clone(),
            for_agent,
            // We need to make sure this is easily clone-able
            store,
            origin,
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
    subscribed: std::collections::HashSet<atomic_lib::Subject>,
    /// The CommitMonitor Actor that receives and sends messages for Commits
    commit_monitor_addr: Addr<CommitMonitor>,
    loro_sync_broadcaster_addr: Addr<LoroSyncBroadcaster>,
    /// The Agent who is connected.
    /// If it's not specified, it's the Public Agent.
    agent: ForAgent,
    store: Db,
    origin: String,
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
                    if let Some(subject_str) = parts.nth(1) {
                        let subject_str = subject_str.to_string();
                        let store = self.store.clone();
                        let agent = self.agent.clone();
                        let origin = self.origin.clone();
                        ctx.spawn(
                            async move {
                                let subject = atomic_lib::Subject::from_raw(
                                    &subject_str,
                                    store.get_base_domain().as_deref(),
                                );
                                tracing::debug!("WebSocket GET {}", subject_str);
                                (
                                    store.get_resource_extended(&subject, false, &agent).await,
                                    subject_str,
                                    origin,
                                )
                            }
                            .into_actor(self)
                            .map(|(res, subject_str, origin), _actor, ctx| match res {
                                Ok(r) => {
                                    let serialized = r
                                        .to_json_ad(Some(&origin))
                                        .expect("Can't serialize Resource to JSON-AD");
                                    ctx.text(format!("RESOURCE {serialized}"));
                                    crate::metrics::resource_fetched_ws();
                                }
                                Err(e) => {
                                    let r = e.into_resource(subject_str);
                                    let serialized_err = r
                                        .to_json_ad(Some(&origin))
                                        .expect("Can't serialize Resource to JSON-AD");
                                    ctx.text(format!("RESOURCE {serialized_err}"));
                                }
                            }),
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
    tracing::debug!("WebSocket message {}", text);
    match text.as_str() {

        s if s.starts_with("SUBSCRIBE ") => {
            let mut parts = s.split("SUBSCRIBE ");
            if let Some(subject_str) = parts.nth(1) {
                let subject: atomic_lib::Subject = atomic_lib::Subject::from_raw(
                    subject_str,
                    conn.store.get_base_domain().as_deref(),
                );
                conn.commit_monitor_addr
                    .do_send(crate::actor_messages::Subscribe {
                        addr: ctx.address(),
                        subject: subject.clone(),
                        agent: conn.agent.to_string(),
                    });
                conn.subscribed.insert(subject);
                Ok(())
            } else {
                Err("SUBSCRIBE needs a subject".into())
            }
        }
        s if s.starts_with("UNSUBSCRIBE ") => {
            let mut parts = s.split("UNSUBSCRIBE ");
            if let Some(subject_str) = parts.nth(1) {
                let subject = atomic_lib::Subject::from_raw(
                    subject_str,
                    conn.store.get_base_domain().as_deref(),
                );
                conn.subscribed.remove(&subject);
                Ok(())
            } else {
                Err("UNSUBSCRIBE needs a subject".into())
            }
        }
        s if s.starts_with("LORO_SYNC_SUBSCRIBE ") => {
            let json = &s[20..];
            let message: crate::actor_messages::LoroSubscriptionJSON =
                serde_json::from_str(json)
                    .map_err(|e| format!("Invalid LORO_SYNC_SUBSCRIBE JSON: {e}"))?;
            conn.loro_sync_broadcaster_addr
                .do_send(crate::actor_messages::SubscribeLoroSync {
                    addr: ctx.address(),
                    subject: message.subject,
                    agent: conn.agent.to_string(),
                });
            Ok(())
        }
        s if s.starts_with("LORO_SYNC_UNSUBSCRIBE ") => {
            let json = &s[22..];
            let message: crate::actor_messages::LoroSubscriptionJSON =
                serde_json::from_str(json)
                    .map_err(|e| format!("Invalid LORO_SYNC_UNSUBSCRIBE JSON: {e}"))?;
            conn.loro_sync_broadcaster_addr
                .do_send(crate::actor_messages::UnsubscribeLoroSync {
                    addr: ctx.address(),
                    subject: message.subject,
                });
            Ok(())
        }
        s if s.starts_with("LORO_SYNC_UPDATE ") => {
            let json = &s[17..];
            let mut update: crate::actor_messages::LoroSyncUpdate =
                serde_json::from_str(json)
                    .map_err(|e| format!("Invalid LORO_SYNC_UPDATE JSON: {e}"))?;
            update.addr = Some(ctx.address());
            conn.loro_sync_broadcaster_addr.do_send(update);
            Ok(())
        }
        s if s.starts_with("LORO_EPHEMERAL_UPDATE ") => {
            let json = &s[21..];
            let mut update: crate::actor_messages::LoroEphemeralUpdate =
                serde_json::from_str(json)
                    .map_err(|e| format!("Invalid LORO_EPHEMERAL_UPDATE JSON: {e}"))?;
            update.addr = Some(ctx.address());
            conn.loro_sync_broadcaster_addr.do_send(update);
            Ok(())
        }
        s if s.starts_with("SUBSCRIBE_QUERY ") => {
            let json = &s[16..];
            let query: crate::actor_messages::QuerySubscriptionJSON =
                serde_json::from_str(json)
                    .map_err(|e| format!("Invalid SUBSCRIBE_QUERY JSON: {e}"))?;
            conn.commit_monitor_addr
                .do_send(crate::actor_messages::SubscribeQuery {
                    addr: ctx.address(),
                    query,
                    agent: conn.agent.to_string(),
                });
            Ok(())
        }
        s if s.starts_with("SYNC_DRIVE ") => {
            let json = &s[11..];
            let request: SyncDriveRequest =
                serde_json::from_str(json)
                    .map_err(|e| format!("Invalid SYNC_DRIVE JSON: {e}"))?;
            let store = conn.store.clone();
            let agent = conn.agent.clone();
            let origin = conn.origin.clone();
            ctx.spawn(
                async move {
                    handle_sync_drive(request, store, agent, origin).await
                }
                .into_actor(conn)
                .map(|messages, _actor, ctx| {
                    for msg in messages {
                        ctx.text(msg);
                    }
                }),
            );
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
        loro_sync_broadcaster_addr: Addr<LoroSyncBroadcaster>,
        agent: ForAgent,
        store: Db,
        origin: String,
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
            loro_sync_broadcaster_addr,
            agent,
            store,
            origin,
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

impl Handler<crate::actor_messages::LoroSyncUpdate> for WebSocketConnection {
    type Result = ();

    #[tracing::instrument(name = "handle_loro_sync_update", skip_all)]
    fn handle(
        &mut self,
        msg: crate::actor_messages::LoroSyncUpdate,
        ctx: &mut ws::WebsocketContext<Self>,
    ) {
        ctx.text(format!(
            "LORO_SYNC_UPDATE {}",
            serde_json::to_string(&msg).unwrap()
        ));
    }
}

impl Handler<crate::actor_messages::LoroEphemeralUpdate> for WebSocketConnection {
    type Result = ();

    #[tracing::instrument(name = "handle_loro_ephemeral_update", skip_all)]
    fn handle(
        &mut self,
        msg: crate::actor_messages::LoroEphemeralUpdate,
        ctx: &mut ws::WebsocketContext<Self>,
    ) {
        ctx.text(format!(
            "LORO_EPHEMERAL_UPDATE {}",
            serde_json::to_string(&msg).unwrap()
        ));
    }
}

impl Handler<crate::actor_messages::QueryUpdate> for WebSocketConnection {
    type Result = ();

    #[tracing::instrument(name = "handle_query_update", skip_all)]
    fn handle(
        &mut self,
        msg: crate::actor_messages::QueryUpdate,
        ctx: &mut ws::WebsocketContext<Self>,
    ) {
        ctx.text(format!(
            "QUERY_UPDATE {}",
            serde_json::to_string(&msg).unwrap()
        ));
    }
}

// === Drive Sync ===

#[derive(serde::Deserialize)]
struct SyncDriveRequest {
    /// The drive subject to sync (e.g. "did:ad:xyz" or "https://server/drive/abc")
    drive: String,
    /// Optional timestamp (unix millis). If provided, only resources modified after this time are sent.
    since: Option<i64>,
}

#[derive(serde::Serialize)]
struct SyncDoneMessage {
    drive: String,
    /// Current server timestamp (unix millis). Client should store this for future SYNC_DRIVE with `since`.
    timestamp: i64,
    /// Number of resources sent in this sync batch.
    count: usize,
}

/// Handles a SYNC_DRIVE request by collecting all resources in the drive
/// and returning them as a list of text messages to send over the WS connection.
async fn handle_sync_drive(
    request: SyncDriveRequest,
    store: Db,
    agent: ForAgent,
    origin: String,
) -> Vec<String> {
    let mut messages = Vec::new();
    let now = atomic_lib::utils::now();
    let drive_subject = atomic_lib::Subject::from_raw(
        &request.drive,
        store.get_base_domain().as_deref(),
    );

    // Query for all resources that have this drive as parent (recursively).
    // We use the PropValSub index: find all resources where parent = drive_subject.
    // Then for each, also find their children, etc.
    // For simplicity and performance, we iterate ALL resources and filter by drive prefix.
    let mut count = 0;

    for resource in store.all_resources(false) {
        let subject = resource.get_subject();

        // Check if this resource belongs to the requested drive.
        // For URL-based subjects, check prefix match.
        // For DID subjects, check parent hierarchy (expensive, so we check the drive mapping).
        let belongs_to_drive = if subject.is_did() {
            // DID resources: check if parent chain leads to the drive
            resource
                .get(atomic_lib::urls::PARENT)
                .ok()
                .map(|v| v.to_string() == drive_subject.as_str().to_string())
                .unwrap_or(false)
        } else {
            // URL resources: prefix match
            subject.as_str().starts_with(drive_subject.as_str())
        };

        if !belongs_to_drive {
            continue;
        }

        // If `since` is specified, only send resources modified after that timestamp
        if let Some(since) = request.since {
            if let Ok(last_commit_val) = resource.get(atomic_lib::urls::LAST_COMMIT) {
                let commit_subject = last_commit_val.to_string();
                if let Ok(commit_resource) = store
                    .get_resource(&commit_subject.into())
                    .await
                {
                    if let Ok(created_at) = commit_resource.get(atomic_lib::urls::CREATED_AT) {
                        if let Ok(ts) = created_at.to_int() {
                            if ts <= since {
                                continue;
                            }
                        }
                    }
                }
            } else {
                // No lastCommit — this resource hasn't been modified, skip if doing delta sync
                continue;
            }
        }

        // Check read permission
        if atomic_lib::hierarchy::check_read(&store, &resource, &agent)
            .await
            .is_err()
        {
            continue;
        }

        match resource.to_json_ad(Some(&origin)) {
            Ok(json_ad) => {
                messages.push(format!("RESOURCE {json_ad}"));
                count += 1;
            }
            Err(e) => {
                tracing::warn!("Failed to serialize resource {} during sync: {}", subject, e);
            }
        }
    }

    let done = SyncDoneMessage {
        drive: request.drive,
        timestamp: now,
        count,
    };
    messages.push(format!(
        "SYNC_DONE {}",
        serde_json::to_string(&done).unwrap()
    ));

    tracing::info!("SYNC_DRIVE completed: sent {} resources", count);
    messages
}
