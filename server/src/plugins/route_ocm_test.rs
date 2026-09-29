//! An Open Cloud Mesh share received end to end through the app
//! (ontola/atomic-plugins#167): the OCM fixture (`testdata/plugin-routes/ocm/`)
//! at `--plugin-routes read-write`. The sending server's discovery and JWK
//! Set come from memory (`KeyFetch`); its WebDAV file and notifications
//! endpoint are a plain stub on loopback, which the loopback test seam lets
//! `blobs.fetch` and the delivery queue reach.
//!
//! Checked: the host verifies the peer's `tag="ocm"` RFC 9421 signature with
//! the key its discovery's `jwksUri` names; `blobs.fetch` puts the shared
//! file into the blob store with the share's secret; the route stores a File
//! holding that blob; the delivery queue sends a `SHARE_ACCEPTED`
//! notification the peer can verify against the installation's published
//! JWK Set. And the refusals: unsigned, another key, another sender, a
//! secret the peer refuses.

use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

use actix_web::{http::header, test as actix_test, web, App};
use atomic_lib::{db::app_agent::AppAgentKey, urls, Storelike, Value};
use serde_json::{json, Value as Json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use super::{
    http_signatures::{self, Algorithm, Message, Outbound, PublicKey, Signer},
    route_auth::KeyFetch,
    route_delivery::{self, DeliveryQueue, EgressTransport, RegistryHost},
    route_exec::RouteExecutor,
    route_registry::slug,
    test_fixture::{fixture_with_args, genesis, install_release_with, ocm_release, Fixture},
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

const SECRET: &str = "invented-shared-secret";
const FILE: &[u8] = b"Hello from the OCM peer fixture.\n";
const PEER: &str = "peer.test";
const KID: &str = "peer.test#key1";

/// One request the stub received.
#[derive(Clone, Debug)]
struct Received {
    method: String,
    path: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

/// The sending server's WebDAV file and notifications endpoint, plain HTTP
/// on `127.0.0.1`. Returns its origin and what it received.
async fn stub() -> (String, Arc<Mutex<Vec<Received>>>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let received: Arc<Mutex<Vec<Received>>> = Default::default();
    let log = received.clone();
    tokio::spawn(async move {
        loop {
            let Ok((mut socket, _)) = listener.accept().await else {
                return;
            };
            let log = log.clone();
            tokio::spawn(async move {
                let mut buf = Vec::new();
                let mut chunk = [0u8; 4096];
                let head_end = loop {
                    let n = socket.read(&mut chunk).await.unwrap_or(0);
                    if n == 0 {
                        return;
                    }
                    buf.extend_from_slice(&chunk[..n]);
                    if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                        break i;
                    }
                };
                let head = String::from_utf8_lossy(&buf[..head_end]).to_string();
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
                let mut body = buf[head_end + 4..].to_vec();
                while body.len() < length {
                    let n = socket.read(&mut chunk).await.unwrap_or(0);
                    if n == 0 {
                        break;
                    }
                    body.extend_from_slice(&chunk[..n]);
                }
                let authorized = headers
                    .iter()
                    .any(|(n, v)| n == "authorization" && *v == format!("Bearer {SECRET}"));
                log.lock().unwrap().push(Received {
                    method: method.clone(),
                    path: path.clone(),
                    headers,
                    body,
                });
                let (status, bytes): (u16, Vec<u8>) = match (method.as_str(), path.as_str()) {
                    ("GET", "/dav/spec.txt") if authorized => (200, FILE.to_vec()),
                    ("GET", "/dav/spec.txt") => (401, Vec::new()),
                    ("POST", "/ocm/notifications") => (201, b"{}".to_vec()),
                    _ => (404, Vec::new()),
                };
                let mut response = format!(
                    "HTTP/1.1 {status} Stub\r\ncontent-type: text/plain\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                    bytes.len()
                )
                .into_bytes();
                response.extend_from_slice(&bytes);
                let _ = socket.write_all(&response).await;
            });
        }
    });
    (origin, received)
}

/// The sending server's discovery and JWK Set, from memory.
struct Discovery(HashMap<String, Vec<u8>>);

#[async_trait::async_trait]
impl KeyFetch for Discovery {
    async fn fetch(&self, url: &url::Url) -> Result<Vec<u8>, String> {
        self.0
            .get(url.as_str())
            .cloned()
            .ok_or_else(|| "404".to_string())
    }
}

struct Ed(ed25519_dalek::SigningKey);

impl Signer for Ed {
    fn algorithm(&self) -> Algorithm {
        Algorithm::Ed25519
    }
    fn sign(&self, data: &[u8]) -> Vec<u8> {
        use ed25519_dalek::Signer as _;
        self.0.sign(data).to_bytes().to_vec()
    }
}

struct Setup {
    f: Fixture,
    folder: String,
    installation: String,
    prefix: String,
    stub: String,
    received: Arc<Mutex<Vec<Received>>>,
    key: ed25519_dalek::SigningKey,
}

async fn setup(name: &str) -> Setup {
    let key = ed25519_dalek::SigningKey::generate(&mut rand::rngs::OsRng);
    let (stub, received) = stub().await;
    let mut jwk = PublicKey::Ed25519(key.verifying_key()).to_jwk();
    jwk["kid"] = json!(KID);
    let discovery = Discovery(HashMap::from([
        (
            format!("https://{PEER}/.well-known/ocm"),
            json!({
                "enabled": true,
                "apiVersion": "1.5.0",
                "endPoint": format!("{stub}/ocm"),
                "capabilities": ["http-sig", "notifications"],
                "jwksUri": format!("https://{PEER}/ocm/jwks"),
            })
            .to_string()
            .into_bytes(),
        ),
        (
            format!("https://{PEER}/ocm/jwks"),
            json!({ "keys": [jwk] }).to_string().into_bytes(),
        ),
    ]));
    let mut f = fixture_with_args(name, &["--plugin-routes", "read-write"]).await;
    f.appstate.route_exec = Arc::new(
        RouteExecutor::default()
            .with_key_fetch(Arc::new(discovery))
            .with_egress_seams(true, None),
    );
    f.appstate.route_delivery = Arc::new(DeliveryQueue::new(
        f.appstate.store.clone(),
        f.appstate.config.opts.plugin_route_deliveries_per_day,
        Arc::new(RegistryHost {
            registry: f.appstate.route_registry.clone(),
            db: f.appstate.store.clone(),
        }),
        Arc::new(EgressTransport {
            loopback: true,
            peer_ca: None,
        }),
    ));
    let store = &f.appstate.store;
    let folder = genesis(
        store,
        vec![
            (urls::PARENT, Value::AtomicUrl(f.drive.as_str().into())),
            (urls::NAME, Value::String("Received shares".into())),
        ],
    )
    .await;
    let installation = install_release_with(
        &f,
        &ocm_release(),
        Some(ocm_release().manifest["http"]["writeTargets"].clone()),
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
    let prefix = format!("/_routes/{}", slug(&installation));
    Setup {
        f,
        folder,
        installation,
        prefix,
        stub,
        received,
        key,
    }
}

fn share(s: &Setup, provider_id: &str, sender: &str, secret: &str) -> Vec<u8> {
    json!({
        "shareWith": "bob@localhost",
        "name": "spec.txt",
        "providerId": provider_id,
        "owner": sender,
        "sender": sender,
        "shareType": "user",
        "resourceType": "file",
        "protocol": {
            "name": "multi",
            "webdav": {
                "uri": format!("{}/dav/spec.txt", s.stub),
                "sharedSecret": secret,
                "permissions": ["read"],
            }
        }
    })
    .to_string()
    .into_bytes()
}

/// A `POST` to the fixture's shares route, signed by `key` as OCM signs.
fn signed(s: &Setup, key: &ed25519_dalek::SigningKey, body: &[u8]) -> actix_test::TestRequest {
    let path = format!("{}/ocm/shares", s.prefix);
    let url = url::Url::parse(&format!("http://localhost{path}")).unwrap();
    let headers = http_signatures::sign_rfc9421_tagged(
        &Ed(key.clone()),
        KID,
        &Outbound {
            method: "POST",
            url: &url,
            body: Some(body),
        },
        std::time::SystemTime::now(),
        Some("ocm"),
    );
    let mut request = actix_test::TestRequest::post()
        .uri(&path)
        .insert_header((header::HOST, "localhost"))
        .insert_header((header::CONTENT_TYPE, "application/json"))
        .set_payload(body.to_vec());
    for (name, value) in headers {
        if name != "content-length" {
            request = request.insert_header((name, value));
        }
    }
    request
}

/// The Files under the folder, as (name, blob).
async fn files(s: &Setup) -> Vec<(String, String)> {
    let store = &s.f.appstate.store;
    store
        .get_resource(&s.folder.as_str().into())
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
        .collect()
}

async fn send_deliveries(s: &Setup) -> usize {
    let handles =
        s.f.appstate
            .route_delivery
            .tick(atomic_lib::utils::now())
            .await;
    let n = handles.len();
    for handle in handles {
        handle.await.unwrap();
    }
    n
}

#[actix_rt::test]
async fn a_signed_share_is_fetched_stored_and_acknowledged() {
    let s = setup("route_ocm_share").await;
    let app = app!(s.f.appstate);

    let body = share(&s, "share-1", &format!("alice@{PEER}"), SECRET);
    let resp = actix_test::call_service(&app, signed(&s, &s.key, &body).to_request()).await;
    let status = resp.status();
    let answer: Json = actix_test::read_body_json(resp).await;
    assert_eq!(status, 201, "{answer}");
    assert_eq!(answer["caller"]["tag"], "ocm");
    assert_eq!(answer["caller"]["domain"], PEER);
    assert_eq!(answer["caller"]["owner"], format!("https://{PEER}"));
    assert_eq!(answer["caller"]["endPoint"], format!("{}/ocm", s.stub));
    let hash = blake3::hash(FILE).to_hex().to_string();
    assert_eq!(answer["blob"]["hash"], hash);
    assert_eq!(answer["blob"]["size"], FILE.len());
    assert_eq!(answer["blob"]["type"], "text/plain");
    assert!(
        !answer.to_string().contains(SECRET),
        "the secret is never answered"
    );

    // The bytes are in the blob store, and a File under the folder holds them.
    assert!(s
        .f
        .appstate
        .store
        .has_blob(&hex::decode(&hash).unwrap())
        .await
        .unwrap());
    assert_eq!(
        files(&s).await,
        vec![("spec.txt".to_string(), format!("atomic:blob:{hash}"))]
    );
    let fetched: Vec<Received> = s
        .received
        .lock()
        .unwrap()
        .iter()
        .filter(|r| r.path == "/dav/spec.txt")
        .cloned()
        .collect();
    assert_eq!(fetched.len(), 1);
    assert!(fetched[0]
        .headers
        .contains(&("authorization".into(), format!("Bearer {SECRET}"))));

    // The acknowledgement is queued, and sent by the delivery queue.
    assert_eq!(send_deliveries(&s).await, 1);
    let notification = s
        .received
        .lock()
        .unwrap()
        .iter()
        .find(|r| r.path == "/ocm/notifications")
        .cloned()
        .expect("the peer got a notification");
    assert_eq!(notification.method, "POST");
    let sent: Json = serde_json::from_slice(&notification.body).unwrap();
    assert_eq!(sent["notificationType"], "SHARE_ACCEPTED");
    assert_eq!(sent["notification"]["file"]["providerId"], "share-1");

    // The peer verifies it the OCM way, with the installation's JWK Set.
    let resp = actix_test::call_service(
        &app,
        actix_test::TestRequest::get()
            .uri(&format!("{}/ocm/jwks", s.prefix))
            .insert_header((header::HOST, "localhost"))
            .to_request(),
    )
    .await;
    assert_eq!(resp.status(), 200);
    let set: Json = actix_test::read_body_json(resp).await;
    assert_eq!(set["keys"][0]["kid"], "localhost#ocm-key");
    let (published, alg) = PublicKey::from_jwk(&set["keys"][0]).unwrap();
    assert_eq!(alg, Algorithm::Ed25519);
    let authority = s.stub.trim_start_matches("http://");
    let message = Message {
        method: "POST",
        scheme: "http",
        authority,
        path: "/ocm/notifications",
        query: None,
        headers: &notification.headers,
    };
    let parsed = http_signatures::parse(&message).unwrap();
    let ocm = http_signatures::tagged(&parsed, http_signatures::OCM_TAG).unwrap();
    assert_eq!(ocm.key_id, "localhost#ocm-key");
    http_signatures::check_policy(
        ocm,
        &message,
        &notification.body,
        atomic_lib::utils::now() / 1000,
    )
    .unwrap();
    http_signatures::check_ocm_policy(ocm, &notification.body).unwrap();
    http_signatures::verify(ocm, &published).unwrap();
    let settled = route_delivery::settled(&s.f.appstate.store, &s.installation);
    assert_eq!(settled.len(), 1);
    assert_eq!(settled[0].state, route_delivery::JobState::Delivered);
}

#[actix_rt::test]
async fn unsigned_forged_and_refused_shares_store_nothing() {
    let s = setup("route_ocm_refusals").await;
    let app = app!(s.f.appstate);
    let path = format!("{}/ocm/shares", s.prefix);
    let body = share(&s, "share-2", &format!("alice@{PEER}"), SECRET);

    // Unsigned: the host answers 401 and the handler never runs.
    let resp = actix_test::call_service(
        &app,
        actix_test::TestRequest::post()
            .uri(&path)
            .insert_header((header::HOST, "localhost"))
            .insert_header((header::CONTENT_TYPE, "application/json"))
            .set_payload(body.clone())
            .to_request(),
    )
    .await;
    assert_eq!(resp.status(), 401);

    // Signed by a key the peer never published under that kid.
    let other = ed25519_dalek::SigningKey::generate(&mut rand::rngs::OsRng);
    let resp = actix_test::call_service(&app, signed(&s, &other, &body).to_request()).await;
    assert_eq!(resp.status(), 401);

    // The right key, but the body names another server as the sender: its
    // discovery is not there.
    let forged = share(&s, "share-3", "alice@elsewhere.test", SECRET);
    let resp = actix_test::call_service(&app, signed(&s, &s.key, &forged).to_request()).await;
    assert_eq!(resp.status(), 401);

    // A secret the peer refuses: the fetch answers 401, the handler 400.
    let wrong = share(&s, "share-4", &format!("alice@{PEER}"), "not-the-secret");
    let resp = actix_test::call_service(&app, signed(&s, &s.key, &wrong).to_request()).await;
    assert_eq!(resp.status(), 400);

    assert!(files(&s).await.is_empty());
    assert_eq!(send_deliveries(&s).await, 0);
}

#[test]
fn fetch_operations_may_end_in_a_rest_segment() {
    let manifest = super::manifest::Manifest::parse(json!({
        "schemaVersion": 3,
        "operations": [
            { "id": "fetch", "method": "GET", "url": "https://*/{*rest}", "effect": "read" },
            { "id": "dav", "method": "GET", "url": "https://dav.example/files/{*rest}", "effect": "read" },
            { "id": "post", "method": "POST", "url": "https://*/{*rest}", "effect": "write" }
        ],
        "http": {
            "mount": "drive-prefix",
            "routes": [{
                "id": "r", "path": "/r", "methods": ["POST"],
                "principal": "anonymous", "auth": "none", "body": "json",
                "enqueues": ["post"],
                "fetches": ["fetch", "dav"]
            }]
        }
    }))
    .unwrap()
    .unwrap();
    let url = |u: &str| url::Url::parse(u).unwrap();
    assert!(manifest.allows_fetch("fetch", &url("https://a.example/remote.php/dav/x")));
    assert!(!manifest.allows_fetch("fetch", &url("http://a.example/x")));
    assert!(!manifest.allows_fetch("fetch", &url("https://a.example/")));
    assert!(manifest.allows_fetch("dav", &url("https://dav.example/files/a/b.txt")));
    assert!(!manifest.allows_fetch("dav", &url("https://dav.example/files/")));
    assert!(!manifest.allows_fetch("dav", &url("https://dav.example/other/a")));
    assert!(!manifest.allows_fetch("dav", &url("https://evil.example/files/a")));
    // Only GET operations fetch; POST is still a delivery.
    assert!(!manifest.allows_fetch("post", &url("https://a.example/x")));
    assert!(manifest.allows_delivery("post", "POST", &url("https://a.example/ocm/notifications")));
}
