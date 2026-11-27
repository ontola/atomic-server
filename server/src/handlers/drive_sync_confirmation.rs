use crate::{
    appstate::AppState, errors::AtomicServerResult, helpers::get_client_agent_for_signed_url,
};
use actix_web::{web, HttpRequest, HttpResponse};
use atomic_lib::{sync::confirmation::try_confirm_drive, Storelike, Subject};
use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfirmationParams {
    subject: String,
    hash: String,
    hash_version: u8,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ConfirmationResponse {
    version: u8,
    drive: String,
    hash_version: u8,
    drive_hash: String,
    confirmed: bool,
    checked_blobs: u64,
}

pub async fn handle_drive_sync_confirmation(
    appstate: web::Data<AppState>,
    params: web::Query<ConfirmationParams>,
    req: HttpRequest,
) -> AtomicServerResult<HttpResponse> {
    if params.hash_version != 2
        || params.hash.len() != 64
        || !params
            .hash
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Ok(HttpResponse::BadRequest()
            .insert_header(("Cache-Control", "no-store"))
            .finish());
    }
    let store = &appstate.store;
    let agent = match get_client_agent_for_signed_url(&req, &appstate).await {
        Ok(agent) => agent,
        Err(_) => {
            return Ok(HttpResponse::Unauthorized()
                .insert_header(("Cache-Control", "no-store"))
                .finish())
        }
    };
    let subject = Subject::from_raw(&params.subject, store.get_base_domain().as_deref());
    if !subject.is_local() {
        return Ok(HttpResponse::NotFound()
            .insert_header(("Cache-Control", "no-store"))
            .finish());
    }
    let normalized = atomic_lib::sync::engine::WireScheme::CANONICAL
        .subject(&store.normalize_subject(&subject).pure_id());
    match try_confirm_drive(store, &subject, &agent, &params.hash).await {
        Ok(Some((drive_hash, confirmed, checked_blobs))) => Ok(HttpResponse::Ok()
            .insert_header(("Cache-Control", "no-store"))
            .json(ConfirmationResponse {
                version: 1,
                drive: normalized,
                hash_version: 2,
                drive_hash,
                confirmed,
                checked_blobs,
            })),
        // A healthy overlapping mutation prevents a proof, not availability.
        Ok(None) => Ok(HttpResponse::NoContent()
            .insert_header(("Cache-Control", "no-store"))
            .finish()),
        // Actual inventory/auth/storage failures remain errors. Do not expose
        // internal subjects or error details in the response.
        Err(e) if e.error_type == atomic_lib::errors::AtomicErrorType::UnauthorizedError => {
            Ok(HttpResponse::Unauthorized()
                .insert_header(("Cache-Control", "no-store"))
                .finish())
        }
        Err(_) => Ok(HttpResponse::ServiceUnavailable()
            .insert_header(("Cache-Control", "no-store"))
            .finish()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use actix_web::{test, App};
    use atomic_lib::{
        agents::Agent,
        db::kv_store::{KvIter, KvStore, ReplicaIdentity},
        db::trees::Tree,
        errors::AtomicResult,
    };
    use clap::Parser;
    use std::sync::{
        atomic::{AtomicU8, Ordering},
        Arc,
    };

    struct ControlledFlush(
        std::sync::Arc<dyn KvStore>,
        std::sync::Arc<std::sync::atomic::AtomicU8>,
    );

    impl KvStore for ControlledFlush {
        fn replica_identity(&self, scope: &str) -> AtomicResult<Option<ReplicaIdentity>> {
            self.0.replica_identity(scope)
        }
        fn get(&self, tree: Tree, key: &[u8]) -> AtomicResult<Option<Vec<u8>>> {
            self.0.get(tree, key)
        }
        fn insert(&self, tree: Tree, key: &[u8], val: &[u8]) -> AtomicResult<()> {
            self.0.insert(tree, key, val)
        }
        fn remove(&self, tree: Tree, key: &[u8]) -> AtomicResult<()> {
            self.0.remove(tree, key)
        }
        fn contains_key(&self, tree: Tree, key: &[u8]) -> AtomicResult<bool> {
            self.0.contains_key(tree, key)
        }
        fn scan_prefix(&self, tree: Tree, prefix: &[u8]) -> KvIter {
            self.0.scan_prefix(tree, prefix)
        }
        fn range(&self, tree: Tree, start: Vec<u8>, end: Vec<u8>, reverse: bool) -> KvIter {
            self.0.range(tree, start, end, reverse)
        }
        fn iter_tree(&self, tree: Tree) -> KvIter {
            self.0.iter_tree(tree)
        }
        fn clear_tree(&self, tree: Tree) -> AtomicResult<()> {
            self.0.clear_tree(tree)
        }
        fn apply_batch(&self, operations: &[atomic_lib::db::trees::Operation]) -> AtomicResult<()> {
            self.0.apply_batch(operations)
        }
        fn flush(&self) -> AtomicResult<()> {
            match self.1.load(std::sync::atomic::Ordering::SeqCst) {
                1 => self
                    .0
                    .insert(Tree::SyncReceipts, b"unrelated-drive", b"healthy-write")?,
                2 => return Err("injected confirmation I/O failure".into()),
                _ => (),
            }
            self.0.flush()
        }
        fn len(&self, tree: Tree) -> AtomicResult<usize> {
            self.0.len(tree)
        }
    }

    fn request(
        state: &AppState,
        owner: Option<&Agent>,
        drive: &str,
        hash: &str,
    ) -> test::TestRequest {
        let mut url = url::Url::parse(&format!(
            "{}/drive-sync-confirmation",
            state.config.get_origin()
        ))
        .unwrap();
        url.query_pairs_mut()
            .append_pair("subject", drive)
            .append_pair("hash", hash)
            .append_pair("hashVersion", "2");
        let mut request =
            test::TestRequest::get().uri(&format!("{}?{}", url.path(), url.query().unwrap()));
        if let Some(owner) = owner {
            for (name, value) in
                atomic_lib::client::get_authentication_headers(url.as_str(), owner).unwrap()
            {
                request = request.insert_header((name, value));
            }
        }
        request
    }

    #[actix_rt::test]
    async fn concurrent_write_is_no_content_but_storage_and_auth_failures_stay_errors() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().to_str().unwrap();
        let opts = crate::config::Opts::parse_from([
            "atomic-server",
            "--initialize",
            "--data-dir",
            root,
            "--config-dir",
            root,
        ]);
        let mut config = crate::config::build_config(opts).unwrap();
        config.search_index_path = directory.path().join("search");
        config.vector_search_index_path = directory.path().join("vectors");
        let mut state = AppState::init(config).await.unwrap();
        let (owner, drive) = state.store.setup("Confirmation owner").await.unwrap();
        let (hash, _, _) = atomic_lib::sync::confirmation::confirm_drive(
            &state.store,
            &drive.as_str().into(),
            &atomic_lib::agents::ForAgent::Sudo,
            "",
        )
        .await
        .unwrap();
        let mode = Arc::new(AtomicU8::new(0));
        state.store.kv = Arc::new(ControlledFlush(state.store.kv.clone(), mode.clone()));
        let app = test::init_service(App::new().app_data(web::Data::new(state.clone())).route(
            "/drive-sync-confirmation",
            web::get().to(handle_drive_sync_confirmation),
        ))
        .await;
        let response = test::call_service(
            &app,
            request(&state, Some(&owner), &drive, &hash).to_request(),
        )
        .await;
        assert_eq!(response.status(), 200);
        let proof: serde_json::Value = test::read_body_json(response).await;
        assert_eq!(proof["confirmed"], true);
        mode.store(1, Ordering::SeqCst);
        let response = test::call_service(
            &app,
            request(&state, Some(&owner), &drive, &hash).to_request(),
        )
        .await;
        assert_eq!(response.status(), 204);
        assert_eq!(response.headers().get("Cache-Control").unwrap(), "no-store");
        assert!(test::read_body(response).await.is_empty());
        let response =
            test::call_service(&app, request(&state, None, &drive, &hash).to_request()).await;
        assert_eq!(response.status(), 401);
        mode.store(2, Ordering::SeqCst);
        let response = test::call_service(
            &app,
            request(&state, Some(&owner), &drive, &hash).to_request(),
        )
        .await;
        assert_eq!(response.status(), 503);
        assert_eq!(response.headers().get("Cache-Control").unwrap(), "no-store");
        assert!(test::read_body(response).await.is_empty());
        mode.store(0, Ordering::SeqCst);
        let response = test::call_service(
            &app,
            request(&state, Some(&owner), &drive, &hash).to_request(),
        )
        .await;
        assert_eq!(response.status(), 200);
        let proof: serde_json::Value = test::read_body_json(response).await;
        assert_eq!(proof["confirmed"], true);
    }
}
