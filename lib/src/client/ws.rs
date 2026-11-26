//! WebSocket client for real-time communication with an Atomic Server.
//!
//! Hybrid v2 protocol: auth, resource UPDATEs and live collaboration
//! (`EPHEMERAL`) are binary frames (`sync::protocol`); the Loro and presence
//! *subscriptions* and the drive inventory are still text frames
//! (`LORO_SYNC_SUBSCRIBE`, `PRESENCE_SUBSCRIBE`, ...). `SYNC_DELTAS` was removed (F8,
//! planning/unified-sync.md) — it imported peer-supplied Loro deltas with
//! no rights check at all; `SYNC` → `SYNC_PUSH` (binary v2, admission- and
//! rights-checked via `import_sync_push`) is the real replacement and
//! predates the deletion, so nothing lost functionality.
//!
//! **Canonical wire-format spec:** `docs/src/websockets.md`. Frame
//! encode/decode lives in [`crate::sync::protocol`]; the TypeScript client
//! counterpart is `browser/lib/src/websockets.ts` (with low-level helpers in
//! `browser/lib/src/ws-v2.ts`). Update all four together when changing the
//! protocol.

use crate::{
    agents::Agent,
    errors::{AtomicError, AtomicResult},
    sync::protocol,
};
use futures::{SinkExt, StreamExt};
use tokio::sync::{broadcast, mpsc, watch};
#[cfg(not(target_os = "android"))]
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message;

/// A message received from the server over WebSocket.
#[derive(Clone, Debug)]
pub enum WsMessage {
    /// An edit in progress on `subject`: `EPHEMERAL (0x40)` of kind `DOC`,
    /// raw Loro update bytes.
    LoroSyncUpdate { subject: String, update: Vec<u8> },
    /// Cursors for `subject`: `EPHEMERAL` of kind `LORO`, raw
    /// `EphemeralStore` bytes.
    LoroEphemeralUpdate { subject: String, update: Vec<u8> },
    /// Drive-scoped presence: `EPHEMERAL` of kind `PRESENCE`, where
    /// `subject` is the drive.
    PresenceUpdate { subject: String, update: Vec<u8> },
    /// Server confirmed authentication. Its advertised capabilities are
    /// available via [`WsClient::server_capabilities`].
    Authenticated,
    /// A validated storage barrier; consumers must correlate it to a pending request.
    StorageReceipt(protocol::StorageReceipt),
    /// The server echoed a `KEEPALIVE` (0x41) we sent.
    Keepalive,
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
    /// Server confirmed a posted commit (binary COMMIT_OK). `commit_id` is
    /// the server's id for it; `commit_json` is the full commit only when
    /// the server sent the legacy full form (this client asks for the slim
    /// one in its `HELLO`).
    CommitOk {
        request_id: u16,
        commit_id: String,
        commit_json: Option<String>,
        /// The node's write-load hint (`commit-pace`): the least number of
        /// milliseconds to leave between commits of one resource.
        pace_ms: Option<u32>,
    },
    /// The server's `CHALLENGE` (0x42): the nonce this connection's AUTH
    /// proof binds itself to. Recorded by the client; `authenticate` uses it
    /// automatically.
    Challenge { nonce: String },
    /// A `SYNC_OK` (0x31) frame: the drive matches ours, or a `SYNC_PUSH`
    /// chunk was accepted. Note the server sends this for an accepted *and* a
    /// rights-rejected import alike, so it is not proof the data landed.
    SyncOk { drive: String },
    /// A `SYNC_RESEND` (0x38) frame: our hash-first `SYNC` probe missed;
    /// reconcile and send the version vectors.
    SyncResend { drive: String },
    /// A `SYNC_DIFF` (0x32) frame: the server's verdict on our version vector.
    /// `pull` is what it wants us to send it; `push` is what it will send us.
    SyncDiff {
        drive: String,
        pull: Vec<String>,
        push: Vec<String>,
        remove: Vec<String>,
        remove_commits: std::collections::HashMap<String, String>,
    },
    /// A `SYNC_PUSH` (0x33) frame: the server is sending us resource state.
    SyncPush {
        drive: String,
        entries: Vec<(String, Vec<u8>)>,
        last: bool,
    },
    /// A `BLOB_REQUEST` (0x34) frame: the server imported a resource that
    /// references a blob it doesn't have, and is asking us for the bytes.
    BlobRequest { hash: [u8; 32] },
    /// An `ERROR` (0x03) frame. `request_id` is the id of the `GET` /
    /// `COMMIT` it answers, or `0` for a connection-level refusal (a rejected
    /// `AUTH`, `SUB`, `SYNC_PUSH`, ...). `code` is one of
    /// [`protocol::error_code`].
    Error {
        request_id: u16,
        code: u16,
        message: String,
    },
    /// A text frame this client does not translate (an unknown prefix, or a
    /// known one with an unparsable body). Informational; never an error the
    /// server sent.
    Unrecognized(String),
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
    /// `http(s)://host[:port]` of the server, derived from the `ws(s)://`
    /// URL. This is what `authenticate` signs as `requestedSubject`: the
    /// server binds an AUTH proof to its own origin, so a proof signed for
    /// anything else (the agent's own subject, another server) is refused.
    origin: String,
    auth: std::sync::Arc<std::sync::Mutex<AuthState>>,
    auth_serial: tokio::sync::Mutex<()>,
    connection_id: String,
    /// The nonce from the server's `CHALLENGE`, once it arrived. `None` on a
    /// server that predates the frame.
    challenge: std::sync::Arc<std::sync::Mutex<Option<String>>>,
    /// Flips to `true` when the reader task ends, i.e. the socket closed.
    closed: watch::Receiver<bool>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct WsAuthContext {
    pub generation: u64,
    pub agent: String,
}

#[derive(Default)]
struct AuthState {
    generation: u64,
    pending: Option<String>,
    accepted: Option<String>,
    caps: Vec<String>,
    // AUTH_OK has no request id. After an untracked/cancelled AUTH, an old
    // acknowledgement cannot safely identify a later attempt on this socket.
    uncorrelated: bool,
}
impl AuthState {
    fn invalidate(&mut self, uncorrelated: bool) {
        self.generation = self.generation.wrapping_add(1);
        self.pending = None;
        self.accepted = None;
        self.caps.clear();
        self.uncorrelated |= uncorrelated;
    }
    fn accept(&mut self, caps: Vec<String>) {
        if let Some(agent) = self.pending.take() {
            self.accepted = Some(agent);
            self.caps = caps;
        }
    }
    fn context(&self) -> Option<WsAuthContext> {
        if self.uncorrelated {
            return None;
        }
        Some(WsAuthContext {
            generation: self.generation,
            agent: self.accepted.clone()?,
        })
    }
}
struct AuthAttempt {
    auth: std::sync::Arc<std::sync::Mutex<AuthState>>,
    generation: u64,
    completed: bool,
}
impl Drop for AuthAttempt {
    fn drop(&mut self) {
        if !self.completed {
            let mut auth = self.auth.lock().unwrap();
            if auth.generation == self.generation {
                auth.invalidate(true);
            }
        }
    }
}

/// How long `authenticate` waits for the server's `CHALLENGE` when it has
/// not arrived yet. The server sends it as its very first frame, so on a
/// current server this never elapses; on an older one it costs this once.
const CHALLENGE_WAIT: std::time::Duration = std::time::Duration::from_millis(300);

/// `ws://host:port/ws` → `http://host:port`; `wss://` → `https://`. Falls
/// back to the input when it does not parse, so a bad URL still fails at
/// connect time with a useful error rather than here.
fn http_origin_of_ws_url(url: &str) -> String {
    let Ok(parsed) = url::Url::parse(url) else {
        return url.to_string();
    };
    let scheme = match parsed.scheme() {
        "wss" | "https" => "https",
        _ => "http",
    };
    let Some(host) = parsed.host_str() else {
        return url.to_string();
    };
    match parsed.port() {
        Some(port) => format!("{scheme}://{host}:{port}"),
        None => format!("{scheme}://{host}"),
    }
}

impl WsClient {
    #[cfg(test)]
    pub(crate) fn receipt_test_client(
        agent: &str,
        capability: bool,
    ) -> (
        std::sync::Arc<Self>,
        mpsc::Receiver<Message>,
        watch::Sender<bool>,
    ) {
        let (tx, rx) = mpsc::channel(64);
        let (closed_tx, closed) = watch::channel(false);
        let auth = AuthState {
            generation: 1,
            accepted: Some(agent.into()),
            caps: if capability {
                vec![protocol::CAP_SERVER_STORAGE_RECEIPTS_V1.into()]
            } else {
                vec![]
            },
            ..Default::default()
        };
        (
            std::sync::Arc::new(Self {
                tx,
                broadcast_tx: broadcast::channel(256).0,
                origin: "https://server.example".into(),
                auth: std::sync::Arc::new(std::sync::Mutex::new(auth)),
                auth_serial: tokio::sync::Mutex::new(()),
                connection_id: protocol::new_challenge_nonce(),
                challenge: Default::default(),
                closed,
            }),
            rx,
            closed_tx,
        )
    }

    /// Connect to an AtomicServer WebSocket endpoint.
    /// The URL should be `ws://` or `wss://` (e.g. `ws://localhost:9883/ws`).
    pub async fn connect(url: &str) -> AtomicResult<Self> {
        super::install_default_crypto_provider();
        #[cfg(target_os = "android")]
        let connected = tokio_tungstenite::connect_async_tls_with_config(
            url,
            None,
            false,
            Some(tokio_tungstenite::Connector::Rustls(
                super::tls::client_config(),
            )),
        )
        .await;
        // `connect_async` builds its TLS config from the process default
        // provider, and rustls won't pick one itself when both ring and
        // aws-lc-rs are compiled in: it panics. The server installs ring at
        // boot; an embedding app (Flutter on macOS and iOS) may not have. An
        // error only means a provider is already installed.
        #[cfg(not(target_os = "android"))]
        let connected = {
            let _ = rustls::crypto::ring::default_provider().install_default();
            connect_async(url).await
        };
        let (ws_stream, _response) =
            connected.map_err(|e| format!("WebSocket connection failed to {}: {}", url, e))?;

        let origin = http_origin_of_ws_url(url);
        let auth = std::sync::Arc::new(std::sync::Mutex::new(AuthState::default()));
        let auth_for_reader = auth.clone();
        let challenge = std::sync::Arc::new(std::sync::Mutex::new(None));
        let challenge_for_reader = challenge.clone();

        let (mut write, mut read) = ws_stream.split();
        let (tx, mut rx) = mpsc::channel::<Message>(64);
        let (broadcast_tx, _) = broadcast::channel::<WsMessage>(256);
        let broadcast_tx_clone = broadcast_tx.clone();
        let (closed_tx, closed_rx) = watch::channel(false);

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
                    Message::Binary(bin) => {
                        if bin.first() == Some(&protocol::tag::AUTH_OK) {
                            auth_for_reader
                                .lock()
                                .unwrap()
                                .accept(protocol::decode_auth_ok(&bin[1..]));
                        }
                        if bin.first() == Some(&protocol::tag::CHALLENGE) {
                            if let (Some(nonce), Ok(mut slot)) = (
                                protocol::decode_challenge(&bin[1..]),
                                challenge_for_reader.lock(),
                            ) {
                                *slot = Some(nonce.to_string());
                            }
                        }
                        parse_binary_message(&bin)
                    }
                    _ => None,
                };
                if let Some(parsed) = parsed {
                    let _ = broadcast_tx_clone.send(parsed);
                }
            }
            auth_for_reader.lock().unwrap().invalidate(true);
            let _ = closed_tx.send(true);
        });

        let client = Self {
            tx,
            broadcast_tx,
            origin,
            auth,
            auth_serial: tokio::sync::Mutex::new(()),
            connection_id: protocol::new_challenge_nonce(),
            challenge,
            closed: closed_rx,
        };
        // Introduce ourselves: the capabilities we speak, so the server can
        // answer COMMIT with a slim COMMIT_OK. A pre-2026-09 server drops the
        // frame unread.
        let mut capabilities = protocol::CLIENT_CAPABILITIES.to_vec();
        capabilities.push(protocol::CAP_SERVER_STORAGE_RECEIPTS_V1);
        client
            .send_binary(protocol::encode_hello_with_caps(
                "atomic_lib WsClient",
                &capabilities,
            ))
            .await?;
        Ok(client)
    }

    /// Whether the socket has closed (the server went away or dropped us).
    pub fn is_closed(&self) -> bool {
        *self.closed.borrow()
    }

    /// Resolves once the socket has closed. Used by load tests to notice a
    /// server restart without waiting for a keepalive to fail.
    pub async fn wait_closed(&self) {
        let mut rx = self.closed.clone();
        while !*rx.borrow_and_update() {
            if rx.changed().await.is_err() {
                return;
            }
        }
    }

    /// The nonce the server issued in its `CHALLENGE`, if it has arrived.
    pub fn challenge_nonce(&self) -> Option<String> {
        self.challenge.lock().ok().and_then(|c| c.clone())
    }

    /// Wait briefly for the server's `CHALLENGE` if it has not arrived yet.
    async fn await_challenge(&self) -> Option<String> {
        if let Some(nonce) = self.challenge_nonce() {
            return Some(nonce);
        }
        let mut rx = self.subscribe();
        tokio::time::timeout(CHALLENGE_WAIT, async {
            while let Ok(msg) = rx.recv().await {
                if let WsMessage::Challenge { nonce } = msg {
                    return Some(nonce);
                }
            }
            None
        })
        .await
        .ok()
        .flatten()
        .or_else(|| self.challenge_nonce())
    }

    /// The subject `authenticate` signs: this server's origin, with the
    /// connection's challenge nonce in the fragment once the server issued
    /// one (`{origin}#{nonce}`), so the proof is good on this socket only.
    pub async fn auth_subject(&self) -> String {
        match self.await_challenge().await {
            Some(nonce) => format!("{}#{}", self.origin, nonce),
            None => self.origin.clone(),
        }
    }

    /// The `http(s)://host[:port]` this client signs AUTH proofs for.
    pub fn origin(&self) -> &str {
        &self.origin
    }

    /// Capability names the server advertised on `AUTH_OK` (see
    /// `protocol::CAPABILITIES`). Empty before authentication and for servers
    /// that predate the list.
    pub fn server_capabilities(&self) -> Vec<String> {
        let auth = self.auth.lock().unwrap();
        if auth.context().is_none() || self.is_closed() {
            Vec::new()
        } else {
            auth.caps.clone()
        }
    }

    /// Unique to this physical WebSocket, including after reconnecting to the same URL.
    pub fn connection_id(&self) -> &str {
        &self.connection_id
    }

    pub(crate) fn receipt_context(&self) -> Option<WsAuthContext> {
        if self.is_closed() {
            return None;
        }
        let auth = self.auth.lock().unwrap();
        if !auth
            .caps
            .iter()
            .any(|cap| cap == protocol::CAP_SERVER_STORAGE_RECEIPTS_V1)
        {
            return None;
        }
        auth.context()
    }

    /// Serialize evidence publication with AUTH invalidation. No async work may
    /// happen inside this callback.
    pub(crate) fn with_receipt_context<T>(
        &self,
        expected: &WsAuthContext,
        action: impl FnOnce() -> T,
    ) -> Option<T> {
        let auth = self.auth.lock().unwrap();
        if self.is_closed()
            || auth.context().as_ref() != Some(expected)
            || !auth
                .caps
                .iter()
                .any(|cap| cap == protocol::CAP_SERVER_STORAGE_RECEIPTS_V1)
        {
            return None;
        }
        Some(action())
    }

    /// Call only inside `with_receipt_context`; the collector also holds its
    /// lifecycle and local-agent publication guards while admitting the frame.
    pub(crate) fn try_send_receipt_unchecked(&self, frame: Vec<u8>) -> bool {
        self.tx.try_send(Message::Binary(frame.into())).is_ok()
    }

    /// Subscribe to incoming messages. Returns a broadcast receiver.
    /// Multiple subscribers can be created.
    pub fn subscribe(&self) -> broadcast::Receiver<WsMessage> {
        self.broadcast_tx.subscribe()
    }

    /// Authenticate with the server using an Agent's credentials.
    /// Sends a binary v2 AUTH (0x01) frame and waits for AUTH_OK (0x02).
    /// The proof names the server's origin (see [`WsClient::origin`]), which
    /// is what the server binds it to, plus the connection's `CHALLENGE`
    /// nonce when the server sent one (see [`WsClient::auth_subject`]).
    pub async fn authenticate(&self, agent: &Agent) -> AtomicResult<()> {
        let subject = self.auth_subject().await;
        let frame = protocol::encode_auth(agent, &subject)?;
        self.authenticate_with_frame(frame).await
    }

    /// Authenticate with an AUTH (0x01) frame that was signed elsewhere.
    ///
    /// The frame proves ownership of a private key we never see, so a server
    /// can push on behalf of a user — carrying the user's identity to the
    /// remote — without ever holding the user's key. The frame is
    /// timestamp-bound, so mint it immediately before connecting.
    pub async fn authenticate_with_frame(&self, frame: Vec<u8>) -> AtomicResult<()> {
        let _serial = self.auth_serial.lock().await;
        if frame.first() != Some(&protocol::tag::AUTH) {
            return Err("Expected AUTH frame".into());
        }
        let proof: crate::authentication::AuthValues = serde_json::from_slice(&frame[1..])?;
        let agent = proof.agent_subject;
        let mut rx = self.subscribe();
        let generation = {
            let mut auth = self.auth.lock().unwrap();
            auth.invalidate(false);
            auth.pending = Some(agent.clone());
            auth.generation
        };
        let mut attempt = AuthAttempt {
            auth: self.auth.clone(),
            generation,
            completed: false,
        };
        // Managed authentication bypasses the deliberately conservative raw-AUTH gate.
        self.tx
            .send(Message::Binary(frame.into()))
            .await
            .map_err(|e| format!("AUTH send failed: {e}"))?;
        let result = tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                tokio::select! {
                    _ = self.wait_closed() => return Err(AtomicError::from("WebSocket closed during authentication")),
                    message = rx.recv() => match message {
                        Ok(WsMessage::Authenticated) => {
                            let auth = self.auth.lock().unwrap();
                            if auth.generation != generation { return Err("Authentication context changed".into()); }
                            if auth.accepted.as_deref() == Some(&agent) { return Ok(()); }
                        }
                        Ok(WsMessage::Error { request_id: 0, message, .. }) => return Err(format!("Auth failed: {message}").into()),
                        Err(_) => return Err("WebSocket authentication receiver closed".into()),
                        _ => {}
                    }
                }
            }
        }).await.map_err(|_| AtomicError::from("Authentication timed out"))?;
        if result.is_ok() {
            attempt.completed = true;
        }
        result
    }

    /// Subscribe to commit notifications for one resource (binary `SUB`,
    /// the same frame as [`subscribe_drive`](Self::subscribe_drive); the
    /// server registers drive-wide fan-out only when the subject is a
    /// drive). Sent the text `SUBSCRIBE` frame until 2026-09-04.
    pub async fn subscribe_resource(&self, subject: &str) -> AtomicResult<()> {
        self.send_binary(protocol::encode_sub(subject)).await
    }

    /// Subscribe to Loro CRDT sync updates for a resource.
    pub async fn subscribe_loro_sync(&self, subject: &str) -> AtomicResult<()> {
        self.send_raw(&format!(
            "LORO_SYNC_SUBSCRIBE {}",
            serde_json::json!({ "subject": subject })
        ))
        .await
    }

    /// Send an `EPHEMERAL (0x40)` frame of `kind` for `subject`. The agent
    /// field is left empty: the server attributes the frame to the identity
    /// this connection proved with `AUTH` and stamps that on the way out.
    async fn send_ephemeral(&self, kind: u8, subject: &str, update: &[u8]) -> AtomicResult<()> {
        self.send_binary(protocol::encode_ephemeral(kind, subject, "", update))
            .await
    }

    /// Send a Loro CRDT document update (an edit in progress) for a resource.
    pub async fn send_loro_sync_update(&self, subject: &str, update: &[u8]) -> AtomicResult<()> {
        self.send_ephemeral(protocol::ephemeral_kind::DOC, subject, update)
            .await
    }

    /// Send a Loro ephemeral update (cursors) for a resource.
    pub async fn send_loro_ephemeral_update(
        &self,
        subject: &str,
        update: &[u8],
    ) -> AtomicResult<()> {
        self.send_ephemeral(protocol::ephemeral_kind::LORO, subject, update)
            .await
    }

    /// Subscribe to the ephemeral presence channel of a drive.
    pub async fn subscribe_presence(&self, drive: &str) -> AtomicResult<()> {
        self.send_raw(&format!(
            "PRESENCE_SUBSCRIBE {}",
            serde_json::json!({ "subject": drive })
        ))
        .await
    }

    /// Unsubscribe from the ephemeral presence channel of a drive.
    pub async fn unsubscribe_presence(&self, drive: &str) -> AtomicResult<()> {
        self.send_raw(&format!(
            "PRESENCE_UNSUBSCRIBE {}",
            serde_json::json!({ "subject": drive })
        ))
        .await
    }

    /// Broadcast a presence update (Loro EphemeralStore bytes) to a drive's
    /// presence subscribers.
    pub async fn send_presence_update(&self, drive: &str, update: &[u8]) -> AtomicResult<()> {
        self.send_ephemeral(protocol::ephemeral_kind::PRESENCE, drive, update)
            .await
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
                    WsMessage::Error { message, .. } => {
                        return Err(AtomicError::from(format!("Blob fetch error: {}", message)));
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

    /// Send a raw text frame over the WebSocket (the `LORO_*` / `PRESENCE_*`
    /// subscribe frames, `RBSR_ITEMS`).
    pub async fn send_raw(&self, msg: &str) -> AtomicResult<()> {
        self.tx
            .send(Message::Text(msg.to_string().into()))
            .await
            .map_err(|e| format!("Failed to send WebSocket message: {}", e).into())
    }

    /// Send a raw binary frame over the WebSocket (v2 protocol).
    pub async fn send_binary(&self, bytes: Vec<u8>) -> AtomicResult<()> {
        if bytes.first() == Some(&protocol::tag::AUTH) {
            self.auth.lock().unwrap().invalidate(true);
        }
        self.tx
            .send(Message::Binary(bytes.into()))
            .await
            .map_err(|e| format!("Failed to send WebSocket binary: {}", e).into())
    }

    /// Subscribe to every commit under a drive (binary `SUB` 0x20).
    pub async fn subscribe_drive(&self, drive_subject: &str) -> AtomicResult<()> {
        self.send_binary(protocol::encode_sub(drive_subject)).await
    }

    /// Cancel a drive subscription (binary `UNSUB` 0x21). No answer frame.
    pub async fn unsubscribe_drive(&self, drive_subject: &str) -> AtomicResult<()> {
        self.send_binary(protocol::encode_unsub(drive_subject))
            .await
    }

    /// Send a `KEEPALIVE` (0x41). The server echoes it as
    /// [`WsMessage::Keepalive`]; no echo within a deadline means the socket
    /// is dead.
    pub async fn send_keepalive(&self) -> AtomicResult<()> {
        self.send_binary(protocol::encode_keepalive()).await
    }

    /// Post a commit over WebSocket; returns the server's commit id on success.
    ///
    /// Only the `COMMIT_OK` / `ERROR` carrying this `request_id` settles the
    /// call, so several `post_commit`s may be in flight on one connection and
    /// an unrelated refusal (a rejected `SUB`, another commit's error) does
    /// not fail this one.
    pub async fn post_commit(&self, request_id: u16, commit_json: &str) -> AtomicResult<String> {
        let mut rx = self.subscribe();
        self.send_binary(protocol::encode_commit(request_id, commit_json))
            .await?;

        let timeout = tokio::time::timeout(std::time::Duration::from_secs(30), async {
            while let Ok(msg) = rx.recv().await {
                match msg {
                    WsMessage::CommitOk {
                        request_id: rid,
                        commit_id,
                        ..
                    } if rid == request_id => return Ok(commit_id),
                    WsMessage::Error {
                        request_id: rid,
                        code,
                        message,
                    } if rid == request_id => {
                        return Err(AtomicError::from(format!(
                            "COMMIT failed (code {code}): {message}"
                        )));
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

/// The WebSocket client is an outbox transport: one `COMMIT` per call,
/// answered by the matching `COMMIT_OK` or `ERROR`. Transport failures
/// (closed socket, timeout) come back as an `UNKNOWN`-coded refusal so the
/// entry is retried later rather than dropped or parked.
impl crate::sync::outbox::CommitTransport for std::sync::Arc<WsClient> {
    async fn post_commit(
        &mut self,
        request_id: u16,
        commit_json: &str,
    ) -> Result<String, crate::sync::outbox::CommitRefused> {
        use crate::sync::outbox::CommitRefused;
        use crate::sync::protocol::error_code;

        let mut rx = self.subscribe();
        self.send_binary(protocol::encode_commit(request_id, commit_json))
            .await
            .map_err(|e| CommitRefused {
                code: error_code::UNKNOWN,
                message: format!("transport: {e}"),
            })?;

        let wait = tokio::time::timeout(std::time::Duration::from_secs(30), async {
            while let Ok(msg) = rx.recv().await {
                match msg {
                    WsMessage::CommitOk {
                        request_id: rid,
                        commit_id,
                        ..
                    } if rid == request_id => return Ok(commit_id),
                    WsMessage::Error {
                        request_id: rid,
                        code,
                        message,
                    } if rid == request_id => return Err(CommitRefused { code, message }),
                    _ => continue,
                }
            }
            Err(CommitRefused {
                code: error_code::UNKNOWN,
                message: "WebSocket closed while waiting for COMMIT_OK".into(),
            })
        });
        match wait.await {
            Ok(result) => result,
            Err(_) => Err(CommitRefused {
                code: error_code::UNKNOWN,
                message: "COMMIT timed out".into(),
            }),
        }
    }
}

/// Parse a text frame into a typed `WsMessage`.
///
/// The server's remaining text frames (`docs/src/websockets.md`, "Text
/// frames") are the `RBSR_ITEMS` inventory answer and `INDEX_STATUS`, none of which this
/// client consumes, so every text frame is reported as
/// [`WsMessage::Unrecognized`]. Reporting one as `Error` used to fail
/// whatever `authenticate` / `fetch_blob` / `post_commit` was waiting at
/// that moment. Loro and presence updates arrive as binary `EPHEMERAL`
/// since 2026-09-04; the pre-v2 `COMMIT `, `RESOURCE `, `AUTHENTICATED`
/// and `ERROR ` text frames went in 2026-09.
fn parse_server_message(text: &str) -> WsMessage {
    WsMessage::Unrecognized(text.to_string())
}

/// Parse a binary v2 frame. Returns `None` for frames the client doesn't
/// translate into `WsMessage` (UPDATE, SYNC_*, etc.).
fn parse_binary_message(bin: &[u8]) -> Option<WsMessage> {
    use protocol::tag;
    let tag = *bin.first()?;
    match tag {
        tag::AUTH_OK => Some(WsMessage::Authenticated),
        tag::STORAGE_RECEIPT => {
            protocol::StorageReceipt::decode(&bin[1..]).map(WsMessage::StorageReceipt)
        }
        tag::KEEPALIVE => Some(WsMessage::Keepalive),
        tag::ERROR => Some(match protocol::decode_error(&bin[1..]) {
            // A notice, not a failure: it is not tied to any request, and
            // reporting it as `Error` would fail whatever is waiting.
            Some(e) if e.code == protocol::error_code::DEPRECATED_CLIENT => {
                tracing::warn!("server notice: {}", e.message);
                return None;
            }
            Some(e) => WsMessage::Error {
                request_id: e.request_id,
                code: e.code,
                message: e.message,
            },
            None => WsMessage::Error {
                request_id: 0,
                code: protocol::error_code::UNKNOWN,
                message: "Malformed ERROR frame".into(),
            },
        }),
        tag::BLOB_RESPONSE => {
            let resp = protocol::decode_blob_response(&bin[1..])?;
            Some(WsMessage::BlobResponse {
                hash: resp.hash,
                bytes: resp.bytes,
            })
        }
        tag::UPDATE => decode_update_frame(&bin[1..]),
        tag::DESTROY => {
            // [tag] [request_id: u16] [subject: utf8]
            if bin.len() < 3 {
                return None;
            }
            let subject = std::str::from_utf8(&bin[3..]).ok()?.to_string();
            Some(WsMessage::Destroy { subject })
        }
        tag::COMMIT_OK => {
            let decoded = protocol::decode_commit_ok(&bin[1..])?;
            Some(WsMessage::CommitOk {
                request_id: decoded.request_id,
                commit_id: decoded.commit_id,
                commit_json: decoded.commit_json,
                pace_ms: decoded.pace_ms,
            })
        }
        tag::CHALLENGE => Some(WsMessage::Challenge {
            nonce: protocol::decode_challenge(&bin[1..])?.to_string(),
        }),
        tag::SYNC_RESEND => Some(WsMessage::SyncResend {
            drive: protocol::decode_sync_resend(&bin[1..])?.to_string(),
        }),
        tag::EPHEMERAL => {
            let decoded = protocol::decode_ephemeral(&bin[1..])?;
            let subject = decoded.drive;
            let update = decoded.payload;
            Some(match decoded.kind {
                protocol::ephemeral_kind::DOC => WsMessage::LoroSyncUpdate { subject, update },
                protocol::ephemeral_kind::LORO => {
                    WsMessage::LoroEphemeralUpdate { subject, update }
                }
                protocol::ephemeral_kind::PRESENCE => WsMessage::PresenceUpdate { subject, update },
                _ => return None,
            })
        }
        tag::SYNC_OK => {
            // [tag] [drive_len: u16] [drive]
            let data = &bin[1..];
            if data.len() < 2 {
                return None;
            }
            let drive_len = u16::from_be_bytes([data[0], data[1]]) as usize;
            let drive = std::str::from_utf8(data.get(2..2 + drive_len)?)
                .ok()?
                .to_string();
            Some(WsMessage::SyncOk { drive })
        }
        tag::SYNC_DIFF => {
            let diff = protocol::decode_sync_diff(&bin[1..])?;
            Some(WsMessage::SyncDiff {
                drive: diff.drive,
                pull: diff.pull,
                push: diff.push,
                remove: diff.remove,
                remove_commits: diff.remove_commits,
            })
        }
        tag::SYNC_PUSH => {
            let push = protocol::decode_sync_push(&bin[1..])?;
            Some(WsMessage::SyncPush {
                drive: push.drive,
                entries: push
                    .entries
                    .into_iter()
                    .map(|e| (e.subject, e.loro_bytes))
                    .collect(),
                last: push.last,
            })
        }
        tag::BLOB_REQUEST => {
            let hash = protocol::decode_blob_request(&bin[1..])?;
            Some(WsMessage::BlobRequest { hash })
        }
        _ => None,
    }
}

/// Decode an UPDATE frame payload (everything after the tag byte). Layout:
/// `[flags: u8] [request_id: u16] [subject_len: u16] [subject] [optional
/// commit_id_len: u16 + commit_id] [loro_bytes...]`.
///
/// Authoritative source of truth for the wire format: [docs/src/websockets.md](file:///Users/joep/dev/atomic-server/docs/src/websockets.md)
fn decode_update_frame(payload: &[u8]) -> Option<WsMessage> {
    use protocol::flags;
    let decoded = protocol::decode_update(payload)?;
    Some(WsMessage::Update {
        subject: decoded.subject,
        loro_bytes: decoded.loro_bytes,
        commit_id: decoded.commit_id,
        is_snapshot: decoded.flag_bits & flags::SNAPSHOT != 0,
        is_push: decoded.flag_bits & flags::PUSH != 0,
    })
}

#[cfg(test)]
mod receipt_auth_tests {
    use super::*;

    fn acknowledge(client: &WsClient) {
        client
            .auth
            .lock()
            .unwrap()
            .accept(vec![protocol::CAP_SERVER_STORAGE_RECEIPTS_V1.into()]);
        let _ = client.broadcast_tx.send(WsMessage::Authenticated);
    }

    #[test]
    fn unsolicited_ack_does_not_advertise_authenticated_capability() {
        let mut state = AuthState::default();
        state.accept(vec![protocol::CAP_SERVER_STORAGE_RECEIPTS_V1.into()]);
        assert!(state.context().is_none());
        assert!(state.caps.is_empty());
    }

    #[tokio::test]
    async fn managed_auth_attempts_serialize_and_replace_the_accepted_epoch() {
        let (client, mut outgoing, _closed) = WsClient::receipt_test_client("old", true);
        let agent = crate::agents::Agent::new(None).unwrap();
        let frame = protocol::encode_auth(&agent, client.origin()).unwrap();
        let before = client.receipt_context().unwrap();
        let first = tokio::spawn({
            let client = client.clone();
            let frame = frame.clone();
            async move { client.authenticate_with_frame(frame).await }
        });
        outgoing.recv().await.unwrap();
        assert!(client.receipt_context().is_none());
        let second = tokio::spawn({
            let client = client.clone();
            async move { client.authenticate_with_frame(frame).await }
        });
        tokio::task::yield_now().await;
        assert!(
            outgoing.try_recv().is_err(),
            "second AUTH cannot overtake the first ACK"
        );
        acknowledge(&client);
        first.await.unwrap().unwrap();
        outgoing.recv().await.unwrap();
        assert!(client.receipt_context().is_none());
        acknowledge(&client);
        second.await.unwrap().unwrap();
        let after = client.receipt_context().unwrap();
        assert_eq!(after.agent, agent.subject);
        assert!(after.generation > before.generation);
    }

    #[tokio::test]
    async fn cancelled_auth_then_delayed_ack_cannot_certify_a_new_attempt() {
        let (client, mut outgoing, _closed) = WsClient::receipt_test_client("old", true);
        let agent = crate::agents::Agent::new(None).unwrap();
        let frame = protocol::encode_auth(&agent, client.origin()).unwrap();
        let task = tokio::spawn({
            let client = client.clone();
            let frame = frame.clone();
            async move { client.authenticate_with_frame(frame).await }
        });
        outgoing.recv().await.unwrap();
        task.abort();
        let _ = task.await;
        assert!(client.receipt_context().is_none());
        let later = tokio::spawn({
            let client = client.clone();
            async move { client.authenticate_with_frame(frame).await }
        });
        outgoing.recv().await.unwrap();
        // An uncorrelated old ACK may satisfy legacy authentication waiting,
        // but cannot ever establish receipt provenance on this socket again.
        acknowledge(&client);
        later.await.unwrap().unwrap();
        assert!(client.receipt_context().is_none());
        assert!(client.server_capabilities().is_empty());
    }

    #[tokio::test]
    async fn raw_auth_and_disconnect_immediately_revoke_receipt_context() {
        let (client, _outgoing, closed) = WsClient::receipt_test_client("old", true);
        let context = client.receipt_context().unwrap();
        client.send_binary(vec![protocol::tag::AUTH]).await.unwrap();
        acknowledge(&client);
        assert!(client.with_receipt_context(&context, || ()).is_none());
        let (fresh, _outgoing, closed_fresh) = WsClient::receipt_test_client("old", true);
        assert!(fresh.receipt_context().is_some());
        closed_fresh.send(true).unwrap();
        assert!(fresh.receipt_context().is_none());
        drop(closed);
    }
}
