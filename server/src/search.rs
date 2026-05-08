//! Full-text search, powered by Tantivy.
//! A folder for the index is stored in the config.
//! You can see the Endpoint on `http://localhost/search`
use crate::config::Config;
use crate::errors::AtomicServerResult;
use atomic_lib::Db;
use atomic_lib::Resource;
use atomic_lib::Storelike;
use tantivy::schema::Facet;
use tantivy::schema::Field;
use tantivy::schema::STORED;
use tantivy::schema::TEXT;
use tantivy::Index;
use tantivy::IndexWriter;
use tantivy::ReloadPolicy;

/// The actual Schema used for search.
/// It mimics a single Atom (or Triple).
#[derive(Debug)]
pub struct Fields {
    pub subject: Field,
    pub title: Field,
    pub description: Field,
    pub propvals: Field,
    pub hierarchy: Field,
}

/// Contains the index and the schema. for search
#[derive(Clone)]
pub struct SearchState {
    /// reader for performing queries
    pub reader: tantivy::IndexReader,
    /// index
    pub index: tantivy::Index,
    /// For adding stuff to the search index
    /// Just take the read lock for adding documents, and the write lock for committing.
    // see https://github.com/quickwit-inc/tantivy/issues/550
    pub writer: std::sync::Arc<std::sync::RwLock<tantivy::IndexWriter>>,
    /// The shape of data stored in the index
    pub schema: tantivy::schema::Schema,
}

impl SearchState {
    /// Create a new SearchState for the Server, which includes building the schema and index.
    pub fn new(config: &Config) -> AtomicServerResult<SearchState> {
        tracing::info!("Starting search service");
        let schema = crate::search::build_schema()?;
        let (writer, index) = crate::search::get_index(config)?;
        let reader = crate::search::get_reader(&index)?;
        let locked = std::sync::RwLock::from(writer);
        let arced = std::sync::Arc::from(locked);
        Ok(SearchState {
            schema,
            reader,
            index,
            writer: arced,
        })
    }

    /// Returns the schema for the search index.
    pub fn get_schema_fields(&self) -> AtomicServerResult<Fields> {
        let subject = self.schema.get_field("subject")?;
        let title = self.schema.get_field("title")?;
        let description = self.schema.get_field("description")?;
        let propvals = self.schema.get_field("propvals")?;
        let hierarchy = self.schema.get_field("hierarchy")?;

        Ok(Fields {
            subject,
            title,
            description,
            propvals,
            hierarchy,
        })
    }

    /// Indexes all resources from the store to search.
    /// At this moment does not remove existing index.
    pub async fn add_all_resources(&self, store: &Db) -> AtomicServerResult<()> {
        tracing::info!("Building search index");

        let resources = store.all_resources(true).filter(|resource| {
            !resource.get_subject().as_str().contains("/commits/")
                && !resource
                    .get_subject()
                    .as_str()
                    .starts_with("did:ad:commit:")
        });

        for resource in resources {
            self.add_resource(&resource, store).await.map_err(|e| {
                format!(
                    "Failed to add resource to search index: {}. Error: {}",
                    resource.get_subject(),
                    e
                )
            })?
        }

        self.writer.write()?.commit()?;
        tracing::info!("Search index finished!");
        Ok(())
    }

    /// Adds a single resource to the search index, but does _not_ commit!
    /// Does not index outgoing links, or resourcesArrays
    /// `appstate.search_index_writer.write()?.commit()?;`
    #[tracing::instrument(
        skip(self, store, resource),
        fields(subject = %resource.get_subject())
    )]
    pub async fn add_resource(&self, resource: &Resource, store: &Db) -> AtomicServerResult<()> {
        let fields = self.get_schema_fields()?;
        // Store the canonical subject (e.g. "internal:/files/xxx") as the index key.
        // Resolution to full URLs (e.g. "http://localhost:9883/files/xxx") happens at the
        // output layer (search handler), not here. This keeps add/remove symmetric — both
        // just use subject.as_str().
        let subject = resource.get_subject().as_str();
        let title = get_resource_title(resource);
        let has_name = resource.get(atomic_lib::urls::NAME).is_ok();
        let title_is_subject = title == subject;
        tracing::info!(
            "INDEXING title={:?} has_name={} title_is_fallback={}",
            if title_is_subject {
                "<subject>"
            } else {
                &title
            },
            has_name,
            title_is_subject
        );
        let origin = store
            .get_base_domain()
            .unwrap_or_else(|| "http://localhost".to_string());
        tracing::debug!("search::add_resource subject={}", subject);
        let mut doc = tantivy::TantivyDocument::default();
        doc.add_object(
            fields.propvals,
            serde_json::from_str(&resource.to_json_ad(Some(&origin))?).map_err(|e| {
                format!(
                "Failed to convert resource to json for search indexing. Subject: {}. Error: {}",
                subject, e
            )
            })?,
        );

        doc.add_text(fields.subject, subject);
        doc.add_text(fields.title, get_resource_title(resource));

        if let Ok(atomic_lib::Value::Markdown(description)) =
            resource.get(atomic_lib::urls::DESCRIPTION)
        {
            doc.add_text(fields.description, description);
        };

        // If the resource has Loro document content, extract the text for search indexing.
        if let Ok(atomic_lib::Value::LoroDoc(snapshot)) =
            resource.get(atomic_lib::urls::DOCUMENT_CONTENT)
        {
            if let Ok(loro_doc) = atomic_lib::loro::AtomicLoroDoc::from_snapshot(snapshot) {
                if let Some(text) = loro_doc.get_string_property(atomic_lib::urls::DOCUMENT_CONTENT)
                {
                    doc.add_text(fields.description, text);
                }
            }
        }

        let hierarchy = resource_to_facet(resource, store).await.map_err(|e| {
            tracing::warn!(
                "search::add_resource resource_to_facet FAILED for subject={}: {}",
                subject,
                e
            );
            e
        })?;
        tracing::debug!(
            "search::add_resource facet={:?} for subject={}",
            hierarchy,
            subject
        );
        doc.add_facet(fields.hierarchy, hierarchy);

        let writer = self.writer.read()?;
        writer.add_document(doc)?;

        Ok(())
    }

    /// Removes a single resource from the search index, but does _not_ commit!
    /// Pass `subject.as_str()` — the same canonical form that `add_resource` stores.
    /// Does not index outgoing links, or resourcesArrays
    /// `appstate.search_index_writer.write()?.commit()?;`
    #[tracing::instrument(skip(self))]
    pub fn remove_resource(&self, subject: &str) -> AtomicServerResult<()> {
        let fields = self.get_schema_fields()?;
        let writer = self.writer.read()?;
        let term = tantivy::Term::from_field_text(fields.subject, subject);
        writer.delete_term(term);
        Ok(())
    }
}

/// Returns the schema for the search index.
pub fn build_schema() -> AtomicServerResult<tantivy::schema::Schema> {
    let mut schema_builder = tantivy::schema::Schema::builder();
    // The STORED flag makes the index store the full values. Can be useful.

    // The raw tokenizer is used to index the subject field as is, without any tokenization.
    // If we don't do this the subject will be split into multiple tokens which breaks the search.
    schema_builder.add_text_field(
        "subject",
        tantivy::schema::TextOptions::default()
            .set_stored()
            .set_indexing_options(
                tantivy::schema::TextFieldIndexing::default()
                    .set_tokenizer("raw")
                    .set_index_option(tantivy::schema::IndexRecordOption::Basic),
            ),
    );
    schema_builder.add_text_field("title", TEXT | STORED);
    schema_builder.add_text_field("description", TEXT | STORED);
    schema_builder.add_json_field("propvals", STORED | TEXT);
    schema_builder.add_facet_field("hierarchy", STORED);
    let schema = schema_builder.build();
    Ok(schema)
}

/// Creates or reads the index from the `search_index_path` and allocates some heap size.
pub fn get_index(config: &Config) -> AtomicServerResult<(IndexWriter, tantivy::Index)> {
    let schema = build_schema()?;
    std::fs::create_dir_all(&config.search_index_path)?;
    if config.opts.rebuild_indexes {
        std::fs::remove_dir_all(&config.search_index_path)?;
        std::fs::create_dir_all(&config.search_index_path)?;
    }
    let mmap_directory = tantivy::directory::MmapDirectory::open(&config.search_index_path)?;
    let index = Index::open_or_create(mmap_directory, schema).map_err(|e| {
        format!(
            "Failed to create or open search index. Try starting again with --rebuild-indexes. Error: {}",
            e
        )
    })?;

    // Register the raw tokenizer
    index
        .tokenizers()
        .register("raw", tantivy::tokenizer::RawTokenizer::default());

    let heap_size_bytes = 50_000_000;
    let index_writer = index.writer(heap_size_bytes)?;
    Ok((index_writer, index))
}

// For a search server you will typically create one reader for the entire lifetime of your program, and acquire a new searcher for every single request.
pub fn get_reader(index: &tantivy::Index) -> AtomicServerResult<tantivy::IndexReader> {
    Ok(index
        .reader_builder()
        .reload_policy(ReloadPolicy::OnCommitWithDelay)
        .try_into()?)
}

pub fn subject_to_facet(subject: String) -> AtomicServerResult<Facet> {
    Facet::from_encoded(subject.into_bytes())
        .map_err(|e| format!("Failed to create facet from subject. Error: {}", e).into())
}

pub async fn resource_to_facet(resource: &Resource, store: &Db) -> AtomicServerResult<Facet> {
    let mut parent_tree = resource.get_parent_tree(store).await?;
    parent_tree.reverse();

    let mut hierarchy_bytes: Vec<u8> = Vec::new();

    for (index, parent) in parent_tree.iter().enumerate() {
        let facet = subject_to_facet(parent.get_subject().to_string())?;

        if index != 0 {
            hierarchy_bytes.push(0u8);
        }

        hierarchy_bytes.append(&mut facet.encoded_str().to_string().into_bytes());
    }
    let leaf_facet = subject_to_facet(resource.get_subject().to_string())?;

    if !hierarchy_bytes.is_empty() {
        hierarchy_bytes.push(0u8);
    }

    hierarchy_bytes.append(&mut leaf_facet.encoded_str().to_string().into_bytes());

    let result = Facet::from_encoded(hierarchy_bytes)
        .map_err(|e| format!("Failed to convert resource to facet, Error: {}", e))
        .unwrap();

    Ok(result)
}

fn get_resource_title(resource: &Resource) -> String {
    let title = if let Ok(name) = resource.get(atomic_lib::urls::NAME) {
        name.clone()
    } else if let Ok(shortname) = resource.get(atomic_lib::urls::SHORTNAME) {
        shortname.clone()
    } else if let Ok(filename) = resource.get(atomic_lib::urls::FILENAME) {
        filename.clone()
    } else {
        atomic_lib::Value::String(resource.get_subject().to_string())
    };

    match title {
        atomic_lib::Value::String(s) => s,
        atomic_lib::Value::Slug(s) => s,
        _ => resource.get_subject().to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use atomic_lib::{urls, Resource, Storelike};

    #[actix_rt::test]
    async fn facet_contains_subfacet() {
        let store = atomic_lib::Db::init_temp("facet_contains").await.unwrap();
        let mut prev_subject: Option<String> = None;
        let mut resources = Vec::new();

        for index in [0, 1, 2].iter() {
            let subject = format!("http://example.com/{}", index);

            let mut resource = Resource::new(subject.clone());
            if let Some(prev_subject) = prev_subject.clone() {
                resource
                    .set_string(urls::PARENT.into(), &prev_subject, &store)
                    .await
                    .unwrap();
            }

            prev_subject = Some(subject.clone());

            store.add_resource(&resource).await.unwrap();
            resources.push(resource);
        }

        let parent_tree = resources[2].get_parent_tree(&store).await.unwrap();
        assert_eq!(parent_tree.len(), 2);

        let index_facet = resource_to_facet(&resources[2], &store).await.unwrap();

        let query_facet_direct_parent = resource_to_facet(&resources[1], &store).await.unwrap();
        let query_facet_root = resource_to_facet(&resources[0], &store).await.unwrap();

        assert!(query_facet_direct_parent.is_prefix_of(&index_facet));
        assert!(query_facet_root.is_prefix_of(&index_facet));
    }

    /// Regression test for the DID search-index bug: resources with `did:ad:...`
    /// subjects were not findable via /search?q=... after being added to the
    /// tantivy index. Repro: create a drive (DID), create a folder under it
    /// (DID), index the folder, commit, query for its name. Expected: found.
    #[actix_rt::test]
    async fn did_subject_is_indexed_and_searchable() {
        let unique = atomic_lib::utils::random_string(10);
        let config = crate::config::build_temp_config(&unique).unwrap();
        let store = atomic_lib::Db::init_temp(&unique).await.unwrap();
        atomic_lib::test_utils::setup_test_env(&store)
            .await
            .unwrap();

        let search_state = SearchState::new(&config).unwrap();
        let fields = search_state.get_schema_fields().unwrap();

        // A drive with a DID subject — matches how dev-drive / user flows work.
        let drive_subject = "did:ad:test-drive-subject";
        let mut drive = Resource::new(drive_subject.to_string());
        drive
            .set_string(urls::NAME.into(), "Drive", &store)
            .await
            .unwrap();
        store.add_resource(&drive).await.unwrap();

        // A folder under that drive, also DID-subject.
        let folder_subject = "did:ad:test-folder-subject";
        let mut folder = Resource::new(folder_subject.to_string());
        folder
            .set_string(urls::NAME.into(), "MyUniqueFolder", &store)
            .await
            .unwrap();
        folder
            .set_string(urls::PARENT.into(), drive_subject, &store)
            .await
            .unwrap();
        // Avoid class-membership — Folder requires display-style, etc. We
        // just want to test the search-index path for DID subjects.
        store.add_resource(&folder).await.unwrap();

        // Index it the way CommitMonitor does.
        search_state.add_resource(&folder, &store).await.unwrap();
        search_state.writer.write().unwrap().commit().unwrap();
        search_state.reader.reload().unwrap();

        let searcher = search_state.reader.searcher();
        let parser =
            tantivy::query::QueryParser::for_index(&search_state.index, vec![fields.title]);
        let query = parser.parse_query("MyUniqueFolder").unwrap();
        let top_docs = searcher
            .search(&query, &tantivy::collector::TopDocs::with_limit(10))
            .unwrap();

        assert!(
            !top_docs.is_empty(),
            "DID-subject folder should be findable by name",
        );
    }

    #[actix_rt::test]
    async fn test_update_resource() {
        let unique_string = atomic_lib::utils::random_string(10);

        let config = crate::config::build_temp_config(&unique_string)
            .map_err(|e| format!("Initialization failed: {}", e))
            .expect("failed init config");

        let store = atomic_lib::Db::init_temp(&unique_string).await.unwrap();
        atomic_lib::test_utils::setup_test_env(&store)
            .await
            .unwrap();

        let search_state = SearchState::new(&config).unwrap();
        let fields = search_state.get_schema_fields().unwrap();

        // Create initial resource
        let mut resource = Resource::new_generate_subject(&store).unwrap();
        resource
            .set_string(urls::NAME.into(), "Initial Title", &store)
            .await
            .unwrap();
        store.add_resource(&resource).await.unwrap();

        // Add to search index
        search_state.add_resource(&resource, &store).await.unwrap();
        search_state.writer.write().unwrap().commit().unwrap();

        // Update the resource
        resource
            .set_string(urls::NAME.into(), "Updated Title", &store)
            .await
            .unwrap();
        resource.save(&store).await.unwrap();

        // Update in search index — just use the canonical subject, no resolution needed
        search_state
            .remove_resource(resource.get_subject().as_str())
            .unwrap();
        search_state.add_resource(&resource, &store).await.unwrap();
        search_state.writer.write().unwrap().commit().unwrap();

        // Make sure changes are visible to searcher
        search_state.reader.reload().unwrap();

        let searcher = search_state.reader.searcher();

        // Search for the old title - should return no results
        let query_parser =
            tantivy::query::QueryParser::for_index(&search_state.index, vec![fields.title]);
        let query = query_parser.parse_query("Initial").unwrap();
        let top_docs = searcher
            .search(&query, &tantivy::collector::TopDocs::with_limit(1))
            .unwrap();
        assert_eq!(top_docs.len(), 0, "Old title should not be found in index");

        // Search for the new title - should return one result
        let query = query_parser.parse_query("Updated").unwrap();
        let top_docs = searcher
            .search(&query, &tantivy::collector::TopDocs::with_limit(1))
            .unwrap();
        assert_eq!(top_docs.len(), 1, "New title should be found in index");
    }
}
