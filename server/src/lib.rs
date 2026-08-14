/*!
Atomic-Server is mostly desgigned to run as a binary, but it can be embedded in other projects, too.
It is currently used as an embedded server in the Tauri distribution of Atomic Server.
See https://github.com/atomicdata-dev/atomic-server/tree/master/src-tauri
*/
mod actor_messages;
pub mod appstate;
mod commit_monitor;
pub mod config;
mod content_types;
pub mod context;
mod errors;
mod handlers;
mod helpers;
pub mod host_mode;
#[cfg(feature = "https")]
mod https;
pub mod invite_token;
mod jsonerrors;
mod loro_sync_broadcaster;
mod metrics;
pub mod plugins;
/// Phase 5 push wake helpers (payload contract + mention/watch match).
pub mod push_wake;
/// In-process FCM OAuth / APNs JWT minting from service-account JSON and `.p8`.
pub mod push_credentials;
/// Env-configured FCM/APNs sender (`ATOMIC_FCM_*` / `ATOMIC_APNS_*`).
pub mod push_provider;
pub mod routes;
pub mod serve;
pub mod vector_search;
// #[cfg(feature = "search")]
pub mod iroh_transport;
mod search;
#[cfg(test)]
mod tests;
mod trace;
// Force rebuild for blake3
