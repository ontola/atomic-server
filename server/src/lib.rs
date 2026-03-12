/*!
Atomic-Server is mostly desgigned to run as a binary, but it can be embedded in other projects, too.
It is currently used as an embedded server in the Tauri distribution of Atomic Server.
See https://github.com/atomicdata-dev/atomic-server/tree/master/src-tauri
*/
mod actor_messages;
mod appstate;
mod commit_monitor;
pub mod config;
mod content_types;
mod errors;
mod handlers;
mod helpers;
#[cfg(feature = "https")]
mod https;
mod jsonerrors;
pub mod plugins;
mod routes;
pub mod serve;
mod y_sync_broadcaster;
pub mod vector_search;
// #[cfg(feature = "search")]
mod search;
#[cfg(test)]
mod tests;
mod trace;
