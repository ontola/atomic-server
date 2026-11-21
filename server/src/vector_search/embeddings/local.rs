use super::Embedder;
use crate::config::Config;
use crate::errors::AtomicServerResult;
use crate::vector_search::fastembed_gpu::fastembed_gpu_execution_providers;
use async_trait::async_trait;
use fastembed::{EmbeddingModel, InitOptions, TextEmbedding};
use std::path::PathBuf;
use std::sync::Arc;

/// fastembed `AllMiniLML6V2Q` output width; must match the LanceDB `vector` column when using local embeddings.
const LOCAL_EMBEDDING_DIM: usize = 384;

/// Where fastembed keeps its downloaded models (~1.1 GB with the reranker).
///
/// fastembed's own default is `.fastembed_cache` relative to the working
/// directory, so every checkout, worktree and directory a server or test was
/// started from got its own copy. Use one per-user cache instead.
/// `FASTEMBED_CACHE_DIR` still wins when set.
pub(crate) fn model_cache_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("FASTEMBED_CACHE_DIR") {
        return PathBuf::from(dir);
    }
    directories::ProjectDirs::from("", "", "atomic-data")
        .map(|d| d.cache_dir().join("fastembed"))
        .unwrap_or_else(|| PathBuf::from(".fastembed_cache"))
}

const LOCAL_INDEX_BATCH_SIZE: usize = 64;
const LOCAL_INDEX_BATCH_CONCURRENCY: usize = 1;

pub(crate) struct LocalEmbedder {
    model: Arc<tokio::sync::Mutex<TextEmbedding>>,
}

impl LocalEmbedder {
    pub(crate) fn new(config: &Config) -> AtomicServerResult<Self> {
        let mut embedding_options = InitOptions::new(EmbeddingModel::AllMiniLML6V2Q)
            .with_cache_dir(model_cache_dir())
            .with_show_download_progress(true);

        if config.gpu_indexing {
            tracing::info!("Enabling GPU execution providers for fastembed");
            embedding_options =
                embedding_options.with_execution_providers(fastembed_gpu_execution_providers());
        }

        let text_model = TextEmbedding::try_new(embedding_options)
            .map_err(|e| format!("Failed to initialize fastembed: {}", e))?;

        Ok(Self {
            model: Arc::new(tokio::sync::Mutex::new(text_model)),
        })
    }
}

#[async_trait]
impl Embedder for LocalEmbedder {
    fn embedding_dimensions(&self) -> usize {
        LOCAL_EMBEDDING_DIM
    }

    fn index_batch_size(&self) -> usize {
        LOCAL_INDEX_BATCH_SIZE
    }

    fn index_batch_concurrency(&self) -> usize {
        LOCAL_INDEX_BATCH_CONCURRENCY
    }

    async fn embed_strings(&self, chunks: &[String]) -> AtomicServerResult<Vec<Vec<f32>>> {
        let mut m = self.model.lock().await;

        let embeddings = {
            #[cfg(target_os = "macos")]
            {
                objc::rc::autoreleasepool(|| m.embed(chunks, None))
                    .map_err(|e| format!("Failed to embed text: {}", e))?
            }

            #[cfg(not(target_os = "macos"))]
            {
                m.embed(chunks, None)
                    .map_err(|e| format!("Failed to embed text: {}", e))?
            }
        };

        Ok(embeddings)
    }
}
