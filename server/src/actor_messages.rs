//! The actor messages are used for communication between Actix Actors.
//! In this case it's for communication between the CommitMonitor and the WebSocketConnection.

use actix::{prelude::Message, Addr};
use serde::{Deserialize, Serialize};

/// Subscribes a WebSocketConnection to a Subject.
#[derive(Message)]
#[rtype(result = "()")]
pub struct Subscribe {
    pub addr: Addr<crate::handlers::web_sockets::WebSocketConnection>,
    pub subject: atomic_lib::Subject,
    pub agent: String,
}

/// A message containing a Resource, which should be sent to subscribers
#[derive(Message, Clone, Debug)]
#[rtype(result = "()")]
pub struct CommitMessage {
    /// Full resource of the Commit itself, the new resource, and the old one
    pub commit_response: atomic_lib::commit::CommitResponse,
}

// === Loro CRDT Sync Messages ===

#[derive(Deserialize, Serialize)]
pub struct LoroSubscriptionJSON {
    pub subject: atomic_lib::Subject,
}

#[derive(Message)]
#[rtype(result = "()")]
pub struct SubscribeLoroSync {
    pub addr: Addr<crate::handlers::web_sockets::WebSocketConnection>,
    pub subject: atomic_lib::Subject,
    pub agent: String,
}

#[derive(Message)]
#[rtype(result = "()")]
pub struct UnsubscribeLoroSync {
    pub addr: Addr<crate::handlers::web_sockets::WebSocketConnection>,
    pub subject: atomic_lib::Subject,
}

/// A Loro CRDT document update for real-time sync (not persisted).
#[derive(Message, Clone, Debug, Serialize, Deserialize)]
#[rtype(result = "()")]
pub struct LoroSyncUpdate {
    pub subject: atomic_lib::Subject,
    pub update: String,
    #[serde(skip)]
    pub addr: Option<Addr<crate::handlers::web_sockets::WebSocketConnection>>,
}

/// A Loro ephemeral update (cursors, presence) — not persisted.
#[derive(Message, Clone, Debug, Serialize, Deserialize)]
#[rtype(result = "()")]
pub struct LoroEphemeralUpdate {
    pub subject: atomic_lib::Subject,
    pub update: String,
    #[serde(skip)]
    pub addr: Option<Addr<crate::handlers::web_sockets::WebSocketConnection>>,
}
