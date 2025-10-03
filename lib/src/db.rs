//! Persistent, ACID compliant, threadsafe to-disk store.
//! Powered by SQLite with connection pooling - an embedded relational database used as a key-value store.

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
    path::PathBuf,
    sync::Arc,
    time::Duration,
    vec,
};
use parking_lot::Mutex;

use r2d2::Pool;
use r2d2_sqlite::SqliteConnectionManager;
use rusqlite::{params, OptionalExtension};

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
    plugins,
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

// A function called by the Store when a Commit is accepted
type HandleCommit = Box<dyn Fn(&CommitResponse) + Send + Sync>;

/// Inside the reference_index, each value is mapped to this type.
/// The String on the left represents a Property URL, and the second one is the set of subjects.
pub type PropSubjectMap = HashMap<String, HashSet<String>>;

/// The Db is a persistent on-disk Atomic Data store.
/// It's an implementation of [Storelike].
/// It uses SQLite tables as Key Value stores with connection pooling.
/// It stores [Resource]s as [PropVals]s by their subject as key.
/// It builds a value index for performant [Query]s.
/// It keeps track of Queries and updates their index when [crate::Commit]s are applied.
/// You can pass a custom `on_commit` function to run at Commit time.
/// `Db` should be easily, cheaply clone-able, as users of this library could have one `Db` per connection.
#[derive(Clone)]
pub struct Db {
    /// Connection pool to SQLite database
    pool: Pool<SqliteConnectionManager>,
    default_agent: Arc<Mutex<Option<crate::agents::Agent>>>,
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
        // For SQLite, we need a file path, not a directory path
        // If the path doesn't have an extension, add .db
        let db_path = if path.extension().is_none() {
            path.with_extension("db")
        } else {
            path.to_path_buf()
        };

        tracing::info!("Opening SQLite database at {:?}", db_path);

        // Ensure the directory exists
        if let Some(parent) = db_path.parent() {
            fs::create_dir_all(parent)?;
        }

        // Create connection manager and pool
        let manager = SqliteConnectionManager::file(&db_path).with_init(
            |conn: &mut rusqlite::Connection| -> Result<(), rusqlite::Error> {
                configure_sqlite_for_r2d2(conn)?;
                initialize_tables_for_r2d2(conn)?;
                Ok(())
            },
        );

        let pool = Pool::builder()
            .min_idle(Some(5))
            .max_size(50)
            .connection_timeout(Duration::from_secs(5))
            .build(manager)
            .map_err(|e| format!("Failed to create connection pool: {}", e))?;

        let store = Db {
            pool,
            path: db_path,
            default_agent: Arc::new(Mutex::new(None)),
            server_url,
            endpoints: plugins::defaults::default_endpoints(),
            class_extenders: plugins::defaults::default_class_extenders(),
            on_commit: None,
        };

        // Run any necessary migrations
        migrate_maybe(&store).map_err(|e| format!("Error during migration: {:?}", e))?;

        // Populate base models
        crate::populate::populate_base_models(&store)
            .map_err(|e| format!("Failed to populate base models: {}", e))?;

        Ok(store)
    }

    /// Create a temporary Db in `.temp/db/{id}`. Useful for testing.
    /// Populates the database, creates a default agent, and sets the server_url to "http://localhost/".
    pub fn init_temp(id: &str) -> AtomicResult<Db> {
        let tmp_dir_path = format!(".temp/db/{}", id);
        let _try_remove_existing = std::fs::remove_dir_all(&tmp_dir_path);
        fs::create_dir_all(&tmp_dir_path)?;
        let db_path = PathBuf::from(&tmp_dir_path).join("atomic.db");
        let store = Db::init(&db_path, "https://localhost".into())?;
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

        let resource_bin = encode_propvals(propvals)?;

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

    /// Get a database connection from the pool (for internal use by search implementations)
    pub fn get_connection(
        &self,
    ) -> Result<r2d2::PooledConnection<r2d2_sqlite::SqliteConnectionManager>, String> {
        self.pool
            .get()
            .map_err(|e| format!("Failed to get connection: {}", e))
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

            if (count + 1) % 1000 == 0 {
                tracing::info!("Building index, applied transaction: {}", count + 1);
            }

            if (count + 1) % 10000 == 0 {
                tracing::info!("Building index, checkpoint");
                // SQLite handles checkpointing automatically with WAL mode
            }
        }

        tracing::info!("Building index finished!");
        Ok(())
    }

    /// Internal method for fetching Resource data.
    /// Optimized version with connection pooling
    #[instrument(skip(self))]
    fn set_propvals(&self, subject: &str, propvals: &PropVals) -> AtomicResult<()> {
        let resource_bin = encode_propvals(propvals)?;

        let conn = self
            .pool
            .get()
            .map_err(|e| format!("Failed to get connection from pool: {}", e))?;

        // Use prepared statement for better performance
        let mut stmt = conn
            .prepare_cached("INSERT OR REPLACE INTO resources (key, value) VALUES (?1, ?2)")
            .map_err(|e| format!("Failed to prepare statement: {}", e))?;

        stmt.execute(params![subject.as_bytes(), resource_bin])
            .map_err(|e| format!("Failed to set propvals: {}", e))?;

        Ok(())
    }

    /// Sets a function that is called whenever a [Commit::apply] is called.
    /// This can be used to listen to events.
    pub fn set_handle_commit(&mut self, on_commit: HandleCommit) {
        self.on_commit = Some(Arc::new(on_commit));
    }

    /// Finds resource by Subject, return PropVals HashMap
    /// Optimized version with connection pooling
    #[instrument(skip(self), fields(subject))]
    fn get_propvals(&self, subject: &str) -> AtomicResult<PropVals> {
        let conn = self
            .pool
            .get()
            .map_err(|e| format!("Failed to get connection from pool: {}", e))?;

        // Use prepared statement for better performance
        let result = conn
            .prepare_cached("SELECT value FROM resources WHERE key = ?1")
            .and_then(|mut stmt| {
                stmt.query_row(params![subject.as_bytes()], |row| {
                    let value: Vec<u8> = row.get(0)?;
                    Ok(value)
                })
                .optional()
            })
            .map_err(|e| format!("Database query error: {}", e))?;

        match result {
            Some(binpropval) => {
                let propval: PropVals = decode_propvals(&binpropval)?;
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
        let conn = self
            .pool
            .get()
            .map_err(|e| format!("Failed to get connection from pool: {}", e))?;

        conn.execute_batch(
            "
            DELETE FROM prop_val_sub;
            DELETE FROM val_prop_sub;
            DELETE FROM query_members;
            DELETE FROM watched_queries;
        ",
        )
        .map_err(|e| format!("Failed to clear index: {}", e))?;

        Ok(())
    }

    /// Removes the DB and all content from disk.
    /// WARNING: This is irreversible.
    pub fn clear_all_danger(self) -> AtomicResult<()> {
        self.clear_index()?;
        let path = self.path.clone();
        drop(self);
        fs::remove_file(&path)?;
        // Remove SQLite WAL and SHM files if they exist
        let _ = fs::remove_file(path.with_extension("db-wal"));
        let _ = fs::remove_file(path.with_extension("db-shm"));
        if let Some(parent) = path.parent() {
            let _ = fs::remove_dir(parent);
        }
        Ok(())
    }

    /// Helper to get a value from a table by key (restored for compatibility)
    #[allow(dead_code)]
    fn get_table_value(&self, table: &str, key: &[u8]) -> AtomicResult<Option<Vec<u8>>> {
        let conn = self
            .pool
            .get()
            .map_err(|e| format!("Failed to get connection from pool: {}", e))?;
        let query = format!("SELECT value FROM {} WHERE key = ?1", table);

        conn.query_row(&query, params![key], |row| row.get(0))
            .optional()
            .map_err(|e| format!("Failed to get value from {}: {}", table, e).into())
    }

    /// Helper to set a value in a table (restored for compatibility)
    #[allow(dead_code)]
    fn set_table_value(&self, table: &str, key: &[u8], value: &[u8]) -> AtomicResult<()> {
        let conn = self
            .pool
            .get()
            .map_err(|e| format!("Failed to get connection from pool: {}", e))?;
        let query = format!(
            "INSERT OR REPLACE INTO {} (key, value) VALUES (?1, ?2)",
            table
        );

        conn.execute(&query, params![key, value])
            .map_err(|e| format!("Failed to set value in {}: {}", table, e))?;

        Ok(())
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
    /// Optimized version with connection pooling and batch operations
    #[instrument(skip(self))]
    fn apply_transaction(&self, transaction: &mut Transaction) -> AtomicResult<()> {
        // Check if transaction is empty using safe iterator check
        if transaction.iter().next().is_none() {
            return Ok(());
        }

        let mut conn = self
            .pool
            .get()
            .map_err(|e| format!("Failed to get connection from pool: {}", e))?;

        let tx = conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|e| format!("Failed to start transaction: {}", e))?;

        // Group operations by table for batch processing
        let mut resources_ops = Vec::new();
        let mut propvalsub_ops = Vec::new();
        let mut valpropsub_ops = Vec::new();
        let mut watched_queries_ops = Vec::new();
        let mut query_members_ops = Vec::new();

        for op in transaction.iter() {
            match op.tree {
                Tree::Resources => resources_ops.push(op),
                Tree::PropValSub => propvalsub_ops.push(op),
                Tree::ValPropSub => valpropsub_ops.push(op),
                Tree::WatchedQueries => watched_queries_ops.push(op),
                Tree::QueryMembers => query_members_ops.push(op),
            }
        }

        // Process each table's operations in batches
        process_table_operations(&tx, "resources", &resources_ops)?;
        process_table_operations(&tx, "prop_val_sub", &propvalsub_ops)?;
        process_table_operations(&tx, "val_prop_sub", &valpropsub_ops)?;
        process_table_operations(&tx, "watched_queries", &watched_queries_ops)?;
        process_table_operations(&tx, "query_members", &query_members_ops)?;

        tx.commit()
            .map_err(|e| format!("Failed to commit transaction: {}", e))?;

        // Force WAL checkpoint for durability after critical operations
        conn.pragma_update(None, "wal_checkpoint", "TRUNCATE")
            .map_err(|e| format!("Failed to checkpoint WAL: {}", e))?;

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
        // Connection pool handles cleanup automatically
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
        let commit_response = commit.validate_and_build_response(opts, self)?;

        let mut transaction = Transaction::new();

        // BEFORE APPLY COMMIT HANDLERS
        if let Some(resource_new) = &commit_response.resource_new {
            for extender in self.class_extenders.iter() {
                if extender.resource_has_extender(resource_new)? {
                    let Some(handler) = extender.before_commit else {
                        continue;
                    };

                    (handler)(CommitExtenderContext {
                        store: self,
                        commit: &commit_response.commit,
                        resource: resource_new,
                    })?;
                }
            }
        }

        // Save the Commit to the Store. We can skip the required props checking, but we need to make sure the commit hasn't been applied before.
        self.add_resource_tx(&commit_response.commit_resource, &mut transaction)?;
        // We still need to index the Commit!
        for atom in commit_response.commit_resource.to_atoms() {
            self.add_atom_to_index(&atom, &commit_response.commit_resource, &mut transaction)?;
        }

        match (&commit_response.resource_old, &commit_response.resource_new) {
            (None, None) => {
                return Err("Neither an old nor a new resource is returned from the commit - something went wrong.".into())
            },
            (Some(_old), None) => {
                assert_eq!(_old.get_subject(), &commit_response.commit.subject);
                assert!(&commit_response.commit.destroy.expect("Resource was removed but `commit.destroy` was not set!"));
                self.recursive_remove(&commit_response.commit.subject, &mut transaction)?;
            },
            _ => {}
        };

        if let Some(new) = &commit_response.resource_new {
            self.add_resource_tx(new, &mut transaction)?;
        }

        if opts.update_index {
            if let Some(old) = &commit_response.resource_old {
                for atom in &commit_response.remove_atoms {
                    self.remove_atom_from_index(atom, old, &mut transaction)
                        .map_err(|e| format!("Error removing atom from index: {e}  Atom: {e}"))?
                }
            }
            if let Some(new) = &commit_response.resource_new {
                for atom in &commit_response.add_atoms {
                    self.add_atom_to_index(atom, new, &mut transaction)
                        .map_err(|e| format!("Error adding atom to index: {e}  Atom: {e}"))?
                }
            }
        }

        self.apply_transaction(&mut transaction)?;

        self.handle_commit(&commit_response);

        // AFTER APPLY COMMIT HANDLERS
        if let Some(resource_new) = &commit_response.resource_new {
            for extender in self.class_extenders.iter() {
                if extender.resource_has_extender(resource_new)? {
                    use crate::class_extender::CommitExtenderContext;

                    let Some(handler) = extender.after_commit else {
                        continue;
                    };

                    (handler)(CommitExtenderContext {
                        store: self,
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
        match self.default_agent.lock().to_owned() {
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

        let conn = match self.pool.get() {
            Ok(conn) => conn,
            Err(e) => {
                tracing::error!("Failed to get connection for all_resources: {}", e);
                return Box::new(std::iter::empty());
            }
        };

        // Query all resources from the database with prepared statement caching
        let mut stmt = conn
            .prepare("SELECT key, value FROM resources")
            .expect("Failed to prepare statement");

        let resource_iter = stmt
            .query_map([], |row| {
                let key: Vec<u8> = row.get(0)?;
                let value: Vec<u8> = row.get(1)?;
                Ok((key, value))
            })
            .expect("Failed to query resources");

        // Convert the result into a vec to avoid lifetime issues
        let resources: Vec<Resource> = resource_iter
            .filter_map(|item| {
                let (key, value) = item.ok()?;
                let subject = String::from_utf8(key).ok()?;

                if !include_external && !subject.starts_with(&self_url) {
                    return None;
                }

                let propvals: PropVals = decode_propvals(&value).ok()?;
                Some(Resource::from_propvals(propvals, subject))
            })
            .collect();

        Box::new(resources.into_iter())
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
        *self.default_agent.lock() = Some(agent);
    }
}

/// Process operations for a specific table in batches for better performance
fn process_table_operations(
    tx: &rusqlite::Transaction,
    table_name: &str,
    operations: &[&Operation],
) -> AtomicResult<()> {
    if operations.is_empty() {
        return Ok(());
    }

    // Prepare statements once per batch
    let insert_sql = format!(
        "INSERT OR REPLACE INTO {} (key, value) VALUES (?1, ?2)",
        table_name
    );
    let delete_sql = format!("DELETE FROM {} WHERE key = ?1", table_name);

    let mut insert_stmt = tx
        .prepare_cached(&insert_sql)
        .map_err(|e| format!("Failed to prepare insert for {}: {}", table_name, e))?;
    let mut delete_stmt = tx
        .prepare_cached(&delete_sql)
        .map_err(|e| format!("Failed to prepare delete for {}: {}", table_name, e))?;

    for op in operations {
        match op.method {
            Method::Insert => {
                insert_stmt
                    .execute(params![&op.key, op.val.as_ref().unwrap()])
                    .map_err(|e| format!("Failed to insert into {}: {}", table_name, e))?;
            }
            Method::Delete => {
                delete_stmt
                    .execute(params![&op.key])
                    .map_err(|e| format!("Failed to delete from {}: {}", table_name, e))?;
            }
        }
    }

    Ok(())
}

/// Configure SQLite for optimal performance (for r2d2 init)
fn configure_sqlite_for_r2d2(conn: &mut rusqlite::Connection) -> Result<(), rusqlite::Error> {
    // Enable WAL mode for concurrent readers
    conn.pragma_update(None, "journal_mode", "WAL")?;
    
    // Set synchronous=NORMAL for much faster writes (safe with WAL mode)
    conn.pragma_update(None, "synchronous", "NORMAL")?;

    // Memory-mapped I/O for faster reads (2GB for reduced syscalls)
    conn.pragma_update(None, "mmap_size", 2147483647)?;

    // Larger page size for blob storage (8KB for better blob performance)
    conn.pragma_update(None, "page_size", 8192)?;

    // Aggressive caching (128MB)
    conn.pragma_update(None, "cache_size", -131072)?;

    // Keep temporary indices in memory
    conn.pragma_update(None, "temp_store", "MEMORY")?;

    // Optimize WAL checkpointing for performance (much less frequent to avoid lock contention)
    conn.pragma_update(None, "wal_autocheckpoint", 10000)?;
    
    // Limit WAL file size to prevent bloat (6MB)
    conn.pragma_update(None, "journal_size_limit", 6144000)?;

    // Enable query planner optimizations (best effort, ignore failures)
    let _ = conn.execute_batch("PRAGMA optimize;");

    // Additional performance optimizations
    // Increase lookaside memory for better allocation performance
    let _ = conn.execute("PRAGMA lookaside=1024,128", []);
    
    // Optimize busy timeout for concurrent access (fail faster for better debugging)
    conn.pragma_update(None, "busy_timeout", 10000)?; // 10 seconds
    
    // Collect optimizer statistics for better query planning
    let _ = conn.execute("ANALYZE", []);

    Ok(())
}

/// Initialize SQLite tables for each tree structure (for r2d2 init)
fn initialize_tables_for_r2d2(conn: &mut rusqlite::Connection) -> Result<(), rusqlite::Error> {
    conn.execute_batch(
        "
        -- Main resources table
        CREATE TABLE IF NOT EXISTS resources (
            key BLOB PRIMARY KEY,
            value BLOB NOT NULL
        ) WITHOUT ROWID;
        
        -- Property-Value-Subject index
        CREATE TABLE IF NOT EXISTS prop_val_sub (
            key BLOB PRIMARY KEY,
            value BLOB NOT NULL
        ) WITHOUT ROWID;
        
        -- Value-Property-Subject index (reference index)
        CREATE TABLE IF NOT EXISTS val_prop_sub (
            key BLOB PRIMARY KEY,
            value BLOB NOT NULL
        ) WITHOUT ROWID;
        
        -- Query members index
        CREATE TABLE IF NOT EXISTS query_members (
            key BLOB PRIMARY KEY,
            value BLOB NOT NULL
        ) WITHOUT ROWID;
        
        -- Watched queries
        CREATE TABLE IF NOT EXISTS watched_queries (
            key BLOB PRIMARY KEY,
            value BLOB NOT NULL
        ) WITHOUT ROWID;
        
        -- FTS5 search index table for full-text search
        CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5(
            subject UNINDEXED,
            title,
            description,
            propvals_json,
            hierarchy,
            tokenize='porter unicode61'
        );
        
        -- FST index table for fuzzy search
        CREATE TABLE IF NOT EXISTS fst_index (
            term TEXT PRIMARY KEY,
            fst_data BLOB
        );
        
        -- Search metadata table
        CREATE TABLE IF NOT EXISTS search_metadata (
            key TEXT PRIMARY KEY,
            value TEXT
        );
    ",
    )?;

    Ok(())
}

/// Configure SQLite for optimal performance
#[allow(dead_code)]
fn configure_sqlite(
    conn: &rusqlite::Connection,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    // Enable WAL mode for concurrent readers
    conn.pragma_update(None, "journal_mode", "WAL")?;
    
    // Set synchronous=NORMAL for much faster writes (safe with WAL mode)
    conn.pragma_update(None, "synchronous", "NORMAL")?;

    // Memory-mapped I/O for faster reads (2GB for reduced syscalls)
    conn.pragma_update(None, "mmap_size", 2147483647)?;

    // Larger page size for blob storage (8KB for better blob performance)
    conn.pragma_update(None, "page_size", 8192)?;

    // Aggressive caching (128MB)
    conn.pragma_update(None, "cache_size", -131072)?;

    // Keep temporary indices in memory
    conn.pragma_update(None, "temp_store", "MEMORY")?;

    // Optimize WAL checkpointing for performance (much less frequent to avoid lock contention)
    conn.pragma_update(None, "wal_autocheckpoint", 10000)?;
    
    // Limit WAL file size to prevent bloat (6MB)
    conn.pragma_update(None, "journal_size_limit", 6144000)?;

    // Enable query planner optimizations (best effort, ignore failures)
    let _ = conn.execute_batch("PRAGMA optimize;");

    // Additional performance optimizations
    // Increase lookaside memory for better allocation performance
    let _ = conn.execute("PRAGMA lookaside=1024,128", []);
    
    // Optimize busy timeout for concurrent access (fail faster for better debugging)
    conn.pragma_update(None, "busy_timeout", 10000)?; // 10 seconds
    
    // Collect optimizer statistics for better query planning
    let _ = conn.execute("ANALYZE", []);

    Ok(())
}

/// Initialize SQLite tables for each tree structure
#[allow(dead_code)]
fn initialize_tables(
    conn: &rusqlite::Connection,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    conn.execute_batch(
        "
        -- Main resources table
        CREATE TABLE IF NOT EXISTS resources (
            key BLOB PRIMARY KEY,
            value BLOB NOT NULL
        ) WITHOUT ROWID;
        
        -- Property-Value-Subject index
        CREATE TABLE IF NOT EXISTS prop_val_sub (
            key BLOB PRIMARY KEY,
            value BLOB NOT NULL
        ) WITHOUT ROWID;
        
        -- Value-Property-Subject index (reference index)
        CREATE TABLE IF NOT EXISTS val_prop_sub (
            key BLOB PRIMARY KEY,
            value BLOB NOT NULL
        ) WITHOUT ROWID;
        
        -- Query members index
        CREATE TABLE IF NOT EXISTS query_members (
            key BLOB PRIMARY KEY,
            value BLOB NOT NULL
        ) WITHOUT ROWID;
        
        -- Watched queries
        CREATE TABLE IF NOT EXISTS watched_queries (
            key BLOB PRIMARY KEY,
            value BLOB NOT NULL
        ) WITHOUT ROWID;
    ",
    )?;

    Ok(())
}

impl std::fmt::Debug for Db {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Db")
            .field("server_url", &self.server_url)
            .field("path", &self.path)
            .field("pool_state", &self.pool.state())
            .finish()
    }
}

#[cfg(test)]
mod tests_sqlite_config;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_db_debug_format() {
        let temp_dir = tempfile::TempDir::new().unwrap();
        let db_path = temp_dir.path().join("debug_test.db");
        let store = Db::init(&db_path, "http://localhost".to_string()).unwrap();

        let debug_str = format!("{:?}", store);
        assert!(debug_str.contains("Db"));
        assert!(debug_str.contains("server_url"));
        assert!(debug_str.contains("http://localhost"));
    }
}
