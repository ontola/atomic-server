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
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use crate::{
    actor_messages::CommitMessage, appstate::AppState, commit_monitor::CommitMonitor,
    errors::AtomicServerResult, handlers::ws_v2, helpers::get_auth_headers,
    loro_sync_broadcaster::LoroSyncBroadcaster,
};

const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(5);
// How long a connection can go without receiving anything from the
// client before we declare it dead. Generous on purpose — TCP RST
// already catches truly broken connections, and the renderer can
// legitimately stall PONG delivery for several seconds when the JS
// thread is saturated (parallel playwright workers, heavy WASM init).
// A tighter budget here disconnects healthy clients under load.
const CLIENT_TIMEOUT: Duration = Duration::from_secs(60);

/// Per-process counter for generating WebSocket connection identifiers.
/// Used as the `source_id` carried on `CommitOpts`/`CommitResponse` so
/// the commit monitor can suppress same-source broadcasts (no echo of
/// a client's own commit back to the connection that sent it).
static CONNECTION_COUNTER: AtomicU64 = AtomicU64::new(0);

fn new_connection_id() -> String {
    let n = CONNECTION_COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("ws-{n}")
}

/// Upgrade an HTTP request to a WebSocket connection.
#[tracing::instrument(skip(appstate, stream))]
pub async fn web_socket_handler(
    req: HttpRequest,
    stream: web::Payload,
    appstate: web::Data<AppState>,
    context: crate::context::RequestContext,
) -> AtomicServerResult<HttpResponse> {
    let auth_header_values = get_auth_headers(req.headers(), "ws")?;
    let for_agent =
        get_agent_from_auth_values_and_check(auth_header_values, &appstate.store).await?;

    let result = WsResponseBuilder::new(
        WebSocketConnection {
            hb: Instant::now(),
            subscribed: std::collections::HashSet::new(),
            commit_monitor_addr: appstate.commit_monitor.clone(),
            loro_sync_broadcaster_addr: appstate.loro_sync_broadcaster.clone(),
            agent: for_agent,
            store: appstate.store.clone(),
            connection_id: new_connection_id(),
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
    /// Unique-per-process identifier. Threaded through `CommitOpts` into
    /// `CommitResponse` and the emitted `DbEvent`s, so the commit monitor
    /// can suppress broadcasts back to this connection.
    connection_id: String,
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
                let origin = self
                    .store
                    .get_base_domain()
                    .unwrap_or_else(|| "http://localhost".to_string());
                ctx.spawn(
                    async move {
                        let subject = atomic_lib::Subject::from_raw(
                            &subject_str,
                            store.get_base_domain().as_deref(),
                        );
                        (
                            store.get_resource_extended(&subject, false, &agent).await,
                            request_id,
                            origin,
                        )
                    }
                    .into_actor(self)
                    .map(|(res, rid, origin), _actor, ctx| match res {
                        Ok(r) => {
                            let resource = r.to_single();

                            // KNOWN GAP: extender-modified state isn't reflected on the
                            // wire. `get_resource_extended` runs `on_resource_get` and
                            // updates propvals (e.g. plugin renames folder), but the
                            // persisted Loro snapshot still encodes the unmodified state.
                            // We send the stored snapshot here because rebuilding from
                            // propvals would discard the CRDT history (Lamport timeline,
                            // peer ids) that clients rely on for offline edits + merges.
                            // The right long-term fix is for plugins to emit real commits
                            // via `host.commit` so transformations land in the persisted
                            // Loro state — read-side decoration is fundamentally
                            // incompatible with content-addressed sync. See atomic-plugin
                            // wit `on-install` (declared, not yet wired) for the install-
                            // time fan-out hook.
                            let snapshot = resource.get_loro_snapshot().unwrap_or_else(|| {
                                match resource.build_loro_doc_from_state() {
                                    Ok(doc) => doc.export_snapshot(),
                                    Err(_) => Vec::new(),
                                }
                            });

                            if snapshot.is_empty() {
                                ctx.binary(ws_v2::encode_error(rid, "Cannot build resource state"));
                            } else {
                                // Resolve `internal:/…` to the server origin — `internal:` is a
                                // server-side concept and must not cross the wire; the client
                                // keys its resource cache on whatever subject we emit.
                                let subject_resolved = resource.get_subject().resolve(&origin);
                                ctx.binary(ws_v2::encode_update(
                                    ws_v2::flags::SNAPSHOT,
                                    rid,
                                    &subject_resolved,
                                    None,
                                    &snapshot,
                                ));
                            }
                        }
                        Err(e) => ctx.binary(ws_v2::encode_error(rid, &e.to_string())),
                    }),
                );
            }

            ws_v2::tag::COMMIT => {
                let Some(decoded) = ws_v2::decode_commit(&bin[1..]) else {
                    return;
                };
                let request_id = decoded.request_id;
                let body = decoded.commit_json.to_string();
                let store = self.store.clone();
                let source_id = self.connection_id.clone();
                let origin = self
                    .store
                    .get_base_domain()
                    .unwrap_or_else(|| "http://localhost".to_string());
                ctx.spawn(
                    async move {
                        let result = crate::handlers::commit::apply_commit_json(
                            &store,
                            &origin,
                            &body,
                            Some(source_id),
                        )
                        .await;
                        (request_id, result)
                    }
                    .into_actor(self)
                    .map(|(rid, res), _actor, ctx| match res {
                        Ok(server_commit_json) => {
                            ctx.binary(ws_v2::encode_commit_ok(rid, &server_commit_json));
                        }
                        Err(e) => {
                            ctx.binary(ws_v2::encode_error(rid, &e.to_string()));
                        }
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
                            source_id: self.connection_id.clone(),
                        });
                    // Also subscribe to resource-level commits on the drive itself
                    self.commit_monitor_addr
                        .do_send(crate::actor_messages::Subscribe {
                            addr: ctx.address(),
                            subject: subject.clone(),
                            agent: self.agent.to_string(),
                            source_id: self.connection_id.clone(),
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

            ws_v2::tag::SYNC
            | ws_v2::tag::SYNC_PUSH
            | ws_v2::tag::BLOB_REQUEST
            | ws_v2::tag::BLOB_RESPONSE => {
                let store = self.store.clone();
                let mut agent = self.agent.clone();
                let bin_vec = bin.to_vec();
                ctx.spawn(
                    async move {
                        atomic_lib::sync::engine::handle_frame(&bin_vec, &store, &mut agent).await
                    }
                    .into_actor(self)
                    .map(|responses, _actor, ctx| {
                        for response in responses {
                            ctx.binary(response);
                        }
                    }),
                );
            }

            _ => {
                tracing::debug!("Unhandled binary tag: 0x{:02x}", bin[0]);
            }
        }
    }

    /// Handle remaining text messages (Loro sync, SYNC_VV/DELTAS, query subs).
    fn handle_text(&mut self, text: &str, ctx: &mut ws::WebsocketContext<Self>) {
        if let Some(json) = text.strip_prefix("LORO_SYNC_SUBSCRIBE ") {
            if let Ok(msg) =
                serde_json::from_str::<crate::actor_messages::LoroSubscriptionJSON>(json)
            {
                self.loro_sync_broadcaster_addr
                    .do_send(crate::actor_messages::SubscribeLoroSync {
                        addr: ctx.address(),
                        subject: msg.subject,
                        agent: self.agent.to_string(),
                    });
            }
        } else if let Some(json) = text.strip_prefix("LORO_SYNC_UNSUBSCRIBE ") {
            if let Ok(msg) =
                serde_json::from_str::<crate::actor_messages::LoroSubscriptionJSON>(json)
            {
                self.loro_sync_broadcaster_addr.do_send(
                    crate::actor_messages::UnsubscribeLoroSync {
                        addr: ctx.address(),
                        subject: msg.subject,
                    },
                );
            }
        } else if let Some(json) = text.strip_prefix("LORO_SYNC_UPDATE ") {
            if let Ok(mut update) =
                serde_json::from_str::<crate::actor_messages::LoroSyncUpdate>(json)
            {
                update.addr = Some(ctx.address());
                self.loro_sync_broadcaster_addr.do_send(update);
            }
        } else if let Some(json) = text.strip_prefix("LORO_EPHEMERAL_UPDATE ") {
            if let Ok(mut update) =
                serde_json::from_str::<crate::actor_messages::LoroEphemeralUpdate>(json)
            {
                update.addr = Some(ctx.address());
                self.loro_sync_broadcaster_addr.do_send(update);
            }
        } else if let Some(json) = text.strip_prefix("SUBSCRIBE_QUERY ") {
            if let Ok(query) =
                serde_json::from_str::<crate::actor_messages::QuerySubscriptionJSON>(json)
            {
                self.commit_monitor_addr
                    .do_send(crate::actor_messages::SubscribeQuery {
                        addr: ctx.address(),
                        query,
                        agent: self.agent.to_string(),
                        source_id: self.connection_id.clone(),
                    });
            }
        } else if let Some(json) = text.strip_prefix("SUBSCRIBE ") {
            let subject =
                atomic_lib::Subject::from_raw(json, self.store.get_base_domain().as_deref());
            self.commit_monitor_addr
                .do_send(crate::actor_messages::Subscribe {
                    addr: ctx.address(),
                    subject: subject.clone(),
                    agent: self.agent.to_string(),
                    source_id: self.connection_id.clone(),
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
        // The wire `commit_id` becomes the client's `lastCommit` propval and,
        // on its next commit, its `previousCommit`. The latter is parsed as
        // an AtomicURL by the server's JSON-AD parser — a raw base64
        // signature isn't a URL and gets rejected. Always emit the full
        // `did:ad:commit:{signature}` DID. (`commit.url` is never populated
        // in practice, so the previous `or(signature)` fallback was always
        // taken — silently dropping the prefix.)
        let commit_id_owned = commit
            .url
            .clone()
            .or_else(|| {
                commit
                    .signature
                    .as_ref()
                    .map(|s| format!("did:ad:commit:{}", s))
            })
            .unwrap_or_default();
        let commit_id = commit_id_owned.as_str();

        // Resolve any `internal:/…` subject to the server's origin — the client
        // only speaks HTTP URLs and DIDs; `internal:` is a server-only form.
        let origin = self
            .store
            .get_base_domain()
            .unwrap_or_else(|| "http://localhost".to_string());
        let subject_resolved = commit.subject.resolve(&origin);

        if let Some(loro_update) = &commit.loro_update {
            ctx.binary(ws_v2::encode_update(
                ws_v2::flags::HAS_COMMIT_ID | ws_v2::flags::PUSH,
                0,
                &subject_resolved,
                Some(commit_id),
                loro_update,
            ));
        } else if commit.destroy.unwrap_or(false) {
            ctx.binary(ws_v2::encode_destroy(0, &subject_resolved));
        }
    }
}

impl Handler<crate::actor_messages::LoroSyncUpdate> for WebSocketConnection {
    type Result = ();

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

    fn handle(
        &mut self,
        msg: crate::actor_messages::QueryUpdate,
        ctx: &mut ws::WebsocketContext<Self>,
    ) {
        ctx.binary(ws_v2::encode_query_update(
            msg.property.as_deref(),
            msg.value.as_deref(),
            &msg.added,
            &msg.removed,
        ));
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
async fn handle_sync_vv(request: SyncVVRequest, store: Db, agent: ForAgent) -> Vec<Vec<u8>> {
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
    atomic_lib::sync::engine::handle_sync_deltas(&request.drive, &request.deltas, &store).await;
}
