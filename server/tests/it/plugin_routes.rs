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

use crate::common::{start_server_with, start_server_with_args, wait_for_server};

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

/// `testdata/plugin-routes/inbox/`: `POST /inbox` writes a PlainText under
/// the configured inbox (AS-07).
const INBOX_SOURCE: &str = include_str!("../../../testdata/plugin-routes/inbox/plugin.js");
const INBOX_MANIFEST: &str = include_str!("../../../testdata/plugin-routes/inbox/manifest.json");

/// At `read-write`, a route with a route grant writes into its target: a
/// POST from anyone is stored, signed by the installation, with provenance,
/// and reads back. A write outside the target is refused.
/// Installs the inbox fixture in a new public drive of a new agent, with the
/// route grant its review shows and an inbox its agent may write to.
/// Returns the drive, the inbox and the Installation.
async fn install_inbox(client: &Client) -> AtomicResult<(String, String, String)> {
    let agent = client.new_agent("Alice").await?;
    let drive = client.new_public_drive(&agent, "Inbox Drive").await?;

    // The inbox the installer points the plugin at.
    let mut inbox = client.new_resource(&drive)?;
    inbox.set_unsafe(urls::NAME.into(), Value::String("Inbox".into()))?;
    inbox.save_remote(client.store()).await?;
    let inbox = inbox.get_subject().to_string();

    // Installed with the route grant its review shows: the write targets.
    let manifest: serde_json::Value = serde_json::from_str(INBOX_MANIFEST)?;
    let targets = manifest["http"]["writeTargets"].clone();
    let mut release = PluginRelease::js(INBOX_SOURCE.into(), manifest, Default::default());
    release.world = WORLD_EXTENSION.into();
    let mut release_resource = client.new_resource(&drive)?;
    release.write_to_resource(&mut release_resource, None)?;
    release_resource.save_remote(client.store()).await?;
    let mut installation = client.new_resource(&drive)?;
    for (property, value) in [
        (
            urls::IS_A,
            Value::ResourceArray(vec![urls::INSTALLATION.into()]),
        ),
        (urls::NAME, Value::String("inbox".into())),
        (urls::NAMESPACE, Value::String("fixtures".into())),
        (
            urls::RELEASE_PROP,
            Value::String(release_resource.get_subject().to_string()),
        ),
        (urls::RELEASE_ID, Value::String(release.id()?)),
        (urls::INSTALLATION_STATUS, Value::String("active".into())),
        (
            urls::GRANTS,
            Value::Json(json!(["storage", {"route-writes": targets}])),
        ),
        (urls::CONFIG, Value::Json(json!({ "inbox": inbox }))),
    ] {
        installation.set_unsafe(property.into(), value)?;
    }
    installation.save_remote(client.store()).await?;
    let installation = installation.get_subject().to_string();

    // The installer lets the plugin's agent write to the inbox.
    let plugin_agent = client
        .get_resource(&installation)
        .await?
        .get(urls::PLUGIN_AGENT)?
        .to_string();
    let mut inbox_resource = client.get_resource(&inbox).await?;
    inbox_resource.set_unsafe(
        urls::WRITE.into(),
        Value::ResourceArray(vec![plugin_agent.as_str().into()]),
    )?;
    inbox_resource.save_remote(client.store()).await?;
    Ok((drive, inbox, installation))
}

#[tokio::test]
async fn a_route_write_is_stored_and_reads_back() -> AtomicResult<()> {
    let port = start_server_with_args("plugin_route_writes", &["--plugin-routes", "read-write"]);
    wait_for_server(port).await;
    let server = format!("http://localhost:{port}");
    let client = Client::new(&server).await?;
    let http = reqwest::Client::new();
    let (drive, inbox, installation) = install_inbox(&client).await?;

    // Anyone on the internet POSTs.
    let prefix = format!("{server}/_routes/{}", slug(&installation));
    let resp = http
        .post(format!("{prefix}/inbox"))
        .json(&json!({"name": "hello", "text": "from far away"}))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    assert_eq!(resp.status(), 202);

    // It reads back, through the route and from the store.
    let resp = http
        .get(format!("{prefix}/items"))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    assert_eq!(resp.status(), 200);
    let items: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    let item = items
        .as_array()
        .and_then(|items| items.iter().find(|i| i["name"] == "hello"))
        .unwrap_or_else(|| panic!("the item is not listed: {items}"));
    assert_eq!(item["description"], "from far away");
    let provenance = &item["provenance"];
    assert_eq!(provenance["installation"], installation);
    assert_eq!(provenance["route"], "inbox");
    assert!(provenance["request"]
        .as_str()
        .is_some_and(|r| r.starts_with("http:")));
    let stored = client
        .get_resource(item["subject"].as_str().unwrap())
        .await?;
    assert_eq!(stored.get(urls::PARENT)?.to_string(), inbox);
    assert_eq!(stored.get(urls::DESCRIPTION)?.to_string(), "from far away");

    // Outside the target: refused, and not stored.
    let resp = http
        .post(format!("{prefix}/inbox"))
        .json(&json!({"name": "stray", "parent": drive}))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    assert_eq!(resp.status(), 502);
    let problem: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    assert_eq!(problem["type"], "route-write-refused");

    // A signed POST, end to end (#1718). The actor publishes its key; the
    // host signs a delivery with it on the plugin's behalf; the signed inbox
    // verifies that signature before the sandbox starts, and the handler and
    // the stored item's provenance get the verified caller.
    let actor: serde_json::Value = http
        .get(format!("{prefix}/actor"))
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    let key_id = actor["publicKey"]["id"].as_str().unwrap().to_string();
    assert_eq!(key_id, format!("{prefix}/actor#main-key"));
    assert!(actor["publicKey"]["publicKeyPem"]
        .as_str()
        .is_some_and(|pem| pem.starts_with("-----BEGIN PUBLIC KEY-----")));
    let activity = r#"{"type":"Create","name":"signed"}"#;
    let signed: serde_json::Value = http
        .post(format!("{prefix}/outbox"))
        .json(&json!({"to": format!("{prefix}/signed-inbox"), "activity": activity}))
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    let deliver = |body: &'static str| {
        let mut request = http
            .post(format!("{prefix}/signed-inbox"))
            .header("content-type", "application/activity+json")
            .body(body);
        for (name, value) in signed["headers"].as_object().unwrap() {
            if name != "host" {
                request = request.header(name.as_str(), value.as_str().unwrap());
            }
        }
        request.send()
    };
    let resp = deliver(activity).await.map_err(|e| e.to_string())?;
    assert_eq!(resp.status(), 202);
    let answer: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    assert_eq!(answer["caller"]["keyId"], key_id);
    assert_eq!(answer["caller"]["owner"], format!("{prefix}/actor"));
    assert_eq!(answer["caller"]["scheme"], "draft-cavage-12");
    // The same headers over another body: refused before the handler runs.
    let resp = deliver(r#"{"type":"Delete"}"#)
        .await
        .map_err(|e| e.to_string())?;
    assert_eq!(resp.status(), 401);
    assert!(resp.headers().contains_key("www-authenticate"));
    let items: serde_json::Value = http
        .get(format!("{prefix}/items"))
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    let signed_items: Vec<&serde_json::Value> = items
        .as_array()
        .unwrap()
        .iter()
        .filter(|i| i["provenance"]["route"] == "signed-inbox")
        .collect();
    assert_eq!(signed_items.len(), 1, "{items}");
    assert_eq!(signed_items[0]["provenance"]["caller"]["keyId"], key_id);
    Ok(())
}

/// What a receiver got: method, path, lowercased headers and body.
type Received = (String, String, Vec<(String, String)>, Vec<u8>);

/// A receiver on loopback that records each request and answers `202`.
async fn receiver() -> (String, std::sync::Arc<std::sync::Mutex<Vec<Received>>>) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let received: std::sync::Arc<std::sync::Mutex<Vec<Received>>> = Default::default();
    let log = received.clone();
    tokio::spawn(async move {
        while let Ok((mut socket, _)) = listener.accept().await {
            let log = log.clone();
            tokio::spawn(async move {
                let mut buf = Vec::new();
                let mut chunk = [0u8; 4096];
                let end = loop {
                    let n = socket.read(&mut chunk).await.unwrap_or(0);
                    if n == 0 {
                        return;
                    }
                    buf.extend_from_slice(&chunk[..n]);
                    if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                        break i;
                    }
                };
                let head = String::from_utf8_lossy(&buf[..end]).to_string();
                let mut lines = head.split("\r\n");
                let mut start = lines.next().unwrap_or_default().split(' ');
                let method = start.next().unwrap_or_default().to_string();
                let path = start.next().unwrap_or_default().to_string();
                let headers: Vec<(String, String)> = lines
                    .filter_map(|l| l.split_once(':'))
                    .map(|(n, v)| (n.trim().to_ascii_lowercase(), v.trim().to_string()))
                    .collect();
                let length: usize = headers
                    .iter()
                    .find(|(n, _)| n == "content-length")
                    .and_then(|(_, v)| v.parse().ok())
                    .unwrap_or(0);
                let mut body = buf[end + 4..].to_vec();
                while body.len() < length {
                    let n = socket.read(&mut chunk).await.unwrap_or(0);
                    if n == 0 {
                        break;
                    }
                    body.extend_from_slice(&chunk[..n]);
                }
                log.lock().unwrap().push((method, path, headers, body));
                let _ = socket
                    .write_all(
                        b"HTTP/1.1 202 Accepted\r\ncontent-length: 0\r\nconnection: close\r\n\r\n",
                    )
                    .await;
            });
        }
    });
    (origin, received)
}

/// A route enqueues a delivery (#1719), end to end on a real server: the
/// route answers `202` at once, and the server's own worker delivers a POST
/// to a receiver, signed by the host with the installation's key, which
/// verifies against the key the actor publishes. Deliveries reach loopback
/// only through a test seam that has no option or env var.
#[tokio::test]
async fn a_route_enqueues_a_delivery_the_server_sends_signed() -> AtomicResult<()> {
    use atomic_server_lib::plugins::http_signatures::{self, Message, PublicKey};

    let port = start_server_with(
        "plugin_route_delivery",
        &["--plugin-routes", "read-write"],
        |config| config.plugin_delivery_loopback = true,
    );
    wait_for_server(port).await;
    let server = format!("http://localhost:{port}");
    let client = Client::new(&server).await?;
    let http = reqwest::Client::new();
    let (_, _, installation) = install_inbox(&client).await?;
    let prefix = format!("{server}/_routes/{}", slug(&installation));
    let (origin, received) = receiver().await;

    let activity = r#"{"type":"Follow","id":"https://example.com/follow/1"}"#;
    let deliver = || {
        http.post(format!("{prefix}/deliver"))
            .json(&json!({
                "to": format!("{origin}/inbox"),
                "operation": "deliver-local",
                "activity": activity,
                "id": "follow-1",
            }))
            .send()
    };
    let resp = deliver().await.map_err(|e| e.to_string())?;
    assert_eq!(resp.status(), 202);

    // The worker sends it within a few seconds.
    let mut delivered = None;
    for _ in 0..100 {
        if let Some(first) = received.lock().unwrap().first().cloned() {
            delivered = Some(first);
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    let (method, path, headers, body) = delivered.expect("the receiver got the delivery");
    assert_eq!(method, "POST");
    assert_eq!(path, "/inbox");
    assert_eq!(body, activity.as_bytes());

    // Signed with the key the actor publishes.
    let actor: serde_json::Value = http
        .get(format!("{prefix}/actor"))
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    let authority = headers
        .iter()
        .find(|(n, _)| n == "host")
        .map(|(_, v)| v.clone())
        .unwrap();
    let message = Message {
        method: &method,
        scheme: "http",
        authority: &authority,
        path: &path,
        query: None,
        headers: &headers,
    };
    let parsed = http_signatures::parse(&message).map_err(|e| e.to_string())?;
    assert_eq!(parsed[0].key_id, actor["publicKey"]["id"]);
    let key = PublicKey::from_pem(actor["publicKey"]["publicKeyPem"].as_str().unwrap())?;
    http_signatures::verify(&parsed[0], &key).map_err(|e| e.to_string())?;
    http_signatures::check_policy(&parsed[0], &message, &body, atomic_lib::utils::now() / 1000)
        .map_err(|e| e.to_string())?;

    // The same idempotency key again is accepted and not sent twice.
    let resp = deliver().await.map_err(|e| e.to_string())?;
    assert_eq!(resp.status(), 202);
    tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
    assert_eq!(received.lock().unwrap().len(), 1);

    // Plain HTTP is only the fixture's `deliver-local`: the declared
    // `https://*/inbox` refuses it before anything is queued.
    let resp = http
        .post(format!("{prefix}/deliver"))
        .json(&json!({ "to": format!("{origin}/inbox"), "activity": activity }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    assert_eq!(resp.status(), 502);
    Ok(())
}
