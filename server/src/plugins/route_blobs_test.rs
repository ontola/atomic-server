//! Blob request and response bodies through the app (#1720), with the
//! `files` fixture (`testdata/plugin-routes/files/`), a remoteStorage-like
//! plugin: `PUT /files/{*path}` stores a File, `GET /files/{*path}` serves
//! its blob.

use actix_web::{
    body::{BodySize, MessageBody},
    http::header,
    test as actix_test, web, App,
};
use atomic_lib::{db::app_agent::AppAgentKey, urls, Storelike, Value};
use serde_json::{json, Value as Json};

use super::{
    route_blobs,
    route_registry::slug,
    test_fixture::{
        files_release, fixture_with_args, genesis, install_release, install_release_with, Fixture,
    },
};

macro_rules! app {
    ($appstate:expr) => {
        actix_test::init_service(
            App::new()
                .app_data(web::Data::new($appstate.clone()))
                .configure(crate::routes::config_routes),
        )
        .await
    };
}

struct Files {
    f: Fixture,
    folder: String,
    installation: String,
    prefix: String,
}

/// A drive with a folder the installation's agent may write to, and the
/// files fixture installed with its route grant, at `read-write`.
async fn setup(name: &str, extra: &[&str]) -> Files {
    setup_with(name, extra, true).await
}

async fn setup_with(name: &str, extra: &[&str], granted: bool) -> Files {
    let mut args = vec!["--plugin-routes", "read-write"];
    args.extend_from_slice(extra);
    let f = fixture_with_args(name, &args).await;
    let store = &f.appstate.store;
    let folder = genesis(
        store,
        vec![
            (urls::PARENT, Value::AtomicUrl(f.drive.as_str().into())),
            (urls::NAME, Value::String("Files".into())),
        ],
    )
    .await;
    let release = files_release();
    let grant = granted.then(|| release.manifest["http"]["writeTargets"].clone());
    let installation = install_release_with(&f, &release, grant, Some(json!({ "folder": folder })))
        .await
        .unwrap();
    let agent = store
        .get_app_agent_info(&AppAgentKey::new(&f.drive, &installation))
        .unwrap()
        .unwrap()
        .agent;
    let mut resource = store.get_resource(&folder.as_str().into()).await.unwrap();
    resource
        .set_unsafe(
            urls::WRITE.into(),
            Value::ResourceArray(vec![agent.as_str().into()]),
        )
        .unwrap();
    // Public, like a remoteStorage public folder: the handler reads as the
    // public agent (`principal: anonymous`).
    resource
        .set_unsafe(
            urls::READ.into(),
            Value::ResourceArray(vec![urls::PUBLIC_AGENT.into()]),
        )
        .unwrap();
    resource.save(store).await.unwrap();
    let prefix = format!("/_routes/{}", slug(&installation));
    Files {
        f,
        folder,
        installation,
        prefix,
    }
}

fn put(uri: &str, content_type: &str, bytes: Vec<u8>) -> actix_test::TestRequest {
    actix_test::TestRequest::put()
        .uri(uri)
        .insert_header((header::CONTENT_TYPE, content_type))
        .set_payload(bytes)
}

/// Bytes that are not text, so nothing could pass them off as a string.
fn bytes(n: usize, seed: u8) -> Vec<u8> {
    (0..n)
        .map(|i| (i as u8).wrapping_mul(31).wrapping_add(seed))
        .collect()
}

fn hash(bytes: &[u8]) -> String {
    blake3::hash(bytes).to_hex().to_string()
}

async fn problem<B: MessageBody>(resp: actix_web::dev::ServiceResponse<B>) -> String {
    let body: Json = actix_test::read_body_json(resp).await;
    body["type"].as_str().unwrap_or_default().to_string()
}

fn header_of<B>(resp: &actix_web::dev::ServiceResponse<B>, name: header::HeaderName) -> String {
    resp.headers()
        .get(name)
        .map(|v| v.to_str().unwrap().to_string())
        .unwrap_or_default()
}

async fn has_blob(f: &Fixture, hash: &str) -> bool {
    f.appstate
        .store
        .has_blob(&hex::decode(hash).unwrap())
        .await
        .unwrap()
}

/// The Files under the folder, by name, with their blob.
async fn files(x: &Files) -> Vec<(String, String)> {
    let store = &x.f.appstate.store;
    let mut out: Vec<(String, String)> = store
        .get_resource(&x.folder.as_str().into())
        .await
        .unwrap()
        .get_children(store)
        .await
        .unwrap()
        .iter()
        .map(|c| {
            (
                c.get(urls::NAME).map(|v| v.to_string()).unwrap_or_default(),
                c.get(urls::BLOB).map(|v| v.to_string()).unwrap_or_default(),
            )
        })
        .collect();
    out.sort();
    out
}

#[actix_rt::test]
async fn an_upload_over_the_inline_limit_is_stored_and_the_handler_sees_a_reference() {
    let x = setup("route_blob_upload", &[]).await;
    let app = app!(x.f.appstate);
    // Twice the largest inline body a route may take.
    let body = bytes(2 * super::manifest_http::MAX_INLINE_BODY_BYTES as usize, 7);
    let h = hash(&body);
    let resp = actix_test::call_service(
        &app,
        put(
            &format!("{}/files/photos/a.bin", x.prefix),
            "application/octet-stream",
            body.clone(),
        )
        .to_request(),
    )
    .await;
    assert_eq!(resp.status(), 201);
    assert_eq!(header_of(&resp, header::ETAG), format!("\"{h}\""));
    let seen: Json = actix_test::read_body_json(resp).await;
    // The handler got the reference, never the bytes.
    assert_eq!(
        seen,
        json!({
            "blob": {
                "hash": h,
                "size": body.len(),
                "type": "application/octet-stream",
                "subject": format!("atomic:blob:{h}"),
            },
            "inline": null,
        })
    );
    let stored =
        x.f.appstate
            .store
            .get_blob(&hex::decode(&h).unwrap())
            .await
            .unwrap()
            .unwrap();
    assert_eq!(stored, body);
    assert_eq!(
        files(&x).await,
        vec![("photos/a.bin".to_string(), format!("atomic:blob:{h}"))]
    );
    // Recorded as this installation's.
    let blob = route_blobs::stored(&x.f.appstate.store, &x.installation, &h).unwrap();
    assert_eq!(blob.size, body.len() as u64);
}

#[actix_rt::test]
async fn a_blob_response_is_streamed_with_the_right_headers() {
    let x = setup("route_blob_serve", &[]).await;
    let app = app!(x.f.appstate);
    let body = b"hello, remote storage".to_vec();
    let h = hash(&body);
    let uri = format!("{}/files/notes/hello.txt", x.prefix);
    let resp = actix_test::call_service(
        &app,
        put(&uri, "text/plain; charset=utf-8", body.clone()).to_request(),
    )
    .await;
    assert_eq!(resp.status(), 201);

    let resp =
        actix_test::call_service(&app, actix_test::TestRequest::get().uri(&uri).to_request()).await;
    assert_eq!(resp.status(), 200);
    assert_eq!(
        header_of(&resp, header::CONTENT_TYPE),
        "text/plain; charset=utf-8"
    );
    assert_eq!(header_of(&resp, header::ETAG), format!("\"{h}\""));
    assert_eq!(header_of(&resp, header::X_CONTENT_TYPE_OPTIONS), "nosniff");
    assert_eq!(header_of(&resp, header::CACHE_CONTROL), "no-cache");
    assert_eq!(
        header_of(&resp, header::CONTENT_SECURITY_POLICY),
        "default-src 'none'; sandbox",
        "drive-prefix"
    );
    assert_eq!(
        resp.response().body().size(),
        BodySize::Sized(body.len() as u64)
    );
    assert_eq!(actix_test::read_body(resp).await, body);

    // HEAD: the length, not the bytes.
    let resp = actix_test::call_service(
        &app,
        actix_test::TestRequest::default()
            .method(actix_web::http::Method::HEAD)
            .uri(&uri)
            .to_request(),
    )
    .await;
    assert_eq!(resp.status(), 200);
    assert_eq!(header_of(&resp, header::ETAG), format!("\"{h}\""));
    assert_eq!(
        resp.response().body().size(),
        BodySize::Sized(body.len() as u64)
    );

    // Conditional GETs, answered by the host.
    let resp = actix_test::call_service(
        &app,
        actix_test::TestRequest::get()
            .uri(&uri)
            .insert_header((header::IF_NONE_MATCH, format!("\"{h}\"")))
            .to_request(),
    )
    .await;
    assert_eq!(resp.status(), 304);
    assert_eq!(header_of(&resp, header::ETAG), format!("\"{h}\""));
    assert!(actix_test::read_body(resp).await.is_empty());
    let resp = actix_test::call_service(
        &app,
        actix_test::TestRequest::get()
            .uri(&uri)
            .insert_header((header::IF_MATCH, "\"not-this-one\""))
            .to_request(),
    )
    .await;
    assert_eq!(resp.status(), 412);

    // The content type the blob was stored with, when the handler names none.
    let resp = actix_test::call_service(
        &app,
        actix_test::TestRequest::get()
            .uri(&format!("{}/raw/{h}", x.prefix))
            .to_request(),
    )
    .await;
    assert_eq!(resp.status(), 200);
    assert_eq!(
        header_of(&resp, header::CONTENT_TYPE),
        "text/plain; charset=utf-8"
    );

    // No HTML or SVG on the shared host, whatever the bytes are.
    for kind in ["text/html", "image/svg+xml"] {
        let resp = actix_test::call_service(
            &app,
            actix_test::TestRequest::get()
                .uri(&format!(
                    "{}/raw/{h}?type={}",
                    x.prefix,
                    kind.replace('+', "%2B")
                ))
                .to_request(),
        )
        .await;
        assert_eq!(resp.status(), 502, "{kind}");
        assert_eq!(problem(resp).await, "route-handler-failed");
    }
}

#[actix_rt::test]
async fn conditional_puts_store_nothing_when_the_precondition_fails() {
    let x = setup("route_blob_conditional", &[]).await;
    let app = app!(x.f.appstate);
    let uri = format!("{}/files/doc.txt", x.prefix);
    let first = b"first".to_vec();
    let second = b"second".to_vec();
    let third = b"third".to_vec();
    let (h1, h2) = (hash(&first), hash(&second));

    // Create only if absent.
    let create = |bytes: Vec<u8>| {
        put(&uri, "text/plain", bytes)
            .insert_header((header::IF_NONE_MATCH, "*"))
            .to_request()
    };
    let resp = actix_test::call_service(&app, create(first.clone())).await;
    assert_eq!(resp.status(), 201);
    let resp = actix_test::call_service(&app, create(second.clone())).await;
    assert_eq!(resp.status(), 412);
    assert_eq!(problem(resp).await, "route-precondition-failed");
    assert_eq!(
        files(&x).await,
        vec![("doc.txt".into(), format!("atomic:blob:{h1}"))]
    );

    // Update only the version the client saw.
    let update = |bytes: Vec<u8>, seen: &str| {
        put(&uri, "text/plain", bytes)
            .insert_header((header::IF_MATCH, format!("\"{seen}\"")))
            .to_request()
    };
    let resp = actix_test::call_service(&app, update(second.clone(), &h1)).await;
    assert_eq!(resp.status(), 200);
    assert_eq!(header_of(&resp, header::ETAG), format!("\"{h2}\""));
    let resp = actix_test::call_service(&app, update(third.clone(), &h1)).await;
    assert_eq!(resp.status(), 412, "a stale If-Match");
    assert_eq!(
        files(&x).await,
        vec![("doc.txt".into(), format!("atomic:blob:{h2}"))]
    );
}

#[actix_rt::test]
async fn an_oversized_body_is_refused_before_it_is_stored() {
    // The operator's cap (1000 bytes) is below the route default of 16 MiB.
    let x = setup(
        "route_blob_too_large",
        &["--plugin-route-max-blob-bytes", "1000"],
    )
    .await;
    let app = app!(x.f.appstate);
    let body = bytes(2000, 1);
    let resp = actix_test::call_service(
        &app,
        put(
            &format!("{}/files/big.bin", x.prefix),
            "application/octet-stream",
            body.clone(),
        )
        .to_request(),
    )
    .await;
    assert_eq!(resp.status(), 413);
    assert_eq!(problem(resp).await, "route-body-too-large");
    assert!(!has_blob(&x.f, &hash(&body)).await);

    // The route's own `maxBodyBytes` (1024), below the operator's default.
    let x = setup("route_blob_too_large_route", &[]).await;
    let app = app!(x.f.appstate);
    let body = bytes(1025, 2);
    let resp = actix_test::call_service(
        &app,
        put(
            &format!("{}/small/big.bin", x.prefix),
            "application/octet-stream",
            body.clone(),
        )
        .to_request(),
    )
    .await;
    assert_eq!(resp.status(), 413);
    assert!(!has_blob(&x.f, &hash(&body)).await);
    assert!(files(&x).await.is_empty());
    let ok = bytes(1024, 2);
    let resp = actix_test::call_service(
        &app,
        put(
            &format!("{}/small/ok.bin", x.prefix),
            "application/octet-stream",
            ok.clone(),
        )
        .to_request(),
    )
    .await;
    assert_eq!(resp.status(), 201);
    assert!(has_blob(&x.f, &hash(&ok)).await);
}

#[actix_rt::test]
async fn blob_bytes_count_toward_the_daily_byte_quota() {
    let x = setup(
        "route_blob_quota",
        &["--plugin-route-bytes-per-day", "5000"],
    )
    .await;
    let app = app!(x.f.appstate);
    let first = bytes(3000, 3);
    let resp = actix_test::call_service(
        &app,
        put(
            &format!("{}/files/one.bin", x.prefix),
            "application/octet-stream",
            first,
        )
        .to_request(),
    )
    .await;
    assert_eq!(resp.status(), 201);
    // 3000 of the blob plus the File's properties are booked.
    let (left, _) =
        x.f.appstate
            .route_exec
            .quotas
            .bytes_left(&x.installation, atomic_lib::utils::now())
            .unwrap();
    assert!(left < 2000, "{left} bytes left");

    let second = bytes(3000, 4);
    let resp = actix_test::call_service(
        &app,
        put(
            &format!("{}/files/two.bin", x.prefix),
            "application/octet-stream",
            second.clone(),
        )
        .to_request(),
    )
    .await;
    assert_eq!(resp.status(), 429);
    assert!(!header_of(&resp, header::RETRY_AFTER).is_empty());
    assert_eq!(problem(resp).await, "route-quota-exceeded");
    assert!(!has_blob(&x.f, &hash(&second)).await);
    assert_eq!(files(&x).await.len(), 1);
}

#[actix_rt::test]
async fn a_foreign_blob_is_neither_served_nor_adopted() {
    let x = setup("route_blob_foreign", &[]).await;
    let app = app!(x.f.appstate);
    let store = &x.f.appstate.store;
    // Bytes someone else stored, e.g. an upload in another drive.
    let secret = b"someone else's file".to_vec();
    let h = hash(&secret);
    store
        .put_blob(&hex::decode(&h).unwrap(), &secret)
        .await
        .unwrap();

    let raw = |h: &str| {
        actix_test::TestRequest::get()
            .uri(&format!("{}/raw/{h}", x.prefix))
            .to_request()
    };
    let resp = actix_test::call_service(&app, raw(&h)).await;
    assert_eq!(resp.status(), 502);
    assert_eq!(problem(resp).await, "route-blob-refused");

    // Nor can a route write the hash into its folder and serve it from there.
    let resp = actix_test::call_service(
        &app,
        actix_test::TestRequest::post()
            .uri(&format!("{}/link/stolen.txt", x.prefix))
            .insert_header((header::CONTENT_TYPE, "application/json"))
            .set_payload(json!({ "hash": h }).to_string())
            .to_request(),
    )
    .await;
    assert_eq!(resp.status(), 502);
    assert_eq!(problem(resp).await, "route-write-refused");
    assert!(files(&x).await.is_empty());

    // A File the owner put in the plugin's folder: its write target holds
    // that blob, so the plugin may serve it.
    genesis(
        store,
        vec![
            (urls::PARENT, Value::AtomicUrl(x.folder.as_str().into())),
            (urls::IS_A, Value::ResourceArray(vec![urls::FILE.into()])),
            (urls::NAME, Value::String("shared.txt".into())),
            (
                urls::DOWNLOAD_URL,
                Value::String("https://example.com/shared.txt".into()),
            ),
            (
                urls::BLOB,
                Value::AtomicUrl(format!("atomic:blob:{h}").into()),
            ),
        ],
    )
    .await;
    let resp = actix_test::call_service(&app, raw(&h)).await;
    assert_eq!(resp.status(), 200);
    assert_eq!(actix_test::read_body(resp).await, secret);

    // A blob the installation stored itself is its own.
    let own = b"mine".to_vec();
    let resp = actix_test::call_service(
        &app,
        put(
            &format!("{}/files/mine.txt", x.prefix),
            "text/plain",
            own.clone(),
        )
        .to_request(),
    )
    .await;
    assert_eq!(resp.status(), 201);
    let resp = actix_test::call_service(&app, raw(&hash(&own))).await;
    assert_eq!(resp.status(), 200);

    // A hash that is not one is the handler's fault.
    let resp = actix_test::call_service(&app, raw("nope")).await;
    assert_eq!(resp.status(), 502);
    assert_eq!(problem(resp).await, "route-handler-failed");
}

#[actix_rt::test]
async fn without_a_route_grant_nothing_is_stored() {
    let x = setup_with("route_blob_no_grant", &[], false).await;
    let app = app!(x.f.appstate);
    let body = b"not granted".to_vec();
    let resp = actix_test::call_service(
        &app,
        put(
            &format!("{}/files/x.txt", x.prefix),
            "text/plain",
            body.clone(),
        )
        .to_request(),
    )
    .await;
    assert_eq!(resp.status(), 403);
    assert_eq!(problem(resp).await, "route-write-not-granted");
    assert!(!has_blob(&x.f, &hash(&body)).await);
}

#[actix_rt::test]
async fn read_only_cannot_store_blobs() {
    // The release has a blob route, which needs `read-write`: at
    // `read-only` it does not install, so nothing can store through it.
    let f = fixture_with_args("route_blob_read_only", &["--plugin-routes", "read-only"]).await;
    let refused = install_release(&f, &files_release()).await;
    assert!(refused.is_err(), "{refused:?}");

    // Serving is a read: a GET-only release that answers with a blob
    // installs at `read-only`.
    let manifest = json!({
        "schemaVersion": 3,
        "name": "blob-reader",
        "namespace": "fixtures",
        "capabilities": [{ "name": "storage", "reason": "Fixture." }],
        "http": {
            "mount": "drive-prefix",
            "routes": [{
                "id": "raw", "path": "/raw/{hash}", "methods": ["GET"],
                "principal": "anonymous", "auth": "none"
            }]
        }
    });
    let release =
        super::test_fixture::js_release_with_source(super::test_fixture::FILES_SOURCE, manifest);
    let installation = install_release(&f, &release).await.unwrap();
    // A blob this installation stored (as it could have at `read-write`).
    let body = b"stored earlier".to_vec();
    let h = hash(&body);
    route_blobs::store(
        &f.appstate.store,
        &f.appstate.route_exec.quotas,
        &installation,
        &body,
        &h,
        "text/plain".into(),
        atomic_lib::utils::now(),
    )
    .await
    .unwrap();
    let app = app!(f.appstate);
    let resp = actix_test::call_service(
        &app,
        actix_test::TestRequest::get()
            .uri(&format!("/_routes/{}/raw/{h}", slug(&installation)))
            .to_request(),
    )
    .await;
    assert_eq!(resp.status(), 200);
    assert_eq!(header_of(&resp, header::CONTENT_TYPE), "text/plain");
    assert_eq!(actix_test::read_body(resp).await, body);
}
