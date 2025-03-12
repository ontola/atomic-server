//! Persistent, ACID compliant, threadsafe to-disk store.
//! Powered by Sled - an embedded database.

mod encoding;
mod migrations;
mod prop_val_sub_index;
mod query_index;
#[cfg(test)]
pub mod test;
mod trees;
mod v1_types;
mod val_prop_sub_index;

use std::{
    collections::{HashMap, HashSet},
    fs,
    sync::{Arc, Mutex},
    vec,
};

use crate::{
    agents::ForAgent,
    atoms::IndexAtom,
    class_extender::{ClassExtender, CommitExtenderContext, GetExtenderContext},
    commit::{CommitOpts, CommitResponse},
    db::{
        encoding::{decode_propvals, encode_propvals},
        query_index::{requires_query_index, NO_VALUE},
        val_prop_sub_index::find_in_val_prop_sub_index,
    },
    endpoints::{Endpoint, HandleGetContext},
    errors::{AtomicError, AtomicResult},
    plugins::plugins,
    resources::PropVals,
    storelike::{Query, QueryResult, ResourceResponse, Storelike},
    values::SortableValue,
    Atom, Commit, Resource,
};
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
    /// Stores all resources. The Key is the Subject as a `string.as_bytes()`, the value a [PropVals]. Propvals must be serialized using [bincode].
    resources: sled::Tree,
    /// [Tree::ValPropSub]
    reference_index: sled::Tree,
    /// [Tree::PropValSub]
    prop_val_sub_index: sled::Tree,
    /// [Tree::QueryMembers]
    query_index: sled::Tree,
    /// [Tree::WatchedQueries]
    watched_queries: sled::Tree,
    /// The address where the db will be hosted, e.g. http://localhost/
    server_url: String,
    /// Endpoints are checked whenever a resource is requested. They calculate (some properties of) the resource and return it.
    endpoints: Vec<Endpoint>,
    /// List of class extenders.
    class_extenders: Vec<ClassExtender>,
    /// Function called whenever a Commit is applied.
    on_commit: Option<Arc<HandleCommit>>,
    /// Where the DB is stored on disk.
    path: std::path::PathBuf,
}

impl Db {
    /// Creates a new store at the specified path, or opens the store if it already exists.
    /// The server_url is the domain where the db will be hosted, e.g. http://localhost/
    /// It is used for distinguishing locally defined items from externally defined ones.
    pub fn init(path: &std::path::Path, server_url: String) -> AtomicResult<Db> {
        tracing::info!("Opening database at {:?}", path);

        let db = sled::open(path).map_err(|e|format!("Failed opening DB at this location: {:?} . Is another instance of Atomic Server running? {}", path, e))?;
        let resources = db.open_tree(Tree::Resources).map_err(|e| format!("Failed building resources. Your DB might be corrupt. Go back to a previous version and export your data. {}", e))?;
        let reference_index = db.open_tree(Tree::ValPropSub)?;
        let query_index = db.open_tree(Tree::QueryMembers)?;
        let prop_val_sub_index = db.open_tree(Tree::PropValSub)?;
        let watched_queries = db.open_tree(Tree::WatchedQueries)?;
        let store = Db {
            path: path.into(),
            db,
            default_agent: Arc::new(Mutex::new(None)),
            resources,
            reference_index,
            query_index,
            prop_val_sub_index,
            server_url,
            watched_queries,
            endpoints: plugins::default_endpoints(),
            class_extenders: plugins::default_class_extenders(),
            on_commit: None,
        };
        migrate_maybe(&store).map(|e| format!("Error during migration of database: {:?}", e))?;
        crate::populate::populate_base_models(&store)
            .map_err(|e| format!("Failed to populate base models. {}", e))?;
        Ok(store)
    }

    /// Create a temporary Db in `.temp/db/{id}`. Useful for testing.
    /// Populates the database, creates a default agent, and sets the server_url to "http://localhost/".
    pub fn init_temp(id: &str) -> AtomicResult<Db> {
        let tmp_dir_path = format!(".temp/db/{}", id);
        let _try_remove_existing = std::fs::remove_dir_all(&tmp_dir_path);
        let store = Db::init(
            std::path::Path::new(&tmp_dir_path),
            "https://localhost".into(),
        )?;
        let agent = store.create_agent(None)?;
        store.set_default_agent(agent);
        store.populate()?;
        Ok(store)
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
        let subject = resource.get_subject();
        let propvals = resource.get_propvals();

        let resource_bin = encode_propvals(&propvals)?;

        transaction.push(Operation {
            tree: Tree::Resources,
            method: Method::Insert,
            key: subject.as_bytes().to_vec(),
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
        let mut count = 0;

        for r in self.all_resources(include_external) {
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

            count += 1;
        }

        tracing::info!("Building index finished!");
        Ok(())
    }

    /// Internal method for fetching Resource data.
    #[instrument(skip(self))]
    fn set_propvals(&self, subject: &str, propvals: &PropVals) -> AtomicResult<()> {
        let resource_bin = encode_propvals(&propvals)?;

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
            None => {
                return Err(AtomicError::not_found(format!(
                    "Resource {} not found",
                    subject
                )))
            }
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

    /// Removes the DB and all content from disk.
    /// WARNING: This is irreversible.
    pub fn clear_all_danger(self) -> AtomicResult<()> {
        self.clear_index()?;
        let path = self.path.clone();
        drop(self);
        fs::remove_dir_all(path)?;
        Ok(())
    }

    fn map_sled_item_to_resource(
        item: Result<(sled::IVec, sled::IVec), sled::Error>,
        self_url: String,
        include_external: bool,
    ) -> Option<Resource> {
        let (subject, resource_bin) = item.expect(DB_CORRUPT_MSG);
        let subject: String = String::from_utf8_lossy(&subject).to_string();

        if !include_external && !subject.starts_with(&self_url) {
            return None;
        }

        let propvals: PropVals = decode_propvals(&resource_bin)
            .unwrap_or_else(|e| panic!("{}. {}", corrupt_db_message(&subject), e));

        Some(Resource::from_propvals(propvals, subject))
    }

    fn build_index_for_atom(
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
                match self.get_value(&atom.subject, sort) {
                    Ok(val) => val.to_sortable_string(),
                    // If we try sorting on a value that does not exist,
                    // we'll use an empty string as the sortable value.
                    Err(_) => NO_VALUE.to_string(),
                }
            }
        } else {
            atom.sort_value.clone()
        };

        update_indexed_member(query_filter, &atom.subject, &sort_val, false, transaction)?;
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
            }
        }

        (
            &self.resources,
            &self.prop_val_sub_index,
            &self.reference_index,
            &self.watched_queries,
            &self.query_index,
        )
            .transaction(
                |(
                    tx_resources,
                    tx_prop_val_sub_index,
                    tx_reference_index,
                    tx_watched_queries,
                    tx_query_index,
                )| {
                    tx_resources.apply_batch(&batch_resources)?;
                    tx_prop_val_sub_index.apply_batch(&batch_propvalsub)?;
                    tx_reference_index.apply_batch(&batch_valpropsub)?;
                    tx_watched_queries.apply_batch(&batch_watched_queries)?;
                    tx_query_index.apply_batch(&batch_query_members)?;
                    Ok::<(), sled::transaction::ConflictableTransactionError<sled::Error>>(())
                },
            )
            .map_err(|e: TransactionError<_>| format!("Failed to apply transaction: {}", e))?;

        Ok(())
    }

    fn query_basic(&self, q: &Query) -> AtomicResult<QueryResult> {
        let self_url = self
            .get_self_url()
            .ok_or("No self_url set, required for Queries")?;

        let mut subjects: Vec<String> = vec![];
        let mut resources: Vec<Resource> = vec![];
        let mut total_count = 0;

        let atoms = self.get_index_iterator_for_query(q);

        for (i, atom_res) in atoms.enumerate() {
            let atom = atom_res?;
            if !q.include_external && !atom.subject.starts_with(&self_url) {
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

                if let Ok(resource) = self.get_resource_extended(&atom.subject, true, &q.for_agent)
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

    fn query_complex(&self, q: &Query) -> AtomicResult<QueryResult> {
        let (mut subjects, mut resources, mut total_count) = query_sorted_indexed(self, q)?;
        let q_filter: QueryFilter = q.into();

        if total_count == 0 && !q_filter.is_watched(self) {
            info!(filter = ?q_filter, "Building query index");
            let atoms = self.get_index_iterator_for_query(q);
            q_filter.watch(self)?;

            let mut transaction = Transaction::new();
            // Build indexes
            for atom in atoms.flatten() {
                self.build_index_for_atom(&atom, &q_filter, &mut transaction)?;
            }
            self.apply_transaction(&mut transaction)?;

            // Query through the new indexes.
            (subjects, resources, total_count) = query_sorted_indexed(self, q)?;
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
    fn recursive_remove(&self, subject: &str, transaction: &mut Transaction) -> AtomicResult<()> {
        if let Ok(found) = self.get_propvals(subject) {
            let resource = Resource::from_propvals(found, subject.to_string());
            transaction.push(Operation::remove_resource(subject));
            let mut children = resource.get_children(self)?;
            for child in children.iter_mut() {
                self.recursive_remove(child.get_subject(), transaction)?;
            }
            for (prop, val) in resource.get_propvals() {
                let remove_atom = crate::Atom::new(subject.into(), prop.clone(), val.clone());
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
    fn call_endpoint(&self, subject: &str, for_agent: &ForAgent) -> AtomicResult<ResourceResponse> {
        let url = url::Url::parse(subject)?;

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
                    (handle)(context).map_err(|e| {
                        format!("Error handling {} Endpoint: {}", endpoint.shortname, e)
                    })?
                } else {
                    endpoint.to_resource_response(self)?
                };

                // Extended resources must always return the requested subject as their own subject
                match response {
                    ResourceResponse::Resource(mut resource) => {
                        resource.set_subject(subject.into());
                        return Ok(resource.into());
                    }
                    ResourceResponse::ResourceWithReferenced(mut resource, references) => {
                        resource.set_subject(subject.into());
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

impl Drop for Db {
    fn drop(&mut self) {
        match self.db.flush() {
            Ok(..) => (),
            Err(e) => eprintln!("Failed to flush the database: {}", e),
        };
    }
}

impl Storelike for Db {
    #[instrument(skip(self))]
    fn add_atoms(&self, atoms: Vec<Atom>) -> AtomicResult<()> {
        // Start with a nested HashMap, containing only strings.
        let mut map: HashMap<String, Resource> = HashMap::new();
        for atom in atoms {
            match map.get_mut(&atom.subject) {
                // Resource exists in map
                Some(resource) => {
                    resource
                        .set_string(atom.property.clone(), &atom.value.to_string(), self)
                        .map_err(|e| format!("Failed adding attom {}. {}", atom, e))?;
                }
                // Resource does not exist
                None => {
                    let mut resource = Resource::new(atom.subject.clone());
                    resource
                        .set_string(atom.property.clone(), &atom.value.to_string(), self)
                        .map_err(|e| format!("Failed adding attom {}. {}", atom, e))?;
                    map.insert(atom.subject, resource);
                }
            }
        }
        for (_subject, resource) in map.iter() {
            self.add_resource(resource)?
        }
        self.db.flush()?;
        Ok(())
    }

    #[instrument(skip(self, resource), fields(sub = %resource.get_subject()))]
    fn add_resource_opts(
        &self,
        resource: &Resource,
        check_required_props: bool,
        update_index: bool,
        overwrite_existing: bool,
    ) -> AtomicResult<()> {
        // This only works if no external functions rely on using add_resource for atom-like operations!
        // However, add_atom uses set_propvals, which skips the validation.
        let existing = self.get_propvals(resource.get_subject()).ok();
        if !overwrite_existing && existing.is_some() {
            return Err(format!(
                "Failed to add: '{}', already exists, should not be overwritten.",
                resource.get_subject()
            )
            .into());
        }
        if check_required_props {
            resource.check_required_props(self)?;
        }
        if update_index {
            let mut transaction = Transaction::new();
            if let Some(pv) = existing {
                let subject = resource.get_subject();
                for (prop, val) in pv.iter() {
                    // Possible performance hit - these clones can be replaced by modifying remove_atom_from_index
                    let remove_atom = crate::Atom::new(subject.into(), prop.into(), val.clone());
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
        self.set_propvals(resource.get_subject(), resource.get_propvals())
    }

    /// Apply a single signed Commit to the Db.
    /// Creates, edits or destroys a resource.
    /// Allows for control over which validations should be performed.
    /// Returns the generated Commit, the old Resource and the new Resource.
    #[tracing::instrument(skip(self))]
    fn apply_commit(&self, commit: Commit, opts: &CommitOpts) -> AtomicResult<CommitResponse> {
        let store = self;

        let commit_response = commit.validate_and_build_response(opts, store)?;

        let mut transaction = Transaction::new();

        // BEFORE APPLY COMMIT HANDLERS
        if let Some(resource_new) = &commit_response.resource_new {
            for extender in self.class_extenders.iter() {
                if extender.resource_has_extender(resource_new)? {
                    let Some(handler) = extender.before_commit else {
                        continue;
                    };

                    (handler)(CommitExtenderContext {
                        store,
                        commit: &commit_response.commit,
                        resource: resource_new,
                    })?;
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
                return Err("Neither an old nor a new resource is returned from the commit - something went wrong.".into())
            },
            (Some(_old), None) => {
                assert_eq!(_old.get_subject(), &commit_response.commit.subject);
                assert!(&commit_response.commit.destroy.expect("Resource was removed but `commit.destroy` was not set!"));
                self.remove_resource(&commit_response.commit.subject)?;
            },
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
        if let Some(resource_new) = &commit_response.resource_new {
            for extender in self.class_extenders.iter() {
                if extender.resource_has_extender(resource_new)? {
                    use crate::class_extender::CommitExtenderContext;

                    let Some(handler) = extender.after_commit else {
                        continue;
                    };

                    (handler)(CommitExtenderContext {
                        store,
                        commit: &commit_response.commit,
                        resource: resource_new,
                    })?;
                }
            }
        }
        Ok(commit_response)
    }

    fn get_server_url(&self) -> AtomicResult<String> {
        Ok(self.server_url.clone())
    }

    // Since the DB is often also the server, this should make sense.
    // Some edge cases might appear later on (e.g. a slave DB that only stores copies?)
    fn get_self_url(&self) -> Option<String> {
        self.get_server_url().ok()
    }

    fn get_default_agent(&self) -> AtomicResult<crate::agents::Agent> {
        match self.default_agent.lock().unwrap().to_owned() {
            Some(agent) => Ok(agent),
            None => Err("No default agent has been set.".into()),
        }
    }

    #[instrument(skip(self))]
    fn get_resource(&self, subject: &str) -> AtomicResult<Resource> {
        match self.get_propvals(subject) {
            Ok(propvals) => {
                let resource = crate::resources::Resource::from_propvals(propvals, subject.into());
                Ok(resource)
            }
            Err(e) => {
                tracing::error!("Error getting resource: {:?}", e);
                self.handle_not_found(subject, e, None)
            }
        }
    }

    #[instrument(skip(self))]
    fn get_resource_extended(
        &self,
        subject: &str,
        skip_dynamic: bool,
        for_agent: &ForAgent,
    ) -> AtomicResult<ResourceResponse> {
        let url_span = tracing::span!(tracing::Level::TRACE, "URL parse").entered();
        // This might add a trailing slash
        let url = url::Url::parse(subject)?;
        let mut removed_query_params = {
            let mut url_altered = url.clone();
            url_altered.set_query(None);
            url_altered.to_string()
        };

        // Remove trailing slash
        if removed_query_params.ends_with('/') {
            removed_query_params.pop();
        }

        url_span.exit();

        let endpoint_span = tracing::span!(tracing::Level::TRACE, "Endpoint").entered();

        // Check if the subject matches one of the endpoints, if so, call the endpoint.
        if self.is_endpoint(&url) {
            return self.call_endpoint(subject, for_agent);
        }

        endpoint_span.exit();

        let dynamic_span =
            tracing::span!(tracing::Level::TRACE, "get_resource_extended (dynamic)").entered();

        let mut resource = self.get_resource(&removed_query_params)?;

        let _explanation = crate::hierarchy::check_read(self, &resource, for_agent)?;

        // If a certain class needs to be extended, add it to this match statement
        for extender in self.class_extenders.iter() {
            if extender.resource_has_extender(&resource)? {
                if skip_dynamic {
                    // This lets clients know that the resource may have dynamic properties that are currently not included
                    resource.set(
                        crate::urls::INCOMPLETE.into(),
                        crate::Value::Boolean(true),
                        self,
                    )?;

                    dynamic_span.exit();
                    return Ok(resource.into());
                }

                if let Some(handler) = extender.on_resource_get {
                    let resource_response = (handler)(GetExtenderContext {
                        store: self,
                        url: &url,
                        db_resource: &mut resource,
                        for_agent,
                    })?;

                    dynamic_span.exit();

                    // TODO: Check if we actually need this
                    // make sure the actual subject matches the one requested - It should not be changed in the logic above
                    match resource_response {
                        ResourceResponse::Resource(mut resource) => {
                            resource.set_subject(subject.into());
                            return Ok(resource.into());
                        }
                        ResourceResponse::ResourceWithReferenced(mut resource, referenced) => {
                            resource.set_subject(subject.into());

                            return Ok(ResourceResponse::ResourceWithReferenced(
                                resource, referenced,
                            ));
                        }
                    }
                }
            }
        }

        resource.set_subject(subject.into());

        Ok(resource.into())
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
    fn query(&self, q: &Query) -> AtomicResult<QueryResult> {
        if requires_query_index(q) {
            return self.query_complex(q);
        }

        self.query_basic(q)
    }

    #[instrument(skip(self))]
    fn all_resources(
        &self,
        include_external: bool,
    ) -> Box<dyn std::iter::Iterator<Item = Resource>> {
        let self_url = self
            .get_self_url()
            .expect("No self URL set, is required in DB");

        let result = self.resources.into_iter().filter_map(move |item| {
            Db::map_sled_item_to_resource(item, self_url.clone(), include_external)
        });

        Box::new(result)
    }

    fn post_resource(
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
                        body,
                        for_agent,
                        subject: subj_url,
                    };
                    let mut resource = fun(handle_post_context)?.to_single();
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

    fn populate(&self) -> AtomicResult<()> {
        crate::populate::populate_all(self)
    }

    #[instrument(skip(self))]
    fn remove_resource(&self, subject: &str) -> AtomicResult<()> {
        let mut transaction = Transaction::new();

        self.recursive_remove(subject, &mut transaction)?;

        self.apply_transaction(&mut transaction)
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
            .field("server_url", &self.server_url)
            .finish()
    }
}
