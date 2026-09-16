//! Clockify OAD/overlay traversal fixture: the first `apiKey`-scheme
//! platform in the catalog (Clockify has no OAuth2 login). Set
//! `CLOCKIFY_OAD_DIR` and `CLOCKIFY_OVERLAYS_DIR` to run it; the generated
//! provider document is maintained outside this crate, in
//! `localthought/openapi-directory` and `localthought/overlays`.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use syncables::client::client::{Fetch, HttpRequest, HttpResponse};
use syncables::{ClientConfig, Credentials, InMemoryStorage, SyncClient};

#[derive(Clone, Default)]
struct ClockifyFetch {
    requests: Arc<Mutex<Vec<String>>>,
}

#[async_trait]
impl Fetch for ClockifyFetch {
    async fn fetch(&self, request: HttpRequest) -> syncables::Result<HttpResponse> {
        self.requests.lock().unwrap().push(request.url.clone());
        Ok(HttpResponse {
            status: 200,
            headers: Default::default(),
            body: br#"[{"id":"entry-one","workspaceId":"ws-one","userId":"user-one"}]"#.to_vec(),
        })
    }
}

#[tokio::test]
#[ignore = "requires external published metadata fixtures"]
async fn clockify_time_entries_collection_is_discovered_and_synced_without_bearer_auth() {
    let oad_dir = std::env::var("CLOCKIFY_OAD_DIR").expect("set CLOCKIFY_OAD_DIR");
    let overlays_dir = std::env::var("CLOCKIFY_OVERLAYS_DIR").expect("set CLOCKIFY_OVERLAYS_DIR");
    let document_path = PathBuf::from(oad_dir).join("openapi.yaml");
    let overlays_dir = PathBuf::from(overlays_dir);
    let overlays = [
        "auth-overlay.yaml",
        "pagination-overlay.yaml",
        "crud-causality-overlay.yaml",
    ]
    .map(|name| overlays_dir.join(name))
    .to_vec();
    let document =
        syncables::load_open_api_document_with_overlays(document_path.as_path(), &overlays)
            .await
            .unwrap();

    let model = syncables::discover_resource_model(&document).unwrap();
    assert_eq!(model.collections.len(), 1);
    let collection = model.by_name("timeEntries").unwrap();
    assert_eq!(collection.resource, "timeEntry");
    assert_eq!(collection.id_field, "id");
    assert_eq!(
        model.root_parameters(),
        ["workspaceId".to_string(), "userId".to_string()]
            .into_iter()
            .collect()
    );
    assert!(model.reads.iter().any(|read| read.resource == "timeEntry"));

    // The declared scheme is `apiKey`, not `oauth2`/bearer: this crate's own
    // Credentials type only models Bearer/Anonymous, and never attaches an
    // Authorization header for Anonymous — the browser-owned proxy hop is
    // what actually injects the X-Api-Key header, on the other side of a
    // transport this crate doesn't see in production either. This test
    // fixes that boundary: no bearer token is fabricated here for a
    // platform that has none.
    let fetch = ClockifyFetch::default();
    let requests = fetch.requests.clone();
    let client = SyncClient::new(
        ClientConfig {
            document: document_path,
            overlays,
            credentials: Credentials::Anonymous,
            constants: BTreeMap::from([
                ("workspaceId".to_string(), "ws-one".to_string()),
                ("userId".to_string(), "user-one".to_string()),
            ]),
            ontology_base_url: "https://ontology.example/clockify".to_string(),
        },
        Arc::new(fetch),
    )
    .unwrap();
    let report = client
        .sync_document(&document, &InMemoryStorage::new())
        .await
        .unwrap();
    assert!(report.errors.is_empty(), "{:?}", report.errors);
    assert_eq!(report.read.get("timeEntry").copied().unwrap_or(0), 1);
    let requests = requests.lock().unwrap();
    assert!(requests
        .iter()
        .any(|url| url.contains("/v1/workspaces/ws-one/user/user-one/time-entries")));
}
