//! Semantic search over LanceDB with vector embeddings (when `vector-search` feature is enabled).

/// Reports whether a drive is currently being indexed.
pub type IndexNotifier = std::sync::Arc<dyn Fn(&str, bool) + Send + Sync>;

#[cfg(feature = "vector-search")]
mod embeddings;
#[cfg(feature = "vector-search")]
mod enabled;
#[cfg(feature = "vector-search")]
mod fastembed_gpu;
#[cfg(not(feature = "vector-search"))]
mod stub;
#[cfg(feature = "vector-search")]
mod table;

pub mod common;
pub use common::*;

#[cfg(feature = "vector-search")]
pub use enabled::VectorSearchState;
#[cfg(not(feature = "vector-search"))]
pub use stub::VectorSearchState;
