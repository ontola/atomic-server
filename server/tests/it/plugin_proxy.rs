//! A JS plugin's `ctx.http("atomic-proxy:/...")` reaches the integration
//! proxy, end to end: a real server started with `--integration-proxy-url`, a
//! release pinned and installed over HTTP, the plugin run through
//! `POST /plugin-run`, and a stub proxy on a real loopback socket that records
//! what arrived (#1700).
//!
//! Run: cargo test -p atomic-server --test it plugin_proxy

use std::sync::{Arc, Mutex};

use atomic_lib::{
    agents::Agent, client::connected::Client, errors::AtomicResult, urls, Resource, Value,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::common::{start_server_with_args, wait_for_server};

const STUB_BODY: &str = r#"{"items":["a","b"]}"#;

/// A stand-in for the integration proxy: answers every request with
/// [STUB_BODY] and keeps the raw request head.
async fn stub_proxy() -> (u16, Arc<Mutex<Vec<String>>>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let recorded = seen.clone();
    tokio::spawn(async move {
        loop {
            let Ok((mut socket, _)) = listener.accept().await else {
                return;
            };
            let recorded = recorded.clone();
            tokio::spawn(async move {
                let mut raw = Vec::new();
                let mut buf = [0u8; 4096];
                while !raw.windows(4).any(|w| w == b"\r\n\r\n") {
                    match socket.read(&mut buf).await {
                        Ok(0) | Err(_) => return,
                        Ok(n) => raw.extend_from_slice(&buf[..n]),
                    }
                }
                recorded
                    .lock()
                    .unwrap()
                    .push(String::from_utf8_lossy(&raw).into_owned());
                let response = format!(
                    "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{STUB_BODY}",
                    STUB_BODY.len()
                );
                let _ = socket.write_all(response.as_bytes()).await;
                let _ = socket.shutdown().await;
            });
        }
    });
    (port, seen)
}

fn header<'a>(raw: &'a str, name: &str) -> Vec<&'a str> {
    raw.lines()
        .filter_map(|line| line.split_once(':'))
        .filter(|(n, _)| n.trim().eq_ignore_ascii_case(name))
        .map(|(_, v)| v.trim())
        .collect()
}

fn encode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}

/// A signed request as a browser would make it (v1: over the URL).
async fn signed(
    method: reqwest::Method,
    url: &str,
    agent: &Agent,
    body: Option<serde_json::Value>,
) -> serde_json::Value {
    let mut req = reqwest::Client::new().request(method, url);
    for (k, v) in atomic_lib::client::get_authentication_headers(url, agent).unwrap() {
        req = req.header(k, v);
    }
    if let Some(body) = body {
        req = req.json(&body);
    }
    let response = req.send().await.unwrap();
    let status = response.status();
    let text = response.text().await.unwrap();
    assert!(status.is_success(), "{url}: {status} {text}");
    serde_json::from_str(&text).unwrap_or_else(|e| panic!("{url}: {e}: {text}"))
}

async fn create(client: &Client, parent: &str, props: Vec<(&str, Value)>) -> String {
    let mut resource: Resource = client.new_resource(parent).unwrap();
    for (prop, value) in props {
        resource.set_unsafe(prop.into(), value).unwrap();
    }
    resource.save_remote(client.store()).await.unwrap()
}

/// Declares platform `demo` and reads `atomic-proxy:/demo/items`; also tries
/// `other`, which it does not declare (a manifest cannot even declare an
/// operation on it). Returns what happened to both.
const SOURCE: &str = r#"
export const manifest = {
  schemaVersion: 2,
  proxy: ["demo"],
  operations: [
    { id: "items", method: "GET", url: "atomic-proxy:/demo/items", effect: "read" },
  ],
};
export function run(ctx) {
  const res = ctx.http({ operation: "items", method: "GET", url: "atomic-proxy:/demo/items" });
  let refused = null;
  try {
    ctx.http({ method: "GET", url: "atomic-proxy:/other/items" });
  } catch (e) {
    refused = String(e && e.message || e);
  }
  return { intents: [], problems: [], status: res.status, body: res.body,
    connections: ctx.connections, refused };
}
"#;

#[tokio::test]
async fn a_plugin_reaches_the_integration_proxy_signed_as_its_node_agent() -> AtomicResult<()> {
    let (stub_port, seen) = stub_proxy().await;
    let proxy_origin = format!("http://127.0.0.1:{stub_port}");
    let port = start_server_with_args("plugin_proxy", &["--integration-proxy-url", &proxy_origin]);
    wait_for_server(port).await;
    let server = format!("http://localhost:{port}");

    let client = Client::new(&server).await?;
    let alice = client.new_agent("Alice").await?;

    // The drive's ontology names the property a draft keeps its source in;
    // it lives in a drive of its own so the real one can point at it from
    // its genesis.
    let vocabulary = client.new_drive(&alice, "Vocabulary").await?;
    let ontology = create(
        &client,
        &vocabulary,
        vec![
            (
                urls::IS_A,
                Value::ResourceArray(vec![urls::ONTOLOGY.into()]),
            ),
            (urls::SHORTNAME, Value::Slug("plugins".into())),
            (urls::DESCRIPTION, Value::Markdown("Plugins".into())),
        ],
    )
    .await;
    let source_prop = create(
        &client,
        &ontology,
        vec![
            (
                urls::IS_A,
                Value::ResourceArray(vec![urls::PROPERTY.into()]),
            ),
            (urls::SHORTNAME, Value::Slug("plugin-source".into())),
            (urls::DESCRIPTION, Value::Markdown("plugin source".into())),
            (urls::DATATYPE_PROP, Value::AtomicUrl(urls::MARKDOWN.into())),
        ],
    )
    .await;
    let mut ontology_resource = client.get_resource(&ontology).await?;
    ontology_resource.set_unsafe(
        urls::PROPERTIES.into(),
        Value::ResourceArray(vec![source_prop.as_str().into()]),
    )?;
    ontology_resource.save_remote(client.store()).await?;

    let mut drive = Resource::new("did:ad:placeholder".into());
    drive.set_unsafe(
        urls::IS_A.into(),
        Value::ResourceArray(vec![urls::DRIVE.into()]),
    )?;
    drive.set_name("Proxy drive")?;
    for right in [urls::READ, urls::WRITE] {
        drive.set_unsafe(
            right.into(),
            Value::ResourceArray(vec![alice.subject.to_string().into()]),
        )?;
    }
    drive.set_unsafe(
        urls::DEFAULT_ONTOLOGY.into(),
        Value::AtomicUrl(ontology.as_str().into()),
    )?;
    let drive = drive.save_remote(client.store()).await?;

    // A draft, pinned as a private release, installed from that release.
    let draft = create(
        &client,
        &drive,
        vec![
            (urls::NAME, Value::String("Demo draft".into())),
            (source_prop.as_str(), Value::Markdown(SOURCE.into())),
        ],
    )
    .await;
    let pinned = signed(
        reqwest::Method::POST,
        &format!("{server}/plugin-release-pin"),
        &alice,
        Some(serde_json::json!({"drive": drive, "plugin": draft})),
    )
    .await;
    let release_id = pinned["id"].as_str().expect("a release id").to_string();
    let release = pinned["subject"].as_str().expect("a release").to_string();

    let app_id = Agent::new(None)?.subject.to_string();
    let installation = create(
        &client,
        &drive,
        vec![
            (
                urls::IS_A,
                Value::ResourceArray(vec![urls::INSTALLATION.into()]),
            ),
            (urls::NAME, Value::String("demo".into())),
            (urls::NAMESPACE, Value::String("test".into())),
            (
                urls::RELEASE_PROP,
                Value::AtomicUrl(release.as_str().into()),
            ),
            (urls::RELEASE_ID, Value::String(release_id)),
            (urls::GRANTS, Value::Json(serde_json::json!([]))),
            (urls::INSTALLATION_STATUS, Value::String("active".into())),
            (
                urls::INTEGRATION_APP_AGENT,
                Value::AtomicUrl(app_id.as_str().into()),
            ),
            (
                urls::INTEGRATION_CONNECTIONS,
                Value::Json(serde_json::json!({"demo": "conn-1"})),
            ),
        ],
    )
    .await;

    // The agent activation minted for this installation on this node.
    let info = signed(
        reqwest::Method::GET,
        &format!(
            "{server}/app-agent?drive={}&app={}",
            encode(&drive),
            encode(&installation)
        ),
        &alice,
        None,
    )
    .await;
    let node_agent = info["agent"]
        .as_str()
        .unwrap_or_else(|| panic!("activation minted no agent: {info}"))
        .to_string();

    let ran = signed(
        reqwest::Method::POST,
        &format!("{server}/plugin-run"),
        &alice,
        Some(serde_json::json!({
            "drive": drive,
            "plugin": installation,
            "source": SOURCE,
            "input": r#"{"trigger":{"kind":"manual","at":1700000000000}}"#,
        })),
    )
    .await;
    let verdict: serde_json::Value = serde_json::from_str(
        ran["verdict"]
            .as_str()
            .unwrap_or_else(|| panic!("the run failed: {ran}")),
    )
    .unwrap();

    // The plugin got the stub's answer, and was told its connections.
    assert_eq!(verdict["status"], 200, "{verdict}");
    assert_eq!(verdict["body"], STUB_BODY, "{verdict}");
    assert_eq!(
        verdict["connections"],
        serde_json::json!({"demo": "conn-1"})
    );

    // An undeclared platform is refused before anything leaves the host.
    let refused = verdict["refused"].as_str().expect("the other call threw");
    assert!(
        refused.contains("does not declare proxy platform 'other'"),
        "{refused}"
    );
    let seen = seen.lock().unwrap().clone();
    assert_eq!(
        seen.len(),
        1,
        "exactly one request reached the proxy: {seen:?}"
    );
    let raw = &seen[0];

    // integration-proxy's route: /proxy/{connection_id}/{platform}/{path}.
    assert!(
        raw.starts_with("GET /proxy/conn-1/demo/items HTTP/1.1\r\n"),
        "{raw}"
    );
    assert_eq!(header(raw, "x-atomic-agent"), vec![node_agent.as_str()]);
    assert_ne!(node_agent, alice.subject.to_string());
    assert_ne!(node_agent, app_id);
    assert_eq!(header(raw, "x-atomic-signature-version"), vec!["2"]);

    // Verified the way the proxy verifies it: v2, over method, full URL and
    // the (empty) body, by the node's agent for this installation.
    let url = format!("{proxy_origin}/proxy/conn-1/demo/items");
    let values = |method: &str| atomic_lib::authentication::AuthValues {
        public_key: header(raw, "x-atomic-public-key")[0].to_string(),
        timestamp: header(raw, "x-atomic-timestamp")[0].parse().unwrap(),
        signature: header(raw, "x-atomic-signature")[0].to_string(),
        requested_subject: url.clone(),
        agent_subject: node_agent.clone(),
        request: Some(atomic_lib::authentication::RequestBinding::new(method, b"")),
    };
    atomic_lib::authentication::check_auth_signature(&url, &values("GET"))
        .expect("a valid v2 signature from the node's app agent");
    assert!(
        atomic_lib::authentication::check_auth_signature(&url, &values("POST")).is_err(),
        "the signature is bound to the method"
    );

    Ok(())
}
