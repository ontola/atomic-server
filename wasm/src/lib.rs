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
    /// Create a new in-memory ClientDb.
    /// `base_url` is the server URL, e.g. "https://myserver.com".
    #[wasm_bindgen(constructor)]
    pub async fn new(base_url: Option<String>) -> Result<ClientDb, JsError> {
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
        let resource = atomic_lib::parse::parse_json_ad_resource(
            json_ad,
            &self.db,
            &ParseOpts::default(),
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
        let commit_resource = atomic_lib::parse::parse_json_ad_resource(
            commit_json_ad,
            &self.db,
            &ParseOpts::default(),
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
            validate_for_agent: None,
            update_index: true,
        };
        self.db.apply_commit(commit, &opts).await.map_err(to_js_err)?;
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
    pub async fn query(
        &self,
        property: Option<String>,
        value: Option<String>,
        sort_by: Option<String>,
        sort_desc: Option<bool>,
        limit: Option<usize>,
        offset: Option<usize>,
        include_resources: Option<bool>,
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
            drive: None,
        };

        let result = self.db.query(&q).await.map_err(to_js_err)?;
        let response = QueryResponse::from_result(&result)?;
        serde_wasm_bindgen::to_value(&response).map_err(|e| JsError::new(&e.to_string()))
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
            .map(|r| resource_to_json_ad(r))
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
