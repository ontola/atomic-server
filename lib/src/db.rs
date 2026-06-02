//! Persistent, ACID compliant, threadsafe to-disk store.
//! Powered by Sled - an embedded database.

pub mod btreemap_store;
mod encoding;
pub mod kv_store;
#[cfg(feature = "db-sled")]
mod migrations;
#[cfg(all(feature = "db-redb", target_arch = "wasm32"))]
pub mod opfs_backend;
pub mod plugin_meta;
mod prop_val_sub_index;
mod query_index;
#[cfg(feature = "db-redb")]
pub mod redb_store;
pub use query_index::{drive_prefix_from_subject, QueryFilter};
#[cfg(feature = "db-sled")]
pub mod sled_store;
#[cfg(test)]
pub mod test;
pub mod trees;
#[cfg(feature = "db-sled")]
mod v1_types;
#[cfg(feature = "db-sled")]
mod v2_types;
mod val_prop_sub_index;

use std::{
    collections::{HashMap, HashSet},
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
    kv_store::KvStore,
    prop_val_sub_index::{add_atom_to_prop_val_sub_index, find_in_prop_val_sub_index},
    query_index::{
        check_if_atom_matches_watched_query_filters, query_sorted_indexed, should_include_resource,
        update_indexed_member, IndexIterator,
    },
    val_prop_sub_index::add_atom_to_valpropsub_index,
};

// A function called by the Store when a Commit is accepted
type HandleCommit = Box<dyn Fn(&CommitResponse) + Send + Sync>;

/// Event emitted when a resource is created, updated, or deleted.
#[derive(Debug, Clone)]
pub enum DbEvent {
    /// Resource changed. Carries the subject (pure_id) and the Loro delta if available.
    Changed {
        subject: Subject,
        /// The Loro delta (from the commit's loro_update). None for non-Loro changes.
        delta: Option<Vec<u8>>,
        /// Optional transport/source identity for echo suppression.
        source_id: Option<String>,
        /// True when this change created the resource (no prior version).
        is_new: bool,
    },
    /// Resource destroyed.
    Destroyed {
        subject: Subject,
        /// Optional transport/source identity for echo suppression.
        source_id: Option<String>,
    },
    /// A resource entered or left the result set of a watched query. Emitted
    /// from `apply_transaction` after a successful write that touches
    /// `Tree::QueryMembers`. `filter_bytes` is the encoded `QueryFilter`
    /// (the same key used in `Tree::WatchedQueries`).
    ///
    /// Note: a sort-key change on an already-matching resource produces a
    /// (Removed, Added) pair for the same `(filter_bytes, subject)` within a
    /// single commit. Consumers that want true add/remove semantics should
    /// dedup; consumers that want every membership-touching event (the
    /// current text `QUERY_UPDATE` model) can pass them through.
    QueryMembershipChanged {
        filter_bytes: Vec<u8>,
        subject: String,
        added: bool,
        /// Optional transport/source identity for echo suppression.
        source_id: Option<String>,
    },
}

/// A drive with its subject and display name.
#[derive(Debug, Clone, serde::Serialize)]
pub struct DriveInfo {
    pub subject: String,
    pub name: String,
}

/// Result of loading an agent from a secret.
pub struct AgentLoadResult {
    pub agent: crate::agents::Agent,
    /// If true, the drive DID from the secret doesn't exist locally.
    /// The caller must sync with another device to obtain the genesis commit.
    pub drive_needs_sync: bool,
}

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
/// It uses a [KvStore] backend for key-value storage (sled, BTreeMap, etc.).
/// It stores [Resource]s as [PropVals]s by their subject as key.
/// It builds a value index for performant [Query]s.
/// It keeps track of Queries and updates their index when [crate::Commit]s are applied.
/// You can pass a custom `on_commit` function to run at Commit time.
/// `Db` should be easily, cheaply clone-able, as users of this library could have one `Db` per connection.
#[derive(Clone)]
pub struct Db {
    /// The key-value store backend. Abstracted behind a trait so different
    /// backends (sled, BTreeMap, etc.) can be used interchangeably.
    pub kv: Arc<dyn KvStore>,
    default_agent: Arc<Mutex<Option<crate::agents::Agent>>>,
    /// Endpoints are checked whenever a resource is requested. They calculate (some properties of) the resource and return it.
    endpoints: Vec<Endpoint>,
    /// List of class extenders.
    class_extenders: Arc<RwLock<Vec<ClassExtender>>>,
    /// Function called whenever a Commit is applied.
    on_commit: Option<Arc<HandleCommit>>,
    /// Broadcast channel for all resource mutations.
    db_events: tokio::sync::broadcast::Sender<DbEvent>,
    /// In-memory authoritative map of watched query filters, keyed by drive
    /// prefix (e.g. `"https://example.com"` for HTTP drives, the DID for
    /// DID-form drives). The KV `Tree::WatchedQueries` is the persistence
    /// layer; this map is the runtime lookup. Populated from the KV at Db
    /// open, kept in sync by `Db::register_watched_query`. The hot path in
    /// `check_if_atom_matches_watched_query_filters` reads from here and
    /// never touches msgpack on a commit.
    watched_queries_by_drive: Arc<RwLock<HashMap<String, Vec<Arc<query_index::QueryFilter>>>>>,
    /// Where the DB is stored on disk.
    #[allow(dead_code)]
    path: std::path::PathBuf,
    /// The base domain of the store.
    pub base_domain: Option<String>,
}

impl Db {
    /// Creates a new store at the specified path, or opens the store if it already exists.
    /// Uses sled as the storage backend.
    #[cfg(feature = "db-sled")]
    pub async fn init(path: &std::path::Path, base_domain: Option<String>) -> AtomicResult<Db> {
        tracing::info!("Opening database at {:?}", path);

        let sled_store = sled_store::SledStore::open(path)?;

        // Run migrations before wrapping in Arc (migrations need direct sled access)
        migrations::migrate_maybe(&sled_store)
            .map(|e| format!("Error during migration of database: {:?}", e))?;

        let store = Db {
            path: path.into(),
            kv: Arc::new(sled_store),
            default_agent: Arc::new(Mutex::new(None)),
            endpoints: vec![],
            class_extenders: Arc::new(RwLock::new(vec![])),

            on_commit: None,
            db_events: tokio::sync::broadcast::channel(64).0,
            watched_queries_by_drive: Arc::new(RwLock::new(HashMap::new())),
            base_domain,
        };

        store.add_class_extender(crate::collections::get_collection_class_extender())?;

        // Load persisted watched-queries (if any) into the in-memory map
        // before bootstrap, so any filter-matching commits during bootstrap
        // see the right state.
        store.populate_watched_queries_cache()?;

        // Re-run on every startup so new vocabulary (properties, classes) added
        // to default_store.json is available without a manual `populate` command.
        crate::populate::bootstrap(&store)
            .await
            .map_err(|e| format!("Failed to populate base models. {}", e))?;
        Ok(store)
    }

    /// Creates a Db backed by an in-memory BTreeMap store.
    /// Useful for tests and WASM targets.
    pub async fn init_memory(base_domain: Option<String>) -> AtomicResult<Db> {
        let store = Db {
            path: std::path::PathBuf::new(),
            kv: Arc::new(btreemap_store::BTreeMapStore::new()),
            default_agent: Arc::new(Mutex::new(None)),
            endpoints: vec![],
            class_extenders: Arc::new(RwLock::new(vec![])),

            on_commit: None,
            db_events: tokio::sync::broadcast::channel(64).0,
            watched_queries_by_drive: Arc::new(RwLock::new(HashMap::new())),
            base_domain,
        };

        store.add_class_extender(crate::collections::get_collection_class_extender())?;

        store.populate_watched_queries_cache()?;
        crate::populate::bootstrap(&store)
            .await
            .map_err(|e| format!("Failed to populate base models. {}", e))?;
        Ok(store)
    }

    /// Creates a Db backed by redb with an in-memory backend.
    /// Useful for WASM targets where redb provides proper B-tree indexing.
    /// Can be upgraded to OPFS persistence in the future.
    #[cfg(feature = "db-redb")]
    pub async fn init_redb(base_domain: Option<String>) -> AtomicResult<Db> {
        let redb_store = redb_store::RedbStore::new_memory()?;

        let store = Db {
            path: std::path::PathBuf::new(),
            kv: Arc::new(redb_store),
            default_agent: Arc::new(Mutex::new(None)),
            endpoints: vec![],
            class_extenders: Arc::new(RwLock::new(vec![])),

            on_commit: None,
            db_events: tokio::sync::broadcast::channel(64).0,
            watched_queries_by_drive: Arc::new(RwLock::new(HashMap::new())),
            base_domain,
        };

        store.add_class_extender(crate::collections::get_collection_class_extender())?;

        store.populate_watched_queries_cache()?;
        crate::populate::bootstrap(&store)
            .await
            .map_err(|e| format!("Failed to populate base models. {}", e))?;
        Ok(store)
    }

    /// Creates a Db backed by redb with file-based persistent storage.
    /// Works on all native targets (not WASM — use init_redb_opfs for that).
    #[cfg(all(feature = "db-redb", not(target_arch = "wasm32")))]
    pub async fn init_redb_file(
        path: &std::path::Path,
        base_domain: Option<String>,
        uploads_path: &std::path::Path,
    ) -> AtomicResult<Db> {
        tracing::info!("Opening ReDB database at {:?}", path);

        std::fs::create_dir_all(path).map_err(|e| {
            format!(
                "Failed to create database directory {}: {e}",
                path.display()
            )
        })?;

        let redb_path = path.join("atomic.redb");

        // Migration logic: if sled exists but redb doesn't, migrate
        #[cfg(feature = "db-sled")]
        if !redb_path.exists() {
            let sled_path = path.join("sled");
            if sled_path.exists() {
                Self::migrate_from_sled(
                    &sled_path,
                    &redb_path,
                    uploads_path,
                    base_domain.as_deref(),
                )
                .await?;
            }
        } else {
            let _ = uploads_path;
        }

        #[cfg(not(feature = "db-sled"))]
        let _ = uploads_path;

        let redb_store = redb_store::RedbStore::new_file(&redb_path)?;

        let store = Db {
            path: path.to_path_buf(),
            kv: Arc::new(redb_store),
            default_agent: Arc::new(Mutex::new(None)),
            endpoints: vec![],
            class_extenders: Arc::new(RwLock::new(vec![])),

            on_commit: None,
            db_events: tokio::sync::broadcast::channel(64).0,
            watched_queries_by_drive: Arc::new(RwLock::new(HashMap::new())),
            base_domain,
        };

        store.add_class_extender(crate::collections::get_collection_class_extender())?;

        store.populate_watched_queries_cache()?;
        crate::populate::bootstrap(&store)
            .await
            .map_err(|e| format!("Failed to populate base models. {}", e))?;
        Ok(store)
    }

    #[cfg(all(feature = "db-redb", feature = "db-sled", not(target_arch = "wasm32")))]
    async fn migrate_from_sled(
        sled_path: &std::path::Path,
        redb_path: &std::path::Path,
        uploads_path: &std::path::Path,
        base_domain: Option<&str>,
    ) -> AtomicResult<()> {
        tracing::warn!("Migrating data from Sled to ReDB and files to CAS...");

        let sled_store = sled_store::SledStore::open(sled_path)?;
        let redb_store = redb_store::RedbStore::new_file(redb_path)?;

        let mut count_resources = 0;
        let mut count_snapshots = 0;
        let mut count_blobs = 0;

        // Migrate Resources
        for item in sled_store.iter_tree(Tree::Resources) {
            let (subject_bytes, propvals_bin) = item?;
            let subject_str = String::from_utf8_lossy(&subject_bytes).to_string();

            // Try to decode with various versions
            let mut propvals = if let Ok(pv) = rmp_serde::from_slice::<PropVals>(&propvals_bin) {
                pv
            } else if let Ok(pv_v2) = rmp_serde::from_slice::<v2_types::PropValsV2>(&propvals_bin) {
                v2_types::propvals_v2_to_v3(pv_v2, base_domain.unwrap_or("localhost"))
            } else if let Ok(pv_v1) = bincode1::deserialize::<v1_types::PropValsV1>(&propvals_bin) {
                v1_types::propvals_v1_to_v2(pv_v1)
            } else {
                tracing::error!("Failed to migrate resource: {}", subject_str);
                continue;
            };

            // Migrate File resources to CAS
            let is_file = propvals
                .get(urls::IS_A)
                .map(|v| v.to_string().contains(urls::FILE))
                .unwrap_or(false);

            if is_file && !propvals.contains_key(urls::BLOB) {
                if let Some(internal_id) = propvals.get(urls::INTERNAL_ID).map(|v| v.to_string()) {
                    let file_path = uploads_path.join(&internal_id);
                    if file_path.exists() {
                        if let Ok(bytes) = std::fs::read(&file_path) {
                            let hash = blake3::hash(&bytes);
                            let hash_hex = hash.to_hex().to_string();
                            let hash_bytes = hash.as_bytes();

                            redb_store.insert(Tree::Blobs, hash_bytes, &bytes)?;
                            propvals.insert(
                                urls::BLOB.to_string(),
                                Value::AtomicUrl(
                                    format!("did:ad:blob:{}", hash_hex.clone()).into(),
                                ),
                            );
                            propvals.insert(urls::INTERNAL_ID.to_string(), Value::String(hash_hex));
                            count_blobs += 1;
                        }
                    }
                }
            }

            redb_store.insert(
                Tree::Resources,
                &subject_bytes,
                &rmp_serde::to_vec(&propvals).unwrap(),
            )?;
            count_resources += 1;
        }

        // Migrate LoroSnapshots
        for item in sled_store.iter_tree(Tree::LoroSnapshots) {
            let (key, val) = item?;
            redb_store.insert(Tree::LoroSnapshots, &key, &val)?;
            count_snapshots += 1;
        }

        // Migrate other metadata trees
        for tree in [Tree::PluginMeta, Tree::DriveMapping, Tree::DidMapping] {
            for item in sled_store.iter_tree(tree.clone()) {
                let (key, val) = item?;
                redb_store.insert(tree.clone(), &key, &val)?;
            }
        }

        tracing::info!(
            "Migration complete: {} resources, {} snapshots, {} blobs migrated.",
            count_resources,
            count_snapshots,
            count_blobs
        );

        // Optionally rename old sled dir
        let mut backup_path = sled_path.to_path_buf();
        backup_path.set_extension("bak");
        let _ = std::fs::rename(sled_path, backup_path);

        Ok(())
    }

    /// Creates a Db backed by redb with OPFS persistent storage.
    /// Only available in WASM Workers. Data survives page reloads.
    #[cfg(all(feature = "db-redb", target_arch = "wasm32"))]
    pub async fn init_redb_opfs(base_domain: Option<String>, filename: &str) -> AtomicResult<Db> {
        let redb_store = redb_store::RedbStore::new_opfs(filename).await?;

        let store = Db {
            path: std::path::PathBuf::new(),
            kv: Arc::new(redb_store),
            default_agent: Arc::new(Mutex::new(None)),
            endpoints: vec![],
            class_extenders: Arc::new(RwLock::new(vec![])),

            on_commit: None,
            db_events: tokio::sync::broadcast::channel(64).0,
            watched_queries_by_drive: Arc::new(RwLock::new(HashMap::new())),
            base_domain,
        };

        store.add_class_extender(crate::collections::get_collection_class_extender())?;

        store.populate_watched_queries_cache()?;
        crate::populate::bootstrap(&store)
            .await
            .map_err(|e| format!("Failed to populate base models. {}", e))?;
        Ok(store)
    }

    /// Creates a clone of the store with a different base_domain.
    /// This is useful for multi-tenant applications.
    /// Cloning is very cheap, as it only clones Arc pointers.
    pub fn clone_with_url(&self, base_domain: String) -> Db {
        let mut clone = self.clone();
        clone.base_domain = Some(base_domain);
        clone
    }

    /// Create a temporary Db in `.temp/db/{id}`. Useful for testing.
    /// Populates the database, creates a default agent, and sets the server_url to "http://localhost/".
    #[cfg(all(feature = "db-sled", not(feature = "db-redb")))]
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

    /// Create a temporary Db backed by ReDB. Useful for testing.
    #[cfg(all(feature = "db-redb", not(target_arch = "wasm32")))]
    pub async fn init_temp(id: &str) -> AtomicResult<Db> {
        let tmp_dir_path = format!(".temp/db/{}", id);
        let uploads_path = format!(".temp/db/{}/uploads", id);
        let _try_remove_existing = std::fs::remove_dir_all(&tmp_dir_path);
        std::fs::create_dir_all(&uploads_path)
            .map_err(|e| format!("Failed to create temp dir: {e}"))?;
        let store = Db::init_redb_file(
            std::path::Path::new(&tmp_dir_path),
            Some("https://localhost".into()),
            std::path::Path::new(&uploads_path),
        )
        .await?;
        let agent = store.create_agent(None).await?;
        store.set_default_agent(agent);
        store.populate().await?;
        Ok(store)
    }

    // ── High-level SDK helpers ──────────────────────────────────────────────────

    /// Get the active drive subject, if one is set.
    pub fn get_active_drive(&self) -> Option<String> {
        self.kv
            .get(trees::Tree::PluginMeta, b"active_drive")
            .ok()
            .flatten()
            .and_then(|v| String::from_utf8(v).ok())
    }

    /// Set the active drive subject. Persisted in the database.
    pub fn set_active_drive(&self, drive: &str) -> AtomicResult<()> {
        self.kv
            .insert(trees::Tree::PluginMeta, b"active_drive", drive.as_bytes())
    }

    /// Clear the default agent.
    pub fn clear_default_agent(&self) {
        self.default_agent.lock().unwrap().take();
    }

    /// Create a new drive owned by the current agent.
    /// Signs a genesis commit to produce a `did:ad:` subject.
    /// Sets it as the active drive. Returns the drive DID.
    pub async fn create_drive(&self, name: &str) -> AtomicResult<String> {
        let agent = self.get_default_agent()?;

        let mut builder = crate::commit::CommitBuilder::new("placeholder".into());
        builder.set(
            urls::IS_A.into(),
            Value::ResourceArray(vec![urls::DRIVE.into()]),
        );
        builder.set(urls::NAME.into(), Value::String(name.into()));
        builder.set(
            urls::WRITE.into(),
            Value::ResourceArray(vec![agent.subject.to_string().into()]),
        );
        builder.set(
            urls::READ.into(),
            Value::ResourceArray(vec![urls::PUBLIC_AGENT.into()]),
        );

        let commit = crate::commit::Commit::create_did(builder, &agent, self).await?;
        let did = commit.subject.to_string();

        let opts = crate::commit::CommitOpts {
            validate_signature: true,
            validate_timestamp: false,
            validate_previous_commit: false,
            validate_rights: false,
            update_index: true,
            ..crate::commit::CommitOpts::no_validations_no_index()
        };
        self.apply_commit(commit, &opts).await?;
        self.set_active_drive(&did)?;

        // Add the new drive to the agent's `drives` array and persist.
        let agent = self.get_default_agent()?;
        let mut agent_resource = self.get_resource(&agent.subject).await?;
        let mut drives: Vec<crate::values::SubResource> = agent_resource
            .get(urls::DRIVES)
            .ok()
            .and_then(|v| match v {
                Value::ResourceArray(arr) => Some(arr.clone()),
                _ => None,
            })
            .unwrap_or_default();
        if !drives.iter().any(|d| d.to_string() == did) {
            drives.push(did.clone().into());
            agent_resource.set_unsafe(urls::DRIVES.into(), Value::ResourceArray(drives))?;
            self.add_resource_opts(&agent_resource, false, true, true)
                .await?;
        }

        Ok(did)
    }

    /// Create a new resource with a `did:ad:` subject via genesis commit.
    pub async fn create_resource(
        &self,
        class: &str,
        parent: &str,
        name: &str,
        props: Option<Vec<(&str, Value)>>,
    ) -> AtomicResult<String> {
        let agent = self.get_default_agent()?;

        let mut builder = crate::commit::CommitBuilder::new("placeholder".into());
        builder.set(urls::IS_A.into(), Value::ResourceArray(vec![class.into()]));
        builder.set(urls::NAME.into(), Value::String(name.into()));
        builder.set(urls::PARENT.into(), Value::AtomicUrl(parent.into()));

        if let Some(extra) = props {
            for (prop, val) in extra {
                builder.set(prop.into(), val);
            }
        }

        let commit = crate::commit::Commit::create_did(builder, &agent, self).await?;
        let did = commit.subject.to_string();

        let opts = crate::commit::CommitOpts {
            validate_signature: true,
            validate_timestamp: false,
            validate_previous_commit: false,
            validate_rights: false,
            update_index: true,
            ..crate::commit::CommitOpts::no_validations_no_index()
        };
        self.apply_commit(commit, &opts).await?;
        Ok(did)
    }

    /// Load an agent from a secret and set it as the default agent.
    /// Persists the agent resource so its `drives` property is queryable.
    /// If the secret contains a drive DID, sets it as the active drive.
    ///
    /// Returns `AgentLoadResult` which indicates whether the drive exists locally.
    /// If `drive_needs_sync` is true, the caller must sync with another device
    /// before the user can create resources — the drive's genesis commit is missing.
    pub async fn load_agent_from_secret(&self, secret: &str) -> AtomicResult<AgentLoadResult> {
        let agent = crate::agents::Agent::from_secret(secret)?;
        self.set_default_agent(agent.clone());

        // Persist so list_drives() can read the agent's `drives` property
        let agent_resource = agent.to_resource()?;
        self.add_resource_opts(&agent_resource, false, false, true)
            .await?;

        let mut drive_needs_sync = false;

        if let Some(drive) = &agent.initial_drive {
            let drive_str = drive.to_string();
            let _ = self.set_active_drive(&drive_str);

            // Check if the drive resource actually exists locally.
            // Without the genesis commit, the DID is just a string — the device
            // can't create resources under it.
            let drive_subject = Subject::from_raw(&drive_str, self.get_base_domain().as_deref());
            if self.get_resource(&drive_subject).await.is_err() {
                tracing::warn!(
                    "Drive {} from secret does not exist locally — needs sync from another device",
                    &drive_str[..drive_str.len().min(30)]
                );
                drive_needs_sync = true;
            }
        }

        Ok(AgentLoadResult {
            agent,
            drive_needs_sync,
        })
    }

    /// List drives belonging to the current agent.
    /// Falls back to the active drive if the agent resource has no `drives` property.
    pub async fn list_drives(&self) -> AtomicResult<Vec<DriveInfo>> {
        let agent = self.get_default_agent()?;
        let agent_resource = self.get_resource(&agent.subject).await?;

        let subjects = match agent_resource.get(urls::DRIVES) {
            Ok(Value::ResourceArray(arr)) => arr.iter().map(|s| s.to_string()).collect::<Vec<_>>(),
            _ => vec![],
        };

        // Fallback: active drive not in agent resource
        let subjects = if subjects.is_empty() {
            match self.get_active_drive() {
                Some(active) => vec![active],
                None => vec![],
            }
        } else {
            subjects
        };

        let mut drives = Vec::with_capacity(subjects.len());
        for subject in subjects {
            let name = match self.get_resource(&subject.as_str().into()).await {
                Ok(r) => r.get(urls::NAME).map(|v| v.to_string()).unwrap_or_default(),
                Err(_) => String::new(),
            };
            drives.push(DriveInfo { subject, name });
        }

        Ok(drives)
    }

    /// Get children of a resource, optionally filtered by class.
    pub async fn get_children(
        &self,
        parent: &str,
        class_filter: Option<&str>,
    ) -> AtomicResult<Vec<Resource>> {
        let mut result = Vec::new();

        for resource in self.all_resources(false) {
            if let Ok(p) = resource.get(urls::PARENT) {
                if p.to_string() != parent {
                    continue;
                }
            } else {
                continue;
            }

            if let Some(class) = class_filter {
                if let Ok(is_a) = resource.get(urls::IS_A) {
                    if !is_a.to_string().contains(class) {
                        continue;
                    }
                } else {
                    continue;
                }
            }

            result.push(resource);
        }

        Ok(result)
    }

    /// Full onboarding: create an agent and a personal drive in one call.
    /// The agent's secret will contain the drive DID for DHT discovery.
    /// Returns (agent, drive_subject).
    pub async fn setup(&self, agent_name: &str) -> AtomicResult<(crate::agents::Agent, String)> {
        let mut agent = self.create_agent(Some(agent_name)).await?;
        self.set_default_agent(agent.clone());
        let drive = self
            .create_drive(&format!("{}'s Drive", agent_name))
            .await?;

        // Set initial_drive so the secret contains the drive DID.
        // This lets other devices find this drive via DHT when restoring from secret.
        agent.initial_drive = Some(drive.as_str().into());
        self.set_default_agent(agent.clone());
        // Re-save the agent resource so `drives` and `personalDrive` are persisted.
        self.add_resource_opts(&agent.to_resource()?, false, true, true)
            .await?;

        Ok((agent, drive))
    }
    // ── High-level SDK helpers ─────────────────────────────────────────

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
        if subject.is_blob_did() {
            if let Some(hash) = subject.blob_hash_hex() {
                let target = format!("{}/download/files/{}", origin.trim_end_matches('/'), hash);
                return Ok(ResourceResponse::Redirect(target));
            }
        }

        let store = self.clone_with_url(origin.to_string());

        store.get_resource_extended(subject, false, for_agent).await
    }

    /// Resolves a `did:ad:frozen:` subject from [`Tree::Frozen`]: loads the
    /// stored JSON-AD bytes, **verifies they hash to the requested id**
    /// (trustless — no signature, no trust in the source), and parses them into
    /// a read-only Resource. Immutability is enforced elsewhere by rejecting
    /// commits to frozen subjects. Cycle "unit" objects are not yet
    /// materializable as individual resources.
    async fn materialize_frozen(&self, subject: &Subject) -> AtomicResult<Resource> {
        let id = subject.pure_id();
        let hash_hex = subject
            .frozen_hash_hex()
            .ok_or_else(|| AtomicError::not_found(format!("Invalid frozen subject: {}", id)))?;
        let bytes = self
            .kv
            .get(Tree::Frozen, hash_hex.as_bytes())?
            .ok_or_else(|| AtomicError::not_found(format!("Frozen resource not found: {}", id)))?;
        let body: serde_json::Value = serde_json::from_slice(&bytes)
            .map_err(|e| format!("Stored frozen body for {} is not valid JSON: {}", id, e))?;

        // Trustless verification: the stored bytes must hash to the requested id.
        crate::frozen::verify_frozen(&id, &body)?;

        if crate::frozen::is_unit(&body) {
            return Err(format!(
                "Frozen subject {} is a reference-cycle unit; materializing individual members is not yet supported.",
                id
            )
            .into());
        }

        let serde_json::Value::Object(map) = body else {
            return Err(format!("Frozen body for {} must be a JSON object", id).into());
        };

        // DontSave: a frozen resource is read-only — never write it to
        // Tree::Resources and never run class-`requires` validation (a frozen
        // definition deliberately omits presentation like `description`; its
        // validity is the hash, not class completeness).
        let parse_opts = crate::parse::ParseOpts {
            save: crate::parse::SaveOpts::DontSave,
            skip_unknown_props: true,
            ..Default::default()
        };
        crate::parse::parse_json_ad_map_to_resource(map, self, Some(id), &parse_opts).await
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

        self.kv
            .insert(Tree::DriveMapping, host.as_bytes(), did_str.as_bytes())?;
        tracing::info!("Added drive mapping: {} -> {}", host, did_str);
        Ok(())
    }

    /// Removes the drive mapping for a given host.
    pub fn remove_drive_mapping(&self, host: &str) -> AtomicResult<()> {
        self.kv.remove(Tree::DriveMapping, host.as_bytes())?;
        tracing::info!("Removed drive mapping for host: {}", host);
        Ok(())
    }

    /// Returns the full Drive DID for a given host (domain/subdomain).
    pub async fn get_drive_did(&self, host: &str) -> AtomicResult<Option<Subject>> {
        if let Some(did_bin) = self.kv.get(Tree::DriveMapping, host.as_bytes())? {
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
    #[instrument(level = "trace", skip_all)]
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

        // Phase 2c (loro-source-of-truth): the `loroUpdate` propval is the
        // resource's CRDT snapshot — it belongs in `Tree::LoroSnapshots`, not
        // duplicated inside the resource blob, which is now a pure derived
        // projection. Commit resources are the exception: a commit's
        // `loroUpdate` is its signed payload and must stay in the blob.
        let resource_bin = if subject.is_commit_did() {
            encode_propvals(propvals)?
        } else {
            let mut projection = propvals.clone();
            projection.remove(crate::urls::LORO_UPDATE);
            encode_propvals(&projection)?
        };

        transaction.push(Operation {
            tree: Tree::Resources,
            method: Method::Insert,
            key: subject_str.as_bytes().to_vec(),
            val: Some(resource_bin),
        });
        Ok(())
    }

    #[instrument(skip_all)]
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
                self.kv.flush()?;
            }
        }

        tracing::info!("Building index finished!");
        Ok(())
    }

    /// Sets a function that is called whenever a [Commit::apply] is called.
    /// This can be used to listen to events.
    pub fn set_handle_commit(&mut self, on_commit: HandleCommit) {
        self.on_commit = Some(Arc::new(on_commit));
    }

    /// Subscribe to all DB events (changes, deletions).
    pub fn subscribe_events(&self) -> tokio::sync::broadcast::Receiver<DbEvent> {
        self.db_events.subscribe()
    }

    /// Finds resource by Subject, return PropVals HashMap
    #[instrument(skip_all)]
    fn get_propvals(&self, subject: &str) -> AtomicResult<PropVals> {
        match self.kv.get(Tree::Resources, subject.as_bytes())? {
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
        self.kv.clear_tree(Tree::ValPropSub)?;
        self.kv.clear_tree(Tree::PropValSub)?;
        self.kv.clear_tree(Tree::QueryMembers)?;
        self.kv.clear_tree(Tree::WatchedQueries)?;
        Ok(())
    }

    /// Reset the watched-query registry (`Tree::WatchedQueries` + the
    /// in-memory `watched_queries_by_drive` map). Called on server
    /// startup: every restart drops every WS connection, so any
    /// previously-registered filter is now an orphan with no live
    /// subscriber. Without this, e2e suites leak filters across runs
    /// (each test's drive is unique, so each filter is unique), and
    /// `check_if_atom_matches_watched_query_filters` iterates a growing
    /// pile of dead entries on every commit — observed to reach 13k+
    /// filters, slowing rapid-save tests past their timeout. Active
    /// subscribers re-register their filters on reconnect, so the
    /// map repopulates organically without surprising anyone.
    pub fn clear_watched_queries(&self) -> AtomicResult<()> {
        self.kv.clear_tree(Tree::WatchedQueries)?;
        if let Ok(mut map) = self.watched_queries_by_drive.write() {
            map.clear();
        }
        Ok(())
    }

    /// Flushes the current state to disk.
    pub fn flush(&self) -> AtomicResult<()> {
        self.kv.flush()
    }

    /// Removes the DB and all content from disk.
    /// WARNING: This is irreversible.
    #[cfg(feature = "db-sled")]
    pub fn clear_all_danger(self) -> AtomicResult<()> {
        let path = self.path.clone();
        drop(self);
        std::fs::remove_dir_all(path)?;
        Ok(())
    }

    fn map_kv_item_to_resource(
        subject_bytes: &[u8],
        resource_bin: &[u8],
        include_external: bool,
        base_domain: Option<&str>,
    ) -> Option<Resource> {
        let subject: String = String::from_utf8_lossy(subject_bytes).to_string();

        let subject_obj = Subject::from_raw(&subject, base_domain);

        if !include_external && !subject_obj.is_local() {
            return None;
        }

        let propvals: PropVals = decode_propvals(resource_bin)
            .unwrap_or_else(|e| panic!("{}. {}", corrupt_db_message(&subject), e));

        Some(Resource::from_propvals(propvals, subject_obj))
    }

    pub fn get_plugin_meta(&self, key: &PluginMetaKey) -> AtomicResult<Option<PluginMeta>> {
        let Some(plugin_meta_bin) = self.kv.get(Tree::PluginMeta, &key.encode()?)? else {
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
        self.kv
            .insert(Tree::PluginMeta, &key.encode()?, &plugin_meta.encode()?)?;
        Ok(())
    }

    pub fn delete_plugin_meta(&self, key: &PluginMetaKey) -> AtomicResult<()> {
        self.kv.remove(Tree::PluginMeta, &key.encode()?)?;
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

    /// Register a filter to be watched. Persists to `Tree::WatchedQueries`
    /// (idempotent — same filter encodes to the same bytes) and pushes into
    /// the in-memory `watched_queries_by_drive` map. The KV `contains_key`
    /// short-circuit keeps the in-memory Vec from growing on duplicate
    /// `watch()` calls (e.g. when a client reconnects and re-watches a
    /// filter that's already persisted).
    pub(crate) fn register_watched_query(
        &self,
        filter: query_index::QueryFilter,
    ) -> AtomicResult<()> {
        let filter_bytes = filter.encode()?;
        // Skip if already persisted — avoids growing the in-memory Vec on
        // re-watches. The KV is authoritative for "what filters exist"; the
        // in-memory map is just a decoded mirror.
        if self
            .kv
            .contains_key(crate::db::trees::Tree::WatchedQueries, &filter_bytes)
            .unwrap_or(false)
        {
            return Ok(());
        }
        self.kv
            .insert(crate::db::trees::Tree::WatchedQueries, &filter_bytes, b"")?;
        let drive_key = filter.drive.as_str().to_string();
        if let Ok(mut map) = self.watched_queries_by_drive.write() {
            map.entry(drive_key)
                .or_insert_with(Vec::new)
                .push(Arc::new(filter));
        }
        Ok(())
    }

    /// Rebuild the in-memory watched-queries map from `Tree::WatchedQueries`.
    /// Called once at Db open (after KV/migrations are ready) so the map is
    /// authoritative on first commit. Subsequent `register_watched_query`
    /// calls keep both stores in sync.
    pub(crate) fn populate_watched_queries_cache(&self) -> AtomicResult<()> {
        let mut new_map: HashMap<String, Vec<Arc<query_index::QueryFilter>>> = HashMap::new();
        for entry in self.kv.iter_tree(crate::db::trees::Tree::WatchedQueries) {
            let (k, _v) = match entry {
                Ok(pair) => pair,
                Err(e) => {
                    tracing::warn!("populate_watched_queries_cache: skipping bad entry: {e}");
                    continue;
                }
            };
            let qf = match query_index::QueryFilter::from_bytes(&k) {
                Ok(qf) => qf,
                Err(e) => {
                    tracing::warn!(
                        "populate_watched_queries_cache: skipping undecodable entry ({} bytes): {e}",
                        k.len()
                    );
                    continue;
                }
            };
            let drive_key = qf.drive.as_str().to_string();
            new_map.entry(drive_key).or_default().push(Arc::new(qf));
        }
        if let Ok(mut map) = self.watched_queries_by_drive.write() {
            *map = new_map;
        }
        Ok(())
    }

    /// Look up the watched filters for a given drive prefix string. Returns
    /// a cheap-cloned `Vec<Arc<QueryFilter>>`; iterating it doesn't hold the
    /// map lock.
    pub(crate) fn watched_queries_for_drive(
        &self,
        drive_key: &str,
    ) -> Vec<Arc<query_index::QueryFilter>> {
        self.watched_queries_by_drive
            .read()
            .ok()
            .and_then(|m| m.get(drive_key).cloned())
            .unwrap_or_default()
    }

    /// All watched filters across every drive. Used as a fallback for
    /// DID-subject atoms whose drive prefix can't be derived (their
    /// `drive_prefix_from_subject` returns the subject itself, which won't
    /// match an HTTP-drive filter's bucket).
    pub(crate) fn all_watched_queries(&self) -> Vec<Arc<query_index::QueryFilter>> {
        self.watched_queries_by_drive
            .read()
            .map(|m| m.values().flat_map(|v| v.iter().cloned()).collect())
            .unwrap_or_default()
    }

    /// Apply made changes to the store.
    ///
    /// After a successful KV apply, scans the transaction for writes to
    /// `Tree::QueryMembers` and broadcasts a `DbEvent::QueryMembershipChanged`
    /// for each one. Subscribers (e.g. `CommitMonitor`'s listener task) use
    /// these to push live `QUERY_UPDATE` notifications without re-deriving
    /// membership from the raw atom stream.
    #[instrument(level = "trace", skip_all)]
    fn apply_transaction(&self, transaction: &mut Transaction) -> AtomicResult<()> {
        self.apply_transaction_with_source(transaction, None)
    }

    fn apply_transaction_with_source(
        &self,
        transaction: &mut Transaction,
        source_id: Option<&str>,
    ) -> AtomicResult<()> {
        self.kv.apply_batch(transaction)?;

        for op in transaction.iter() {
            if op.tree != Tree::QueryMembers {
                continue;
            }
            // Op key layout: `[encoded_filter] || 0xff || [sortable_value] || 0xff || [subject]`.
            // We need filter_bytes (raw) and subject — skip the value entirely.
            // Splitting on 0xff (SEPARATION_BIT) is safe because the encoded
            // filter prefix never contains 0xff in practice (drive URL bytes are
            // ASCII/UTF-8, drive_len LE-bytes for sub-16M lengths have a 0x00
            // high byte, msgpack output for the QueryFilterRest fields doesn't
            // hit 0xff for typical Option<String>/Option<Value> contents).
            // Same invariant `parse_collection_members_key` already relies on.
            let mut iter = op.key.split(|b| b == &query_index::SEPARATION_BIT);
            let filter_bytes = match iter.next() {
                Some(b) if !b.is_empty() => b.to_vec(),
                _ => continue,
            };
            let _value = iter.next();
            let subject_bytes = match iter.next() {
                Some(b) => b,
                None => continue,
            };
            let subject = match std::str::from_utf8(subject_bytes) {
                Ok(s) => s.to_string(),
                Err(_) => continue,
            };
            let added = matches!(op.method, crate::db::trees::Method::Insert);
            let _ = self.db_events.send(DbEvent::QueryMembershipChanged {
                filter_bytes,
                subject,
                added,
                source_id: source_id.map(str::to_string),
            });
        }
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
                } else {
                    // The index has an entry for this subject but the
                    // requesting agent can't resolve it — auth-filtered,
                    // destroyed-with-stale-index, or otherwise invisible.
                    // Roll back the count bump so it doesn't outrun the
                    // returned subjects and produce a
                    // `totalMembers: N, members: []` drift. We only do
                    // this for in-page hits; entries past the limit stay
                    // counted blindly (issue #286).
                    total_count -= 1;
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
            (subjects, resources, total_count) = query_sorted_indexed(self, q, &q_filter).await?;
        }

        Ok(QueryResult {
            subjects,
            resources,
            count: total_count,
        })
    }

    #[instrument(skip_all)]
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

    /// Recursively removes a resource and its children from the database.
    /// `removed` collects the `pure_id()` of every deleted subject so the
    /// caller can tombstone them after the transaction is applied.
    async fn recursive_remove(
        &self,
        subject: &Subject,
        transaction: &mut Transaction,
        removed: &mut Vec<String>,
    ) -> AtomicResult<()> {
        // Key by `pure_id()` — that is how resources and Loro snapshots are
        // stored (`add_resource_tx`, `apply_commit`). Looking up by the raw
        // `to_string()` (which may carry `?drive=` params) would miss the
        // row entirely for DID subjects with a drive hint.
        let subject_str = subject.pure_id();
        if let Ok(found) = self.get_propvals(&subject_str) {
            let resource = Resource::from_propvals(found, subject.clone());
            transaction.push(Operation::remove_resource(&subject_str));
            // Remove the Loro snapshot in the same transaction. Without this
            // the snapshot is orphaned in `Tree::LoroSnapshots` and leaks
            // forever — only the WS/Iroh DESTROY path cleaned it before.
            transaction.push(Operation::remove_loro_snapshot(&subject_str));
            removed.push(subject_str.clone());
            let mut children = resource.get_children(self).await?;
            for child in children.iter_mut() {
                // Notify subscribers so clients evict the cascade-deleted
                // child from their cache. The signed destroy commit only
                // fires DbEvent::Destroyed for the top-level subject; without
                // this, children remain in WASM-DB / store and the UI keeps
                // rendering them.
                let _ = self.db_events.send(DbEvent::Destroyed {
                    subject: child.get_subject().without_params(),
                    source_id: None,
                });
                // Because the function is async we need to box it to use recursion.
                Box::pin(self.recursive_remove(child.get_subject(), transaction, removed)).await?;
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

    #[tracing::instrument(skip_all)]
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
                    ResourceResponse::Redirect(target) => {
                        return Ok(ResourceResponse::Redirect(target));
                    }
                }
            }
        }

        Err(format!("No endpoint found for {}", subject).into())
    }
}

// Drop is handled by SledStore's own Drop impl which flushes on drop.
// No explicit Drop needed for Db since Arc<dyn KvStore> handles cleanup.

#[cfg_attr(target_arch = "wasm32", async_trait(?Send))]
#[cfg_attr(not(target_arch = "wasm32"), async_trait)]
impl Storelike for Db {
    fn normalize_subject(&self, subject: &Subject) -> Subject {
        Subject::from_raw(subject.as_str(), self.get_base_domain().as_deref())
    }

    fn get_active_drive(&self) -> Option<String> {
        self.get_active_drive()
    }

    fn set_active_drive(&self, drive: &str) -> AtomicResult<()> {
        self.set_active_drive(drive)
    }

    fn clear_default_agent(&self) {
        self.clear_default_agent()
    }

    /// Adds Atoms to the store.
    /// Will replace existing Atoms that share Subject / Property combination.
    /// Validates datatypes and required props presence.
    #[instrument(skip_all)]
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
        self.kv.flush()?;
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

    #[instrument(skip_all)]
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
        // Build a single transaction for index updates + resource persistence
        let mut transaction = Transaction::new();

        if update_index {
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
        }
        // Phase 2b/2c (loro-source-of-truth): the snapshot in
        // `Tree::LoroSnapshots` is the authoritative CRDT state. Derive and
        // persist it here UNCONDITIONALLY for every CRDT resource — in the
        // same transaction as the `Tree::Resources` write — so the invariant
        // holds that every resource blob is paired with a current snapshot.
        // (The old code only wrote the snapshot when the propvals lacked a
        // `loroUpdate`, so any resource that had been through `apply_state_doc`
        // — i.e. every sync import — had its snapshot write silently skipped.)
        // The `loroUpdate` propval is stripped from the `Tree::Resources`
        // blob: that blob is a pure derived projection, not a second home for
        // the CRDT state. Commits are native (immutable, not CRDT) — they get
        // no snapshot and keep their `loroUpdate` payload in the blob.
        let mut propvals = resource.get_propvals().clone();
        if !subject.is_commit_did() {
            let snapshot = resource.build_state_doc()?.export_snapshot();
            propvals.remove(crate::urls::LORO_UPDATE);
            transaction.push(Operation {
                tree: Tree::LoroSnapshots,
                method: Method::Insert,
                key: subject_str.as_bytes().to_vec(),
                val: Some(snapshot),
            });
        }

        // Persist the resource data in the same transaction
        let resource_bin = encode_propvals(&propvals)?;
        transaction.push(Operation {
            tree: Tree::Resources,
            method: Method::Insert,
            key: subject_str.as_bytes().to_vec(),
            val: Some(resource_bin),
        });
        self.apply_transaction(&mut transaction)?;
        let _ = self.db_events.send(DbEvent::Changed {
            subject: resource.get_subject().without_params(),
            delta: None,
            source_id: None,
            is_new: false,
        });
        Ok(())
    }

    /// Apply a single signed Commit to the Db.
    /// Creates, edits or destroys a resource.
    /// Allows for control over which validations should be performed.
    /// Returns the generated Commit, the old Resource and the new Resource.
    #[tracing::instrument(skip_all)]
    async fn apply_commit(
        &self,
        commit: Commit,
        opts: &CommitOpts,
    ) -> AtomicResult<CommitResponse> {
        let store = self;

        let commit_response = commit.validate_and_build_response(opts, store).await?;

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
                        changed_props: &commit_response.changed_props,
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
                    self.normalize_subject(&commit_response.commit.subject.clone());
                assert_eq!(
                    _old.get_subject().to_string(),
                    normalized_commit_subject.to_string()
                );
                assert!(&commit_response
                    .commit
                    .destroy
                    .expect("Resource was removed but `commit.destroy` was not set!"));
                let subject: Subject = commit_response.commit.subject.clone();
                self.remove_resource(&subject).await?;
            }
            _ => {}
        };

        if let Some(new) = &commit_response.resource_new {
            self.add_resource_tx(new, &mut transaction)?;

            // Persist the Loro snapshot so VV-based sync can find it.
            // Use pure_id() (strips query params/drive hints) for a canonical key.
            if let Some(snapshot) = new.materialized_state() {
                transaction.push(trees::Operation {
                    tree: trees::Tree::LoroSnapshots,
                    method: trees::Method::Insert,
                    key: new.get_subject().pure_id().as_bytes().to_vec(),
                    val: Some(snapshot),
                });
            }
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

        store.apply_transaction_with_source(
            &mut transaction,
            commit_response.source_id.as_deref(),
        )?;

        // Notify subscribers
        let subject = commit_response.commit.subject.without_params();
        let is_destroy = commit_response.commit.destroy.unwrap_or(false);
        let event = if is_destroy {
            DbEvent::Destroyed {
                subject,
                source_id: commit_response.source_id.clone(),
            }
        } else {
            DbEvent::Changed {
                subject,
                delta: commit_response.commit.loro_update.clone(),
                source_id: commit_response.source_id.clone(),
                is_new: commit_response.resource_old.is_none(),
            }
        };
        let _ = store.db_events.send(event);

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
                        changed_props: &commit_response.changed_props,
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
            None => {
                Err("No agent set. Call db.setup() or db.load_agent_from_secret() first.".into())
            }
        }
    }

    #[instrument(skip_all)]
    async fn get_value(&self, subject: &str, property: &str) -> AtomicResult<Value> {
        self.get_resource(&subject.into())
            .await
            .and_then(|r| r.get(property).cloned())
    }

    #[instrument(skip_all)]
    async fn get_resource(&self, subject: &Subject) -> AtomicResult<Resource> {
        let normalized = self.normalize_subject(subject);
        // Frozen resources are content-addressed and immutable; they live in
        // Tree::Frozen, not Tree::Resources, and materialize by re-hash + parse.
        if normalized.is_frozen_did() {
            return self.materialize_frozen(&normalized).await;
        }
        let subject_str = normalized.pure_id();
        if let Ok(propvals) = self.get_propvals(&subject_str) {
            let mut res_subject = normalized.clone();

            // If it's a DID and we don't have a hint in the requested subject,
            // check if we have one persisted in the did_mapping tree.
            if let Subject::Did {
                drive_hint: None, ..
            } = &res_subject
            {
                if let Ok(Some(hint_bin)) = self.kv.get(Tree::DidMapping, subject_str.as_bytes()) {
                    if let Ok(hint) = std::str::from_utf8(&hint_bin) {
                        res_subject = res_subject.set_drive_hint(hint.to_string());
                    }
                }
            }

            let mut resource = Resource::from_propvals(propvals, res_subject);
            // Authoritative merged CRDT state (full oplog) lives in LoroSnapshots.
            // Propvals may carry a smaller incremental `loroUpdate` from the last commit.
            if let Ok(Some(snapshot)) = self.kv.get(
                crate::db::trees::Tree::LoroSnapshots,
                subject_str.as_bytes(),
            ) {
                if let Ok(doc) = crate::loro::AtomicLoroDoc::from_snapshot(&snapshot) {
                    let _ = resource.apply_state_doc(doc);
                }
            }
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

    fn has_stored_resource(&self, subject: &Subject) -> bool {
        let normalized = self.normalize_subject(subject);
        self.get_propvals(&normalized.pure_id()).is_ok()
    }

    #[instrument(skip_all)]
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
                            ResourceResponse::Redirect(target) => {
                                return Ok(ResourceResponse::Redirect(target));
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
    #[instrument(skip_all)]
    async fn query(&self, q: &Query) -> AtomicResult<QueryResult> {
        if requires_query_index(q) {
            return self.query_complex(q).await;
        }

        self.query_basic(q).await
    }

    #[instrument(skip_all)]
    fn all_resources(
        &self,
        include_external: bool,
    ) -> Box<dyn std::iter::Iterator<Item = Resource> + Send> {
        let base_domain = self.base_domain.clone();
        let result = self.kv.iter_tree(Tree::Resources).filter_map(move |item| {
            let (subject_bytes, resource_bin) = item.expect(DB_CORRUPT_MSG);
            Db::map_kv_item_to_resource(
                &subject_bytes,
                &resource_bin,
                include_external,
                base_domain.as_deref(),
            )
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

    #[instrument(skip_all)]
    async fn remove_resource(&self, subject: &Subject) -> AtomicResult<()> {
        let mut transaction = Transaction::new();
        let mut removed = Vec::new();
        self.recursive_remove(subject, &mut transaction, &mut removed)
            .await?;
        self.apply_transaction(&mut transaction)?;
        // Tombstone every removed subject so bulk sync (Iroh / WS `SYNC`)
        // does not resurrect them from a peer that still holds a stale copy.
        for s in &removed {
            crate::sync::tombstones::record_tombstone(self, s);
        }
        // TODO: deletion sync — should create a signed destroy commit
        // and push it through the normal commit pipeline, not a raw DESTROY frame.
        Ok(())
    }

    fn set_default_agent(&self, agent: crate::agents::Agent) {
        self.default_agent.lock().unwrap().replace(agent);
    }

    fn begin_batch(&self) {
        self.kv.begin_batch();
    }

    fn commit_batch(&self) -> AtomicResult<()> {
        self.kv.commit_batch()
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
        resource
            .set_unsafe(urls::PARENT.into(), Value::AtomicUrl(drive_did.clone()))
            .unwrap();
        resource
            .set_unsafe(urls::SHORTNAME.into(), Value::Slug("about".into()))
            .unwrap();
        resource
            .set_unsafe(urls::NAME.into(), Value::String("About".into()))
            .unwrap();
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
