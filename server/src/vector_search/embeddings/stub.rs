use super::Embedder;
use crate::errors::AtomicServerResult;
use async_trait::async_trait;

/// Placeholder embedder used when vector indexing is disabled (tests, temp stores).
pub(crate) struct StubEmbedder {
    dim: usize,
}

impl StubEmbedder {
    pub(crate) fn new(dim: usize) -> Self {
        Self { dim }
    }
}

#[async_trait]
impl Embedder for StubEmbedder {
    fn embedding_dimensions(&self) -> usize {
        self.dim
    }

    fn index_batch_size(&self) -> usize {
        64
    }

    fn index_batch_concurrency(&self) -> usize {
        1
    }

    async fn embed_strings(&self, _chunks: &[String]) -> AtomicServerResult<Vec<Vec<f32>>> {
        Err("vector search is disabled".into())
    }
}
