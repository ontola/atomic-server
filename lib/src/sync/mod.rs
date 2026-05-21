//! Sync protocol — transport-agnostic drive synchronization.
//!
//! Contains the v2 binary frame protocol and the sync engine.
//! Used by WebSocket (server), Iroh QUIC (native peers), and WASM clients.

pub mod engine;
#[cfg(feature = "iroh")]
pub mod peer;
pub mod protocol;
pub mod tombstones;
pub mod ws_apply;
#[cfg(all(test, feature = "iroh"))]
mod tests;
#[cfg(all(test, feature = "iroh", feature = "db-redb"))]
mod iroh_e2e;
