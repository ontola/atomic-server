//! Semantic search over LanceDB with vector embeddings.
//!
//! By default embeddings use local fastembed (`AllMiniLML6V2Q`, dimension 384).
//! Set `OPENROUTER_API_KEY` and `OPENROUTER_EMBEDDING_MODEL` to use
//! [OpenRouter embeddings](https://openrouter.ai/docs/api/api-reference/embeddings/create-embeddings) instead.
//! Optional `OPENROUTER_EMBEDDING_DIMENSIONS` is sent as the JSON `dimensions` field; not all upstream models honor it.
//! Every OpenRouter embeddings request sets `provider.data_collection` to `deny` (only providers that do not collect user data).

mod embeddings;
mod fastembed_gpu;
mod table;

use crate::config::Config;
use crate::errors::AtomicServerResult;
use crate::search::extract_plain_text;
use arrow::array::{
    ArrayRef, FixedSizeListArray, Float32Array, ListBuilder, RecordBatch, RecordBatchIterator,
    StringArray, StringBuilder,
};
use arrow::datatypes::{DataType, Field};
use atomic_lib::{Db, Resource, Storelike};
use embeddings::Embedder;
use fastembed::{RerankInitOptions, RerankerModel, TextRerank};
use fastembed_gpu::fastembed_gpu_execution_providers;
use lancedb::index::scalar::{BTreeIndexBuilder, FtsIndexBuilder, LabelListIndexBuilder};
use lancedb::index::vector::IvfPqIndexBuilder;
use lancedb::index::Index;
use lancedb::table::OptimizeAction;
use lancedb::{Connection, DistanceType, Table};
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;
use table::{create_resources_table, open_resources_table, table_vector_dimension};
use text_splitter::{ChunkConfig, MarkdownSplitter, TextSplitter};
use yrs::updates::decoder::Decode;
use yrs::Transact;
use yrs::WriteTxn;

// We don't add these classes to the database because they would decrease the quality of the AI answers.
const CLASS_INDEX_BLACKLIST: &[&str] = &[
    atomic_lib::urls::TEXT_PART,
    atomic_lib::urls::REASONING_PART,
];

#[derive(Default)]
struct PendingBatch {
    batch_subjects: Vec<String>,
    batch_is_a: Vec<Vec<String>>,
    batch_hierarchy: Vec<Vec<String>>,
    batch_text_chunks: Vec<String>,
}

pub fn get_resource_title(resource: &Resource) -> Option<String> {
    let title = if let Ok(name) = resource.get(atomic_lib::urls::NAME) {
        name.clone()
    } else if let Ok(shortname) = resource.get(atomic_lib::urls::SHORTNAME) {
        shortname.clone()
    } else if let Ok(filename) = resource.get(atomic_lib::urls::FILENAME) {
        filename.clone()
    } else {
        // We don't return the subject as a default because we don't want to index it.
        return None;
    };

    match title {
        atomic_lib::Value::String(s) => Some(s),
        atomic_lib::Value::Slug(s) => Some(s),
        _ => None,
    }
}

pub fn get_resource_text_parts(
    resource: &Resource,
) -> (Option<String>, Option<String>, Option<String>) {
    let title = get_resource_title(resource);

    let description = if let Ok(atomic_lib::Value::Markdown(description)) =
        resource.get(atomic_lib::urls::DESCRIPTION)
    {
        Some(description.to_string())
    } else {
        None
    };

    let doc_content = if let Ok(atomic_lib::Value::YDoc(state)) =
        resource.get(atomic_lib::urls::DOCUMENT_CONTENT)
    {
        let ydoc = yrs::Doc::new();
        let mut txn = ydoc.transact_mut();

        if txn
            .apply_update(yrs::Update::decode_v2(state).unwrap_or_default())
            .is_ok()
        {
            let xml_content = txn.get_or_insert_xml_fragment("content");
            Some(extract_plain_text(&xml_content, &txn))
        } else {
            None
        }
    } else {
        None
    };

    (title, description, doc_content)
}

/// State for the vector search, utilizing fastembed or OpenRouter for embeddings and LanceDB for storage.
#[derive(Clone)]
pub struct VectorSearchState {
    embedder: Arc<dyn Embedder>,
    /// Width of each stored vector; matches the LanceDB `vector` column and the active embedding backend.
    pub embedding_dim: usize,
    pub rerank_model: Arc<tokio::sync::Mutex<TextRerank>>,
    pub table: Arc<Table>,
    pending: Arc<tokio::sync::Mutex<PendingBatch>>,
    /// For `println!` diagnostics on incremental indexing (see `add_resource` / `flush_pending`).
    incremental_batch_seq: Arc<AtomicU64>,
    incremental_resources_indexed: Arc<AtomicU64>,
    /// Chunk rows queued or being embedded for incremental indexing, keyed by drive root subject.
    indexing_rows_by_drive: Arc<Mutex<HashMap<String, u32>>>,
    /// Optional: notify websocket subscribers when per-drive indexing state changes.
    index_notifier: Option<Arc<dyn Fn(&str, bool) + Send + Sync>>,
}

fn init_rerank_model(config: &Config) -> AtomicServerResult<TextRerank> {
    let mut rerank_options =
        RerankInitOptions::new(RerankerModel::BGERerankerBase).with_show_download_progress(true);

    if config.gpu_indexing {
        tracing::info!("Enabling GPU execution providers for fastembed reranker");
        rerank_options =
            rerank_options.with_execution_providers(fastembed_gpu_execution_providers());
    }

    TextRerank::try_new(rerank_options)
        .map_err(|e| format!("Failed to initialize fastembed reranker: {}", e).into())
}

/// Opens the `resources` table if it exists and checks its vector dimension against the embedder, or creates it.
async fn open_or_create_resources_table(
    db: &Connection,
    table_exists: bool,
    embedder: &dyn Embedder,
) -> AtomicServerResult<(Table, usize)> {
    let ed = embedder.embedding_dimensions();

    if table_exists {
        let table = open_resources_table(db).await?;
        let dim = table_vector_dimension(&table).await?;

        if dim != ed {
            return Err(
                format!(
                    "The configured embedder's dimension size ({}) does not match existing index dimension ({}). Try rebuilding the vector index or choose a different embedding model.",
                    ed, dim
                )
            .into());
        }
        Ok((table, dim))
    } else {
        let table = create_resources_table(db, ed).await?;
        Ok((table, ed))
    }
}

async fn connect_vector_db(config: &Config) -> AtomicServerResult<(Connection, bool)> {
    if config.opts.rebuild_indexes == Some(crate::config::RebuildIndexMode::All)
        || config.opts.rebuild_indexes == Some(crate::config::RebuildIndexMode::Vector)
    {
        let _ = std::fs::remove_dir_all(&config.vector_search_index_path);
    }
    std::fs::create_dir_all(&config.vector_search_index_path)?;

    let db = lancedb::connect(config.vector_search_index_path.to_str().unwrap())
        .execute()
        .await
        .map_err(|e| format!("Failed to connect to lancedb: {}", e))?;

    let table_names = db
        .table_names()
        .execute()
        .await
        .map_err(|e| format!("Failed to get lancedb table names: {}", e))?;
    let table_exists = table_names.contains(&"resources".to_string());
    Ok((db, table_exists))
}

impl VectorSearchState {
    pub async fn new(
        config: &Config,
        index_notifier: Option<Arc<dyn Fn(&str, bool) + Send + Sync>>,
    ) -> AtomicServerResult<Self> {
        tracing::info!("Starting vector search service");

        let rerank_model = init_rerank_model(config)?;
        let (db, table_exists) = connect_vector_db(config).await?;

        let embedder = embeddings::create_embedder(config).await?;
        let (table, embedding_dim) =
            open_or_create_resources_table(&db, table_exists, embedder.as_ref()).await?;

        Ok(VectorSearchState {
            embedder,
            embedding_dim,
            rerank_model: Arc::new(tokio::sync::Mutex::new(rerank_model)),
            table: Arc::new(table),
            pending: Arc::new(tokio::sync::Mutex::new(PendingBatch::default())),
            incremental_batch_seq: Arc::new(AtomicU64::new(0)),
            incremental_resources_indexed: Arc::new(AtomicU64::new(0)),
            indexing_rows_by_drive: Arc::new(Mutex::new(HashMap::new())),
            index_notifier,
        })
    }

    fn notify_indexing_changed(&self, drives: &[String]) {
        let Some(notifier) = &self.index_notifier else {
            return;
        };
        let mut seen = HashSet::new();
        for d in drives {
            if seen.insert(d.as_str()) {
                let indexing = self.is_drive_indexing(d);
                notifier(d, indexing);
            }
        }
    }

    fn register_pending(&self, drive: &str, rows: u32) {
        if rows == 0 {
            return;
        }
        let mut g = self
            .indexing_rows_by_drive
            .lock()
            .expect("indexing_rows_by_drive mutex");
        *g.entry(drive.to_string()).or_insert(0) += rows;
        drop(g);
        self.notify_indexing_changed(&[drive.to_string()]);
    }

    fn complete_batch_rows(&self, batch_subjects: &[String], batch_hierarchy: &[Vec<String>]) {
        debug_assert_eq!(batch_subjects.len(), batch_hierarchy.len());
        let mut drives_to_notify = Vec::new();
        let mut g = self
            .indexing_rows_by_drive
            .lock()
            .expect("indexing_rows_by_drive mutex");
        for i in 0..batch_subjects.len() {
            let drive_key = batch_hierarchy[i]
                .last()
                .cloned()
                .unwrap_or_else(|| batch_subjects[i].clone());
            let should_remove = {
                if let Some(c) = g.get_mut(&drive_key) {
                    *c = c.saturating_sub(1);
                    *c == 0
                } else {
                    tracing::warn!("vector index refcount underflow for drive {}", drive_key);
                    false
                }
            };
            if should_remove {
                g.remove(&drive_key);
            }
            drives_to_notify.push(drive_key);
        }
        drop(g);
        self.notify_indexing_changed(&drives_to_notify);
    }

    /// True while incremental vector indexing has queued or in-flight chunk rows for this drive root.
    pub fn is_drive_indexing(&self, drive: &str) -> bool {
        let g = self
            .indexing_rows_by_drive
            .lock()
            .expect("indexing_rows_by_drive mutex");
        g.get(drive).copied().unwrap_or(0) > 0
    }

    #[tracing::instrument(skip(self, store), level = "trace")]
    pub async fn add_all_resources(&self, store: &Db) -> AtomicServerResult<()> {
        let index_started = Instant::now();
        tracing::info!("Building vector search index...");
        self.incremental_batch_seq.store(0, Ordering::Relaxed);
        self.incremental_resources_indexed
            .store(0, Ordering::Relaxed);

        let resources = store
            .all_resources(true)
            .filter(|resource| !resource.get_subject().contains("/commits/"));

        let mut batch_subjects = Vec::new();
        let mut batch_is_a = Vec::new();
        let mut batch_hierarchy = Vec::new();
        let mut batch_text_chunks = Vec::new();
        let mut batch_count = 0;
        let mut resources_processed = 0;
        let batch_size = self.embedder.index_batch_size();

        for resource in resources {
            if let Some((subject, is_a, hierarchy, chunks)) =
                self.create_resource_chunks(&resource, store).await?
            {
                for chunk in chunks {
                    batch_subjects.push(subject.clone());
                    batch_is_a.push(is_a.clone());
                    batch_hierarchy.push(hierarchy.clone());
                    batch_text_chunks.push(chunk);

                    if batch_subjects.len() >= batch_size {
                        batch_count += 1;
                        println!(
                            "starting batch: {}, resources processed: {}",
                            batch_count, resources_processed
                        );
                        self.embed_and_add_batch(
                            &mut batch_subjects,
                            &mut batch_is_a,
                            &mut batch_hierarchy,
                            &mut batch_text_chunks,
                        )
                        .await?;
                    }
                }
            }

            resources_processed += 1;
        }

        if !batch_subjects.is_empty() {
            self.embed_and_add_batch(
                &mut batch_subjects,
                &mut batch_is_a,
                &mut batch_hierarchy,
                &mut batch_text_chunks,
            )
            .await?;
        }

        tracing::info!("Creating vector index...");
        self.table
            .create_index(
                &["vector"],
                Index::IvfPq(IvfPqIndexBuilder::default().distance_type(DistanceType::Cosine)),
            )
            .execute()
            .await
            .map_err(|e| format!("Failed to create vector index: {}", e))?;

        tracing::info!("Creating scalar indexes...");
        self.table
            .create_index(&["text_chunk"], Index::FTS(FtsIndexBuilder::default()))
            .execute()
            .await
            .map_err(|e| format!("Failed to create FTS index: {}", e))?;

        self.table
            .create_index(&["subject"], Index::BTree(BTreeIndexBuilder::default()))
            .execute()
            .await
            .map_err(|e| format!("Failed to create subject index: {}", e))?;

        self.table
            .create_index(
                &["is_a"],
                Index::LabelList(LabelListIndexBuilder::default()),
            )
            .execute()
            .await
            .map_err(|e| format!("Failed to create is_a index: {}", e))?;

        self.table
            .create_index(
                &["hierarchy"],
                Index::LabelList(LabelListIndexBuilder::default()),
            )
            .execute()
            .await
            .map_err(|e| format!("Failed to create hierarchy index: {}", e))?;

        tracing::info!("Optimizing vector table...");
        self.table
            .optimize(OptimizeAction::All)
            .await
            .map_err(|e| format!("Failed to optimize table: {}", e))?;

        tracing::info!(
            "Vector search index finished in {:?}",
            index_started.elapsed()
        );
        Ok(())
    }

    /// Embeds one or more strings using the configured backend (local fastembed or OpenRouter).
    #[tracing::instrument(skip(self, chunks), level = "trace")]
    pub async fn embed_chunks(&self, chunks: &[String]) -> AtomicServerResult<Vec<Vec<f32>>> {
        self.embedder.embed_strings(chunks).await
    }

    async fn embed_and_add_owned_batch(
        &self,
        batch_subjects: Vec<String>,
        batch_is_a: Vec<Vec<String>>,
        batch_hierarchy: Vec<Vec<String>>,
        batch_text_chunks: Vec<String>,
    ) -> AtomicServerResult<()> {
        if batch_subjects.is_empty() {
            return Ok(());
        }

        let embeddings = self.embed_chunks(&batch_text_chunks).await?;

        self.add_batch(
            &batch_subjects,
            &batch_is_a,
            &batch_hierarchy,
            &batch_text_chunks,
            &embeddings,
        )
        .await?;

        Ok(())
    }

    async fn embed_and_add_batch(
        &self,
        batch_subjects: &mut Vec<String>,
        batch_is_a: &mut Vec<Vec<String>>,
        batch_hierarchy: &mut Vec<Vec<String>>,
        batch_text_chunks: &mut Vec<String>,
    ) -> AtomicServerResult<()> {
        if batch_subjects.is_empty() {
            return Ok(());
        }

        self.embed_and_add_owned_batch(
            std::mem::take(batch_subjects),
            std::mem::take(batch_is_a),
            std::mem::take(batch_hierarchy),
            std::mem::take(batch_text_chunks),
        )
        .await
    }

    #[tracing::instrument(
        skip(self, subjects, is_a_arrays, hierarchy_arrays, text_chunks, embeddings),
        level = "trace"
    )]
    async fn add_batch(
        &self,
        subjects: &[String],
        is_a_arrays: &[Vec<String>],
        hierarchy_arrays: &[Vec<String>],
        text_chunks: &[String],
        embeddings: &[Vec<f32>],
    ) -> AtomicServerResult<()> {
        let num_embeddings = embeddings.len();
        let schema = self
            .table
            .schema()
            .await
            .map_err(|e| format!("Failed to get schema: {}", e))?;

        let subject_array = Arc::new(StringArray::from_iter_values(subjects.iter()));
        let text_chunk_array = Arc::new(StringArray::from_iter_values(text_chunks.iter()));

        let mut is_a_builder = ListBuilder::new(StringBuilder::new());
        for classes in is_a_arrays {
            for class in classes {
                is_a_builder.values().append_value(class);
            }
            is_a_builder.append(true);
        }
        let is_a_array = Arc::new(is_a_builder.finish());

        let mut hierarchy_builder = ListBuilder::new(StringBuilder::new());
        for h in hierarchy_arrays {
            for parent in h {
                hierarchy_builder.values().append_value(parent);
            }
            hierarchy_builder.append(true);
        }
        let hierarchy_array = Arc::new(hierarchy_builder.finish());

        let mut flat_embeddings: Vec<f32> = Vec::with_capacity(num_embeddings * self.embedding_dim);
        for embedding in embeddings {
            if embedding.len() != self.embedding_dim {
                return Err(format!(
                    "Embedding length {} does not match index dimension {}",
                    embedding.len(),
                    self.embedding_dim
                )
                .into());
            }
            flat_embeddings.extend(embedding);
        }

        let values = Arc::new(Float32Array::from(flat_embeddings));
        let vector_array = Arc::new(
            FixedSizeListArray::try_new(
                Arc::new(Field::new("item", DataType::Float32, true)),
                self.embedding_dim as i32,
                values as ArrayRef,
                None,
            )
            .map_err(|e| format!("Failed to create FixedSizeListArray: {}", e))?,
        );

        let batch = RecordBatch::try_new(
            schema.clone(),
            vec![
                subject_array,
                text_chunk_array as ArrayRef,
                is_a_array as ArrayRef,
                hierarchy_array as ArrayRef,
                vector_array,
            ],
        )
        .map_err(|e| format!("Failed to create record batch: {}", e))?;

        let batches = RecordBatchIterator::new(vec![Ok(batch)], schema.clone());

        self.table
            .add(Box::new(batches))
            .execute()
            .await
            .map_err(|e| format!("Failed to add to lancedb table: {}", e))?;

        Ok(())
    }

    #[tracing::instrument(skip(self, resource, store))]
    pub async fn create_resource_chunks(
        &self,
        resource: &Resource,
        store: &Db,
    ) -> AtomicServerResult<Option<(String, Vec<String>, Vec<String>, Vec<String>)>> {
        let subject = resource.get_subject().to_string();

        let mut is_a = Vec::new();
        if let Ok(atomic_lib::Value::ResourceArray(classes)) = resource.get(atomic_lib::urls::IS_A)
        {
            is_a = classes.iter().map(|c| c.to_string()).collect();
        }

        // If is_a contains a class from the blacklist we return None.
        if is_a
            .iter()
            .any(|c| CLASS_INDEX_BLACKLIST.contains(&c.as_str()))
        {
            return Ok(None);
        }

        let (title, description, doc_content) = get_resource_text_parts(resource);

        if title.is_none() && description.is_none() && doc_content.is_none() {
            return Ok(None);
        }

        let mut hierarchy = Vec::new();
        if let Ok(parent_tree) = resource.get_parent_tree(store).await {
            hierarchy = parent_tree
                .iter()
                .map(|p| p.get_subject().to_string())
                .collect();
        }

        let max_length = 256;
        let overlap = 100;

        let plain_text_splitter = TextSplitter::new(
            ChunkConfig::new(max_length)
                .with_overlap(overlap)
                .map_err(|e| format!("Failed to create chunk config: {}", e))?,
        );
        let markdown_splitter = MarkdownSplitter::new(
            ChunkConfig::new(max_length)
                .with_overlap(overlap)
                .map_err(|e| format!("Failed to create chunk config: {}", e))?,
        );

        let mut chunks = Vec::new();

        if let Some(title) = title {
            chunks.push(title);
        }

        if let Some(description) = description {
            for chunk in markdown_splitter.chunks(&description) {
                chunks.push(chunk.to_string());
            }
        }

        if let Some(doc_content) = doc_content {
            for chunk in plain_text_splitter.chunks(&doc_content) {
                chunks.push(chunk.to_string());
            }
        }

        if chunks.is_empty() {
            return Ok(None);
        }

        Ok(Some((subject, is_a, hierarchy, chunks)))
    }

    #[tracing::instrument(skip(self, resource, store))]
    pub async fn add_resource(&self, resource: &Resource, store: &Db) -> AtomicServerResult<()> {
        let Some((subject, is_a, hierarchy, chunks)) =
            self.create_resource_chunks(resource, store).await?
        else {
            return Ok(());
        };

        self.incremental_resources_indexed
            .fetch_add(1, Ordering::Relaxed);

        let drive_root = hierarchy.last().cloned().unwrap_or_else(|| subject.clone());
        let chunk_count = chunks.len().min(u32::MAX as usize) as u32;

        {
            let mut p = self.pending.lock().await;
            for chunk in chunks {
                p.batch_subjects.push(subject.clone());
                p.batch_is_a.push(is_a.clone());
                p.batch_hierarchy.push(hierarchy.clone());
                p.batch_text_chunks.push(chunk);
            }
        }

        self.register_pending(&drive_root, chunk_count);

        let batch_size = self.embedder.index_batch_size();
        loop {
            let (batch_subjects, batch_is_a, batch_hierarchy, batch_text_chunks) = {
                let mut p = self.pending.lock().await;
                if p.batch_subjects.len() < batch_size {
                    break;
                }
                let batch_subjects: Vec<_> =
                    p.batch_subjects.drain(..batch_size).collect();
                let batch_is_a: Vec<_> = p.batch_is_a.drain(..batch_size).collect();
                let batch_hierarchy: Vec<_> =
                    p.batch_hierarchy.drain(..batch_size).collect();
                let batch_text_chunks: Vec<_> = p
                    .batch_text_chunks
                    .drain(..batch_size)
                    .collect();
                (
                    batch_subjects,
                    batch_is_a,
                    batch_hierarchy,
                    batch_text_chunks,
                )
            };
            let track_subjects = batch_subjects.clone();
            let track_hierarchy = batch_hierarchy.clone();
            let res = self
                .embed_and_add_owned_batch(
                    batch_subjects,
                    batch_is_a,
                    batch_hierarchy,
                    batch_text_chunks,
                )
                .await;
            self.complete_batch_rows(&track_subjects, &track_hierarchy);
            res?;

            let batch_no = self.incremental_batch_seq.fetch_add(1, Ordering::Relaxed) + 1;
            let pending_after = self.pending.lock().await.batch_subjects.len();
            let resources_processed = self.incremental_resources_indexed.load(Ordering::Relaxed);
            println!(
                "starting incremental batch: {}, chunk rows: {}, pending rows after: {}, resources processed: {}",
                batch_no,
                batch_size,
                pending_after,
                resources_processed
            );
        }

        // Drain any remainder (fewer than one full batch) so LanceDB stays in sync and
        // per-drive indexing refcounts match completed embeds (see `register_pending` / `complete_batch_rows`).
        self.flush_pending().await?;

        Ok(())
    }

    /// Writes all pending vector index rows to LanceDB. Safe to call when idle.
    /// [`remove_resource`] flushes automatically so deletes do not race unflushed adds.
    #[tracing::instrument(skip(self))]
    pub async fn flush_pending(&self) -> AtomicServerResult<()> {
        let batch_size = self.embedder.index_batch_size();
        loop {
            let (chunk_rows, batch_subjects, batch_is_a, batch_hierarchy, batch_text_chunks) = {
                let mut p = self.pending.lock().await;
                if p.batch_subjects.is_empty() {
                    return Ok(());
                }
                let n = if p.batch_subjects.len() >= batch_size {
                    batch_size
                } else {
                    p.batch_subjects.len()
                };
                let batch_subjects: Vec<_> = p.batch_subjects.drain(..n).collect();
                let batch_is_a: Vec<_> = p.batch_is_a.drain(..n).collect();
                let batch_hierarchy: Vec<_> = p.batch_hierarchy.drain(..n).collect();
                let batch_text_chunks: Vec<_> = p.batch_text_chunks.drain(..n).collect();
                (
                    n,
                    batch_subjects,
                    batch_is_a,
                    batch_hierarchy,
                    batch_text_chunks,
                )
            };
            let track_subjects = batch_subjects.clone();
            let track_hierarchy = batch_hierarchy.clone();
            let res = self
                .embed_and_add_owned_batch(
                    batch_subjects,
                    batch_is_a,
                    batch_hierarchy,
                    batch_text_chunks,
                )
                .await;
            self.complete_batch_rows(&track_subjects, &track_hierarchy);
            res?;

            let batch_no = self.incremental_batch_seq.fetch_add(1, Ordering::Relaxed) + 1;
            let pending_after = self.pending.lock().await.batch_subjects.len();
            let resources_processed = self.incremental_resources_indexed.load(Ordering::Relaxed);
            println!(
                "starting incremental batch (flush): {}, chunk rows: {}, pending rows after: {}, resources processed: {}",
                batch_no,
                chunk_rows,
                pending_after,
                resources_processed
            );
        }
    }

    #[tracing::instrument(skip(self))]
    pub async fn remove_resource(&self, subject: &str) -> AtomicServerResult<()> {
        self.flush_pending().await?;

        let safe_subject = subject.replace("'", "''");
        self.table
            .delete(&format!("subject = '{}'", safe_subject))
            .await
            .map_err(|e| format!("Failed to delete from lancedb: {}", e))?;
        Ok(())
    }
}
