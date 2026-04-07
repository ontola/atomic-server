//! WebSocket client for real-time communication with an Atomic Server.
//!
//! Supports the AtomicServer WebSocket protocol:
//! - `AUTHENTICATE` / `AUTHENTICATED` — agent auth
//! - `SUBSCRIBE` / `COMMIT` — resource change notifications
//! - `LORO_SYNC_SUBSCRIBE` / `LORO_SYNC_UPDATE` — real-time Loro CRDT sync
//! - `LORO_EPHEMERAL_UPDATE` — cursor/presence sync
//! - `GET` / `RESOURCE` — fetch resources over WebSocket

use crate::{
    agents::Agent,
    commit::sign_message,
    errors::{AtomicError, AtomicResult},
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
    /// Send commands to the writer task
    tx: mpsc::Sender<String>,
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
        let (tx, mut rx) = mpsc::channel::<String>(64);
        let (broadcast_tx, _) = broadcast::channel::<WsMessage>(256);
        let broadcast_tx_clone = broadcast_tx.clone();

        // Writer task: sends messages from the mpsc channel to the WebSocket
        tokio::spawn(async move {
            while let Some(msg) = rx.recv().await {
                if write.send(Message::Text(msg.into())).await.is_err() {
                    break;
                }
            }
        });

        // Reader task: receives messages from WebSocket, parses and broadcasts them
        tokio::spawn(async move {
            while let Some(Ok(msg)) = read.next().await {
                if let Message::Text(text) = msg {
                    let text = text.to_string();
                    let parsed = parse_server_message(&text);
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
    pub async fn authenticate(&self, agent: &Agent) -> AtomicResult<()> {
        let timestamp = crate::utils::now();
        let subject = &agent.subject.to_string();
        let private_key = agent
            .private_key
            .as_ref()
            .ok_or("Agent has no private key")?;
        let message = format!("{} {}", subject, timestamp);
        let signature = sign_message(&message, private_key, &agent.public_key)?;

        let auth = serde_json::json!({
            "https://atomicdata.dev/properties/auth/agent": subject,
            "https://atomicdata.dev/properties/auth/requestedSubject": subject,
            "https://atomicdata.dev/properties/auth/publicKey": agent.public_key,
            "https://atomicdata.dev/properties/auth/timestamp": timestamp,
            "https://atomicdata.dev/properties/auth/signature": signature,
        });

        // Subscribe BEFORE sending so we don't miss the response
        let mut rx = self.subscribe();

        self.send_raw(&format!("AUTHENTICATE {}", auth)).await?;
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
    pub async fn send_loro_sync_update(
        &self,
        subject: &str,
        update: &[u8],
    ) -> AtomicResult<()> {
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
            Err(AtomicError::from("WebSocket closed while waiting for resource"))
        });

        timeout
            .await
            .map_err(|_| AtomicError::from(format!("Timeout fetching resource {}", subject)))?
    }

    /// Send a raw string message over the WebSocket.
    pub async fn send_raw(&self, msg: &str) -> AtomicResult<()> {
        self.tx
            .send(msg.to_string())
            .await
            .map_err(|e| format!("Failed to send WebSocket message: {}", e).into())
    }
}

/// Parse a raw server message string into a typed `WsMessage`.
fn parse_server_message(text: &str) -> WsMessage {
    if text.starts_with("COMMIT ") {
        WsMessage::Commit(text[7..].to_string())
    } else if text.starts_with("RESOURCE ") {
        WsMessage::Resource(text[9..].to_string())
    } else if text.starts_with("LORO_SYNC_UPDATE ") {
        match serde_json::from_str::<serde_json::Value>(&text[17..]) {
            Ok(v) => {
                let subject = v["subject"].as_str().unwrap_or("").to_string();
                let update_b64 = v["update"].as_str().unwrap_or("");
                let update = crate::agents::decode_base64(update_b64).unwrap_or_default();
                WsMessage::LoroSyncUpdate { subject, update }
            }
            Err(_) => WsMessage::Error(format!("Invalid LORO_SYNC_UPDATE: {}", text)),
        }
    } else if text.starts_with("LORO_EPHEMERAL_UPDATE ") {
        match serde_json::from_str::<serde_json::Value>(&text[21..]) {
            Ok(v) => {
                let subject = v["subject"].as_str().unwrap_or("").to_string();
                let update_b64 = v["update"].as_str().unwrap_or("");
                let update = crate::agents::decode_base64(update_b64).unwrap_or_default();
                WsMessage::LoroEphemeralUpdate { subject, update }
            }
            Err(_) => WsMessage::Error(format!("Invalid LORO_EPHEMERAL_UPDATE: {}", text)),
        }
    } else if text.starts_with("QUERY_UPDATE ") {
        match serde_json::from_str::<serde_json::Value>(&text[13..]) {
            Ok(v) => {
                let property = v["property"].as_str().map(|s| s.to_string());
                let value = v["value"].as_str().map(|s| s.to_string());
                let added = v["added"]
                    .as_array()
                    .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
                    .unwrap_or_default();
                let removed = v["removed"]
                    .as_array()
                    .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
                    .unwrap_or_default();
                WsMessage::QueryUpdate { property, value, added, removed }
            }
            Err(_) => WsMessage::Error(format!("Invalid QUERY_UPDATE: {}", text)),
        }
    } else if text.starts_with("AUTHENTICATED") {
        WsMessage::Authenticated
    } else if text.starts_with("ERROR ") {
        WsMessage::Error(text[6..].to_string())
    } else {
        WsMessage::Error(format!("Unknown message: {}", text))
    }
}
