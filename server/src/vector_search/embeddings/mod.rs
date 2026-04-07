//! Pluggable embedding backends: local fastembed vs OpenRouter HTTP API.

mod local;
mod openrouter;

use crate::config::Config;
use crate::errors::AtomicServerResult;
use async_trait::async_trait;
use std::sync::Arc;

#[async_trait]
pub(crate) trait Embedder: Send + Sync {
    /// Width of vectors produced by this backend (matches LanceDB `vector` column).
    fn embedding_dimensions(&self) -> usize;

    /// How many text chunks to embed per batch when building or incrementally updating the vector index.
    fn index_batch_size(&self) -> usize;

    async fn embed_strings(&self, chunks: &[String]) -> AtomicServerResult<Vec<Vec<f32>>>;
}

pub(crate) async fn create_embedder(config: &Config) -> AtomicServerResult<Arc<dyn Embedder>> {
    if let Some(api_key) = config.openrouter_api_key.clone() {
        Ok(Arc::new(
            openrouter::OpenRouterEmbedder::new(config, api_key).await?,
        ) as Arc<dyn Embedder>)
    } else {
        Ok(Arc::new(local::LocalEmbedder::new(config)?) as Arc<dyn Embedder>)
    }
}
