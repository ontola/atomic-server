//! The actor messages are used for communication between Actix Actors.
//! In this case it's for communication between the CommitMonitor and the WebSocketConnection.

use actix::{prelude::Message, Addr};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

/// Subscribes a WebSocketConnection to a Subject.
#[derive(Message)]
#[rtype(result = "()")]
pub struct Subscribe {
    pub addr: Addr<crate::handlers::web_sockets::WebSocketConnection>,
    pub subject: atomic_lib::Subject,
    pub agent: String,
    /// Identifier of the originating WS connection. The commit monitor
    /// stores this alongside the subscriber address and skips broadcasts
    /// to subscribers whose `source_id` matches an event's `source_id`,
    /// so a client never receives its own commit back.
    pub source_id: String,
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

/// Subscribe to all commits on resources living under a drive. Every
/// commit under the drive fans out to this connection as a `CommitMessage`
/// (encoded as UPDATE / DESTROY by the WebSocketConnection handler).
#[derive(Message)]
#[rtype(result = "()")]
pub struct SubscribeDrive {
    pub addr: Addr<crate::handlers::web_sockets::WebSocketConnection>,
    /// Drive subject (HTTP URL or DID).
    pub drive: String,
    pub agent: String,
    /// Same role as [`Subscribe::source_id`].
    pub source_id: String,
}

// === Filter (query) subscription messages ===
//
// The legacy `QUERY_UPDATE (0x36)` binary frame was retired in
// `planning/drop-query-update.md`, but the *registration* primitive
// remains: a client can say "send me updates for resources matching
// `property=value` in `drive`" via `SUBSCRIBE_QUERY <json>`. Membership
// changes for those filters are delivered as plain `UPDATE` / `DESTROY`
// frames — same channel that already carries drive-wide and per-resource
// events — by way of [`MembershipNotification`].

/// JSON shape of the `SUBSCRIBE_QUERY <json>` text-frame payload.
///
/// - `property` + `value`: watch resources whose `property` currently
///   equals `value`. Both must be present together.
/// - `drive` is required (auth boundary — only resources in this drive
///   are considered, and the agent must have read access).
/// - `sort_by` is informational; it's stored in the encoded filter so
///   sorted-collection consumers can dispatch on it.
#[derive(Deserialize, Serialize, Debug, Clone)]
pub struct QuerySubscriptionJSON {
    pub property: Option<String>,
    pub value: Option<String>,
    pub sort_by: Option<String>,
    pub drive: Option<String>,
}

/// Register a filter subscription with the `CommitMonitor`.
#[derive(Message)]
#[rtype(result = "()")]
pub struct SubscribeQuery {
    pub addr: Addr<crate::handlers::web_sockets::WebSocketConnection>,
    pub query: QuerySubscriptionJSON,
    pub agent: String,
    /// Same role as [`Subscribe::source_id`].
    pub source_id: String,
}

/// Drop every filter subscription this connection holds.
#[derive(Message)]
#[rtype(result = "()")]
pub struct UnsubscribeQuery {
    pub addr: Addr<crate::handlers::web_sockets::WebSocketConnection>,
}

/// Sent by `WebSocketConnection::stopped` to every subscription-holding
/// actor (`CommitMonitor`, `LoroSyncBroadcaster`). Each handler walks
/// its maps and removes every entry whose `Addr` matches. Without this,
/// stale entries accumulate over the server's lifetime and every fanout
/// pass pays for dead `Addr`s.
#[derive(Message)]
#[rtype(result = "()")]
pub struct UnsubscribeAll {
    pub addr: Addr<crate::handlers::web_sockets::WebSocketConnection>,
}

/// Pre-encoded wire frame (`UPDATE` or `DESTROY`) ready for `ctx.binary`.
///
/// Sent by `CommitMonitor`'s fanout: the frame is encoded **once** from
/// the `CommitMessage`, wrapped in an `Arc`, then dispatched to every
/// subscriber. Each `do_send` clones only the `Arc` pointer (O(1))
/// instead of cloning the full `CommitMessage` (which would re-clone the
/// Loro update bytes per subscriber). See
/// `planning/arc-actor-message-payloads.md` for the perf rationale.
#[derive(Message, Clone)]
#[rtype(result = "()")]
pub struct SendFrame {
    pub frame: Arc<[u8]>,
}

/// Forwarded into `CommitMonitor` by the `DbEvent::QueryMembershipChanged`
/// listener task: a resource entered or left a watched filter's result
/// set. Routed to each filter subscriber as an `UPDATE` (added — full
/// snapshot + commit_id pre-fetched here so the receiving actor doesn't
/// have to round-trip through the store) or a `DESTROY` (removed).
#[derive(Message, Clone, Debug)]
#[rtype(result = "()")]
pub struct MembershipNotification {
    /// Filter the subject moved into/out of (encoded `QueryFilter` bytes).
    pub filter_bytes: Vec<u8>,
    /// Subject whose membership changed.
    pub subject: String,
    /// True iff the subject is now a member; false iff it left.
    pub added: bool,
    /// Pre-fetched Loro snapshot bytes — only populated when `added`.
    /// Empty / `None` skips the UPDATE emission (the subscriber can
    /// still GET the subject explicitly). `Arc<[u8]>` so the fanout
    /// loop in `CommitMonitor::Handler<MembershipNotification>` does
    /// O(1) clones per subscriber instead of O(snapshot size).
    pub loro_snapshot: Option<Arc<[u8]>>,
    /// Pre-fetched `lastCommit` propval — only populated when `added`.
    pub commit_id: Option<String>,
    /// Source connection id for echo suppression.
    pub source_id: Option<String>,
}

