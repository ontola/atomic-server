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
use base64::Engine as _;
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

/// Compare client VVs with server VVs, return binary SYNC_OK/SYNC_DIFF/SYNC_PUSH frames.
async fn handle_sync_vv(
    request: SyncVVRequest,
    store: Db,
    agent: ForAgent,
) -> Vec<Vec<u8>> {
    use atomic_lib::db::trees::Tree;
    use atomic_lib::loro::AtomicLoroDoc;

    let drive_subject = atomic_lib::Subject::from_raw(&request.drive, store.get_base_domain().as_deref());
    let drive_subjects = collect_drive_subjects(&store, &drive_subject);

    // Build server VVs
    let mut server_vvs: std::collections::HashMap<String, std::collections::HashMap<String, i32>> =
        std::collections::HashMap::new();

    for subject_str in &drive_subjects {
        if let Ok(Some(snapshot_bytes)) = store.kv.get(Tree::LoroSnapshots, subject_str.as_bytes()) {
            if let Ok(doc) = AtomicLoroDoc::from_snapshot(&snapshot_bytes) {
                server_vvs.insert(subject_str.clone(), doc.oplog_vv_map());
            }
        }
    }

    // Fast path: hash match
    if !request.drive_hash.is_empty() {
        let server_hash = compute_drive_hash(&server_vvs);

        if server_hash == request.drive_hash {
            tracing::info!("SYNC_VV: drive {} — hashes match, in sync", request.drive);

            return vec![ws_v2::encode_sync_ok(&request.drive)];
        }
    }

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

    let mut pull: Vec<String> = Vec::new();
    let mut push_entries: Vec<(String, Vec<u8>)> = Vec::new();

    // Compare server resources against client
    for (subject, server_vv) in &server_vvs {
        // Check read permission
        if let Ok(resource) = store
            .get_resource(&atomic_lib::Subject::from_raw(subject, store.get_base_domain().as_deref()))
            .await
        {
            if atomic_lib::hierarchy::check_read(&store, &resource, &agent).await.is_err() {
                continue;
            }
        }

        if let Some(client_vv) = client_vvs.get(subject) {
            let server_ahead = server_vv.iter().any(|(p, &sc)| client_vv.get(p).copied().unwrap_or(0) < sc);
            let client_ahead = client_vv.iter().any(|(p, &cc)| server_vv.get(p).copied().unwrap_or(0) < cc);

            if server_ahead {
                if let Ok(Some(snapshot_bytes)) = store.kv.get(Tree::LoroSnapshots, subject.as_bytes()) {
                    if let Ok(doc) = AtomicLoroDoc::from_snapshot(&snapshot_bytes) {
                        let client_loro_vv = AtomicLoroDoc::vv_from_map(client_vv);
                        let delta = doc.export_updates_since(&client_loro_vv);

                        if !delta.is_empty() {
                            push_entries.push((subject.clone(), delta));
                        }
                    }
                }
            }

            if client_ahead {
                pull.push(subject.clone());
            }
        } else {
            // Server has it, client doesn't — push full snapshot
            if let Ok(Some(snapshot_bytes)) = store.kv.get(Tree::LoroSnapshots, subject.as_bytes()) {
                push_entries.push((subject.clone(), snapshot_bytes));
            }
        }
    }

    // Client resources not on server
    for subject in client_vvs.keys() {
        if !server_vvs.contains_key(subject) {
            pull.push(subject.clone());
        }
    }

    let push_subjects: Vec<String> = push_entries.iter().map(|(s, _)| s.clone()).collect();

    tracing::info!(
        "SYNC_VV: drive {} — {} to push, {} to pull",
        request.drive,
        push_subjects.len(),
        pull.len(),
    );

    let mut frames = Vec::new();

    // SYNC_DIFF
    frames.push(ws_v2::encode_sync_diff(&request.drive, &pull, &push_subjects));

    // SYNC_PUSH with raw Loro bytes (no base64!)
    if !push_entries.is_empty() {
        let entries: Vec<(&str, &[u8])> = push_entries
            .iter()
            .map(|(s, b)| (s.as_str(), b.as_slice()))
            .collect();
        frames.push(ws_v2::encode_sync_push(&request.drive, &entries));
    }

    frames
}

/// Import Loro deltas from client into server resources.
async fn handle_sync_deltas(request: SyncDeltasRequest, store: Db, _agent: ForAgent) {
    use atomic_lib::db::trees::Tree;
    use atomic_lib::loro::AtomicLoroDoc;

    let mut count = 0;

    for (subject_str, delta_b64) in &request.deltas {
        let Ok(delta_bytes) = base64::engine::general_purpose::STANDARD.decode(delta_b64) else {
            tracing::warn!("SYNC_DELTAS: bad base64 for {}", subject_str);
            continue;
        };

        // Load or create Loro doc
        let doc = if let Ok(Some(snapshot)) = store.kv.get(Tree::LoroSnapshots, subject_str.as_bytes()) {
            match AtomicLoroDoc::from_snapshot(&snapshot) {
                Ok(d) => d,
                Err(_) => AtomicLoroDoc::new(),
            }
        } else {
            AtomicLoroDoc::new()
        };

        if doc.import_update(&delta_bytes).is_err() {
            tracing::warn!("SYNC_DELTAS: import failed for {}", subject_str);
            continue;
        }

        // Persist snapshot
        let new_snapshot = doc.export_snapshot();

        if store.kv.insert(Tree::LoroSnapshots, subject_str.as_bytes(), &new_snapshot).is_err() {
            continue;
        }

        // Materialize into resource
        let subject = atomic_lib::Subject::from_raw(subject_str, store.get_base_domain().as_deref());
        let mut resource = store.get_resource(&subject).await
            .unwrap_or_else(|_| atomic_lib::Resource::new(subject.to_string().into()));

        if resource.replace_state_from_loro_doc(doc).is_err() {
            continue;
        }

        let _ = store.add_resource_opts(&resource, false, true, true).await;
        count += 1;
    }

    tracing::info!("SYNC_DELTAS: imported {} resources for drive {}", count, request.drive);
}

// ---- Helpers ----

/// Collect all subjects belonging to a drive via BFS on parent relationships.
fn collect_drive_subjects(store: &Db, drive_subject: &atomic_lib::Subject) -> std::collections::HashSet<String> {
    let drive_str = drive_subject.as_str().to_string();
    let mut result = std::collections::HashSet::new();
    result.insert(drive_str.clone());

    if drive_subject.is_did() {
        // DID drives: BFS through parent→children
        let mut parent_to_children: std::collections::HashMap<String, Vec<String>> =
            std::collections::HashMap::new();

        for resource in store.all_resources(false) {
            if let Ok(parent_val) = resource.get(atomic_lib::urls::PARENT) {
                parent_to_children
                    .entry(parent_val.to_string())
                    .or_default()
                    .push(resource.get_subject().as_str().to_string());
            }
        }

        let mut queue = vec![drive_str];

        while let Some(current) = queue.pop() {
            if let Some(children) = parent_to_children.get(&current) {
                for child in children {
                    if result.insert(child.clone()) {
                        queue.push(child.clone());
                    }
                }
            }
        }
    } else {
        // URL drives: prefix match
        for resource in store.all_resources(false) {
            let subject = resource.get_subject();

            if subject.as_str().starts_with(drive_subject.as_str()) {
                result.insert(subject.as_str().to_string());
            }
        }
    }

    result
}

/// Compute SHA-256 drive hash matching the client's algorithm.
fn compute_drive_hash(
    vvs: &std::collections::HashMap<String, std::collections::HashMap<String, i32>>,
) -> String {
    let mut peer_set = std::collections::BTreeSet::new();

    for vv in vvs.values() {
        for peer_id in vv.keys() {
            peer_set.insert(peer_id.clone());
        }
    }

    let peers: Vec<String> = peer_set.into_iter().collect();
    let peer_index: std::collections::HashMap<&str, usize> =
        peers.iter().enumerate().map(|(i, p)| (p.as_str(), i)).collect();

    let mut entries: Vec<(String, Vec<i32>)> = vvs
        .iter()
        .map(|(subject, vv)| {
            let mut counters = vec![0i32; peers.len()];

            for (peer_id, &counter) in vv {
                if let Some(&idx) = peer_index.get(peer_id.as_str()) {
                    counters[idx] = counter;
                }
            }

            (subject.clone(), counters)
        })
        .collect();

    entries.sort_by(|(a, _), (b, _)| a.cmp(b));

    let hash_input: String = entries
        .iter()
        .map(|(s, c)| {
            let counters = c.iter().map(|n| n.to_string()).collect::<Vec<_>>().join(",");
            format!("{s}:{counters}")
        })
        .collect::<Vec<_>>()
        .join("|");

    let digest = ring::digest::digest(&ring::digest::SHA256, hash_input.as_bytes());
    hex::encode(digest.as_ref())
}
