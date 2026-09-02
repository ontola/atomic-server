//! Semantic search over LanceDB with vector embeddings (when `vector-search` feature is enabled).

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
