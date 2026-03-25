use crate::config::Config;
use crate::errors::AtomicServerResult;
use crate::search::extract_plain_text;
use arrow::array::{
    ArrayRef, FixedSizeListArray, Float32Array, ListBuilder, RecordBatch, RecordBatchIterator,
    StringArray, StringBuilder,
};
use arrow::datatypes::{DataType, Field, Schema};
use atomic_lib::{Db, Resource, Storelike};
use fastembed::{
    EmbeddingModel, InitOptions, RerankInitOptions, RerankerModel, TextEmbedding, TextRerank,
};
use lancedb::index::scalar::{BTreeIndexBuilder, FtsIndexBuilder, LabelListIndexBuilder};
use lancedb::index::vector::IvfPqIndexBuilder;
use lancedb::index::Index;
use lancedb::table::OptimizeAction;
use lancedb::{DistanceType, Table};
use std::sync::Arc;
use text_splitter::{ChunkConfig, MarkdownSplitter, TextSplitter};
// use tokio::sync::RwLock;
use yrs::updates::decoder::Decode;
use yrs::Transact;
use yrs::WriteTxn;

// We don't add these classes to the database because they would decrease the quality of the AI answers.
const CLASS_INDEX_BLACKLIST: &[&str] = &[
    atomic_lib::urls::TEXT_PART,
    atomic_lib::urls::REASONING_PART,
];

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

/// State for the vector search, utilizing fastembed and lancedb
#[derive(Clone)]
pub struct VectorSearchState {
    pub model: Arc<tokio::sync::Mutex<TextEmbedding>>,
    pub rerank_model: Arc<tokio::sync::Mutex<TextRerank>>,
    pub table: Arc<Table>,
}

impl VectorSearchState {
    pub async fn new(config: &Config) -> AtomicServerResult<Self> {
        tracing::info!("Starting vector search service");

        let mut embedding_options =
            InitOptions::new(EmbeddingModel::AllMiniLML6V2).with_show_download_progress(true);

        let mut rerank_options = RerankInitOptions::new(RerankerModel::BGERerankerBase)
            .with_show_download_progress(true);

        if config.gpu_indexing {
            tracing::info!("Enabling GPU execution providers for fastembed");
            let mut execution_providers = Vec::new();

            #[cfg(target_os = "macos")]
            {
                execution_providers.push(
                    ort::execution_providers::CoreMLExecutionProvider::default()
                        .with_compute_units(
                            ort::execution_providers::coreml::ComputeUnits::CPUAndNeuralEngine,
                        )
                        .with_model_format(ort::execution_providers::coreml::ModelFormat::MLProgram)
                        .build(),
                );
            }
            #[cfg(target_os = "windows")]
            {
                execution_providers
                    .push(ort::execution_providers::DirectMLExecutionProvider::default().build());
                execution_providers
                    .push(ort::execution_providers::CUDAExecutionProvider::default().build());
            }
            #[cfg(not(any(target_os = "macos", target_os = "windows")))]
            {
                execution_providers
                    .push(ort::execution_providers::CUDAExecutionProvider::default().build());
            }

            embedding_options =
                embedding_options.with_execution_providers(execution_providers.clone());
            rerank_options = rerank_options.with_execution_providers(execution_providers);
        }

        // Initialize the embedding model
        let model = TextEmbedding::try_new(embedding_options)
            .map_err(|e| format!("Failed to initialize fastembed: {}", e))?;

        let rerank_model = TextRerank::try_new(rerank_options)
            .map_err(|e| format!("Failed to initialize fastembed reranker: {}", e))?;

        // Open or create lancedb table
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

        let schema = Arc::new(Schema::new(vec![
            Field::new("subject", DataType::Utf8, false),
            Field::new("text_chunk", DataType::Utf8, false),
            Field::new(
                "is_a",
                DataType::List(Arc::new(Field::new("item", DataType::Utf8, true))),
                true,
            ),
            Field::new(
                "hierarchy",
                DataType::List(Arc::new(Field::new("item", DataType::Utf8, true))),
                true,
            ),
            Field::new(
                "vector",
                DataType::FixedSizeList(Arc::new(Field::new("item", DataType::Float32, true)), 384),
                false,
            ),
        ]));

        let table_names = db
            .table_names()
            .execute()
            .await
            .map_err(|e| format!("Failed to get lancedb table names: {}", e))?;
        let table = if table_names.contains(&"resources".to_string()) {
            db.open_table("resources")
                .execute()
                .await
                .map_err(|e| format!("Failed to open lancedb table: {}", e))?
        } else {
            let empty_batches = RecordBatchIterator::new(vec![], schema.clone());
            db.create_table("resources", Box::new(empty_batches))
                .execute()
                .await
                .map_err(|e| format!("Failed to create lancedb table: {}", e))?
        };

        Ok(VectorSearchState {
            model: Arc::new(tokio::sync::Mutex::new(model)),
            rerank_model: Arc::new(tokio::sync::Mutex::new(rerank_model)),
            table: Arc::new(table),
        })
    }

    #[tracing::instrument(skip(self, store), level = "trace")]
    pub async fn add_all_resources(&self, store: &Db) -> AtomicServerResult<()> {
        tracing::info!("Building vector search index...");

        let resources = store
            .all_resources(true)
            .filter(|resource| !resource.get_subject().contains("/commits/"));

        let mut batch_subjects = Vec::new();
        let mut batch_is_a = Vec::new();
        let mut batch_hierarchy = Vec::new();
        let mut batch_text_chunks = Vec::new();
        let batch_size = 100;
        let mut batch_count = 0;
        let mut resources_processed = 0;

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

        tracing::info!("Vector search index finished!");
        Ok(())
    }

    #[tracing::instrument(skip(self, chunks), level = "trace")]
    async fn embed_chunks(&self, chunks: &[String]) -> AtomicServerResult<Vec<Vec<f32>>> {
        let embeddings = {
            let mut model = self.model.lock().await;

            model
                .embed(chunks, None)
                .map_err(|e| format!("Failed to embed text: {}", e))?
        };

        Ok(embeddings)
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

        let embeddings = self.embed_chunks(batch_text_chunks).await?;

        self.add_batch(
            batch_subjects,
            batch_is_a,
            batch_hierarchy,
            batch_text_chunks,
            &embeddings,
        )
        .await?;

        batch_subjects.clear();
        batch_is_a.clear();
        batch_hierarchy.clear();
        batch_text_chunks.clear();

        Ok(())
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

        // Flatten all embeddings into a single Vec<f32>
        let mut flat_embeddings: Vec<f32> = Vec::with_capacity(num_embeddings * 384);
        for embedding in embeddings {
            flat_embeddings.extend(embedding);
        }

        let values = Arc::new(Float32Array::from(flat_embeddings));
        let vector_array = Arc::new(
            FixedSizeListArray::try_new(
                Arc::new(Field::new("item", DataType::Float32, true)),
                384,
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
    async fn create_resource_chunks(
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

        let batch_size = 100;
        let mut batch_subjects = Vec::new();
        let mut batch_is_a = Vec::new();
        let mut batch_hierarchy = Vec::new();
        let mut batch_text_chunks = Vec::new();

        for chunk in chunks {
            batch_subjects.push(subject.clone());
            batch_is_a.push(is_a.clone());
            batch_hierarchy.push(hierarchy.clone());
            batch_text_chunks.push(chunk);

            if batch_subjects.len() >= batch_size {
                self.embed_and_add_batch(
                    &mut batch_subjects,
                    &mut batch_is_a,
                    &mut batch_hierarchy,
                    &mut batch_text_chunks,
                )
                .await?;
            }
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

        Ok(())
    }

    #[tracing::instrument(skip(self))]
    pub async fn remove_resource(&self, subject: &str) -> AtomicServerResult<()> {
        let safe_subject = subject.replace("'", "''");
        self.table
            .delete(&format!("subject = '{}'", safe_subject))
            .await
            .map_err(|e| format!("Failed to delete from lancedb: {}", e))?;
        Ok(())
    }
}
