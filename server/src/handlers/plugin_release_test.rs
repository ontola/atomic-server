//! `/plugin-package/{id}` and `/plugin-package/{id}/zip` against a real store.
//!
//! A listed release is public. A private one is served to whoever can read
//! its `Release` resource, which lives under the publisher's drive, and to
//! nobody else. `/plugin-catalog` is the query over this server's Listings.

use actix_web::{
    body::MessageBody,
    dev::ServiceResponse,
    test::{self, TestRequest},
    web::Data,
    App,
};
use atomic_lib::{db::plugin_release::PluginRelease, Storelike};

use crate::appstate::AppState;
use crate::plugins::{release, test_fixture::fixture};

const TEST_PLUGIN_ZIP: &[u8] =
    include_bytes!("../../../browser/e2e/tests/fixtures/test-plugin.zip");

/// Signs as the store's default agent, who owns the fixture drive.
fn signed(path: &str, appstate: &AppState) -> TestRequest {
    let origin = appstate.config.get_origin();
    let url = format!("{origin}{path}");
    let headers = atomic_lib::client::get_authentication_headers(
        &url,
        &appstate.store.get_default_agent().unwrap(),
    )
    .expect("auth headers");
    let mut request = TestRequest::with_uri(path);
    for (key, value) in headers {
        request = request.insert_header((key, value));
    }
    with_host(request, &origin)
}

fn with_host(mut request: TestRequest, origin: &str) -> TestRequest {
    if let Ok(parsed) = url::Url::parse(origin) {
        if let Some(host) = parsed.host_str() {
            let authority = match parsed.port() {
                Some(port) => format!("{host}:{port}"),
                None => host.to_string(),
            };
            request = request.insert_header(("Host", authority));
        }
    }
    request
}

fn body_of(response: ServiceResponse) -> Vec<u8> {
    response
        .into_body()
        .try_into_bytes()
        .expect("a complete body")
        .to_vec()
}

#[actix_rt::test]
async fn a_private_release_is_served_to_a_reader_of_its_drive_only() {
    let f = fixture("plugin_package_private").await;
    let db = &f.appstate.store;
    let origin = f.appstate.config.get_origin();
    let (id, published, _) = release::publish_package(db, TEST_PLUGIN_ZIP, None)
        .await
        .unwrap();
    let subject = release::record_release(db, &id, &published, &f.drive, None, &origin)
        .await
        .unwrap();
    // The resource is where an Installation's `release` can point.
    assert_eq!(subject.resolve(&origin), format!("{origin}/releases/{id}"));
    let recorded = db.get_resource(&subject).await.unwrap();
    assert_eq!(
        recorded
            .get(atomic_lib::urls::RELEASE_ID)
            .unwrap()
            .to_string(),
        id
    );

    let service = test::init_service(
        App::new()
            .app_data(Data::new(f.appstate.clone()))
            .configure(crate::routes::config_routes),
    )
    .await;
    let path = format!("/plugin-package/{id}");

    // Not catalogued, not signed: the drive is private.
    let refused = test::call_service(
        &service,
        with_host(TestRequest::with_uri(&path), &origin).to_request(),
    )
    .await;
    assert_eq!(
        refused.status(),
        401,
        "{}",
        String::from_utf8_lossy(&body_of(refused))
    );

    // The drive's owner sees the record: the package hash, never the bytes.
    let served = test::call_service(&service, signed(&path, &f.appstate).to_request()).await;
    assert_eq!(served.status(), 200);
    let record: PluginRelease = serde_json::from_slice(&body_of(served)).unwrap();
    assert_eq!(record, published);
    assert!(record.source.is_none());
    assert_eq!(record.manifest["schemaVersion"], 2);

    // And the zip, byte for byte.
    let zip_path = format!("{path}/zip");
    let refused = test::call_service(
        &service,
        with_host(TestRequest::with_uri(&zip_path), &origin).to_request(),
    )
    .await;
    assert_eq!(refused.status(), 401);
    let zipped = test::call_service(&service, signed(&zip_path, &f.appstate).to_request()).await;
    assert_eq!(zipped.status(), 200);
    assert_eq!(
        zipped
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok()),
        Some("application/zip")
    );
    assert_eq!(body_of(zipped), TEST_PLUGIN_ZIP);

    // An id nobody published is not a resource either.
    let unknown = format!("blake3:{}", "0".repeat(64));
    let missing = test::call_service(
        &service,
        signed(&format!("/plugin-package/{unknown}"), &f.appstate).to_request(),
    )
    .await;
    assert_ne!(missing.status(), 200);
}

#[actix_rt::test]
async fn a_listed_release_is_public_and_a_js_release_has_no_zip() {
    let f = fixture("plugin_package_public").await;
    let db = &f.appstate.store;
    let origin = f.appstate.config.get_origin();
    let js = PluginRelease::js(
        "export function run() { return { intents: [] }; }".into(),
        serde_json::json!({"schemaVersion": 1}),
        Default::default(),
    );
    // A private release first: nothing is listed.
    let private = release::publish_release(db, &js, &f.drive, None, &origin, None)
        .await
        .unwrap();
    assert!(private.listing.is_none());
    assert!(!release::is_listed(db, &private.id).await);

    // Publishing it publicly lists it; the drive itself stays private.
    let published = release::publish_release(
        db,
        &js,
        &f.drive,
        Some("did:ad:publisher"),
        &origin,
        Some(release::ListingInput {
            name: "Example".into(),
            emoji: Some("🧪".into()),
            description: "An example".into(),
            domains: vec!["education".into()],
            standards: vec!["https://example.com/standard".into()],
        }),
    )
    .await
    .unwrap();
    let id = published.id.clone();
    assert_eq!(id, private.id);
    let listing = published.listing.clone().expect("a Listing");
    assert_eq!(listing.resolve(&origin), format!("{origin}/listings/{id}"));
    assert!(release::is_listed(db, &id).await);
    // Listing again is a no-op.
    assert_eq!(
        release::publish_release(
            db,
            &js,
            &f.drive,
            None,
            &origin,
            Some(release::ListingInput::default())
        )
        .await
        .unwrap()
        .listing,
        Some(listing)
    );
    // A standard that is not an HTTP link is refused.
    let mut other = js.clone();
    other.source = Some("export function run() { return {}; }".into());
    assert!(release::publish_release(
        db,
        &other,
        &f.drive,
        None,
        &origin,
        Some(release::ListingInput {
            standards: vec!["ftp://nope".into()],
            ..Default::default()
        })
    )
    .await
    .is_err());

    let service = test::init_service(
        App::new()
            .app_data(Data::new(f.appstate.clone()))
            .configure(crate::routes::config_routes),
    )
    .await;

    // The marketplace is a class query over Listings, readable unsigned.
    let catalog = test::call_service(
        &service,
        with_host(TestRequest::with_uri("/plugin-catalog"), &origin).to_request(),
    )
    .await;
    assert_eq!(catalog.status(), 200);
    let entries: Vec<serde_json::Value> = serde_json::from_slice(&body_of(catalog)).unwrap();
    assert_eq!(entries.len(), 1, "{entries:?}");
    let entry = &entries[0];
    assert_eq!(entry["name"], "Example");
    assert_eq!(entry["emoji"], "🧪");
    assert_eq!(entry["description"], "An example");
    assert_eq!(entry["publisher"], "atomic:publisher");
    assert_eq!(entry["domains"], serde_json::json!(["education"]));
    assert_eq!(
        entry["standards"],
        serde_json::json!(["https://example.com/standard"])
    );
    assert_eq!(entry["releaseId"], id);
    assert_eq!(entry["release"], format!("{origin}/releases/{id}"));
    assert_eq!(entry["subject"], format!("{origin}/listings/{id}"));
    assert_eq!(entry["runtime"], "atomic-js/1");
    assert_eq!(entry["world"], "extension");

    let served = test::call_service(
        &service,
        with_host(
            TestRequest::with_uri(&format!("/plugin-package/{id}")),
            &origin,
        )
        .to_request(),
    )
    .await;
    assert_eq!(served.status(), 200);
    let record: PluginRelease = serde_json::from_slice(&body_of(served)).unwrap();
    assert_eq!(record, js);

    let no_zip = test::call_service(
        &service,
        with_host(
            TestRequest::with_uri(&format!("/plugin-package/{id}/zip")),
            &origin,
        )
        .to_request(),
    )
    .await;
    assert_eq!(no_zip.status(), 400);
}

/// A publish is refused before it writes anything, so a rejected request
/// leaves no package bytes and no cached release on the node. `test-plugin.zip`
/// extends classes, which makes it a `server-extension`, so claiming it is an
/// `extension` is the refusal to provoke.
#[actix_rt::test]
async fn a_publish_that_claims_the_wrong_world_stores_nothing() {
    let f = fixture("plugin_package_wrong_world").await;
    let db = &f.appstate.store;
    let hash = blake3::hash(TEST_PLUGIN_ZIP);

    let err = release::publish_package(db, TEST_PLUGIN_ZIP, Some("extension"))
        .await
        .expect_err("a package that extends classes is not an extension")
        .to_string();
    assert!(err.contains("server-extension"), "{err}");
    assert!(err.contains("claimed extension"), "{err}");

    assert!(
        !db.has_blob(hash.as_bytes()).await.unwrap(),
        "a refused publish must not leave the package bytes behind"
    );

    // The release id is the content hash, so publishing the same bytes in
    // another store names the record this one must not hold.
    let other = fixture("plugin_package_wrong_world_reference").await;
    let (id, _, _) = release::publish_package(&other.appstate.store, TEST_PLUGIN_ZIP, None)
        .await
        .unwrap();
    assert!(
        db.get_plugin_release(&id).is_err(),
        "a refused publish must not leave a cached release behind"
    );

    // Without a claim the same bytes publish, which is what makes the refusal
    // the world check rather than anything about the zip.
    let (published, _, _) = release::publish_package(db, TEST_PLUGIN_ZIP, None)
        .await
        .unwrap();
    assert_eq!(published, id);
    assert!(db.has_blob(hash.as_bytes()).await.unwrap());
}
