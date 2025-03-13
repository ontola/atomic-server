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

#[derive(Deserialize, Serialize)]
pub struct YSubscriptionJSON {
    pub subject: atomic_lib::Subject,
    pub property: String,
}

#[derive(Message)]
#[rtype(result = "()")]
pub struct SubscribeYSync {
    pub addr: Addr<crate::handlers::web_sockets::WebSocketConnection>,
    pub subject: atomic_lib::Subject,
    pub property: String,
    pub agent: String,
}

#[derive(Message)]
#[rtype(result = "()")]
pub struct UnsubscribeYSync {
    pub addr: Addr<crate::handlers::web_sockets::WebSocketConnection>,
    pub subject: atomic_lib::Subject,
    pub property: String,
}

/// A message containing a Resource, which should be sent to subscribers
#[derive(Message, Clone, Debug)]
#[rtype(result = "()")]
pub struct CommitMessage {
    /// Full resource of the Commit itself, the new resource, and the old one
    pub commit_response: atomic_lib::commit::CommitResponse,
}

/// A message that can contain both a Yjs Doc update or a Yjs Awareness update.
/// It is used to enable live collaboration on Yjs Docs and does not store these updates on the server.
#[derive(Message, Clone, Debug, Serialize, Deserialize)]
#[rtype(result = "()")]
pub struct YSyncUpdate {
    pub subject: atomic_lib::Subject,
    pub property: String,
    pub awareness_update: Option<String>,
    pub doc_update: Option<String>,
    #[serde(skip)]
    pub addr: Option<Addr<crate::handlers::web_sockets::WebSocketConnection>>,
}
