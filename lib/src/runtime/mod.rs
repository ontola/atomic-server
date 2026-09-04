//! The node runtime boundary: [`AtomicNode`] is the one surface adapters
//! (HTTP, WebSocket, Iroh, WASM, FFI, Flutter) bind to instead of wrapping
//! [`crate::Db`] themselves.
//!
//! Slice 1 (`planning/atomic-lib-runtime.md`, `planning/completed/runtime-boundary-decision.md`)
//! is a thin wrapper: every method delegates to code that already existed, so
//! there is no behaviour change — only a named place for it.

mod node;

pub use node::{AtomicNode, IngestPolicy, NodeConfig, NodeStorage, ResourceEdit};
