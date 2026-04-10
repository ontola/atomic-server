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
use base64::Engine as _;
use std::time::{Duration, Instant};

use crate::{
    actor_messages::CommitMessage, appstate::AppState, commit_monitor::CommitMonitor,
    errors::AtomicServerResult, helpers::get_auth_headers,
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
                            .map(
                                |(res, subject_str, origin), _actor, ctx| match res {
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
            let mut update: crate::actor_messages::LoroSyncUpdate = serde_json::from_str(json)
                .map_err(|e| format!("Invalid LORO_SYNC_UPDATE JSON: {e}"))?;
            update.addr = Some(ctx.address());
            conn.loro_sync_broadcaster_addr.do_send(update);
            Ok(())
        }
        s if s.starts_with("LORO_EPHEMERAL_UPDATE ") => {
            let json = &s[21..];
            let mut update: crate::actor_messages::LoroEphemeralUpdate = serde_json::from_str(json)
                .map_err(|e| format!("Invalid LORO_EPHEMERAL_UPDATE JSON: {e}"))?;
            update.addr = Some(ctx.address());
            conn.loro_sync_broadcaster_addr.do_send(update);
            Ok(())
        }
        s if s.starts_with("SUBSCRIBE_QUERY ") => {
            let json = &s[16..];
            let query: crate::actor_messages::QuerySubscriptionJSON = serde_json::from_str(json)
                .map_err(|e| format!("Invalid SUBSCRIBE_QUERY JSON: {e}"))?;
            conn.commit_monitor_addr
                .do_send(crate::actor_messages::SubscribeQuery {
                    addr: ctx.address(),
                    query,
                    agent: conn.agent.to_string(),
                });
            Ok(())
        }
        s if s.starts_with("SYNC_VV ") => {
            let json = &s[8..];
            let request: SyncVVRequest =
                serde_json::from_str(json).map_err(|e| format!("Invalid SYNC_VV JSON: {e}"))?;
            let store = conn.store.clone();
            let agent = conn.agent.clone();
            let origin = conn.origin.clone();
            ctx.spawn(
                async move { handle_sync_vv(request, store, agent, origin).await }
                    .into_actor(conn)
                    .map(|messages, _actor, ctx| {
                        for msg in messages {
                            ctx.text(msg);
                        }
                    }),
            );
            Ok(())
        }
        s if s.starts_with("SYNC_DELTAS ") => {
            let json = &s[12..];
            let request: SyncDeltasRequest =
                serde_json::from_str(json).map_err(|e| format!("Invalid SYNC_DELTAS JSON: {e}"))?;
            let store = conn.store.clone();
            let agent = conn.agent.clone();
            ctx.spawn(
                async move { handle_sync_deltas(request, store, agent).await }
                    .into_actor(conn)
                    .map(|messages, _actor, ctx| {
                        for msg in messages {
                            ctx.text(msg);
                        }
                    }),
            );
            Ok(())
        }
        s if s.starts_with("SYNC_DRIVE ") => {
            let json = &s[11..];
            let request: SyncDriveRequest =
                serde_json::from_str(json).map_err(|e| format!("Invalid SYNC_DRIVE JSON: {e}"))?;
            let store = conn.store.clone();
            let agent = conn.agent.clone();
            let origin = conn.origin.clone();
            ctx.spawn(
                async move { handle_sync_drive(request, store, agent, origin).await }
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
    let drive_subject =
        atomic_lib::Subject::from_raw(&request.drive, store.get_base_domain().as_deref());

    let drive_subjects = collect_drive_subjects(&store, &drive_subject);

    let mut count = 0;

    for subject_str in &drive_subjects {
        let subject = atomic_lib::Subject::from_raw(subject_str, store.get_base_domain().as_deref());
        let resource = match store.get_resource(&subject).await {
            Ok(r) => r,
            Err(_) => continue,
        };

        // If `since` is specified, only send resources modified after that timestamp
        if let Some(since) = request.since {
            if let Ok(last_commit_val) = resource.get(atomic_lib::urls::LAST_COMMIT) {
                let commit_subject = last_commit_val.to_string();
                if let Ok(commit_resource) = store.get_resource(&commit_subject.into()).await {
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
                tracing::warn!(
                    "Failed to serialize resource {} during sync: {}",
                    subject_str,
                    e
                );
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

// --- Version-vector based sync protocol ---

#[derive(serde::Deserialize)]
struct SyncVVRequest {
    drive: String,
    /// TODO: implement fast-path hash comparison (skip VV diff when hashes match)
    #[serde(rename = "driveHash")]
    _drive_hash: String,
    peers: Vec<String>,
    resources: std::collections::HashMap<String, Vec<i32>>,
}

#[derive(serde::Deserialize)]
struct SyncDeltasRequest {
    drive: String,
    deltas: std::collections::HashMap<String, String>, // subject → base64 Loro bytes
}

#[derive(serde::Serialize)]
struct SyncDiffMessage {
    drive: String,
    /// Subjects the server needs from the client (client-ahead or unknown to server)
    pull: Vec<String>,
    /// Subjects the server will push deltas for (server-ahead)
    push: Vec<String>,
}

#[derive(serde::Serialize)]
struct SyncDeltasMessage {
    drive: String,
    /// subject → base64-encoded Loro delta/snapshot bytes
    deltas: std::collections::HashMap<String, String>,
}

/// Handle SYNC_VV: compare client's version vectors with server's, determine diff.
async fn handle_sync_vv(
    request: SyncVVRequest,
    store: Db,
    agent: ForAgent,
    _origin: String,
) -> Vec<String> {
    use atomic_lib::db::trees::Tree;
    use atomic_lib::loro::AtomicLoroDoc;

    let mut messages = Vec::new();
    let drive_subject =
        atomic_lib::Subject::from_raw(&request.drive, store.get_base_domain().as_deref());

    // Collect server-side VVs for all resources in this drive
    let drive_subjects = collect_drive_subjects(&store, &drive_subject);

    // Build server VV map: subject → { peer_id_str → counter }
    let mut server_vvs: std::collections::HashMap<String, std::collections::HashMap<String, i32>> =
        std::collections::HashMap::new();

    for subject_str in &drive_subjects {
        if let Ok(Some(snapshot_bytes)) = store.kv.get(Tree::LoroSnapshots, subject_str.as_bytes())
        {
            if let Ok(doc) = AtomicLoroDoc::from_snapshot(&snapshot_bytes) {
                server_vvs.insert(subject_str.clone(), doc.oplog_vv_map());
            }
        }
    }

    // Compare VVs to compute diff
    // Reconstruct client VVs from compact format
    let mut client_vvs: std::collections::HashMap<String, std::collections::HashMap<String, i32>> =
        std::collections::HashMap::new();

    for (subject, counters) in &request.resources {
        let mut vv = std::collections::HashMap::new();

        for (i, &counter) in counters.iter().enumerate() {
            if counter != 0 {
                if let Some(peer_id) = request.peers.get(i) {
                    vv.insert(peer_id.clone(), counter);
                }
            }
        }

        client_vvs.insert(subject.clone(), vv);
    }

    let mut pull: Vec<String> = Vec::new(); // server needs from client
    let mut push: Vec<String> = Vec::new(); // server will push to client
    let mut push_deltas: std::collections::HashMap<String, String> =
        std::collections::HashMap::new();

    // Check each server resource against client
    for (subject, server_vv) in &server_vvs {
        // Check read permission before sending
        if let Ok(resource) = store
            .get_resource(&atomic_lib::Subject::from_raw(
                subject,
                store.get_base_domain().as_deref(),
            ))
            .await
        {
            if atomic_lib::hierarchy::check_read(&store, &resource, &agent)
                .await
                .is_err()
            {
                continue;
            }
        }

        if let Some(client_vv) = client_vvs.get(subject) {
            // Both sides have it — check if they differ
            let server_ahead = server_vv
                .iter()
                .any(|(p, &sc)| client_vv.get(p).copied().unwrap_or(0) < sc);
            let client_ahead = client_vv
                .iter()
                .any(|(p, &cc)| server_vv.get(p).copied().unwrap_or(0) < cc);

            if server_ahead {
                // Compute delta from client's version to server's version
                if let Ok(Some(snapshot_bytes)) =
                    store.kv.get(Tree::LoroSnapshots, subject.as_bytes())
                {
                    if let Ok(doc) = AtomicLoroDoc::from_snapshot(&snapshot_bytes) {
                        // Build a VersionVector from client's VV for this resource
                        let client_loro_vv = AtomicLoroDoc::vv_from_map(client_vv);
                        let delta = doc.export_updates_since(&client_loro_vv);

                        if !delta.is_empty() {
                            push_deltas.insert(
                                subject.clone(),
                                base64::engine::general_purpose::STANDARD.encode(&delta),
                            );
                        }
                    }
                }

                push.push(subject.clone());
            }

            if client_ahead {
                pull.push(subject.clone());
            }
        } else {
            // Server has it, client doesn't — push full snapshot
            if let Ok(Some(snapshot_bytes)) =
                store.kv.get(Tree::LoroSnapshots, subject.as_bytes())
            {
                push_deltas.insert(
                    subject.clone(),
                    base64::engine::general_purpose::STANDARD.encode(&snapshot_bytes),
                );
                push.push(subject.clone());
            }
        }
    }

    // Check for resources client has that server doesn't
    for subject in client_vvs.keys() {
        if !server_vvs.contains_key(subject) {
            pull.push(subject.clone());
        }
    }

    // Send diff message
    let diff = SyncDiffMessage {
        drive: request.drive.clone(),
        pull,
        push: push.clone(),
    };
    messages.push(format!(
        "SYNC_DIFF {}",
        serde_json::to_string(&diff).unwrap()
    ));

    // Send server-ahead deltas
    if !push_deltas.is_empty() {
        let deltas_msg = SyncDeltasMessage {
            drive: request.drive.clone(),
            deltas: push_deltas,
        };
        messages.push(format!(
            "SYNC_DELTAS {}",
            serde_json::to_string(&deltas_msg).unwrap()
        ));
    }

    tracing::info!(
        "SYNC_VV: drive {} — {} to push, {} to pull",
        request.drive,
        push.len(),
        diff.pull.len()
    );

    messages
}

/// Handle SYNC_DELTAS from client: import Loro deltas into server resources.
async fn handle_sync_deltas(
    request: SyncDeltasRequest,
    store: Db,
    _agent: ForAgent,
) -> Vec<String> {
    use atomic_lib::db::trees::Tree;
    use atomic_lib::loro::AtomicLoroDoc;

    let mut count = 0;

    for (subject_str, delta_b64) in &request.deltas {
        // Decode base64
        let delta_bytes = match base64::engine::general_purpose::STANDARD.decode(delta_b64) {
            Ok(b) => b,
            Err(e) => {
                tracing::warn!("SYNC_DELTAS: failed to decode base64 for {}: {}", subject_str, e);
                continue;
            }
        };

        // Load or create Loro doc and import the delta
        let doc = if let Ok(Some(existing)) =
            store.kv.get(Tree::LoroSnapshots, subject_str.as_bytes())
        {
            match AtomicLoroDoc::from_snapshot(&existing) {
                Ok(d) => d,
                Err(_) => AtomicLoroDoc::new(),
            }
        } else {
            AtomicLoroDoc::new()
        };

        if let Err(e) = doc.import_update(&delta_bytes) {
            tracing::warn!("SYNC_DELTAS: failed to import for {}: {}", subject_str, e);
            continue;
        }

        // Save Loro snapshot to dedicated table
        let new_snapshot = doc.export_snapshot();
        if let Err(e) = store
            .kv
            .insert(Tree::LoroSnapshots, subject_str.as_bytes(), &new_snapshot)
        {
            tracing::warn!("SYNC_DELTAS: failed to save snapshot for {}: {}", subject_str, e);
            continue;
        }

        // Materialize resource propvals from Loro state and store in main table
        let subject =
            atomic_lib::Subject::from_raw(subject_str, store.get_base_domain().as_deref());
        let mut resource = store
            .get_resource(&subject)
            .await
            .unwrap_or_else(|_| atomic_lib::Resource::new(subject.to_string().into()));

        if let Err(e) = resource.replace_state_from_loro_doc(doc) {
            tracing::warn!("SYNC_DELTAS: failed to materialize {}: {}", subject_str, e);
            continue;
        }

        if let Err(e) = store.add_resource_opts(&resource, false, true, true).await {
            tracing::warn!("SYNC_DELTAS: failed to store {}: {}", subject_str, e);
            continue;
        }

        count += 1;
    }

    tracing::info!(
        "SYNC_DELTAS: imported {} resources for drive {}",
        count,
        request.drive
    );
    Vec::new()
}

/// Collect all subjects belonging to a drive (reused by both SYNC_DRIVE and SYNC_VV).
fn collect_drive_subjects(
    store: &Db,
    drive_subject: &atomic_lib::Subject,
) -> std::collections::HashSet<String> {
    let drive_str = drive_subject.as_str().to_string();
    let mut drive_subjects: std::collections::HashSet<String> = std::collections::HashSet::new();

    // Always include the drive resource itself.
    drive_subjects.insert(drive_str.clone());

    let is_did_drive = drive_subject.is_did();

    if is_did_drive {
        let mut parent_to_children: std::collections::HashMap<String, Vec<String>> =
            std::collections::HashMap::new();

        for resource in store.all_resources(false) {
            if let Ok(parent_val) = resource.get(atomic_lib::urls::PARENT) {
                let parent = parent_val.to_string();
                parent_to_children
                    .entry(parent)
                    .or_default()
                    .push(resource.get_subject().as_str().to_string());
            }
        }

        let mut queue = vec![drive_str];

        while let Some(current) = queue.pop() {
            if let Some(children) = parent_to_children.get(&current) {
                for child in children {
                    if drive_subjects.insert(child.clone()) {
                        queue.push(child.clone());
                    }
                }
            }
        }
    } else {
        for resource in store.all_resources(false) {
            let subject = resource.get_subject();

            if subject.as_str().starts_with(drive_subject.as_str()) {
                drive_subjects.insert(subject.as_str().to_string());
            }
        }
    }

    drive_subjects
}
