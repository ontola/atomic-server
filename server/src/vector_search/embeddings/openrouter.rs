use super::Embedder;
use crate::config::Config;
use crate::errors::AtomicServerResult;
use async_trait::async_trait;
use serde::{Deserialize, Serialize};

const OPENROUTER_EMBEDDINGS_URL: &str = "https://openrouter.ai/api/v1/embeddings";

const OPENROUTER_INDEX_BATCH_SIZE: usize = 64;
const OPENROUTER_INDEX_BATCH_CONCURRENCY: usize = 4;

/// OpenRouter-backed embeddings (`Config::openrouter_*`, env `OPENROUTER_*`). Optional `dimensions` is only honored by some upstream models.
#[derive(Clone)]
pub(crate) struct OpenRouterEmbedder {
    client: reqwest::Client,
    api_key: String,
    model: String,
    dimensions: Option<u32>,
    url: String,
    embedding_dim: usize,
}

/// Subset of OpenRouter [`ProviderPreferences`](https://openrouter.ai/docs/api/api-reference/embeddings/create-embeddings): route only to providers that do not retain user data for training.
#[derive(Serialize)]
struct OpenRouterProviderPreferences {
    data_collection: &'static str,
}

#[derive(Serialize)]
struct OpenRouterEmbeddingsRequest<'a> {
    model: &'a str,
    input: &'a [String],
    #[serde(skip_serializing_if = "Option::is_none")]
    dimensions: Option<u32>,
    provider: OpenRouterProviderPreferences,
}

#[derive(Deserialize)]
struct OpenRouterEmbeddingsResponse {
    data: Vec<OpenRouterEmbeddingDataItem>,
}

#[derive(Deserialize)]
struct OpenRouterEmbeddingDataItem {
    #[serde(default)]
    index: Option<i64>,
    embedding: Vec<f64>,
}

async fn openrouter_embed_http(
    client: &reqwest::Client,
    url: &str,
    api_key: &str,
    model: &str,
    dimensions: Option<u32>,
    inputs: &[String],
) -> AtomicServerResult<Vec<Vec<f32>>> {
    if inputs.is_empty() {
        return Ok(vec![]);
    }

    let body = OpenRouterEmbeddingsRequest {
        model,
        input: inputs,
        dimensions,
        provider: OpenRouterProviderPreferences {
            data_collection: "deny",
        },
    };

    tracing::info!(
        "Sending OpenRouter request with number of chunks: {}",
        inputs.len()
    );
    let response = client
        .post(url)
        .header("Authorization", format!("Bearer {}", api_key))
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("OpenRouter embeddings request failed: {}", e))?;

    let status = response.status();
    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("OpenRouter embeddings response body: {}", e))?;

    if !status.is_success() {
        let text = String::from_utf8_lossy(&bytes);
        return Err(format!("OpenRouter embeddings error {}: {}", status, text).into());
    }

    let parsed: OpenRouterEmbeddingsResponse = serde_json::from_slice(&bytes).map_err(|e| {
        let preview = bytes.len().min(512);
        format!(
            "OpenRouter embeddings JSON parse error: {} (body prefix: {})",
            e,
            String::from_utf8_lossy(&bytes[..preview])
        )
    })?;

    let mut items = parsed.data;
    items.sort_by_key(|x| x.index.unwrap_or(0));

    if items.len() != inputs.len() {
        return Err(format!(
            "OpenRouter returned {} embeddings for {} inputs",
            items.len(),
            inputs.len()
        )
        .into());
    }

    let mut out = Vec::with_capacity(items.len());
    for row in items {
        out.push(row.embedding.iter().map(|&x| x as f32).collect());
    }
    Ok(out)
}

#[async_trait]
impl Embedder for OpenRouterEmbedder {
    fn embedding_dimensions(&self) -> usize {
        self.embedding_dim
    }

    fn index_batch_size(&self) -> usize {
        OPENROUTER_INDEX_BATCH_SIZE
    }

    fn index_batch_concurrency(&self) -> usize {
        OPENROUTER_INDEX_BATCH_CONCURRENCY
    }

    async fn embed_strings(&self, chunks: &[String]) -> AtomicServerResult<Vec<Vec<f32>>> {
        openrouter_embed_http(
            &self.client,
            &self.url,
            &self.api_key,
            &self.model,
            self.dimensions,
            chunks,
        )
        .await
    }
}

impl OpenRouterEmbedder {
    pub(crate) async fn new(config: &Config, api_key: String) -> AtomicServerResult<Self> {
        let model = config.openrouter_embedding_model.clone().ok_or_else(|| {
            format!("OPENROUTER_EMBEDDING_MODEL is required when OPENROUTER_API_KEY is set")
        })?;

        let dimensions = config.openrouter_embedding_dimensions;

        let client = reqwest::Client::builder()
            .build()
            .map_err(|e| format!("Failed to build HTTP client for OpenRouter: {}", e))?;

        let url = OPENROUTER_EMBEDDINGS_URL.to_string();

        let probe = openrouter_embed_http(
            &client,
            &url,
            &api_key,
            &model,
            dimensions,
            &[String::from("probe")],
        )
        .await?;
        let len = probe[0].len();
        let embedding_dim = if let Some(d) = dimensions {
            if len != d as usize {
                return Err(format!(
                    "OpenRouter returned embedding length {} but OPENROUTER_EMBEDDING_DIMENSIONS is {}. Some models do not honor the dimensions parameter; try a different model or omit OPENROUTER_EMBEDDING_DIMENSIONS.",
                    len,
                    d,
                )
                .into());
            }
            len
        } else {
            len
        };

        Ok(Self {
            client,
            api_key,
            model,
            dimensions,
            url,
            embedding_dim,
        })
    }
}
