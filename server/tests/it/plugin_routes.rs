//! Integration test: a real server built with `--features plugin-routes`,
//! started with `--plugin-routes read-only` and a routes origin. A client
//! installs version-three plugins over HTTP, and their mounts answer:
//! `drive-prefix` at `/_routes/<slug>/...`, `installation-origin` on
//! `<slug>.<routes origin>`. A matched route runs the plugin's
//! `handle(ctx, request)` (AS-05), and a claimed `/.well-known/` name runs the
//! route its claim names (#1716).
//!
//! Run: cargo test -p atomic-server --features plugin-routes --test it plugin_routes

use atomic_lib::{
    client::connected::Client,
    db::plugin_release::{PluginRelease, WORLD_EXTENSION},
    errors::AtomicResult,
    urls, Value,
};
use atomic_server_lib::plugins::route_registry::slug;
use serde_json::json;

use crate::common::{start_server_with_args, wait_for_server};

/// `testdata/plugin-routes/hello-route/`, shared with the unit tests.
const HELLO_ROUTE_SOURCE: &str =
    include_str!("../../../testdata/plugin-routes/hello-route/plugin.js");
const HELLO_ROUTE_MANIFEST: &str =
    include_str!("../../../testdata/plugin-routes/hello-route/manifest.json");
/// `testdata/plugin-routes/well-known/`: claims `nodeinfo` and `webfinger`.
const WELL_KNOWN_SOURCE: &str =
    include_str!("../../../testdata/plugin-routes/well-known/plugin.js");
const WELL_KNOWN_MANIFEST: &str =
    include_str!("../../../testdata/plugin-routes/well-known/manifest.json");

/// A manifest for plugin `acme/<name>` with this `http` block.
fn manifest(name: &str, http: serde_json::Value) -> serde_json::Value {
    json!({
        "schemaVersion": 3,
        "name": name,
        "namespace": "acme",
        "capabilities": [{"name": "storage", "reason": "keeps a cursor"}],
        "http": http,
    })
}

/// Publishes a JS release as a `Release` resource in `drive` and installs it
/// as an active Installation. Returns the Installation's subject.
async fn install(
    client: &Client,
    drive: &str,
    manifest: serde_json::Value,
) -> AtomicResult<String> {
    install_source(client, drive, HELLO_ROUTE_SOURCE, manifest).await
}

/// [`install`] with this plugin source.
async fn install_source(
    client: &Client,
    drive: &str,
    source: &str,
    manifest: serde_json::Value,
) -> AtomicResult<String> {
    let mut release = PluginRelease::js(source.into(), manifest, Default::default());
    release.world = WORLD_EXTENSION.into();
    let mut release_resource = client.new_resource(drive)?;
    release.write_to_resource(&mut release_resource, None)?;
    release_resource.save_remote(client.store()).await?;

    let mut installation = client.new_resource(drive)?;
    for (property, value) in [
        (
            urls::IS_A,
            Value::ResourceArray(vec![urls::INSTALLATION.into()]),
        ),
        (
            urls::RELEASE_PROP,
            Value::String(release_resource.get_subject().to_string()),
        ),
        (urls::RELEASE_ID, Value::String(release.id()?)),
        (urls::INSTALLATION_STATUS, Value::String("active".into())),
        (urls::GRANTS, Value::Json(json!(["storage"]))),
    ] {
        installation.set_unsafe(property.into(), value)?;
    }
    installation.save_remote(client.store()).await?;
    Ok(installation.get_subject().to_string())
}

#[tokio::test]
async fn an_installed_v3_plugin_answers_on_its_mounts() -> AtomicResult<()> {
    // Hosts are matched without their port.
    let port = start_server_with_args(
        "plugin_routes",
        &[
            "--plugin-routes",
            "read-only",
            "--routes-origin",
            "http://routes.localhost",
        ],
    );
    wait_for_server(port).await;
    let server = format!("http://localhost:{port}");
    let client = Client::new(&server).await?;
    let agent = client.new_agent("Alice").await?;
    let drive = client.new_public_drive(&agent, "Routes Drive").await?;
    let http = reqwest::Client::new();

    // drive-prefix: /_routes/<slug>/... on the API origin. The hello-route
    // fixture.
    let hello: serde_json::Value = serde_json::from_str(HELLO_ROUTE_MANIFEST)?;
    let prefixed = install(&client, &drive, hello).await?;
    let resp = http
        .get(format!("{server}/_routes/{}/hello/world", slug(&prefixed)))
        .header("origin", "https://elsewhere.example")
        .header("cookie", "atomic_session=not-for-plugins")
        .send()
        .await
        .map_err(|e| e.to_string())?;
    assert_eq!(resp.status(), 200);
    assert_eq!(resp.headers()["content-type"], "text/plain; charset=utf-8");
    assert_eq!(resp.headers()["x-content-type-options"], "nosniff");
    // The server's own CORS layer does not speak for a route that declared
    // none.
    assert!(!resp.headers().contains_key("access-control-allow-origin"));
    assert_eq!(
        resp.text().await.map_err(|e| e.to_string())?,
        "Hello, world"
    );
    let resp = http
        .get(format!("{server}/_routes/{}/nothing-here", slug(&prefixed)))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    assert_eq!(resp.status(), 404);

    // installation-origin: its own host on the routes origin.
    let own = install(
        &client,
        &drive,
        manifest(
            "own-origin",
            json!({"routes": [{"id": "actor", "path": "/users/{name}", "methods": ["GET"]}]}),
        ),
    )
    .await?;
    let resp = http
        .get(format!("{server}/users/alice"))
        .header("host", format!("{}.routes.localhost:{port}", slug(&own)))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    assert_eq!(resp.status(), 200);
    assert_eq!(
        resp.text().await.map_err(|e| e.to_string())?,
        "Hello, alice"
    );

    // A claimed `/.well-known/` name, on the installation's own origin: the
    // well-known fixture, moved to that mount.
    let mut claims: serde_json::Value = serde_json::from_str(WELL_KNOWN_MANIFEST)?;
    claims["http"]["mount"] = "installation-origin".into();
    let claimed = install_source(&client, &drive, WELL_KNOWN_SOURCE, claims).await?;
    let claimed_host = format!("{}.routes.localhost:{port}", slug(&claimed));
    let resp = http
        .get(format!("{server}/.well-known/nodeinfo"))
        .header("host", &claimed_host)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    assert_eq!(resp.status(), 200);
    assert_eq!(resp.headers()["content-type"], "application/json");
    let links: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    assert_eq!(
        links["links"][0]["rel"],
        "http://nodeinfo.diaspora.software/ns/schema/2.1"
    );
    let resp = http
        .get(format!(
            "{server}/.well-known/webfinger?resource=acct%3Aalice%40example.com"
        ))
        .header("host", &claimed_host)
        .header("origin", "https://elsewhere.example")
        .send()
        .await
        .map_err(|e| e.to_string())?;
    assert_eq!(resp.status(), 200);
    // Declared `any-origin-no-credentials`, through the real CORS layer.
    assert_eq!(resp.headers()["access-control-allow-origin"], "*");
    assert!(!resp
        .headers()
        .contains_key("access-control-allow-credentials"));
    let jrd: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    assert_eq!(jrd["subject"], "acct:alice@example.com");
    // An unmatched resource and an unclaimed name are 404; host-meta is
    // generated from the webfinger claim.
    for (path, status) in [
        ("/.well-known/webfinger?resource=https%3A%2F%2Fx", 404),
        ("/.well-known/ocm", 404),
        ("/.well-known/host-meta", 200),
    ] {
        let resp = http
            .get(format!("{server}{path}"))
            .header("host", &claimed_host)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        assert_eq!(resp.status(), status, "{path}");
        if status == 200 {
            let xrd = resp.text().await.map_err(|e| e.to_string())?;
            assert!(
                xrd.contains(&format!(
                    "template=\"http://{claimed_host}/.well-known/webfinger?resource={{uri}}\""
                )),
                "{xrd}"
            );
        }
    }
    // The API origin has no claims without the operator's grant.
    let resp = http
        .get(format!("{server}/.well-known/nodeinfo"))
        .header("accept", "application/json")
        .send()
        .await
        .map_err(|e| e.to_string())?;
    assert_eq!(resp.status(), 404);
    // Nor does a client without an `Accept` header get the app's HTML there.
    let resp = http
        .get(format!("{server}/.well-known/nodeinfo"))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    assert_eq!(resp.status(), 404);
    assert_eq!(resp.headers()["content-type"], "application/problem+json");

    // A reserved path refuses the install.
    let err = install(
        &client,
        &drive,
        manifest(
            "reserved",
            json!({"routes": [{"id": "acme", "path": "/.well-known/acme-challenge/{token}", "methods": ["GET"]}]}),
        ),
    )
    .await
    .unwrap_err()
    .to_string();
    assert!(err.contains("acme-challenge"), "{err}");
    Ok(())
}
