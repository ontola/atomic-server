//! WebSocket client for real-time communication with an Atomic Server.
//!
//! Hybrid v2 protocol: auth and resource UPDATEs are binary frames
//! (`sync::protocol`); legacy collaboration and query messages are still
//! text frames (`LORO_SYNC_*`, `LORO_EPHEMERAL_UPDATE`, `SUBSCRIBE_QUERY`,
//! `QUERY_UPDATE`, `SYNC_VV` / `SYNC_DELTAS`).

use crate::{
    agents::Agent,
    errors::{AtomicError, AtomicResult},
    sync::protocol,
};
use futures::{SinkExt, StreamExt};
use tokio::sync::{broadcast, mpsc};
use tokio_tungstenite::{connect_async, tungstenite::Message};

/// A message received from the server over WebSocket.
#[derive(Clone, Debug)]
pub enum WsMessage {
    /// A commit was applied to a subscribed resource. Contains JSON-AD of the commit.
    Commit(String),
    /// A resource response (from GET). Contains JSON-AD of the resource.
    Resource(String),
    /// A Loro CRDT sync update. Contains `{ subject, update }` JSON.
    LoroSyncUpdate { subject: String, update: Vec<u8> },
    /// A Loro ephemeral update (cursors/presence). Contains `{ subject, update }` JSON.
    LoroEphemeralUpdate { subject: String, update: Vec<u8> },
    /// A query's results changed. Contains added/removed subjects.
    QueryUpdate {
        property: Option<String>,
        value: Option<String>,
        added: Vec<String>,
        removed: Vec<String>,
    },
    /// Server confirmed authentication.
    Authenticated,
    /// A `BLOB_RESPONSE` (0x35) frame: server returned the bytes for a
    /// previously-requested BLAKE3 hash.
    BlobResponse { hash: [u8; 32], bytes: Vec<u8> },
    /// A binary v2 `UPDATE` (0x11) frame: a resource changed (subscription
    /// push, or response to a `GET`). Carries the Loro bytes and, when the
    /// server sets `HAS_COMMIT_ID`, the commit id that produced them.
    Update {
        subject: String,
        loro_bytes: Vec<u8>,
        commit_id: Option<String>,
        is_snapshot: bool,
        is_push: bool,
    },
    /// A binary v2 `DESTROY` (0x12) frame: a subscribed resource was deleted.
    Destroy { subject: String },
    /// Server confirmed a posted commit (binary COMMIT_OK).
    CommitOk {
        request_id: u16,
        commit_json: String,
    },
    /// Server sent an error.
    Error(String),
}

/// WebSocket client for AtomicServer.
///
/// # Example
/// ```no_run
/// use atomic_lib::client::ws::WsClient;
/// use atomic_lib::agents::Agent;
///
/// # async fn example() -> atomic_lib::errors::AtomicResult<()> {
/// let agent = Agent::from_secret("base64secret...")?;
/// let mut client = WsClient::connect("ws://localhost:9883/ws").await?;
/// client.authenticate(&agent).await?;
/// let mut rx = client.subscribe();
/// client.subscribe_resource("did:ad:some-resource").await?;
/// // Receive messages
/// while let Ok(msg) = rx.recv().await {
///     println!("Got: {:?}", msg);
/// }
/// # Ok(())
/// # }
/// ```
pub struct WsClient {
    /// Send frames (text or binary) to the writer task
    tx: mpsc::Sender<Message>,
    /// Broadcast channel for incoming messages
    broadcast_tx: broadcast::Sender<WsMessage>,
}

impl WsClient {
    /// Connect to an AtomicServer WebSocket endpoint.
    /// The URL should be `ws://` or `wss://` (e.g. `ws://localhost:9883/ws`).
    pub async fn connect(url: &str) -> AtomicResult<Self> {
        let (ws_stream, _response) = connect_async(url)
            .await
            .map_err(|e| format!("WebSocket connection failed to {}: {}", url, e))?;

        let (mut write, mut read) = ws_stream.split();
        let (tx, mut rx) = mpsc::channel::<Message>(64);
        let (broadcast_tx, _) = broadcast::channel::<WsMessage>(256);
        let broadcast_tx_clone = broadcast_tx.clone();

        // Writer task: forwards frames verbatim to the WebSocket
        tokio::spawn(async move {
            while let Some(msg) = rx.recv().await {
                if write.send(msg).await.is_err() {
                    break;
                }
            }
        });

        // Reader task: parses incoming frames into WsMessages
        tokio::spawn(async move {
            while let Some(Ok(msg)) = read.next().await {
                let parsed = match msg {
                    Message::Text(text) => Some(parse_server_message(&text)),
                    Message::Binary(bin) => parse_binary_message(&bin),
                    _ => None,
                };
                if let Some(parsed) = parsed {
                    let _ = broadcast_tx_clone.send(parsed);
                }
            }
        });

        Ok(Self { tx, broadcast_tx })
    }

    /// Subscribe to incoming messages. Returns a broadcast receiver.
    /// Multiple subscribers can be created.
    pub fn subscribe(&self) -> broadcast::Receiver<WsMessage> {
        self.broadcast_tx.subscribe()
    }

    /// Authenticate with the server using an Agent's credentials.
    /// Sends a binary v2 AUTH (0x01) frame and waits for AUTH_OK (0x02).
    pub async fn authenticate(&self, agent: &Agent) -> AtomicResult<()> {
        let frame = protocol::encode_auth(agent, &agent.subject.to_string())?;

        // Subscribe BEFORE sending so we don't miss the response
        let mut rx = self.subscribe();

        self.send_binary(frame).await?;
        let timeout = tokio::time::timeout(std::time::Duration::from_secs(5), async {
            while let Ok(msg) = rx.recv().await {
                match msg {
                    WsMessage::Authenticated => return Ok(()),
                    WsMessage::Error(e) => {
                        return Err(AtomicError::from(format!("Auth failed: {}", e)))
                    }
                    _ => continue,
                }
            }
            Err(AtomicError::from("WebSocket closed during authentication"))
        });

        timeout
            .await
            .map_err(|_| AtomicError::from("Authentication timed out"))?
    }

    /// Subscribe to commit notifications for a resource.
    pub async fn subscribe_resource(&self, subject: &str) -> AtomicResult<()> {
        self.send_raw(&format!("SUBSCRIBE {}", subject)).await
    }

    /// Subscribe to Loro CRDT sync updates for a resource.
    pub async fn subscribe_loro_sync(&self, subject: &str) -> AtomicResult<()> {
        self.send_raw(&format!(
            "LORO_SYNC_SUBSCRIBE {}",
            serde_json::json!({ "subject": subject })
        ))
        .await
    }

    /// Send a Loro CRDT document update for a resource.
    pub async fn send_loro_sync_update(&self, subject: &str, update: &[u8]) -> AtomicResult<()> {
        let b64 = crate::agents::encode_base64(update);
        self.send_raw(&format!(
            "LORO_SYNC_UPDATE {}",
            serde_json::json!({ "subject": subject, "update": b64 })
        ))
        .await
    }

    /// Send a Loro ephemeral update (cursors, presence).
    pub async fn send_loro_ephemeral_update(
        &self,
        subject: &str,
        update: &[u8],
    ) -> AtomicResult<()> {
        let b64 = crate::agents::encode_base64(update);
        self.send_raw(&format!(
            "LORO_EPHEMERAL_UPDATE {}",
            serde_json::json!({ "subject": subject, "update": b64 })
        ))
        .await
    }

    /// Fetch a resource over WebSocket (sends GET, waits for RESOURCE response).
    pub async fn get_resource(&self, subject: &str) -> AtomicResult<String> {
        let mut rx = self.subscribe();
        self.send_raw(&format!("GET {}", subject)).await?;
        let timeout = tokio::time::timeout(std::time::Duration::from_secs(10), async {
            while let Ok(msg) = rx.recv().await {
                match msg {
                    WsMessage::Resource(json) => {
                        // Check if this is the resource we requested
                        if json.contains(subject) {
                            return Ok(json);
                        }
                    }
                    WsMessage::Error(e) => {
                        return Err(AtomicError::from(format!(
                            "Error fetching {}: {}",
                            subject, e
                        )))
                    }
                    _ => continue,
                }
            }
            Err(AtomicError::from(
                "WebSocket closed while waiting for resource",
            ))
        });

        timeout
            .await
            .map_err(|_| AtomicError::from(format!("Timeout fetching resource {}", subject)))?
    }

    /// Fetch a content-addressed blob by its 32-byte BLAKE3 hash.
    /// Sends a binary `BLOB_REQUEST` (0x34) and waits for a matching
    /// `BLOB_RESPONSE` (0x35).
    pub async fn fetch_blob(&self, hash: &[u8; 32]) -> AtomicResult<Vec<u8>> {
        let mut rx = self.subscribe();
        self.send_binary(protocol::encode_blob_request(hash))
            .await?;
        let timeout = tokio::time::timeout(std::time::Duration::from_secs(10), async {
            while let Ok(msg) = rx.recv().await {
                match msg {
                    WsMessage::BlobResponse {
                        hash: rcv_hash,
                        bytes,
                    } if rcv_hash == *hash => return Ok(bytes),
                    WsMessage::Error(e) => {
                        return Err(AtomicError::from(format!("Blob fetch error: {}", e)))
                    }
                    _ => continue,
                }
            }
            Err(AtomicError::from("WebSocket closed during blob fetch"))
        });
        timeout
            .await
            .map_err(|_| AtomicError::from("Timeout fetching blob"))?
    }

    /// Send a raw text frame over the WebSocket. Used for legacy text-protocol
    /// commands (LORO_*, SUBSCRIBE_QUERY, SYNC_VV, SYNC_DELTAS).
    pub async fn send_raw(&self, msg: &str) -> AtomicResult<()> {
        self.tx
            .send(Message::Text(msg.to_string().into()))
            .await
            .map_err(|e| format!("Failed to send WebSocket message: {}", e).into())
    }

    /// Send a raw binary frame over the WebSocket (v2 protocol).
    pub async fn send_binary(&self, bytes: Vec<u8>) -> AtomicResult<()> {
        self.tx
            .send(Message::Binary(bytes.into()))
            .await
            .map_err(|e| format!("Failed to send WebSocket binary: {}", e).into())
    }

    /// Subscribe to drive-scoped updates (QUERY_UPDATE + UPDATE pushes).
    pub async fn subscribe_drive(&self, drive_subject: &str) -> AtomicResult<()> {
        self.send_binary(protocol::encode_sub(drive_subject)).await
    }

    /// Register a live query filter (text `SUBSCRIBE_QUERY` frame).
    pub async fn subscribe_query(
        &self,
        property: &str,
        value: &str,
        drive: &str,
    ) -> AtomicResult<()> {
        let json = serde_json::json!({
            "property": property,
            "value": value,
            "drive": drive,
        });
        self.send_raw(&format!("SUBSCRIBE_QUERY {}", json)).await
    }

    /// Post a commit over WebSocket; returns the server's commit JSON-AD on success.
    pub async fn post_commit(&self, request_id: u16, commit_json: &str) -> AtomicResult<String> {
        let mut rx = self.subscribe();
        self.send_binary(protocol::encode_commit(request_id, commit_json))
            .await?;

        let timeout = tokio::time::timeout(std::time::Duration::from_secs(30), async {
            while let Ok(msg) = rx.recv().await {
                match msg {
                    WsMessage::CommitOk {
                        request_id: rid,
                        commit_json,
                    } if rid == request_id => return Ok(commit_json),
                    WsMessage::Error(e) => {
                        return Err(AtomicError::from(format!("COMMIT failed: {}", e)))
                    }
                    _ => continue,
                }
            }
            Err(AtomicError::from(
                "WebSocket closed while waiting for COMMIT_OK",
            ))
        });

        timeout
            .await
            .map_err(|_| AtomicError::from("COMMIT timed out"))?
    }
}

/// Parse a raw server message string into a typed `WsMessage`.
fn parse_server_message(text: &str) -> WsMessage {
    if let Some(stripped) = text.strip_prefix("COMMIT ") {
        WsMessage::Commit(stripped.to_string())
    } else if let Some(stripped) = text.strip_prefix("RESOURCE ") {
        WsMessage::Resource(stripped.to_string())
    } else if let Some(stripped) = text.strip_prefix("LORO_SYNC_UPDATE ") {
        match serde_json::from_str::<serde_json::Value>(stripped) {
            Ok(v) => {
                let subject = v["subject"].as_str().unwrap_or("").to_string();
                let update_b64 = v["update"].as_str().unwrap_or("");
                let update = crate::agents::decode_base64(update_b64).unwrap_or_default();
                WsMessage::LoroSyncUpdate { subject, update }
            }
            Err(_) => WsMessage::Error(format!("Invalid LORO_SYNC_UPDATE: {}", text)),
        }
    } else if let Some(stripped) = text.strip_prefix("LORO_EPHEMERAL_UPDATE ") {
        match serde_json::from_str::<serde_json::Value>(stripped) {
            Ok(v) => {
                let subject = v["subject"].as_str().unwrap_or("").to_string();
                let update_b64 = v["update"].as_str().unwrap_or("");
                let update = crate::agents::decode_base64(update_b64).unwrap_or_default();
                WsMessage::LoroEphemeralUpdate { subject, update }
            }
            Err(_) => WsMessage::Error(format!("Invalid LORO_EPHEMERAL_UPDATE: {}", text)),
        }
    } else if let Some(stripped) = text.strip_prefix("QUERY_UPDATE ") {
        match serde_json::from_str::<serde_json::Value>(stripped) {
            Ok(v) => {
                let property = v["property"].as_str().map(|s| s.to_string());
                let value = v["value"].as_str().map(|s| s.to_string());
                let added = v["added"]
                    .as_array()
                    .map(|a| {
                        a.iter()
                            .filter_map(|v| v.as_str().map(String::from))
                            .collect()
                    })
                    .unwrap_or_default();
                let removed = v["removed"]
                    .as_array()
                    .map(|a| {
                        a.iter()
                            .filter_map(|v| v.as_str().map(String::from))
                            .collect()
                    })
                    .unwrap_or_default();
                WsMessage::QueryUpdate {
                    property,
                    value,
                    added,
                    removed,
                }
            }
            Err(_) => WsMessage::Error(format!("Invalid QUERY_UPDATE: {}", text)),
        }
    } else if text.starts_with("AUTHENTICATED") {
        WsMessage::Authenticated
    } else if let Some(stripped) = text.strip_prefix("ERROR ") {
        WsMessage::Error(stripped.to_string())
    } else {
        WsMessage::Error(format!("Unknown message: {}", text))
    }
}

/// Parse a binary v2 frame. Returns `None` for frames the client doesn't
/// translate into `WsMessage` (UPDATE, SYNC_*, etc.).
fn parse_binary_message(bin: &[u8]) -> Option<WsMessage> {
    use protocol::tag;
    let tag = *bin.first()?;
    match tag {
        tag::AUTH_OK => Some(WsMessage::Authenticated),
        tag::ERROR => {
            // [tag: u8] [request_id: u16] [message: utf8]
            if bin.len() < 3 {
                return Some(WsMessage::Error("Malformed ERROR frame".into()));
            }
            let msg = std::str::from_utf8(&bin[3..])
                .unwrap_or("(non-utf8 error message)")
                .to_string();
            Some(WsMessage::Error(msg))
        }
        tag::BLOB_RESPONSE => {
            let resp = protocol::decode_blob_response(&bin[1..])?;
            Some(WsMessage::BlobResponse {
                hash: resp.hash,
                bytes: resp.bytes,
            })
        }
        tag::UPDATE => decode_update_frame(&bin[1..]),
        tag::QUERY_UPDATE => {
            let q = protocol::decode_query_update(&bin[1..])?;
            Some(WsMessage::QueryUpdate {
                property: q.property,
                value: q.value,
                added: q.added,
                removed: q.removed,
            })
        }
        tag::DESTROY => {
            // [tag] [request_id: u16] [subject: utf8]
            if bin.len() < 3 {
                return None;
            }
            let subject = std::str::from_utf8(&bin[3..]).ok()?.to_string();
            Some(WsMessage::Destroy { subject })
        }
        tag::COMMIT_OK => {
            let decoded = protocol::decode_commit(&bin[1..])?;
            Some(WsMessage::CommitOk {
                request_id: decoded.request_id,
                commit_json: decoded.commit_json.to_string(),
            })
        }
        _ => None,
    }
}

/// Decode an UPDATE frame payload (everything after the tag byte). Layout:
/// `[flags: u8] [request_id: u16] [subject_len: u16] [subject] [optional
/// commit_id_len: u16 + commit_id] [loro_bytes...]`.
fn decode_update_frame(payload: &[u8]) -> Option<WsMessage> {
    use protocol::flags;
    if payload.len() < 5 {
        return None;
    }
    let flag_bits = payload[0];
    let _request_id = u16::from_be_bytes([payload[1], payload[2]]);
    let subject_len = u16::from_be_bytes([payload[3], payload[4]]) as usize;
    let mut cursor = 5;
    if payload.len() < cursor + subject_len {
        return None;
    }
    let subject = std::str::from_utf8(&payload[cursor..cursor + subject_len])
        .ok()?
        .to_string();
    cursor += subject_len;

    let mut commit_id = None;
    if flag_bits & flags::HAS_COMMIT_ID != 0 {
        if payload.len() < cursor + 2 {
            return None;
        }
        let cid_len = u16::from_be_bytes([payload[cursor], payload[cursor + 1]]) as usize;
        cursor += 2;
        if payload.len() < cursor + cid_len {
            return None;
        }
        commit_id = Some(
            std::str::from_utf8(&payload[cursor..cursor + cid_len])
                .ok()?
                .to_string(),
        );
        cursor += cid_len;
    }

    let loro_bytes = payload[cursor..].to_vec();

    Some(WsMessage::Update {
        subject,
        loro_bytes,
        commit_id,
        is_snapshot: flag_bits & flags::SNAPSHOT != 0,
        is_push: flag_bits & flags::PUSH != 0,
    })
}
