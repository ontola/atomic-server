//! Real HTTP/WebSocket adapter boundaries for historical storage receipts.
use atomic_lib::{
    agents::Agent,
    client::{connected::Client, helpers::get_authentication_headers_v2},
    loro::AtomicLoroDoc,
    sync::protocol::{self, StorageReceipt, StorageReceiptRequest},
    Db,
};
use futures_util::{SinkExt, StreamExt};
use std::time::Duration;
use tokio_tungstenite::{connect_async, tungstenite::Message};

const CAP: &str = "server-storage-receipts-v1";
const HEADER: &str = "X-Atomic-Storage-Receipts";
type Socket =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

struct Setup {
    base: String,
    store: Db,
    agent: Agent,
    request: StorageReceiptRequest,
}
async fn setup(name: &str) -> Setup {
    let (port, store) = crate::common::start_server_with_store(name, &[]);
    crate::common::wait_for_server(port).await;
    let base = format!("http://localhost:{port}");
    let client = Client::new(&base).await.unwrap();
    let agent = client.new_agent("Receipt owner").await.unwrap();
    let drive = client.new_drive(&agent, "Receipt drive").await.unwrap();
    let snapshot = store.get_loro_snapshot(&drive.as_str().into()).unwrap();
    let doc = AtomicLoroDoc::from_snapshot(&snapshot).unwrap();
    let request = StorageReceiptRequest {
        nonce: "a".repeat(64),
        drive: drive.clone(),
        subject: drive,
        version: atomic_lib::agents::encode_base64(&doc.doc().state_vv().encode()),
    };
    Setup {
        base,
        store,
        agent,
        request,
    }
}

async fn post(
    s: &Setup,
    body: Vec<u8>,
    signed_body: Option<&[u8]>,
    agent: Option<&Agent>,
) -> reqwest::Response {
    let url = format!("{}/storage-receipt", s.base);
    let mut request = reqwest::Client::new()
        .post(&url)
        .header("Content-Type", "application/json");
    if let Some(agent) = agent {
        for (key, value) in
            get_authentication_headers_v2("POST", &url, signed_body.unwrap_or(&body), agent)
                .unwrap()
        {
            request = request.header(key, value);
        }
    }
    request.body(body).send().await.unwrap()
}

async fn next_tag(ws: &mut Socket, tag: u8) -> Vec<u8> {
    tokio::time::timeout(Duration::from_secs(5), async {
        while let Some(message) = ws.next().await {
            if let Message::Binary(bytes) = message.unwrap() {
                if bytes.first() == Some(&tag) {
                    return bytes.to_vec();
                }
            }
        }
        panic!("socket closed before tag {tag}")
    })
    .await
    .expect("expected frame within five seconds")
}

async fn socket(s: &Setup, capability: bool) -> Socket {
    let url = s.base.replacen("http:", "ws:", 1) + "/ws";
    let (mut ws, _) = connect_async(&url).await.unwrap();
    let challenge = next_tag(&mut ws, protocol::tag::CHALLENGE).await;
    let nonce = protocol::decode_challenge(&challenge[1..]).unwrap();
    let auth = protocol::encode_auth(&s.agent, &format!("{}#{nonce}", s.base)).unwrap();
    ws.send(Message::Binary(auth.into())).await.unwrap();
    let accepted = next_tag(&mut ws, protocol::tag::AUTH_OK).await;
    assert!(protocol::decode_auth_ok(&accepted[1..]).contains(&CAP.to_owned()));
    let caps: &[&str] = if capability {
        &[CAP, protocol::CAP_CANONICAL_SCHEME]
    } else {
        &[protocol::CAP_CANONICAL_SCHEME]
    };
    ws.send(Message::Binary(
        protocol::encode_hello_with_caps("receipt-test", caps).into(),
    ))
    .await
    .unwrap();
    ws
}

#[tokio::test]
async fn http_receipt_is_an_explicit_authenticated_barrier() {
    let s = setup("http_receipt").await;
    let body = serde_json::to_vec(&s.request).unwrap();
    let response = post(&s, body.clone(), None, Some(&s.agent)).await;
    assert_eq!(response.status(), 200);
    let receipt = StorageReceipt::decode(&response.bytes().await.unwrap()).unwrap();
    assert_eq!(receipt.version, s.request.version);
    assert_eq!(receipt.nonce, s.request.nonce);
    assert_eq!(receipt.barrier, protocol::STORAGE_RECEIPT_BARRIER);
    assert_eq!(receipt.replica.storage_id.len(), 64);
    assert_eq!(post(&s, body.clone(), None, None).await.status(), 401);
    assert_eq!(
        post(&s, body, Some(b"altered"), Some(&s.agent))
            .await
            .status(),
        401
    );
    assert_eq!(
        post(&s, b"not json".to_vec(), None, Some(&s.agent))
            .await
            .status(),
        400
    );
    assert_eq!(
        post(&s, vec![b' '; 65536], None, Some(&s.agent))
            .await
            .status(),
        400
    );
}

#[tokio::test]
async fn websocket_receipt_requires_opt_in_and_returns_the_exact_target() {
    let s = setup("ws_receipt").await;
    let mut ws = socket(&s, true).await;
    ws.send(Message::Binary(s.request.encode_frame().unwrap().into()))
        .await
        .unwrap();
    let frame = next_tag(&mut ws, protocol::tag::STORAGE_RECEIPT).await;
    let receipt = StorageReceipt::decode(&frame[1..]).unwrap();
    assert_eq!(receipt.subject, s.request.subject);
    assert_eq!(receipt.version, s.request.version);
    let mut legacy = socket(&s, false).await;
    legacy
        .send(Message::Binary(s.request.encode_frame().unwrap().into()))
        .await
        .unwrap();
    assert!(
        tokio::time::timeout(Duration::from_millis(300), legacy.next())
            .await
            .is_err()
    );
    // Malformed evidence requests are optional and cannot break ordinary sync.
    ws.send(Message::Binary(
        vec![protocol::tag::STORAGE_RECEIPT_REQUEST, b'{'].into(),
    ))
    .await
    .unwrap();
    let ping = vec![9, 8, 7];
    ws.send(Message::Ping(ping.clone().into())).await.unwrap();
    let pong = tokio::time::timeout(Duration::from_secs(2), async {
        while let Some(message) = ws.next().await {
            if let Message::Pong(bytes) = message.unwrap() {
                return bytes;
            }
        }
        panic!("closed instead of answering ping");
    })
    .await
    .unwrap();
    assert_eq!(pong.as_ref(), ping.as_slice());
    let _ = ws.close(None).await;
    let _ = legacy.close(None).await;
}

#[tokio::test]
async fn http_receipts_refuse_unavailable_state_and_unreadable_subjects() {
    let s = setup("http_receipt_negative").await;
    let mut target = s.request.clone();
    target.subject = "atomic:missing-receipt-target".into();
    assert_eq!(
        post(
            &s,
            serde_json::to_vec(&target).unwrap(),
            None,
            Some(&s.agent)
        )
        .await
        .status(),
        204
    );
    // A peer-supplied external target must not trigger an HTTP read while
    // checking whether it was already stored.
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    target.subject = format!("http://{}/missing", listener.local_addr().unwrap());
    assert_eq!(
        post(
            &s,
            serde_json::to_vec(&target).unwrap(),
            None,
            Some(&s.agent)
        )
        .await
        .status(),
        204
    );
    assert!(
        tokio::time::timeout(Duration::from_millis(100), listener.accept())
            .await
            .is_err()
    );
    target = s.request.clone();
    target.drive = "atomic:other-drive".into();
    assert_eq!(
        post(
            &s,
            serde_json::to_vec(&target).unwrap(),
            None,
            Some(&s.agent)
        )
        .await
        .status(),
        400
    );
    let snapshot = s
        .store
        .get_loro_snapshot(&s.request.subject.as_str().into())
        .unwrap();
    let ahead = AtomicLoroDoc::from_snapshot(&snapshot).unwrap();
    ahead
        .set_property(
            atomic_lib::urls::NAME,
            &atomic_lib::Value::String("Not stored".into()),
        )
        .unwrap();
    target = s.request.clone();
    target.version = atomic_lib::agents::encode_base64(&ahead.doc().state_vv().encode());
    assert_eq!(
        post(
            &s,
            serde_json::to_vec(&target).unwrap(),
            None,
            Some(&s.agent)
        )
        .await
        .status(),
        204
    );
    let other = Client::new(&s.base)
        .await
        .unwrap()
        .new_agent("Stranger")
        .await
        .unwrap();
    assert_eq!(
        post(
            &s,
            serde_json::to_vec(&s.request).unwrap(),
            None,
            Some(&other)
        )
        .await
        .status(),
        401
    );
    let url = format!("{}/storage-receipt", s.base);
    let body = serde_json::to_vec(&s.request).unwrap();
    let mut wrong_url = reqwest::Client::new().post(&url);
    for (key, value) in
        get_authentication_headers_v2("POST", &(s.base.clone() + "/other"), &body, &s.agent)
            .unwrap()
    {
        wrong_url = wrong_url.header(key, value);
    }
    assert_eq!(wrong_url.body(body).send().await.unwrap().status(), 401);
}

#[tokio::test]
async fn commit_advertises_receipt_support_without_changing_its_acknowledgement() {
    let s = setup("http_receipt_capability").await;
    let client = Client::new(&s.base).await.unwrap();
    let mut builder = atomic_lib::commit::CommitBuilder::new("placeholder".into());
    builder.set(
        atomic_lib::urls::PARENT.into(),
        atomic_lib::Value::AtomicUrl(s.request.drive.as_str().into()),
    );
    builder.set(
        atomic_lib::urls::NAME.into(),
        atomic_lib::Value::String("Capability".into()),
    );
    let commit = atomic_lib::commit::Commit::create_did(builder, &s.agent, client.store())
        .await
        .unwrap();
    let body = atomic_lib::client::commit_to_wire_json(&commit, client.store())
        .await
        .unwrap();
    let response = reqwest::Client::new()
        .post(format!("{}/commit", s.base))
        .header("Content-Type", "application/ad+json")
        .header("Origin", "https://other.example")
        .body(body)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    assert_eq!(response.headers().get(HEADER).unwrap(), CAP);
    let exposed = response
        .headers()
        .get("Access-Control-Expose-Headers")
        .unwrap()
        .to_str()
        .unwrap()
        .to_ascii_lowercase();
    assert!(exposed.contains(&HEADER.to_ascii_lowercase()));
    let body: serde_json::Value = response.json().await.unwrap();
    assert!(
        body.get("barrier").is_none(),
        "ordinary commit acceptance is not a flush receipt"
    );
}
