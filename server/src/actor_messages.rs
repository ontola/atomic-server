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

// === Query Subscription Messages ===

/// JSON format for SUBSCRIBE_QUERY WebSocket message.
/// - `property` + `value`: watch for specific property-value matches
/// - `drive` only: watch ALL changes in a drive
/// - `property` + `value` + `drive`: scoped property watch
#[derive(Deserialize, Serialize, Debug, Clone)]
pub struct QuerySubscriptionJSON {
    pub property: Option<String>,
    pub value: Option<String>,
    pub sort_by: Option<String>,
    /// Drive scope — restricts matches to resources in this drive.
    /// If set alone (no property/value), watches all changes in the drive.
    pub drive: Option<String>,
}

/// Subscribe to live query updates.
#[derive(Message)]
#[rtype(result = "()")]
pub struct SubscribeQuery {
    pub addr: Addr<crate::handlers::web_sockets::WebSocketConnection>,
    pub query: QuerySubscriptionJSON,
    pub agent: String,
}

/// Unsubscribe from a query.
#[derive(Message)]
#[rtype(result = "()")]
pub struct UnsubscribeQuery {
    pub addr: Addr<crate::handlers::web_sockets::WebSocketConnection>,
}

/// Notification that a query's results changed.
#[derive(Message, Clone, Debug, Serialize, Deserialize)]
#[rtype(result = "()")]
pub struct QueryUpdate {
    /// The query filter that matched (serialized as JSON for the client)
    pub property: Option<String>,
    pub value: Option<String>,
    /// Subjects added to the query results
    pub added: Vec<String>,
    /// Subjects removed from the query results
    pub removed: Vec<String>,
}
