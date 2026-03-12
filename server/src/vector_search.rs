use crate::config::Config;
use crate::errors::AtomicServerResult;
use crate::search::{extract_plain_text, get_resource_title};
use arrow::array::{
    ArrayRef, FixedSizeListArray, Float32Array, ListBuilder, RecordBatch, RecordBatchIterator,
    StringArray, StringBuilder,
};
use arrow::datatypes::{DataType, Field, Schema};
use atomic_lib::{Db, Resource, Storelike};
use fastembed::{
    EmbeddingModel, InitOptions, RerankInitOptions, RerankerModel, TextEmbedding, TextRerank,
};
use lancedb::index::scalar::{BTreeIndexBuilder, LabelListIndexBuilder};
use lancedb::index::vector::IvfPqIndexBuilder;
use lancedb::index::Index;
use lancedb::table::OptimizeAction;
use lancedb::{DistanceType, Table};
use std::sync::Arc;
use text_splitter::{ChunkConfig, TextSplitter};
// use tokio::sync::RwLock;
use yrs::updates::decoder::Decode;
use yrs::Transact;
use yrs::WriteTxn;

// We don't add these classes to the database because they would decrease the quality of the AI answers.
const CLASS_INDEX_BLACKLIST: &[&str] = &[
    atomic_lib::urls::TEXT_PART,
    atomic_lib::urls::REASONING_PART,
];

pub fn get_resource_text_parts(resource: &Resource) -> Vec<String> {
    let mut text_parts = Vec::new();
    text_parts.push(get_resource_title(resource));

    if let Ok(atomic_lib::Value::Markdown(description)) =
        resource.get(atomic_lib::urls::DESCRIPTION)
    {
        text_parts.push(description.to_string());
    }

    if let Ok(atomic_lib::Value::YDoc(state)) = resource.get(atomic_lib::urls::DOCUMENT_CONTENT) {
        let ydoc = yrs::Doc::new();
        let mut txn = ydoc.transact_mut();
        if let Ok(()) = txn.apply_update(yrs::Update::decode_v2(state).unwrap_or_default()) {
            let xml_content = txn.get_or_insert_xml_fragment("content");
            let content = extract_plain_text(&xml_content, &txn);
            text_parts.push(content.to_string());
        }
    }

    text_parts
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

        // Initialize the embedding model
        let model = TextEmbedding::try_new(
            InitOptions::new(EmbeddingModel::AllMiniLML12V2).with_show_download_progress(true),
        )
        .map_err(|e| format!("Failed to initialize fastembed: {}", e))?;

        let rerank_model = TextRerank::try_new(
            RerankInitOptions::new(RerankerModel::BGERerankerBase)
                .with_show_download_progress(true),
        )
        .map_err(|e| format!("Failed to initialize fastembed reranker: {}", e))?;

        // Open or create lancedb table
        if config.opts.rebuild_indexes {
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

    pub async fn add_all_resources(&self, store: &Db) -> AtomicServerResult<()> {
        tracing::info!("Building vector search index...");

        let resources = store
            .all_resources(true)
            .filter(|resource| !resource.get_subject().contains("/commits/"));

        let mut batch_subjects = Vec::new();
        let mut batch_is_a = Vec::new();
        let mut batch_hierarchy = Vec::new();
        let mut batch_text_chunks = Vec::new();
        let mut batch_embeddings = Vec::new();
        let batch_size = 100;

        for resource in resources {
            if let Some((subject, is_a, hierarchy, chunks, embeddings)) =
                self.create_resource_embeddings(&resource, store).await?
            {
                for (chunk, embedding) in chunks.into_iter().zip(embeddings) {
                    batch_subjects.push(subject.clone());
                    batch_is_a.push(is_a.clone());
                    batch_hierarchy.push(hierarchy.clone());
                    batch_text_chunks.push(chunk);
                    batch_embeddings.push(embedding);
                }
            }

            if batch_subjects.len() >= batch_size {
                self.add_batch(
                    &batch_subjects,
                    &batch_is_a,
                    &batch_hierarchy,
                    &batch_text_chunks,
                    &batch_embeddings,
                )
                .await?;
                batch_subjects.clear();
                batch_is_a.clear();
                batch_hierarchy.clear();
                batch_text_chunks.clear();
                batch_embeddings.clear();
            }
        }

        if !batch_subjects.is_empty() {
            self.add_batch(
                &batch_subjects,
                &batch_is_a,
                &batch_hierarchy,
                &batch_text_chunks,
                &batch_embeddings,
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

    async fn create_resource_embeddings(
        &self,
        resource: &Resource,
        store: &Db,
    ) -> AtomicServerResult<Option<(String, Vec<String>, Vec<String>, Vec<String>, Vec<Vec<f32>>)>>
    {
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

        let mut hierarchy = Vec::new();
        if let Ok(parent_tree) = resource.get_parent_tree(store).await {
            hierarchy = parent_tree
                .iter()
                .map(|p| p.get_subject().to_string())
                .collect();
        }

        let text_to_split = get_resource_text_parts(resource);

        if text_to_split.is_empty() {
            return Ok(None);
        }

        let chunk_config = ChunkConfig::new(500)
            .with_overlap(100)
            .map_err(|e| format!("Failed to create chunk config: {}", e))?;
        let splitter = TextSplitter::new(chunk_config);

        let mut chunks = Vec::new();
        for text in text_to_split {
            for chunk in splitter.chunks(&text) {
                chunks.push(chunk.to_string());
            }
        }

        if chunks.is_empty() {
            return Ok(None);
        }

        let embeddings = self
            .model
            .lock()
            .await
            .embed(chunks.clone(), None)
            .map_err(|e| format!("Failed to embed text: {}", e))?;

        if embeddings.is_empty() {
            return Ok(None);
        }

        Ok(Some((subject, is_a, hierarchy, chunks, embeddings)))
    }

    #[tracing::instrument(skip(self, resource, store))]
    pub async fn add_resource(&self, resource: &Resource, store: &Db) -> AtomicServerResult<()> {
        let Some((subject, is_a, hierarchy, chunks, embeddings)) =
            self.create_resource_embeddings(resource, store).await?
        else {
            return Ok(());
        };

        self.add_batch(
            &vec![subject.clone(); embeddings.len()],
            &vec![is_a; embeddings.len()],
            &vec![hierarchy; embeddings.len()],
            &chunks,
            &embeddings,
        )
        .await?;

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
