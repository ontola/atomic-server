//! Atomic as a hosted MCP server (`/mcp`), for clients that cannot run a local
//! process, such as claude.ai. See `planning/mcp-endpoint.md`.
//!
//! Two roles live here, both stateless:
//!
//! - [`oauth`] is the authorization server (OAuth 2.1 with PKCE, dynamic client
//!   registration). The person approves in the app; what a client may reach is
//!   decided by the ACLs the app writes for a fresh *issued agent*, so
//!   revoking is taking that agent off the drives (Connected apps), exactly as
//!   for the local MCP.
//! - [`endpoint`] is the resource server: JSON-RPC over Streamable HTTP. It
//!   reads as the issued agent under the normal rights checks. It is read-only
//!   for now, and never signs a commit as anyone.
//!
//! The node signs nothing as the person, and no bearer token is accepted on
//! `/commit` or on the WebSocket: a token is proof to this handler only.

pub mod document_text;
pub mod endpoint;
pub mod oauth;
pub mod tokens;
pub mod tools;
