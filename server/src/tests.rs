//! This contains a minimal set of tests for the server.
//! Most of the more rigorous testing is done in the end-to-end tests:
//! https://github.com/atomicdata-dev/atomic-data-browser/tree/main/data-browser/tests

use crate::{appstate::AppState, config::Opts};

use super::*;
use actix_web::{
    body::MessageBody,
    dev::ServiceResponse,
    test::{self, TestRequest},
    web::Data,
    App,
};
use atomic_lib::{urls, Storelike};
use base64::Engine;

/// Returns the request with signed headers. Also adds a json-ad accept header - overwrite this if you need something else.
fn build_request_authenticated(path: &str, appstate: &AppState) -> TestRequest {
    let origin = appstate.config.get_origin();
    let url = format!("{}{}", origin, path);
    let headers = atomic_lib::client::get_authentication_headers(
        &url,
        &appstate.store.get_default_agent().unwrap(),
    )
    .expect("could not get auth headers");

    let mut prereq = test::TestRequest::with_uri(path);
    for (k, v) in headers {
        prereq = prereq.insert_header((k, v));
    }

    // Ensure the Host header matches the origin used for signing
    if let Ok(u) = url::Url::parse(&origin) {
        if let Some(host) = u.host_str() {
            let authority = if let Some(port) = u.port() {
                format!("{}:{}", host, port)
            } else {
                host.to_string()
            };
            prereq = prereq.insert_header(("Host", authority));
        }
    }

    prereq.insert_header(("Accept", "application/ad+json"))
}

#[actix_rt::test]
async fn server_tests() {
    // Enable logging
    let _ = tracing_subscriber::fmt()
        .with_env_filter("info,atomic_server=trace")
        .try_init();

    let unique_string = atomic_lib::utils::random_string(10);
    use clap::Parser;
    let opts = Opts::parse_from([
        "atomic-server",
        "--initialize",
        "--data-dir",
        &format!("./.temp/{}/db", unique_string),
        "--config-dir",
        &format!("./.temp/{}/config", unique_string),
    ]);

    let mut config = config::build_config(opts)
        .map_err(|e| format!("Initialization failed: {}", e))
        .expect("failed init config");
    // This prevents folder access issues when running concurrent tests
    config.search_index_path = format!("./.temp/{}/search_index", unique_string).into();

    let appstate = crate::appstate::AppState::init(config.clone())
        .await
        .expect("failed init appstate");
    let data = Data::new(appstate.clone());
    let app = test::init_service(
        App::new()
            .app_data(data)
            .configure(crate::routes::config_routes),
    )
    .await;
    let store = &appstate.store;

    // Does not work, unfortunately, because the server is not accessible.
    // let fetched =
    //     atomic_lib::client::fetch_resource(&appstate.config.get_origin(), &appstate.store, None)
    //         .expect("could not fetch drive");

    // Get HTML page
    let req =
        build_request_authenticated("/", &appstate).insert_header(("Accept", "application/html"));
    let resp = test::call_service(&app, req.to_request()).await;
    let is_success = resp.status().is_success();
    let body = get_body(resp);
    // println!("{:?}", body);
    assert!(is_success);
    assert!(body.as_str().contains("html"));

    // Should 200 (public)
    let req =
        test::TestRequest::with_uri("/properties").insert_header(("Accept", "application/ad+json"));
    let resp = test::call_service(&app, req.to_request()).await;
    assert_eq!(
        resp.status().as_u16(),
        200,
        "properties collections should be found and public"
    );

    // Should 404
    let req = test::TestRequest::with_uri("/doesnotexist")
        .append_header(("Accept", "application/ld+json"))
        .to_request();
    let resp = test::call_service(&app, req).await;
    assert!(resp.status().is_client_error());

    // Edit the main drive, make it hidden to the public agent
    let mut drive = store.get_resource(&"internal:/".into()).await.unwrap();
    drive
        .set(
            urls::READ.into(),
            vec![appstate.store.get_default_agent().unwrap().subject].into(),
            &appstate.store,
        )
        .await
        .unwrap();
    drive.save(store).await.unwrap();

    // Should 401 (Unauthorized)
    let req =
        test::TestRequest::with_uri("/properties").insert_header(("Accept", "application/ad+json"));
    let resp = test::call_service(&app, req.to_request()).await;
    let status = resp.status().as_u16();
    let body = get_body(resp);
    if status != 401 {
        panic!(
            "Public request to /properties status: {}. Expected 401. Body: {}",
            status, body
        );
    }

    // Get JSON-AD
    let req = build_request_authenticated("/properties", &appstate);
    let resp = test::call_service(&app, req.to_request()).await;
    let status = resp.status().as_u16();
    let body = get_body(resp);
    if status >= 400 {
        panic!(
            "Auth request to /properties status: {}. Expected success. Body: {}",
            status, body
        );
    }
    if !body.contains("\"@id\"") {
        panic!("response should be json-ad. Body: {}", body);
    }

    // Get JSON-LD
    let req = build_request_authenticated("/properties", &appstate)
        .insert_header(("Accept", "application/ld+json"));
    let resp = test::call_service(&app, req.to_request()).await;
    assert!(resp.status().is_success(), "setup not returning JSON-LD");
    let body = get_body(resp);
    assert!(
        body.as_str().contains("@context"),
        "response should be json-ld"
    );

    // Get turtle
    let req = build_request_authenticated("/properties", &appstate)
        .insert_header(("Accept", "text/turtle"));
    let resp = test::call_service(&app, req.to_request()).await;
    assert!(resp.status().is_success());
    let body = get_body(resp);
    assert!(
        body.as_str().starts_with("<"),
        "response should be turtle, but was: {}",
        body.as_str()
    );

    // Get Search
    // Does not test the contents of the results - the index isn't built at this point
    let req = build_request_authenticated("/search?q=setup", &appstate);
    let resp = test::call_service(&app, req.to_request()).await;
    assert!(resp.status().is_success());
    let body = get_body(resp);
    println!("{}", body.as_str());
    assert!(
        body.as_str().contains("/results"),
        "response should be a search resource"
    );

    // Get DID endpoint
    let req = build_request_authenticated("/did", &appstate);
    let resp = test::call_service(&app, req.to_request()).await;
    assert!(resp.status().is_success());
    let body = get_body(resp);
    assert!(
        body.as_str().contains("Resolves a DID"),
        "response should be the DID endpoint description"
    );

    // Test path-based DID resolution (even if it doesn't exist, we should get a 404 from the store, not a 500 or 401 before getting there)
    let req = build_request_authenticated("/did:ad:test", &appstate);
    let resp = test::call_service(&app, req.to_request()).await;
    // It should be a 404 because did:ad:test doesn't exist, but it confirms it reached the handler correctly
    assert_eq!(
        resp.status(),
        404,
        "Should be a 404, because `did:ad:test` does not exist"
    );

    // Test Unauthenticated Invite with Public Key
    let issuer_agent = appstate.store.get_default_agent().unwrap();
    let target_resource_subject = "https://atomicdata.dev/test/resource";
    // We need to create the target resource to check write rights
    let mut target = atomic_lib::Resource::new(target_resource_subject.into());
    target
        .set(
            urls::READ.into(),
            vec![issuer_agent.subject.clone()].into(),
            &appstate.store,
        )
        .await
        .unwrap();
    target
        .set(
            urls::WRITE.into(),
            vec![issuer_agent.subject.clone()].into(),
            &appstate.store,
        )
        .await
        .unwrap();
    target.save_locally(&appstate.store).await.unwrap();

    let expiration = atomic_lib::utils::now() + 100000;

    // Construct the InviteToken manually as we don't have a helper in the lib for this yet
    // This replicates what the frontend does
    let mut signable_json = serde_json::Map::new();
    signable_json.insert(
        urls::TARGET.into(),
        serde_json::Value::String(target_resource_subject.into()),
    );
    signable_json.insert(urls::WRITE_BOOL.into(), serde_json::Value::Bool(true));
    signable_json.insert(
        urls::EXPIRES_AT.into(),
        serde_json::Value::Number(expiration.into()),
    );
    signable_json.insert(
        urls::SIGNER.into(),
        serde_json::Value::String(issuer_agent.subject.to_string()),
    );

    let serialized = serde_jcs::to_string(&signable_json).unwrap();
    let private_key = issuer_agent.private_key.clone().unwrap();
    let signature =
        atomic_lib::commit::sign_message(&serialized, &private_key, &issuer_agent.public_key)
            .unwrap();

    let mut map = signable_json;
    map.insert(urls::SIGNATURE.into(), serde_json::Value::String(signature));

    let bytes = serde_json::to_vec(&map).unwrap();
    let token_base64 = base64::engine::general_purpose::STANDARD.encode(bytes);
    let token_encoded: String =
        url::form_urlencoded::byte_serialize(token_base64.as_bytes()).collect();

    // Generate a new public key for the visitor
    let visitor_agent = atomic_lib::agents::Agent::new(None).unwrap();
    let public_key = visitor_agent.public_key; // This gives the Base64 public key
    let public_key_encoded: String =
        url::form_urlencoded::byte_serialize(public_key.as_bytes()).collect();

    let path = format!(
        "/invites?token={}&public-key={}",
        token_encoded, public_key_encoded
    );

    // Use an unauthenticated request
    let req = test::TestRequest::with_uri(&path).insert_header(("Accept", "application/ad+json"));
    let resp = test::call_service(&app, req.to_request()).await;

    assert!(
        resp.status().is_success(),
        "Invite request failed: Status {}",
        resp.status()
    );

    let body = get_body(resp);

    assert!(
        body.contains(urls::DESTINATION) || body.contains(urls::INVITE),
        "Response should contain either destination (redirect) or invite metadata. Body: {}",
        body
    );
}

/// Gets the body from the response as a String. Why doen't actix provide this?
fn get_body(resp: ServiceResponse) -> String {
    let boxbody = resp.into_body();
    let bytes = boxbody.try_into_bytes().unwrap();
    String::from_utf8(bytes.as_ref().into()).unwrap()
}
