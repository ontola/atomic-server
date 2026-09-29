//! `auth: dpop` routes through the app (atomic-plugins#167, section 3): the
//! `solid-dpop` fixture (`testdata/plugin-routes/solid-dpop/`) on the
//! `installation-origin` mount at `--plugin-routes read-write`, with a test
//! Solid-OIDC issuer whose documents come from memory.

use std::sync::Arc;

use actix_web::{http::header, test as actix_test, web, App};
use atomic_lib::{db::app_agent::AppAgentKey, urls, Storelike, Value};
use serde_json::{json, Value as Json};

use crate::plugins::{
    route_dpop::{
        testing::{issuer_docs, Client, Es256, ISSUER, WEBID},
        DpopVerifier, Issuers,
    },
    route_exec::RouteExecutor,
    route_registry::slug,
    test_fixture::{fixture_with_args, genesis, install_release_with, js_release_with_source, Fixture},
};

const SOURCE: &str = include_str!("../../../testdata/plugin-routes/solid-dpop/plugin.js");
const MANIFEST: &str = include_str!("../../../testdata/plugin-routes/solid-dpop/manifest.json");

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

struct Pod {
    f: Fixture,
    folder: String,
    host: String,
    issuer: Es256,
}

async fn setup(name: &str) -> Pod {
    let mut f = fixture_with_args(
        name,
        &[
            "--plugin-routes",
            "read-write",
            "--routes-origin",
            "http://routes.localhost:9883",
        ],
    )
    .await;
    let issuer = Es256::generate("issuer-key");
    let issuers = Issuers::parse(Some(ISSUER)).unwrap();
    f.appstate.route_exec = Arc::new(
        RouteExecutor::default().with_dpop(DpopVerifier::with_fetch(issuers, issuer_docs(&issuer))),
    );
    let store = &f.appstate.store;
    let folder = genesis(
        store,
        vec![
            (urls::PARENT, Value::AtomicUrl(f.drive.as_str().into())),
            (urls::NAME, Value::String("Pod".into())),
        ],
    )
    .await;
    let release = js_release_with_source(SOURCE, serde_json::from_str(MANIFEST).unwrap());
    let installation = install_release_with(
        &f,
        &release,
        Some(release.manifest["http"]["writeTargets"].clone()),
        Some(json!({ "folder": folder })),
    )
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
    resource.save(store).await.unwrap();
    let host = format!("{}.routes.localhost:9883", slug(&installation));
    Pod {
        f,
        folder,
        host,
        issuer,
    }
}

fn now() -> i64 {
    atomic_lib::utils::now() / 1000
}

fn request(method: &str, host: &str, path: &str) -> actix_test::TestRequest {
    let request = match method {
        "PUT" => actix_test::TestRequest::put()
            .insert_header((header::CONTENT_TYPE, "text/turtle"))
            .set_payload("<#it> <http://example.org/p> \"o\" ."),
        _ => actix_test::TestRequest::get(),
    };
    request.uri(path).insert_header((header::HOST, host))
}

fn authorized(
    request: actix_test::TestRequest,
    client: &Client,
    method: &str,
    url: &str,
    jti: &str,
) -> actix_test::TestRequest {
    request
        .insert_header((header::AUTHORIZATION, client.authorization()))
        .insert_header(("dpop", client.proof(method, url, now(), jti)))
}

async fn children(p: &Pod) -> Vec<atomic_lib::Resource> {
    let store = &p.f.appstate.store;
    store
        .get_resource(&p.folder.as_str().into())
        .await
        .unwrap()
        .get_children(store)
        .await
        .unwrap()
}

#[actix_rt::test]
async fn anonymous_requests_read_as_the_public_and_cannot_write() {
    let p = setup("dpop_anonymous").await;
    let app = app!(p.f.appstate);
    let resp = actix_test::call_service(&app, request("GET", &p.host, "/notes/a").to_request()).await;
    assert_eq!(resp.status(), 200);
    let links: Vec<_> = resp.headers().get_all(header::LINK).collect();
    assert_eq!(links.len(), 2, "one Link line per value");
    assert_eq!(resp.headers().get("wac-allow").unwrap(), "public=\"read\"");
    assert_eq!(resp.headers().get(header::ALLOW).unwrap(), "GET, HEAD, PUT");
    assert_eq!(resp.headers().get("accept-patch").unwrap(), "text/n3");
    let body: Json = actix_test::read_body_json(resp).await;
    assert_eq!(body["caller"], Json::Null);

    let resp = actix_test::call_service(&app, request("PUT", &p.host, "/notes/a").to_request()).await;
    assert_eq!(resp.status(), 502);
    let body: Json = actix_test::read_body_json(resp).await;
    assert_eq!(body["type"], "route-write-refused");
    assert!(children(&p).await.is_empty());
}

#[actix_rt::test]
async fn a_verified_webid_reaches_the_handler_and_its_write_is_stored() {
    let p = setup("dpop_verified").await;
    let app = app!(p.f.appstate);
    let client = Client::new(&p.issuer, now(), json!({}));
    let url = format!("http://{}/notes/a", p.host);
    let resp = actix_test::call_service(
        &app,
        authorized(request("PUT", &p.host, "/notes/a"), &client, "PUT", &url, "put-1").to_request(),
    )
    .await;
    assert_eq!(resp.status(), 201);
    let body: Json = actix_test::read_body_json(resp).await;
    assert_eq!(body["caller"]["webid"], WEBID);
    assert_eq!(body["caller"]["scheme"], "dpop");
    let stored = children(&p).await;
    assert_eq!(stored.len(), 1);
    let provenance = match stored[0].get(urls::ROUTE_PROVENANCE).unwrap() {
        Value::Json(json) => json.clone(),
        other => serde_json::from_str(&other.to_string()).unwrap(),
    };
    assert_eq!(provenance["caller"]["webid"], WEBID);

    // The same proof again is a replay.
    let replay = authorized(request("PUT", &p.host, "/notes/a"), &client, "PUT", &url, "put-1");
    let resp = actix_test::call_service(&app, replay.to_request()).await;
    assert_eq!(resp.status(), 401);
}

#[actix_rt::test]
async fn the_proof_must_name_the_url_this_node_serves_not_a_forwarded_one() {
    let p = setup("dpop_forwarded").await;
    let app = app!(p.f.appstate);
    let client = Client::new(&p.issuer, now(), json!({}));
    // A proof captured for another origin, replayed with forwarding headers
    // that claim that origin: the host names the URL from its own config.
    let elsewhere = "https://pod.elsewhere.example/notes/a";
    let resp = actix_test::call_service(
        &app,
        authorized(request("GET", &p.host, "/notes/a"), &client, "GET", elsewhere, "fwd")
            .insert_header(("x-forwarded-host", "pod.elsewhere.example"))
            .insert_header(("x-forwarded-proto", "https"))
            .insert_header(("forwarded", "host=pod.elsewhere.example;proto=https"))
            .to_request(),
    )
    .await;
    assert_eq!(resp.status(), 401);
    let challenge = resp.headers().get(header::WWW_AUTHENTICATE).unwrap();
    assert!(challenge.to_str().unwrap().starts_with("DPoP realm="));
    let body: Json = actix_test::read_body_json(resp).await;
    assert!(body["detail"].as_str().unwrap().contains("another URL"));
}

#[actix_rt::test]
async fn bad_or_unbound_tokens_are_401_before_the_sandbox() {
    let p = setup("dpop_refused").await;
    let app = app!(p.f.appstate);
    let url = format!("http://{}/notes/a", p.host);
    let client = Client::new(&p.issuer, now(), json!({"aud": "not-solid"}));
    let resp = actix_test::call_service(
        &app,
        authorized(request("GET", &p.host, "/notes/a"), &client, "GET", &url, "aud").to_request(),
    )
    .await;
    assert_eq!(resp.status(), 401);
    // A plain bearer token is not accepted either.
    let client = Client::new(&p.issuer, now(), json!({}));
    let resp = actix_test::call_service(
        &app,
        request("GET", &p.host, "/notes/a")
            .insert_header((header::AUTHORIZATION, format!("Bearer {}", client.token)))
            .to_request(),
    )
    .await;
    assert_eq!(resp.status(), 401);
}
