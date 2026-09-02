//! Re-export the v2 binary protocol from atomic_lib.
//! The server uses this for WebSocket frame encoding/decoding.

pub use atomic_lib::sync::protocol::*;
