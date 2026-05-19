// The bindings here use `Db::init_redb_opfs`, which is only compiled for the
// wasm32 target (see `lib/src/db.rs`). When cargo runs `clippy/fmt/check` on
// the workspace from a host target, this crate's body would otherwise fail to
// compile. Stub the whole module out on non-wasm32 targets so workspace-level
// commands stay green; the cdylib build still happens via `wasm-pack` (see
// `.dagger/src/index.ts:wasmBuild`) which targets wasm32-unknown-unknown.
#![cfg(target_arch = "wasm32")]

use atomic_lib::{
    commit::CommitOpts,
    parse::ParseOpts,
    storelike::{Query, QueryResult, Storelike},
    Commit, Db, Resource, Subject, Value,
};
use wasm_bindgen::prelude::*;

/// Initialize panic hook for better error messages in the browser console.
#[wasm_bindgen(start)]
pub fn init() {
    console_error_panic_hook::set_once();
}

/// A client-side Atomic Data database backed by redb (in-memory, future OPFS).
/// Provides indexed queries, resource storage, and commit application.
#[wasm_bindgen]
pub struct ClientDb {
    db: Db,
}

#[wasm_bindgen]
impl ClientDb {
    /// Create a new ClientDb with OPFS persistence.
    /// `base_url` is the server URL, e.g. "https://myserver.com".
    ///
    /// Expected runtime: a DedicatedWorker nested inside a per-origin
    /// SharedWorker. The SharedWorker fans tab ports into this single inner
    /// worker so exactly one OPFS sync access handle exists. If this fails,
    /// OPFS is genuinely broken (corrupt, quota, unsupported browser) — the
    /// error surfaces verbatim.
    #[wasm_bindgen(constructor)]
    pub async fn new(base_url: Option<String>) -> Result<ClientDb, JsError> {
        let db = Db::init_redb_opfs(base_url, "atomic_data.redb")
            .await
            .map_err(|e| to_js_err(format!("OPFS unavailable: {e}")))?;
        web_sys::console::log_1(&"[ClientDb] Using OPFS persistent storage".into());
        Ok(ClientDb { db })
    }

    /// Create a non-persistent in-memory ClientDb. Used in environments
    /// without OPFS — Node integration tests, headless harnesses. Data is
    /// lost when the process exits.
    #[wasm_bindgen(js_name = "newInMemory")]
    pub async fn new_in_memory(base_url: Option<String>) -> Result<ClientDb, JsError> {
        let db = Db::init_redb(base_url).await.map_err(to_js_err)?;
        Ok(ClientDb { db })
    }

    /// Get a resource by its subject URL. Returns JSON-AD string or null.
    #[wasm_bindgen(js_name = "getResource")]
    pub async fn get_resource(&self, subject: &str) -> Result<JsValue, JsError> {
        let subject = Subject::from(subject);
        match self.db.get_resource(&subject).await {
            Ok(resource) => {
                let json = resource_to_json_ad(&resource)?;
                Ok(JsValue::from_str(&json))
            }
            Err(_) => Ok(JsValue::NULL),
        }
    }

    /// Store a resource from a JSON-AD string during initial bulk sync.
    /// Rebuilds the full index for this resource (all atoms).
    /// For incremental updates, use `applyCommit` instead — it only
    /// touches changed properties via the Loro diff.
    #[wasm_bindgen(js_name = "putResource")]
    pub async fn put_resource(&self, json_ad: &str) -> Result<(), JsError> {
        // `SaveOpts::DontSave` keeps `parse_json_ad_resource` from calling
        // `store.add_resource()` (which validates required props) during
        // parsing. The explicit `add_resource_opts(false, true, true)` below is
        // the intended persistence step — it skips validation deliberately.
        let resource = atomic_lib::parse::parse_json_ad_resource(
            json_ad,
            &self.db,
            &ParseOpts {
                skip_unknown_props: true,
                save: atomic_lib::parse::SaveOpts::DontSave,
                ..Default::default()
            },
        )
        .await
        .map_err(to_js_err)?;
        self.db
            .add_resource_opts(&resource, false, true, true)
            .await
            .map_err(to_js_err)?;
        Ok(())
    }

    /// Apply a Commit (JSON-AD) to the local database.
    /// This is the efficient incremental update path: the Loro diff
    /// determines exactly which atoms changed, so only affected index
    /// entries are updated. Use this for real-time updates (COMMIT messages).
    #[wasm_bindgen(js_name = "applyCommit")]
    pub async fn apply_commit(&self, commit_json_ad: &str) -> Result<(), JsError> {
        // `DontSave` is required: the default would store the parsed Commit
        // resource via `add_resource()` (which validates required props)
        // before `apply_commit` runs. `apply_commit` is the proper persistence
        // path here.
        let commit_resource = atomic_lib::parse::parse_json_ad_resource(
            commit_json_ad,
            &self.db,
            &ParseOpts {
                save: atomic_lib::parse::SaveOpts::DontSave,
                ..Default::default()
            },
        )
        .await
        .map_err(to_js_err)?;
        let commit = Commit::from_resource(commit_resource).map_err(to_js_err)?;
        let opts = CommitOpts {
            validate_schema: false,
            validate_signature: false,
            validate_timestamp: false,
            validate_rights: false,
            validate_previous_commit: false,
            validate_loro_causality: false,
            validate_for_agent: None,
            update_index: true,
            source_id: None,
        };
        self.db
            .apply_commit(commit, &opts)
            .await
            .map_err(to_js_err)?;
        Ok(())
    }

    /// Remove a resource by its subject URL.
    #[wasm_bindgen(js_name = "removeResource")]
    pub async fn remove_resource(&self, subject: &str) -> Result<(), JsError> {
        let subject = Subject::from(subject);
        self.db.remove_resource(&subject).await.map_err(to_js_err)?;
        Ok(())
    }

    /// Query the local database.
    /// `property` and `value` are optional filters.
    /// Returns a JSON object: `{ subjects: string[], resources: string[], count: number }`.
    #[allow(clippy::too_many_arguments)]
    pub async fn query(
        &self,
        property: Option<String>,
        value: Option<String>,
        sort_by: Option<String>,
        sort_desc: Option<bool>,
        limit: Option<usize>,
        offset: Option<usize>,
        include_resources: Option<bool>,
        drive: Option<String>,
    ) -> Result<JsValue, JsError> {
        let q = Query {
            property,
            value: value.map(Value::String),
            sort_by,
            sort_desc: sort_desc.unwrap_or(false),
            limit,
            offset: offset.unwrap_or(0),
            start_val: None,
            end_val: None,
            include_external: false,
            include_nested: include_resources.unwrap_or(false),
            for_agent: atomic_lib::agents::ForAgent::Sudo,
            drive: drive.map(Subject::from),
        };

        let result = self.db.query(&q).await.map_err(to_js_err)?;
        let response = QueryResponse::from_result(&result)?;
        serde_wasm_bindgen::to_value(&response).map_err(|e| JsError::new(&e.to_string()))
    }

    /// Store a Loro CRDT snapshot (raw bytes) for a resource subject.
    #[wasm_bindgen(js_name = "putLoroSnapshot")]
    pub fn put_loro_snapshot(&self, subject: &str, data: &[u8]) -> Result<(), JsError> {
        use atomic_lib::db::trees::Tree;
        self.db
            .kv
            .insert(Tree::LoroSnapshots, subject.as_bytes(), data)
            .map_err(to_js_err)
    }

    /// Retrieve a Loro CRDT snapshot for a resource subject. Returns null if not found.
    #[wasm_bindgen(js_name = "getLoroSnapshot")]
    pub fn get_loro_snapshot(&self, subject: &str) -> Result<JsValue, JsError> {
        use atomic_lib::db::trees::Tree;
        match self.db.kv.get(Tree::LoroSnapshots, subject.as_bytes()) {
            Ok(Some(data)) => Ok(js_sys::Uint8Array::from(data.as_slice()).into()),
            Ok(None) => Ok(JsValue::NULL),
            Err(e) => Err(to_js_err(e)),
        }
    }

    /// Store a binary blob keyed by its BLAKE3 hash.
    #[wasm_bindgen(js_name = "putBlob")]
    pub fn put_blob(&self, hash: &[u8], data: &[u8]) -> Result<(), JsError> {
        use atomic_lib::db::trees::Tree;
        if hash.len() != 32 {
            return Err(to_js_err("Hash must be 32 bytes"));
        }
        self.db
            .kv
            .insert(Tree::Blobs, hash, data)
            .map_err(to_js_err)
    }

    /// Retrieve a binary blob by its BLAKE3 hash. Returns null if not found.
    #[wasm_bindgen(js_name = "getBlob")]
    pub fn get_blob(&self, hash: &[u8]) -> Result<JsValue, JsError> {
        use atomic_lib::db::trees::Tree;
        if hash.len() != 32 {
            return Err(to_js_err("Hash must be 32 bytes"));
        }
        match self.db.kv.get(Tree::Blobs, hash) {
            Ok(Some(data)) => Ok(js_sys::Uint8Array::from(data.as_slice()).into()),
            Ok(None) => Ok(JsValue::NULL),
            Err(e) => Err(to_js_err(e)),
        }
    }

    /// Compute a BLAKE3 hash of the given data.
    #[wasm_bindgen(js_name = "blake3Hash")]
    pub fn blake3_hash(&self, data: &[u8]) -> Vec<u8> {
        blake3::hash(data).as_bytes().to_vec()
    }

    /// Get version vectors for all Loro snapshots in the database.
    /// Returns a JSON object: `{ [subject]: { [peer_id]: counter } }`
    #[wasm_bindgen(js_name = "getAllVersionVectors")]
    pub fn get_all_version_vectors(&self) -> Result<JsValue, JsError> {
        use atomic_lib::db::trees::Tree;
        use atomic_lib::loro::AtomicLoroDoc;
        use std::collections::HashMap;

        let mut result: HashMap<String, HashMap<String, i32>> = HashMap::new();

        for item in self.db.kv.iter_tree(Tree::LoroSnapshots) {
            let (key_bytes, snapshot_bytes) = item.map_err(to_js_err)?;
            let subject = String::from_utf8(key_bytes).map_err(|e| JsError::new(&e.to_string()))?;

            match AtomicLoroDoc::from_snapshot(&snapshot_bytes) {
                Ok(doc) => {
                    result.insert(subject, doc.oplog_vv_map());
                }
                Err(e) => {
                    web_sys::console::warn_1(
                        &format!("[ClientDb] Failed to read VV for {}: {e}", &subject).into(),
                    );
                }
            }
        }

        serde_wasm_bindgen::to_value(&result).map_err(|e| JsError::new(&e.to_string()))
    }

    /// Get all subjects in the database.
    #[wasm_bindgen(js_name = "allSubjects")]
    pub fn all_subjects(&self) -> Result<JsValue, JsError> {
        let subjects: Vec<String> = self
            .db
            .all_resources(true)
            .map(|r| r.get_subject().to_string())
            .collect();
        serde_wasm_bindgen::to_value(&subjects).map_err(|e| JsError::new(&e.to_string()))
    }

    /// Populate the database with default Atomic Data vocabulary
    /// (classes, properties, datatypes).
    pub async fn populate(&self) -> Result<(), JsError> {
        self.db.populate().await.map_err(to_js_err)
    }

    /// Export all resources as a JSON array of JSON-AD objects.
    /// Used to snapshot the DB to IndexedDB for persistence across page reloads.
    #[wasm_bindgen(js_name = "exportAllResources")]
    pub fn export_all_resources(&self) -> Result<String, JsError> {
        let mut resources = Vec::new();

        for resource in self.db.all_resources(true) {
            if let Ok(json_ad) = resource.to_json_ad(None) {
                resources.push(json_ad);
            }
        }

        Ok(format!("[{}]", resources.join(",")))
    }

    /// Import resources from a JSON array of JSON-AD objects.
    /// Used to restore a snapshot from IndexedDB on init.
    /// Skips indexing during import and builds the index once at the end.
    #[wasm_bindgen(js_name = "importAllResources")]
    pub async fn import_all_resources(&self, json_array: &str) -> Result<u32, JsError> {
        let items: Vec<serde_json::Value> = serde_json::from_str(json_array).map_err(to_js_err)?;

        let mut count: u32 = 0;

        for item in &items {
            let json_str = item.to_string();

            if let Ok(resource) = atomic_lib::parse::parse_json_ad_resource(
                &json_str,
                &self.db,
                &ParseOpts {
                    skip_unknown_props: true,
                    save: atomic_lib::parse::SaveOpts::DontSave,
                    ..Default::default()
                },
            )
            .await
            {
                // Store without indexing — we build the index once at the end
                if self
                    .db
                    .add_resource_opts(&resource, false, false, true)
                    .await
                    .is_ok()
                {
                    count += 1;
                }
            }
        }

        // Build the full index once
        self.db.build_index(true).map_err(to_js_err)?;

        Ok(count)
    }
}

#[derive(serde::Serialize)]
struct QueryResponse {
    subjects: Vec<String>,
    resources: Vec<String>,
    count: usize,
}

impl QueryResponse {
    fn from_result(result: &QueryResult) -> Result<Self, JsError> {
        let subjects: Vec<String> = result.subjects.iter().map(|s| s.to_string()).collect();

        let resources: Vec<String> = result
            .resources
            .iter()
            .map(resource_to_json_ad)
            .collect::<Result<Vec<_>, _>>()?;

        Ok(QueryResponse {
            subjects,
            resources,
            count: result.count,
        })
    }
}

fn resource_to_json_ad(resource: &Resource) -> Result<String, JsError> {
    resource.to_json_ad(None).map_err(to_js_err)
}

fn to_js_err(e: impl std::fmt::Display) -> JsError {
    JsError::new(&e.to_string())
}
