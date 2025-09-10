//! Sync protocol — transport-agnostic drive synchronization.
//!
//! Contains the v2 binary frame protocol and the sync engine.
//! Used by WebSocket (server), Iroh QUIC (native peers), and WASM clients.

pub mod engine;
#[cfg(feature = "iroh")]
pub mod peer;
pub mod protocol;
