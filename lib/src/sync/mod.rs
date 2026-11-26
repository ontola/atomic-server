//! Sync protocol — transport-agnostic drive synchronization.
//!
//! Contains the v2 binary frame protocol and the sync engine.
//! Used by WebSocket (server), Iroh QUIC (native peers), and WASM clients.

// `policy` and `protocol` are std-only; the rest needs the `db`
// feature. The module itself stays ungated so `Storelike::sync_policy`
// (always compiled) can reference `sync::policy` in a no-features build.
#[cfg(all(feature = "iroh", feature = "db"))]
pub mod call;
#[cfg(feature = "db")]
pub mod confirmation;
#[cfg(feature = "iroh")]
pub mod dial_gate;
#[cfg(feature = "iroh")]
pub mod discover;
#[cfg(feature = "db")]
pub mod engine;
/// Redeeming a signed invite token at the inviter's device, without a server.
#[cfg(all(feature = "iroh", feature = "db"))]
pub mod invite;
#[cfg(all(test, feature = "iroh", feature = "db"))]
mod iroh_e2e;
#[cfg(feature = "iroh")]
pub mod iroh_receipts;
#[cfg(feature = "iroh")]
pub mod local_directory;
/// The durable dirty-subject queue a device drains to a hub.
#[cfg(feature = "db")]
pub mod outbox;
#[cfg(feature = "iroh")]
pub mod peer;
#[cfg(feature = "iroh")]
mod peer_blob_repair;
#[cfg(feature = "iroh")]
mod peer_full_sync;
pub mod policy;
pub mod protocol;
/// Pushing a whole drive to a remote server, as a client. Needs the WS client.
#[cfg(feature = "ws")]
pub mod replicate;
#[cfg(feature = "db")]
pub mod session;
#[cfg(feature = "db")]
pub mod storage_receipts;
#[cfg(all(test, feature = "iroh"))]
mod tests;
#[cfg(feature = "db")]
pub mod tombstones;
#[cfg(feature = "db")]
pub mod transport;
/// Browser `WebSocket` transport (wasm32, no tungstenite).
#[cfg(all(feature = "db", feature = "wasm", target_arch = "wasm32"))]
pub mod web_socket_transport;
#[cfg(feature = "db")]
pub mod ws_apply;

#[cfg(feature = "db")]
pub mod browser_peer;
#[cfg(feature = "db")]
pub mod webrtc_link;

pub mod attachment_manifest;
#[cfg(feature = "db")]
pub mod attachment_receipts;
