//! Shared plumbing for the two ways of extending a store's resources:
//! [crate::endpoints::Endpoint] (a fixed route that returns a dynamic resource)
//! and [crate::class_extender::ClassExtender] (which modifies resources of a
//! given Class, wherever they live).
//!
//! Both take async handlers, so both need the same boxed-future alias. It lives
//! here rather than in either module, so neither owns the other's plumbing —
//! they used to define it twice, and handlers imported whichever they happened
//! to reach for.

use std::future::Future;
use std::pin::Pin;

/// The future returned by a plugin handler.
///
/// Not `Send` on wasm: single-threaded there, and futures touching JS values
/// cannot be. Endpoints are only ever registered by the (native) server, so
/// this bound is what class extenders need.
#[cfg(not(target_arch = "wasm32"))]
pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;
#[cfg(target_arch = "wasm32")]
pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + 'a>>;
