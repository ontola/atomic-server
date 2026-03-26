//! Persistent, ACID compliant, threadsafe to-disk store.
//! Powered by Sled - an embedded database.

mod encoding;
mod migrations;
pub mod plugin_meta;
mod prop_val_sub_index;
mod query_index;
pub use query_index::drive_prefix_from_subject;
#[cfg(test)]
pub mod test;
mod trees;
mod v1_types;
mod v2_types;
mod val_prop_sub_index;

use std::{
    collections::{HashMap, HashSet},
    fs,
    sync::{Arc, Mutex, RwLock},
    vec,
};

use crate::{
    agents::ForAgent,
    atoms::IndexAtom,
    class_extender::{
        ClassExtender, ClassExtenderScope, CommitExtenderContext, GetExtenderContext,
    },
    commit::{CommitOpts, CommitResponse},
    db::{
        encoding::{decode_propvals, encode_propvals},
        plugin_meta::{PluginMeta, PluginMetaKey},
        query_index::{requires_query_index, NO_VALUE},
        val_prop_sub_index::find_in_val_prop_sub_index,
    },
    dht::DhtService,
    endpoints::{Endpoint, HandleGetContext},
    errors::{AtomicError, AtomicResult},
    resources::PropVals,
    storelike::{Query, QueryResult, ResourceResponse, Storelike},
    urls,
    values::SortableValue,
    Atom, Commit, Resource, Subject, Value,
};
use async_trait::async_trait;
use tracing::{info, instrument};
use trees::{Method, Operation, Transaction, Tree};

use self::{
    migrations::migrate_maybe,
    prop_val_sub_index::{add_atom_to_prop_val_sub_index, find_in_prop_val_sub_index},
    query_index::{
        check_if_atom_matches_watched_query_filters, query_sorted_indexed, should_include_resource,
        update_indexed_member, IndexIterator, QueryFilter,
    },
    val_prop_sub_index::add_atom_to_valpropsub_index,
};
use sled::{transaction::TransactionError, Transactional};

// A function called by the Store when a Commit is accepted
type HandleCommit = Box<dyn Fn(&CommitResponse) + Send + Sync>;

/// Result of mapping an incoming request target to a canonical subject.
pub struct ResolvedTarget {
    pub subject: Subject,
    pub alias_subject: Option<String>,
}

/// Inside the reference_index, each value is mapped to this type.
/// The String on the left represents a Property URL, and the second one is the set of subjects.
pub type PropSubjectMap = HashMap<String, HashSet<String>>;

/// The Db is a persistent on-disk Atomic Data store.
/// It's an implementation of [Storelike].
/// It uses [sled::Tree]s as Key Value stores.
/// It stores [Resource]s as [PropVals]s by their subject as key.
/// It builds a value index for performant [Query]s.
/// It keeps track of Queries and updates their index when [crate::Commit]s are applied.
/// You can pass a custom `on_commit` function to run at Commit time.
/// `Db` should be easily, cheaply clone-able, as users of this library could have one `Db` per connection.
#[derive(Clone)]
pub struct Db {
    /// The Key-Value store that contains all data.
    /// Resources can be found using their Subject.
    /// Try not to use this directly, but use the Trees.
    db: sled::Db,
    default_agent: Arc<Mutex<Option<crate::agents::Agent>>>,
    /// Stores all resources. The Key is the Subject as a `string.as_bytes()`, the value a [PropVals]. Propvals must be serialized using messagepack.
    resources: sled::Tree,
    /// [Tree::ValPropSub]
    reference_index: sled::Tree,
    /// [Tree::PropValSub]
    prop_val_sub_index: sled::Tree,
    /// [Tree::QueryMembers]
    query_index: sled::Tree,
    /// [Tree::WatchedQueries]
    watched_queries: sled::Tree,
    /// [Tree::PluginMeta]
    plugin_meta: sled::Tree,
    /// [Tree::DriveMapping]
    drive_mapping: sled::Tree,
    /// [Tree::DidMapping]
    did_mapping: sled::Tree,
    /// Endpoints are checked whenever a resource is requested. They calculate (some properties of) the resource and return it.
    endpoints: Vec<Endpoint>,
    /// List of class extenders.
    class_extenders: Arc<RwLock<Vec<ClassExtender>>>,
    /// DHT service for decentralized discovery.
    dht: Arc<Option<DhtService>>,
    /// Function called whenever a Commit is applied.
    on_commit: Option<Arc<HandleCommit>>,
    /// Where the DB is stored on disk.
    path: std::path::PathBuf,
    /// The base domain of the store.
    pub base_domain: Option<String>,
}

impl Db {
    /// Creates a new store at the specified path, or opens the store if it already exists.
    pub async fn init(path: &std::path::Path, base_domain: Option<String>) -> AtomicResult<Db> {
        tracing::info!("Opening database at {:?}", path);

        let db = sled::open(path).map_err(|e|format!("Failed opening DB at this location: {:?} . Is another instance of Atomic Server running? {}", path, e))?;
        let resources = db.open_tree(Tree::Resources).map_err(|e| format!("Failed building resources. Your DB might be corrupt. Go back to a previous version and export your data. {}", e))?;
        let reference_index = db.open_tree(Tree::ValPropSub)?;
        let query_index = db.open_tree(Tree::QueryMembers)?;
        let prop_val_sub_index = db.open_tree(Tree::PropValSub)?;
        let watched_queries = db.open_tree(Tree::WatchedQueries)?;
        let plugin_meta = db.open_tree(Tree::PluginMeta)?;
        let drive_mapping = db.open_tree(Tree::DriveMapping)?;
        let did_mapping = db.open_tree(Tree::DidMapping)?;

        let store = Db {
            path: path.into(),
            db,
            default_agent: Arc::new(Mutex::new(None)),
            resources,
            reference_index,
            query_index,
            prop_val_sub_index,
            watched_queries,
            plugin_meta,
            drive_mapping,
            did_mapping,
            endpoints: vec![],
            class_extenders: Arc::new(RwLock::new(vec![])),
            dht: Arc::new(None),
            on_commit: None,
            base_domain,
        };

        store.add_class_extender(crate::collections::get_collection_class_extender())?;

        migrate_maybe(&store).map(|e| format!("Error during migration of database: {:?}", e))?;
        // Re-run on every startup so new vocabulary (properties, classes) added
        // to default_store.json is available without a manual `populate` command.
        crate::populate::bootstrap(&store)
            .await
            .map_err(|e| format!("Failed to populate base models. {}", e))?;
        Ok(store)
    }

    /// Creates a clone of the store with a different base_domain.
    /// This is useful for multi-tenant applications.
    /// Cloning is very cheap, as it only clones the pointers to the Sled trees.
    pub fn clone_with_url(&self, base_domain: String) -> Db {
        let mut clone = self.clone();
        clone.base_domain = Some(base_domain);
        clone
    }

    /// Create a temporary Db in `.temp/db/{id}`. Useful for testing.
    /// Populates the database, creates a default agent, and sets the server_url to "http://localhost/".
    pub async fn init_temp(id: &str) -> AtomicResult<Db> {
        let tmp_dir_path = format!(".temp/db/{}", id);
        let _try_remove_existing = std::fs::remove_dir_all(&tmp_dir_path);
        let store = Db::init(
            std::path::Path::new(&tmp_dir_path),
            Some("https://localhost".into()),
        )
        .await?;
        let agent = store.create_agent(None).await?;
        store.set_default_agent(agent);
        store.populate().await?;
        Ok(store)
    }

    /// Sets the DHT service for decentralized discovery.
    pub fn set_dht(&mut self, dht: DhtService) {
        self.dht = Arc::new(Some(dht));
    }

    pub async fn resolve_request_target(
        &self,
        subject: &Subject,
        host: &str,
        subject_string: &str,
        origin: &str,
    ) -> AtomicResult<ResolvedTarget> {
        let full_subject = format!("{}{}", origin.trim_end_matches('/'), subject_string);
        match self
            .map_request_subject(subject, host, subject_string)
            .await
        {
            Ok(mapped_subject) => {
                let alias_subject = if mapped_subject != *subject {
                    Some(full_subject)
                } else {
                    None
                };
                Ok(ResolvedTarget {
                    subject: mapped_subject,
                    alias_subject,
                })
            }
            Err(e) => {
                // Drive-routing failed (e.g. ULID subject not found via shortname traversal).
                // Fall back to a direct DB lookup for the full HTTP URL before giving up.
                let direct = Subject::from_raw(&full_subject, None);
                if self.get_resource(&direct).await.is_ok() {
                    Ok(ResolvedTarget {
                        subject: direct,
                        alias_subject: None,
                    })
                } else {
                    Err(e)
                }
            }
        }
    }

    async fn map_request_subject(
        &self,
        subject: &Subject,
        host: &str,
        subject_string: &str,
    ) -> AtomicResult<Subject> {
        if Self::should_bypass_drive_routing(subject, subject_string) {
            return Ok(subject.clone());
        }

        let Some(drive_did) = self.get_drive_did(host).await? else {
            return Ok(subject.clone());
        };

        if self.get_resource(&drive_did).await.is_err() {
            return Ok(subject.clone());
        }

        if subject_string == "/" {
            return Ok(drive_did);
        }

        let resolved = self
            .get_resource_at_path(&drive_did, subject_string)
            .await
            .map_err(|e| {
                AtomicError::not_found(format!(
                    "Path '{}' not found in drive {}: {}",
                    subject_string, drive_did, e
                ))
            })?;

        Ok(resolved.set_drive_hint(drive_did.as_str().to_string()))
    }

    fn should_bypass_drive_routing(subject: &Subject, subject_string: &str) -> bool {
        subject.is_did()
            || subject_string.starts_with("/did")
            || subject_string.starts_with("/setup")
            || subject_string.starts_with("/search")
            || subject_string.starts_with("/upload")
            || subject_string.starts_with("/export")
            || subject_string.starts_with("/download")
            || subject_string.starts_with("/invites")
            || subject_string.starts_with("/commit")
            || subject_string.starts_with("/path")
            || subject_string.starts_with("/query")
    }

    pub async fn fetch_resource_with_did_fallback(
        &self,
        subject: &Subject,
        origin: &str,
        for_agent: &ForAgent,
    ) -> AtomicResult<ResourceResponse> {
        let store = self.clone_with_url(origin.to_string());

        match store.get_resource_extended(subject, false, for_agent).await {
            Ok(resource) => Ok(resource),
            Err(error) => {
                if let Subject::Did { .. } = subject {
                    if let Some(dht) = self.dht.as_ref() {
                        if let Ok(resource) = dht.resolve(subject, &store).await {
                            if let Err(cache_error) = store.add_resource(&resource).await {
                                tracing::warn!(
                                    "DHT: Resolved {} but failed to cache locally: {}",
                                    subject,
                                    cache_error
                                );
                            }
                            return Ok(resource.into());
                        }
                    }
                }

                Err(error)
            }
        }
    }

    pub fn add_class_extender(&self, class_extender: ClassExtender) -> AtomicResult<()> {
        let mut extenders = self
            .class_extenders
            .write()
            .map_err(|e| format!("Failed to write to class extenders: {}", e))?;

        if let Some(id) = &class_extender.id {
            extenders.retain(|e| e.id.as_ref() != Some(id));
        }

        extenders.push(class_extender);
        Ok(())
    }

    pub fn get_class_extenders_on_drive(&self, drive_subject: &str) -> Vec<ClassExtender> {
        let Ok(extenders) = self.class_extenders.read() else {
            return Vec::new();
        };

        extenders
            .iter()
            .filter(
                |e| matches!(&e.scope, ClassExtenderScope::Drive(scope) if scope == drive_subject),
            )
            .cloned()
            .collect()
    }

    pub fn remove_class_extender(&self, id: &str) -> AtomicResult<()> {
        let mut extenders = self
            .class_extenders
            .write()
            .map_err(|e| format!("Failed to write to class extenders: {}", e))?;
        extenders.retain(|e| e.id.as_deref() != Some(id));
        Ok(())
    }

    pub fn add_endpoint(&mut self, endpoint: Endpoint) -> AtomicResult<()> {
        self.endpoints.push(endpoint);
        Ok(())
    }

    pub fn get_endpoints(&self) -> &Vec<Endpoint> {
        &self.endpoints
    }

    /// Maps a drive hint (short ID) to a full Drive DID.
    pub fn add_drive_mapping(&self, host: &str, drive_did: &Value) -> AtomicResult<()> {
        let did_str = match drive_did {
            Value::AtomicUrl(s) => s.to_string(),
            Value::ResourceArray(arr) => {
                if let Some(first) = arr.first() {
                    first.to_string()
                } else {
                    return Err("Drive DID array is empty".into());
                }
            }
            _ => drive_did.to_string(),
        };

        self.drive_mapping
            .insert(host.as_bytes(), did_str.as_bytes())?;
        tracing::info!("Added drive mapping: {} -> {}", host, did_str);
        Ok(())
    }

    /// Removes the drive mapping for a given host.
    pub fn remove_drive_mapping(&self, host: &str) -> AtomicResult<()> {
        self.drive_mapping.remove(host.as_bytes())?;
        tracing::info!("Removed drive mapping for host: {}", host);
        Ok(())
    }

    /// Returns the full Drive DID for a given host (domain/subdomain).
    pub async fn get_drive_did(&self, host: &str) -> AtomicResult<Option<Subject>> {
        if let Some(did_bin) = self.drive_mapping.get(host.as_bytes())? {
            let did_str = std::str::from_utf8(&did_bin)
                .map_err(|e| format!("Failed to parse DID from database: {}", e))?;
            return Ok(Some(Subject::from_raw(did_str, None)));
        }

        Ok(None)
    }

    /// Resolves a path (e.g. "/blog/my-post") relative to a Drive DID.
    /// 1. First, it tries to find a resource in the Drive that has this exact string in its `PATH` property.
    /// 2. If not found, it traverses the hierarchy recursively using the PARENT property and shortnames.
    pub async fn get_resource_at_path(
        &self,
        drive_did: &Subject,
        path: &str,
    ) -> AtomicResult<Subject> {
        if path == "/" || path.is_empty() {
            return Ok(drive_did.clone());
        }

        // Strategy 1: Direct PATH lookup (flat routing)
        // Find any resource where parent is the drive and path matches the full path string.
        let mut query_path = Query::new_prop_val(urls::PATH, path);
        query_path.limit = Some(1);
        if let Ok(result) = self.query(&query_path).await {
            for resource in result.resources {
                // Verify the resource belongs to this drive
                // (In a multi-tenant world, we want to make sure we don't return someone else's resource)
                if let Ok(parent) = resource.get(urls::PARENT) {
                    if parent.to_string() == *drive_did {
                        return Ok(resource.get_subject().clone());
                    }
                }
            }
        }

        // Strategy 2: Recursive SHORTNAME traversal (hierarchical routing)
        let mut current_subject = drive_did.clone();
        let segments = path.trim_start_matches('/').split('/');

        for segment in segments {
            if segment.is_empty() {
                continue;
            }

            let mut query = Query::new_prop_val(urls::PARENT, current_subject.as_str());
            query.limit = Some(1000); // Reasonable limit for children

            let result = self.query(&query).await?;
            let mut found = None;

            for resource in result.resources {
                if let Ok(sn) = resource.get(urls::SHORTNAME) {
                    if sn.to_string() == segment {
                        found = Some(resource.get_subject().clone());
                        break;
                    }
                }
            }

            current_subject = found.ok_or_else(|| {
                format!(
                    "Could not find segment '{}' in {} (path: {})",
                    segment, current_subject, path
                )
            })?;
        }

        Ok(current_subject)
    }
    #[instrument(skip(self))]
    fn add_atom_to_index(
        &self,
        atom: &Atom,
        resource: &Resource,
        transaction: &mut Transaction,
    ) -> AtomicResult<()> {
        for index_atom in atom.to_indexable_atoms() {
            add_atom_to_valpropsub_index(&index_atom, transaction)?;
            add_atom_to_prop_val_sub_index(&index_atom, transaction)?;
            // Also update the query index to keep collections performant
            check_if_atom_matches_watched_query_filters(
                self,
                &index_atom,
                atom,
                false,
                resource,
                transaction,
            )
            .map_err(|e| format!("Failed to check_if_atom_matches_watched_collections. {}", e))?;
        }
        Ok(())
    }

    fn add_resource_tx(
        &self,
        resource: &Resource,
        transaction: &mut Transaction,
    ) -> AtomicResult<()> {
        let subject = self.normalize_subject(resource.get_subject());
        let subject_str = subject.pure_id();
        let propvals = resource.get_propvals();

        // Persist DID routing hint if available
        if let Subject::Did {
            drive_hint: Some(hint),
            ..
        } = &subject
        {
            transaction.push(Operation {
                tree: Tree::DidMapping,
                method: Method::Insert,
                key: subject_str.as_bytes().to_vec(),
                val: Some(hint.as_bytes().to_vec()),
            });
        }

        let resource_bin = encode_propvals(propvals)?;

        transaction.push(Operation {
            tree: Tree::Resources,
            method: Method::Insert,
            key: subject_str.as_bytes().to_vec(),
            val: Some(resource_bin),
        });
        Ok(())
    }

    #[instrument(skip(self))]
    fn all_index_atoms(&self, include_external: bool) -> IndexIterator {
        Box::new(
            self.all_resources(include_external)
                .flat_map(|resource| {
                    let index_atoms: Vec<IndexAtom> = resource
                        .to_atoms()
                        .iter()
                        .flat_map(|atom| atom.to_indexable_atoms())
                        .collect();
                    index_atoms
                })
                .map(Ok),
        )
    }

    /// Constructs the value index from all resources in the store. Could take a while.
    pub fn build_index(&self, include_external: bool) -> AtomicResult<()> {
        tracing::info!("Building index (this could take a few minutes for larger databases)");
        for (count, r) in self.all_resources(include_external).enumerate() {
            let mut transaction = Transaction::new();
            for atom in r.to_atoms_iter() {
                self.add_atom_to_index(&atom, &r, &mut transaction)
                    .map_err(|e| format!("Failed to add atom to index {}. {}", atom, e))?;
            }
            self.apply_transaction(&mut transaction)
                .map_err(|e| format!("Failed to commit transaction. {}", e))?;

            if count % 1000 == 0 {
                tracing::info!("Building index, applied transaction: {}", count);
            }

            if count % 10000 == 0 {
                tracing::info!("Building index, flushing to disk");
                self.db.flush()?;
            }
        }

        tracing::info!("Building index finished!");
        Ok(())
    }

    /// Internal method for fetching Resource data.
    #[instrument(skip(self))]
    fn set_propvals(&self, subject: &str, propvals: &PropVals) -> AtomicResult<()> {
        let resource_bin = encode_propvals(propvals)?;

        self.resources.insert(subject.as_bytes(), resource_bin)?;
        Ok(())
    }

    /// Sets a function that is called whenever a [Commit::apply] is called.
    /// This can be used to listen to events.
    pub fn set_handle_commit(&mut self, on_commit: HandleCommit) {
        self.on_commit = Some(Arc::new(on_commit));
    }

    /// Finds resource by Subject, return PropVals HashMap
    /// Deals with the binary API of Sled
    #[instrument(skip(self), fields(subject))]
    fn get_propvals(&self, subject: &str) -> AtomicResult<PropVals> {
        let propval_maybe = self
            .resources
            .get(subject.as_bytes())
            .map_err(|e| format!("Can't open {} from store: {}", subject, e))?;
        match propval_maybe.as_ref() {
            Some(binpropval) => {
                let propval: PropVals = decode_propvals(binpropval)?;
                Ok(propval)
            }
            None => Err(AtomicError::not_found(format!(
                "Resource {} not found",
                subject
            ))),
        }
    }

    /// Removes all values from the indexes.
    pub fn clear_index(&self) -> AtomicResult<()> {
        self.reference_index.clear()?;
        self.prop_val_sub_index.clear()?;
        self.query_index.clear()?;
        self.watched_queries.clear()?;
        Ok(())
    }

    /// Flushes the current state to disk.
    pub fn flush(&self) -> AtomicResult<()> {
        self.db
            .flush()
            .map_err(|e| format!("Failed to flush: {}", e).into())
            .map(|_| ())
    }

    /// Removes the DB and all content from disk.
    /// WARNING: This is irreversible.
    pub fn clear_all_danger(self) -> AtomicResult<()> {
        // self.clear_index()?;
        let path = self.path.clone();
        drop(self);
        fs::remove_dir_all(path)?;
        Ok(())
    }

    fn map_sled_item_to_resource(
        item: Result<(sled::IVec, sled::IVec), sled::Error>,
        include_external: bool,
        base_domain: Option<&str>,
    ) -> Option<Resource> {
        let (subject, resource_bin) = item.expect(DB_CORRUPT_MSG);
        let subject: String = String::from_utf8_lossy(&subject).to_string();

        let subject_obj = Subject::from_raw(&subject, base_domain);

        if !include_external && !subject_obj.is_local() {
            return None;
        }

        let propvals: PropVals = decode_propvals(&resource_bin)
            .unwrap_or_else(|e| panic!("{}. {}", corrupt_db_message(&subject), e));

        Some(Resource::from_propvals(propvals, subject_obj))
    }

    pub fn get_plugin_meta(&self, key: &PluginMetaKey) -> AtomicResult<Option<PluginMeta>> {
        let Some(plugin_meta_bin) = self.plugin_meta.get(key.encode()?)? else {
            return Ok(None);
        };
        let plugin_meta = PluginMeta::from_bytes(&plugin_meta_bin)?;

        Ok(Some(plugin_meta))
    }

    pub fn set_plugin_meta(
        &self,
        key: &PluginMetaKey,
        plugin_meta: &PluginMeta,
    ) -> AtomicResult<()> {
        self.plugin_meta
            .insert(key.encode()?, plugin_meta.encode()?)?;
        Ok(())
    }

    pub fn delete_plugin_meta(&self, key: &PluginMetaKey) -> AtomicResult<()> {
        self.plugin_meta.remove(key.encode()?)?;
        Ok(())
    }

    async fn build_index_for_atom(
        &self,
        atom: &IndexAtom,
        query_filter: &QueryFilter,
        transaction: &mut Transaction,
    ) -> AtomicResult<()> {
        // Get the SortableValue either from the Atom or the Resource.
        let sort_val: SortableValue = if let Some(sort) = &query_filter.sort_by {
            if &atom.property == sort {
                atom.sort_value.clone()
            } else {
                // Find the sort value in the store
                match self.get_value(atom.subject.as_str(), sort).await {
                    Ok(val) => val.to_sortable_string(),
                    // If we try sorting on a value that does not exist,
                    // we'll use an empty string as the sortable value.
                    Err(_) => NO_VALUE.to_string(),
                }
            }
        } else {
            atom.sort_value.clone()
        };

        update_indexed_member(
            query_filter,
            atom.subject.as_str(),
            &sort_val,
            false,
            transaction,
        )?;
        Ok(())
    }

    fn get_index_iterator_for_query(&self, q: &Query) -> IndexIterator {
        match (&q.property, q.value.as_ref()) {
            (Some(prop), val) => find_in_prop_val_sub_index(self, prop, val),
            (None, None) => self.all_index_atoms(q.include_external),
            (None, Some(val)) => find_in_val_prop_sub_index(self, val, None),
        }
    }

    /// Apply made changes to the store.
    #[instrument(skip(self))]
    fn apply_transaction(&self, transaction: &mut Transaction) -> AtomicResult<()> {
        let mut batch_resources = sled::Batch::default();
        let mut batch_propvalsub = sled::Batch::default();
        let mut batch_valpropsub = sled::Batch::default();
        let mut batch_watched_queries = sled::Batch::default();
        let mut batch_query_members = sled::Batch::default();
        let mut batch_plugin_meta = sled::Batch::default();
        let mut batch_drive_mapping = sled::Batch::default();
        let mut batch_did_mapping = sled::Batch::default();

        for op in transaction.iter() {
            match op.tree {
                trees::Tree::Resources => match op.method {
                    trees::Method::Insert => {
                        batch_resources.insert::<&[u8], &[u8]>(&op.key, op.val.as_ref().unwrap());
                    }
                    trees::Method::Delete => {
                        batch_resources.remove(op.key.clone());
                    }
                },
                trees::Tree::PropValSub => match op.method {
                    trees::Method::Insert => {
                        batch_propvalsub.insert::<&[u8], &[u8]>(&op.key, op.val.as_ref().unwrap());
                    }
                    trees::Method::Delete => {
                        batch_propvalsub.remove(op.key.clone());
                    }
                },
                trees::Tree::ValPropSub => match op.method {
                    trees::Method::Insert => {
                        batch_valpropsub.insert::<&[u8], &[u8]>(&op.key, op.val.as_ref().unwrap());
                    }
                    trees::Method::Delete => {
                        batch_valpropsub.remove(op.key.clone());
                    }
                },
                trees::Tree::WatchedQueries => match op.method {
                    trees::Method::Insert => {
                        batch_watched_queries
                            .insert::<&[u8], &[u8]>(&op.key, op.val.as_ref().unwrap());
                    }
                    trees::Method::Delete => {
                        batch_watched_queries.remove(op.key.clone());
                    }
                },
                trees::Tree::QueryMembers => match op.method {
                    trees::Method::Insert => {
                        batch_query_members
                            .insert::<&[u8], &[u8]>(&op.key, op.val.as_ref().unwrap());
                    }
                    trees::Method::Delete => {
                        batch_query_members.remove(op.key.clone());
                    }
                },
                trees::Tree::PluginMeta => match op.method {
                    trees::Method::Insert => {
                        batch_plugin_meta.insert::<&[u8], &[u8]>(&op.key, op.val.as_ref().unwrap());
                    }
                    trees::Method::Delete => {
                        batch_plugin_meta.remove(op.key.clone());
                    }
                },
                trees::Tree::DriveMapping => match op.method {
                    trees::Method::Insert => {
                        batch_drive_mapping
                            .insert::<&[u8], &[u8]>(&op.key, op.val.as_ref().unwrap());
                    }
                    trees::Method::Delete => {
                        batch_drive_mapping.remove(op.key.clone());
                    }
                },
                trees::Tree::DidMapping => match op.method {
                    trees::Method::Insert => {
                        batch_did_mapping.insert::<&[u8], &[u8]>(&op.key, op.val.as_ref().unwrap());
                    }
                    trees::Method::Delete => {
                        batch_did_mapping.remove(op.key.clone());
                    }
                },
            }
        }

        (
            &self.resources,
            &self.prop_val_sub_index,
            &self.reference_index,
            &self.watched_queries,
            &self.query_index,
            &self.plugin_meta,
            &self.drive_mapping,
            &self.did_mapping,
        )
            .transaction(
                |(
                    tx_resources,
                    tx_prop_val_sub_index,
                    tx_reference_index,
                    tx_watched_queries,
                    tx_query_index,
                    tx_plugin_meta,
                    tx_drive_mapping,
                    tx_did_mapping,
                )| {
                    tx_resources.apply_batch(&batch_resources)?;
                    tx_prop_val_sub_index.apply_batch(&batch_propvalsub)?;
                    tx_reference_index.apply_batch(&batch_valpropsub)?;
                    tx_watched_queries.apply_batch(&batch_watched_queries)?;
                    tx_query_index.apply_batch(&batch_query_members)?;
                    tx_plugin_meta.apply_batch(&batch_plugin_meta)?;
                    tx_drive_mapping.apply_batch(&batch_drive_mapping)?;
                    tx_did_mapping.apply_batch(&batch_did_mapping)?;
                    Ok::<(), sled::transaction::ConflictableTransactionError<sled::Error>>(())
                },
            )
            .map_err(|e: TransactionError<_>| format!("Failed to apply transaction: {}", e))?;

        Ok(())
    }

    async fn query_basic(&self, q: &Query) -> AtomicResult<QueryResult> {
        let mut subjects: Vec<Subject> = vec![];
        let mut resources: Vec<Resource> = vec![];
        let mut total_count = 0;

        let atoms = self.get_index_iterator_for_query(q);

        for (i, atom_res) in atoms.enumerate() {
            let atom = atom_res?;
            if !q.include_external && !atom.subject.is_local() {
                continue;
            }

            total_count += 1;

            if q.offset > i {
                continue;
            }

            if q.limit.is_none() || subjects.len() < q.limit.unwrap() {
                if !should_include_resource(q) {
                    subjects.push(atom.subject.clone());
                    continue;
                }

                if let Ok(resource) = self
                    .get_resource_extended(&atom.subject.clone(), true, &q.for_agent)
                    .await
                {
                    subjects.push(atom.subject.clone());
                    resources.push(resource.to_single());
                }
            }
        }

        Ok(QueryResult {
            subjects,
            resources,
            count: total_count,
        })
    }

    async fn query_complex(&self, q: &Query) -> AtomicResult<QueryResult> {
        let q_filter = QueryFilter::try_from_query(q)?;
        let (mut subjects, mut resources, mut total_count) =
            query_sorted_indexed(self, q, &q_filter).await?;

        if total_count == 0 && !q_filter.is_watched(self) {
            info!(filter = ?q_filter, "Building query index");
            crate::metrics::query_indexed();
            let atoms = self.get_index_iterator_for_query(q);
            q_filter.watch(self)?;

            let mut transaction = Transaction::new();
            // Build indexes
            for atom in atoms.flatten() {
                self.build_index_for_atom(&atom, &q_filter, &mut transaction)
                    .await?;
            }
            self.apply_transaction(&mut transaction)?;

            // Query through the new indexes.
            (subjects, resources, total_count) =
                query_sorted_indexed(self, q, &q_filter).await?;
        }

        Ok(QueryResult {
            subjects,
            resources,
            count: total_count,
        })
    }

    #[instrument(skip(self))]
    fn remove_atom_from_index(
        &self,
        atom: &Atom,
        resource: &Resource,
        transaction: &mut Transaction,
    ) -> AtomicResult<()> {
        for index_atom in atom.to_indexable_atoms() {
            transaction.push(Operation::remove_atom_from_reference_index(&index_atom));
            transaction.push(Operation::remove_atom_from_prop_val_sub_index(&index_atom));

            check_if_atom_matches_watched_query_filters(
                self,
                &index_atom,
                atom,
                true,
                resource,
                transaction,
            )
            .map_err(|e| format!("Checking atom went wrong: {}", e))?;
        }
        Ok(())
    }

    /// Recursively removes a resource and its children from the database
    async fn recursive_remove(
        &self,
        subject: &Subject,
        transaction: &mut Transaction,
    ) -> AtomicResult<()> {
        let subject_str = subject.to_string();
        if let Ok(found) = self.get_propvals(&subject_str) {
            let resource = Resource::from_propvals(found, subject.clone());
            transaction.push(Operation::remove_resource(&subject_str));
            let mut children = resource.get_children(self).await?;
            for child in children.iter_mut() {
                // Because the function is async we need to box it to use recursion.
                Box::pin(self.recursive_remove(child.get_subject(), transaction)).await?;
            }
            for (prop, val) in resource.get_propvals() {
                let remove_atom = crate::Atom::new(subject.clone(), prop.clone(), val.clone());
                self.remove_atom_from_index(&remove_atom, &resource, transaction)?;
            }
        } else {
            return Err(format!(
                "Resource {} could not be deleted, because it was not found in the store.",
                subject
            )
            .into());
        }
        Ok(())
    }

    fn is_endpoint(&self, url: &url::Url) -> bool {
        self.endpoints.iter().any(|e| e.path == url.path())
    }

    #[tracing::instrument(skip(self))]
    async fn call_endpoint(
        &self,
        subject: &str,
        for_agent: &ForAgent,
    ) -> AtomicResult<ResourceResponse> {
        // For internal endpoint resolution, we use the store's base domain if set.
        let origin = self
            .get_base_domain()
            .unwrap_or_else(|| "http://localhost".to_string());
        let resolved = Subject::from(subject).resolve(&origin);
        let url = url::Url::parse(&resolved)?;

        // Check if the subject matches one of the endpoints
        for endpoint in self.endpoints.iter() {
            if url.path() == endpoint.path {
                // Not all Endpoints have a handle function.
                // If there is none, return the endpoint plainly.
                let response = if let Some(handle) = endpoint.handle {
                    // Call the handle function for the endpoint, if it exists.
                    let context: HandleGetContext = HandleGetContext {
                        subject: url,
                        store: self,
                        for_agent,
                    };
                    (handle)(context).await.map_err(|mut e| {
                        e.message = format!(
                            "Error handling {} Endpoint: {}",
                            endpoint.shortname, e.message
                        );
                        e
                    })?
                } else {
                    endpoint.to_resource_response(self, subject).await?
                };

                // Extended resources must always return the requested subject as their own subject,
                // EXCEPT when the handler returned a resource with its own canonical subject
                // (e.g. the /did proxy endpoint returns DID resources that must keep their DID as @id).
                match response {
                    ResourceResponse::Resource(mut resource) => {
                        if !matches!(resource.get_subject(), Subject::Did { .. }) {
                            resource.set_subject(subject.into());
                        }
                        return Ok(resource.into());
                    }
                    ResourceResponse::ResourceWithReferenced(mut resource, references) => {
                        if !matches!(resource.get_subject(), Subject::Did { .. }) {
                            resource.set_subject(subject.into());
                        }
                        return Ok(ResourceResponse::ResourceWithReferenced(
                            resource, references,
                        ));
                    }
                }
            }
        }

        Err(format!("No endpoint found for {}", subject).into())
    }
}

#[cfg(test)]
mod resolver_tests {
    use super::*;
    use crate::{test_utils::setup_test_env, urls, Resource, Storelike, Value};

    #[tokio::test]
    async fn resolves_root_to_drive_subject() {
        let store = Db::init_temp("resolver_root").await.unwrap();
        setup_test_env(&store).await.unwrap();

        let resolved = store
            .resolve_request_target(
                &Subject::from_raw("/", None),
                "localhost",
                "/",
                "http://localhost",
            )
            .await
            .unwrap();

        assert_eq!(
            resolved.alias_subject,
            Some("http://localhost/".to_string())
        );
        assert!(matches!(resolved.subject, Subject::Did { .. }));
    }

    #[tokio::test]
    async fn resolves_drive_relative_paths_to_canonical_did() {
        let store = Db::init_temp("resolver_path").await.unwrap();
        setup_test_env(&store).await.unwrap();

        let drive_did = store.get_drive_did("localhost").await.unwrap().unwrap();
        let mut resource = Resource::new("did:ad:test-child".into());
        resource.set_unsafe(urls::PARENT.into(), Value::AtomicUrl(drive_did.clone()));
        resource.set_unsafe(urls::SHORTNAME.into(), Value::Slug("about".into()));
        resource.set_unsafe(urls::NAME.into(), Value::String("About".into()));
        store
            .add_resource_opts(&resource, false, true, true)
            .await
            .unwrap();

        let resolved = store
            .resolve_request_target(
                &Subject::from_raw("/about", None),
                "localhost",
                "/about",
                "http://localhost",
            )
            .await
            .unwrap();

        assert_eq!(
            resolved.alias_subject,
            Some("http://localhost/about".to_string())
        );
        assert_eq!(
            resolved.subject.as_str(),
            "did:ad:test-child?drive=".to_string() + drive_did.as_str()
        );
    }
}

impl Drop for Db {
    fn drop(&mut self) {
        match self.db.flush() {
            Ok(..) => (),
            Err(e) => eprintln!("Failed to flush the database: {}", e),
        };
    }
}

#[async_trait]
impl Storelike for Db {
    fn normalize_subject(&self, subject: &Subject) -> Subject {
        Subject::from_raw(subject.as_str(), self.get_base_domain().as_deref())
    }

    /// Adds Atoms to the store.
    /// Will replace existing Atoms that share Subject / Property combination.
    /// Validates datatypes and required props presence.
    #[instrument(skip(self))]
    async fn add_atoms(&self, atoms: Vec<Atom>) -> AtomicResult<()> {
        // Start with a nested HashMap, containing only strings.
        let mut map: HashMap<Subject, Resource> = HashMap::new();
        for atom in atoms {
            match map.get_mut(&atom.subject) {
                // Resource exists in map
                Some(resource) => {
                    resource
                        .set_string(atom.property.clone(), &atom.value.to_string(), self)
                        .await
                        .map_err(|e| format!("Failed adding attom {}. {}", atom, e))?;
                }
                // Resource does not exist
                None => {
                    let mut resource = Resource::new(atom.subject.to_string());
                    resource
                        .set_string(atom.property.clone(), &atom.value.to_string(), self)
                        .await
                        .map_err(|e| format!("Failed adding attom {}. {}", atom, e))?;
                    map.insert(atom.subject, resource);
                }
            }
        }
        for (_subject, resource) in map.iter() {
            self.add_resource(resource).await?
        }
        self.db.flush()?;
        Ok(())
    }

    /// Maps a host (domain/subdomain) to a Drive DID.
    fn add_drive_mapping(&self, host: &str, drive_did: &Value) -> AtomicResult<()> {
        self.add_drive_mapping(host, drive_did)
    }

    /// Removes the drive mapping for a given host.
    fn remove_drive_mapping(&self, host: &str) -> AtomicResult<()> {
        self.remove_drive_mapping(host)
    }

    /// Returns the base domain of the store, e.g. "https://atomicdata.dev".
    fn get_base_domain(&self) -> Option<String> {
        self.base_domain.clone()
    }

    fn set_base_url(&self, _url: &str) {
        // Since Db is mostly immutable and cloned per-request in multi-tenant mode,
        // setting base_url on the original instance might not be what's intended
        // in all cases, but for CLI usage it is.
        // However, we don't have a Mutex for base_domain in Db.
        // Let's just say it's not supported for Db yet if it's not a clone.
        // Actually, for CLI it's usually just initialized once.
        tracing::warn!("set_base_url called on Db, but it is not supported to change it after initialization. Use clone_with_url instead.");
    }

    #[instrument(skip(self, resource), fields(sub = %resource.get_subject()))]
    async fn add_resource_opts(
        &self,
        resource: &Resource,
        check_required_props: bool,
        update_index: bool,
        overwrite_existing: bool,
    ) -> AtomicResult<()> {
        // This only works if no external functions rely on using add_resource for atom-like operations!
        // However, add_atom uses set_propvals, which skips the validation.
        let subject = self.normalize_subject(resource.get_subject());
        let subject_str = subject.pure_id();
        let existing = self.get_propvals(&subject_str).ok();
        if !overwrite_existing && existing.is_some() {
            return Err(format!(
                "Failed to add: '{}', already exists, should not be overwritten.",
                resource.get_subject()
            )
            .into());
        }
        if check_required_props {
            resource.check_required_props(self).await?;
        }
        if update_index {
            let mut transaction = Transaction::new();

            // Persist DID routing hint if available
            if let Subject::Did {
                drive_hint: Some(hint),
                ..
            } = &subject
            {
                transaction.push(Operation {
                    tree: Tree::DidMapping,
                    method: Method::Insert,
                    key: subject_str.as_bytes().to_vec(),
                    val: Some(hint.as_bytes().to_vec()),
                });
            }

            if let Some(pv) = existing {
                let subject = resource.get_subject();
                for (prop, val) in pv.iter() {
                    // Possible performance hit - these clones can be replaced by modifying remove_atom_from_index
                    let remove_atom = crate::Atom::new(subject.clone(), prop.into(), val.clone());
                    self.remove_atom_from_index(&remove_atom, resource, &mut transaction)
                        .map_err(|e| {
                            format!("Failed to remove atom from index {}. {}", remove_atom, e)
                        })?;
                }
            }
            for a in resource.to_atoms() {
                self.add_atom_to_index(&a, resource, &mut transaction)
                    .map_err(|e| format!("Failed to add atom to index {}. {}", a, e))?;
            }
            self.apply_transaction(&mut transaction)?;
        }
        self.set_propvals(&subject_str, resource.get_propvals())
    }

    /// Apply a single signed Commit to the Db.
    /// Creates, edits or destroys a resource.
    /// Allows for control over which validations should be performed.
    /// Returns the generated Commit, the old Resource and the new Resource.
    #[tracing::instrument(skip(self))]
    async fn apply_commit(
        &self,
        commit: Commit,
        opts: &CommitOpts,
    ) -> AtomicResult<CommitResponse> {
        let store = self;

        let commit_response = commit.validate_and_build_response(&opts, store).await?;

        let mut transaction = Transaction::new();

        let mut root_subject: Option<String> = None;

        // BEFORE APPLY COMMIT HANDLERS
        let resource_before = commit_response
            .resource_new
            .as_ref()
            .or(commit_response.resource_old.as_ref());

        if let Some(resource) = resource_before {
            let extenders = self
                .class_extenders
                .read()
                .map_err(|e| format!("Failed to read class extenders: {}", e))?
                .clone();
            for extender in extenders.iter() {
                if extender.resource_has_extender(resource)? {
                    if !extender.can_extend(resource) {
                        continue;
                    }

                    let (is_in_scope, cached_root) =
                        extender.check_scope(resource, self, root_subject).await?;

                    root_subject = cached_root;

                    if !is_in_scope {
                        continue;
                    }

                    let Some(handler) = extender.before_commit.as_ref() else {
                        continue;
                    };

                    let fut = (handler)(CommitExtenderContext {
                        store,
                        commit: &commit_response.commit,
                        resource,
                        is_new: commit_response.resource_old.is_none(),
                    });
                    fut.await?;
                }
            }
        }

        // Save the Commit to the Store. We can skip the required props checking, but we need to make sure the commit hasn't been applied before.
        store.add_resource_tx(&commit_response.commit_resource, &mut transaction)?;
        // We still need to index the Commit!
        for atom in commit_response.commit_resource.to_atoms() {
            store.add_atom_to_index(&atom, &commit_response.commit_resource, &mut transaction)?;
        }

        match (&commit_response.resource_old, &commit_response.resource_new) {
            (None, None) => {
                if !commit_response.commit.destroy.unwrap_or(false) {
                    return Err("Neither an old nor a new resource is returned from the commit - something went wrong.".into());
                }
            }
            (Some(_old), None) => {
                let normalized_commit_subject =
                    self.normalize_subject(&commit_response.commit.subject.clone().into());
                assert_eq!(
                    _old.get_subject().to_string(),
                    normalized_commit_subject.to_string()
                );
                assert!(&commit_response
                    .commit
                    .destroy
                    .expect("Resource was removed but `commit.destroy` was not set!"));
                let subject: Subject = commit_response.commit.subject.clone().into();
                self.remove_resource(&subject).await?;
            }
            _ => {}
        };

        if let Some(new) = &commit_response.resource_new {
            self.add_resource_tx(new, &mut transaction)?;
        }

        if opts.update_index {
            if let Some(old) = &commit_response.resource_old {
                for atom in &commit_response.remove_atoms {
                    store
                        .remove_atom_from_index(atom, old, &mut transaction)
                        .map_err(|e| format!("Error removing atom from index: {e}  Atom: {e}"))?
                }
            }
            if let Some(new) = &commit_response.resource_new {
                for atom in &commit_response.add_atoms {
                    store
                        .add_atom_to_index(atom, new, &mut transaction)
                        .map_err(|e| format!("Error adding atom to index: {e}  Atom: {e}"))?
                }
            }
        }

        store.apply_transaction(&mut transaction)?;

        store.handle_commit(&commit_response);

        // AFTER APPLY COMMIT HANDLERS
        // Commit has been checked and saved.
        // Here you can add side-effects, such as creating new Commits.
        let resource_after = commit_response
            .resource_new
            .as_ref()
            .or(commit_response.resource_old.as_ref());

        if let Some(resource) = resource_after {
            let extenders = self
                .class_extenders
                .read()
                .map_err(|e| format!("Failed to read class extenders: {}", e))?
                .clone();
            for extender in extenders.iter() {
                if extender.resource_has_extender(resource)? {
                    if !extender.can_extend(resource) {
                        continue;
                    }

                    let (is_in_scope, cached_root) =
                        extender.check_scope(resource, self, root_subject).await?;

                    root_subject = cached_root;

                    if !is_in_scope {
                        continue;
                    }

                    use crate::class_extender::CommitExtenderContext;

                    let Some(handler) = extender.after_commit.as_ref() else {
                        continue;
                    };

                    let fut = (handler)(CommitExtenderContext {
                        store,
                        commit: &commit_response.commit,
                        resource,
                        is_new: commit_response.resource_old.is_none(),
                    });
                    fut.await?;
                }
            }
        }
        Ok(commit_response)
    }

    fn get_default_agent(&self) -> AtomicResult<crate::agents::Agent> {
        match self.default_agent.lock().unwrap().to_owned() {
            Some(agent) => Ok(agent),
            None => Err("No default agent has been set.".into()),
        }
    }

    #[instrument(skip(self))]
    async fn get_value(&self, subject: &str, property: &str) -> AtomicResult<Value> {
        self.get_resource(&subject.into())
            .await
            .and_then(|r| r.get(property).cloned())
    }

    #[instrument(skip(self))]
    async fn get_resource(&self, subject: &Subject) -> AtomicResult<Resource> {
        let normalized = self.normalize_subject(subject);
        let subject_str = normalized.pure_id();
        if let Ok(propvals) = self.get_propvals(&subject_str) {
            let mut res_subject = normalized.clone();

            // If it's a DID and we don't have a hint in the requested subject,
            // check if we have one persisted in the did_mapping tree.
            if let Subject::Did {
                drive_hint: None, ..
            } = &res_subject
            {
                if let Ok(Some(hint_bin)) = self.did_mapping.get(subject_str.as_bytes()) {
                    if let Ok(hint) = std::str::from_utf8(&hint_bin) {
                        res_subject = res_subject.set_drive_hint(hint.to_string());
                    }
                }
            }

            let resource = Resource::from_propvals(propvals, res_subject);
            Ok(resource)
        } else {
            // Resolve the subject to a full URL for network operations
            let origin = self
                .get_base_domain()
                .unwrap_or_else(|| "http://localhost".to_string());
            let resolved_url = normalized.resolve(&origin);

            // If the resource is not found, it might be an endpoint.
            // This is checking if the subject matches one of the endpoints
            if let Ok(url) = url::Url::parse(&resolved_url) {
                if self.is_endpoint(&url) {
                    let agent_opt = self.get_default_agent().ok();
                    let for_agent = if let Some(agent) = &agent_opt {
                        ForAgent::from(agent)
                    } else {
                        ForAgent::Public
                    };
                    return Ok(self
                        .call_endpoint(&resolved_url, &for_agent)
                        .await?
                        .to_single());
                }
            }
            let resolved_url = normalized.resolve(&origin);

            if normalized.is_did() || normalized.path().starts_with("/did") {
                // If it's an agent DID and not found locally, return a minimal resource
                // instead of an error. This is important for "just-in-time" agent registration.
                if normalized.is_agent_did() || normalized.path().starts_with("/did:ad:agent:") {
                    let lookup = if normalized.path().starts_with('/') {
                        &normalized.path()[1..]
                    } else {
                        &normalized.path()
                    };
                    if let Some(pubkey) = lookup.strip_prefix("did:ad:agent:") {
                        if let Ok(agent) = crate::agents::Agent::new_from_public_key(pubkey) {
                            if let Ok(resource) = agent.to_resource() {
                                return Ok(resource);
                            }
                        }
                    }
                }

                if normalized.is_did() || resolved_url.starts_with("/did:") {
                    return Err(AtomicError::not_found(format!(
                        "DID Resource {} not found locally",
                        resolved_url
                    )));
                }

                return self
                    .handle_not_found(
                        &resolved_url,
                        format!("Resource {} not found locally", resolved_url).into(),
                        self.get_default_agent().ok().as_ref(),
                    )
                    .await;
            }

            // Only attempt a network fetch for external subjects.
            // Fetching a local URL would cause the server to request itself,
            // creating an infinite loop.
            let resolved_subject_obj =
                Subject::from_raw(&resolved_url, self.get_base_domain().as_deref());
            if resolved_subject_obj.is_local() {
                return self
                    .handle_not_found(
                        &resolved_url,
                        "Not found in DB".into(),
                        self.get_default_agent().ok().as_ref(),
                    )
                    .await;
            }

            if let Ok(resource) = self
                .fetch_resource(&resolved_url, self.get_default_agent().ok().as_ref())
                .await
            {
                // If the resource is external, it's not present in the store.
                // However, we did fetch it (because the user probably requested it).
                // So we should add it to the store.
                // Note that this logic is also in `Store`'s `get_resource`, but it's slightly different there.
                // We should probably unify this.
                // Also, this might cause issues if we want to get a resource but NOT save it.
                self.add_resource_opts(&resource, false, false, true)
                    .await?;
                Ok(resource)
            } else {
                self.handle_not_found(
                    &resolved_url,
                    "Not found in DB".into(),
                    self.get_default_agent().ok().as_ref(),
                )
                .await
            }
        }
    }

    #[instrument(skip(self))]
    async fn get_resource_extended(
        &self,
        subject: &Subject,
        skip_dynamic: bool,
        for_agent: &ForAgent,
    ) -> AtomicResult<ResourceResponse> {
        let subject_without_params = subject.without_params();

        // Get the inner URL for endpoint checking and extender context
        let inner_url = match subject {
            Subject::Internal { url, .. } => url,
            Subject::External(u) => u,
            Subject::Did { url, .. } => url,
        };

        // Check if the subject matches one of the endpoints, if so, call the endpoint.
        let is_endpoint = self.is_endpoint(inner_url);

        if is_endpoint {
            return self.call_endpoint(subject.as_str(), for_agent).await;
        }

        async move {
            let mut resource = self.get_resource(&subject_without_params).await?;

            let _explanation = crate::hierarchy::check_read(self, &resource, for_agent).await?;

            let mut root_subject: Option<String> = None;

            let extenders = self
                .class_extenders
                .read()
                .map_err(|e| format!("Failed to read class extenders: {}", e))?
                .clone();
            for extender in extenders.iter() {
                if !extender.can_extend(&resource) {
                    continue;
                }

                if extender.resource_has_extender(&resource)? {
                    let (is_in_scope, cached_root) =
                        extender.check_scope(&resource, self, root_subject).await?;

                    root_subject = cached_root;

                    if !is_in_scope {
                        continue;
                    }

                    if skip_dynamic {
                        // This lets clients know that the resource may have dynamic properties that are currently not included
                        resource
                            .set(
                                crate::urls::INCOMPLETE.into(),
                                crate::Value::Boolean(true),
                                self,
                            )
                            .await?;

                        return Ok(resource.into());
                    }

                    if let Some(handler) = extender.on_resource_get.as_ref() {
                        let fut = (handler)(GetExtenderContext {
                            store: self,
                            url: inner_url,
                            db_resource: &mut resource,
                            for_agent,
                        });
                        let resource_response = fut.await?;

                        // TODO: Check if we actually need this
                        // make sure the actual subject matches the one requested - It should not be changed in the logic above
                        match resource_response {
                            ResourceResponse::Resource(mut resource) => {
                                resource.set_subject(subject.to_string());
                                return Ok(resource.into());
                            }
                            ResourceResponse::ResourceWithReferenced(mut resource, referenced) => {
                                resource.set_subject(subject.to_string());

                                return Ok(ResourceResponse::ResourceWithReferenced(
                                    resource, referenced,
                                ));
                            }
                        }
                    }
                }
            }

            resource.set_subject(subject.to_string());

            Ok(resource.into())
        }
        .await
    }

    fn handle_commit(&self, commit_response: &CommitResponse) {
        if let Some(fun) = &self.on_commit {
            fun(commit_response);
        }
    }

    /// Search the Store, returns the matching subjects.
    /// The second returned vector should be filled if query.include_resources is true.
    /// Tries `query_cache`, which you should implement yourself.
    #[instrument(skip(self))]
    async fn query(&self, q: &Query) -> AtomicResult<QueryResult> {
        if requires_query_index(q) {
            return self.query_complex(q).await;
        }

        self.query_basic(q).await
    }

    #[instrument(skip(self))]
    fn all_resources(
        &self,
        include_external: bool,
    ) -> Box<dyn std::iter::Iterator<Item = Resource> + Send> {
        let base_domain = self.base_domain.clone();
        let result = self.resources.into_iter().filter_map(move |item| {
            Db::map_sled_item_to_resource(item, include_external, base_domain.as_deref())
        });

        Box::new(result)
    }

    async fn post_resource(
        &self,
        subject: &str,
        body: Vec<u8>,
        for_agent: &ForAgent,
    ) -> AtomicResult<Resource> {
        let endpoints = self.endpoints.iter().filter(|e| e.handle_post.is_some());
        let subj_url = url::Url::try_from(subject)?;
        for e in endpoints {
            if let Some(fun) = &e.handle_post {
                if subj_url.path() == e.path {
                    let handle_post_context = crate::endpoints::HandlePostContext {
                        store: self,
                        body: body.clone(),
                        for_agent,
                        subject: subj_url.clone(),
                    };
                    let mut resource = fun(handle_post_context).await?.to_single();
                    resource.set_subject(subject.into());

                    return Ok(resource);
                }
            }
        }
        // If we get Class Handlers with POST, this is where the code goes
        // let mut r = self.get_resource(subject)?;
        // for class in r.get_classes(self)? {
        //     match class.subject.as_str() {
        //         urls::IMPORTER => {
        //             let query_params = url::Url::try_from(subject)?;
        //             return crate::plugins::importer::construct_importer(
        //                 self,
        //                 query_params.query_pairs(),
        //                 &mut r,
        //                 for_agent,
        //                 Some(body),
        //             );
        //         }
        //         _ => {}
        //     }
        // }
        Err(
            AtomicError::method_not_allowed("Cannot post here - no Endpoint Post handler found")
                .set_subject(subject),
        )
    }

    async fn populate(&self) -> AtomicResult<()> {
        crate::populate::bootstrap(self).await
    }

    #[instrument(skip(self))]
    async fn remove_resource(&self, subject: &Subject) -> AtomicResult<()> {
        let mut transaction = Transaction::new();
        self.recursive_remove(subject, &mut transaction).await?;
        self.apply_transaction(&mut transaction)?;
        Ok(())
    }

    fn set_default_agent(&self, agent: crate::agents::Agent) {
        self.default_agent.lock().unwrap().replace(agent);
    }
}

fn corrupt_db_message(subject: &str) -> String {
    format!("Could not deserialize item {} from database. DB is possibly corrupt, could be due to an update or a lack of migrations. Restore to a previous version, export your data and import your data again.", subject)
}

const DB_CORRUPT_MSG: &str = "Could not deserialize item from database. DB is possibly corrupt, could be due to an update or a lack of migrations. Restore to a previous version, export your data and import your data again.";

impl std::fmt::Debug for Db {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Db")
            .field("base_domain", &self.base_domain)
            .finish()
    }
}
