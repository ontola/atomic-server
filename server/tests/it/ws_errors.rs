//! The `ERROR` (0x03) frame contract over WebSocket:
//! `[0x03] [request_id: u16] [code: u16] [message]`.
//!
//! A refused `COMMIT` is answered with the request id the client chose, so
//! several commits may be in flight and each failure lands on the right
//! one; the code classifies the refusal (`protocol::error_code`); the
//! socket stays open and a later, valid commit on it still succeeds.
//!
//! Run: cargo test -p atomic-server --test it ws_errors

use atomic_lib::{
    client::{
        connected::Client,
        ws::{WsClient, WsMessage},
    },
    errors::AtomicResult,
    sync::protocol::{self, error_code},
};
use std::time::Duration;
use tokio::sync::broadcast::Receiver;

use crate::common::{start_server, wait_for_server};

/// The next `ERROR` on the connection, as `(request_id, code, message)`.
async fn next_error(rx: &mut Receiver<WsMessage>) -> (u16, u16, String) {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            match rx.recv().await {
                Ok(WsMessage::Error {
                    request_id,
                    code,
                    message,
                }) => return (request_id, code, message),
                Ok(_) => continue,
                Err(e) => panic!("connection closed before an ERROR arrived: {e}"),
            }
        }
    })
    .await
    .expect("an ERROR within 5s")
}

/// A signed genesis commit for a new classless resource under `parent`,
/// with a `did:ad:` subject minted from `signer`'s certificate.
async fn genesis_commit_json(
    client: &Client,
    signer: &atomic_lib::agents::Agent,
    parent: &str,
    name: &str,
) -> AtomicResult<String> {
    let mut builder = atomic_lib::commit::CommitBuilder::new("placeholder".into());
    builder.set(
        atomic_lib::urls::NAME.into(),
        atomic_lib::Value::String(name.into()),
    );
    builder.set(
        atomic_lib::urls::PARENT.into(),
        atomic_lib::Value::AtomicUrl(parent.into()),
    );
    let commit = atomic_lib::commit::Commit::create_did(builder, signer, client.store()).await?;
    atomic_lib::client::commit_to_wire_json(&commit, client.store()).await
}

#[tokio::test]
async fn commit_errors_echo_the_request_id_and_carry_a_code() -> AtomicResult<()> {
    let port = start_server("ws_errors");
    wait_for_server(port).await;
    let server_url = format!("http://localhost:{port}");
    let ws_url = format!("ws://localhost:{port}/ws");

    let client = Client::new(&server_url).await?;
    let alice = client.new_agent("Alice").await?;
    let private_drive = client.new_drive(&alice, "Private").await?;
    let mallory = client.new_agent("Mallory").await?;

    // COMMIT needs no session identity: the envelope's signature is the
    // authority. An anonymous socket exercises exactly that.
    let ws = WsClient::connect(&ws_url).await?;
    let mut rx = ws.subscribe();

    // 1. A frame that is not a commit at all.
    let mut garbage = vec![protocol::tag::COMMIT, 0x00, 0x2a];
    garbage.extend_from_slice(b"this is not JSON");
    ws.send_binary(garbage).await?;
    let (rid, code, message) = next_error(&mut rx).await;
    assert_eq!(
        rid, 0x2a,
        "the ERROR names the COMMIT it answers: {message}"
    );
    assert_eq!(code, error_code::UNKNOWN, "{message}");

    // 2. A well-formed commit by an agent without write rights.
    let unauthorized = genesis_commit_json(&client, &mallory, &private_drive, "Intruder").await?;
    ws.send_binary(protocol::encode_commit(43, &unauthorized))
        .await?;
    let (rid, code, message) = next_error(&mut rx).await;
    assert_eq!(rid, 43, "{message}");
    assert_eq!(code, error_code::UNAUTHORIZED_WRITE, "{message}");

    // 3. The owner's commit with its signature tampered.
    let valid = genesis_commit_json(&client, &alice, &private_drive, "Tampered").await?;
    let mut json: serde_json::Value = serde_json::from_str(&valid)?;
    let sig_key = "https://atomicdata.dev/properties/signature";
    let sig = json[sig_key].as_str().unwrap().to_string();
    let flipped = if sig.starts_with('A') { "B" } else { "A" };
    json[sig_key] = serde_json::Value::String(format!("{flipped}{}", &sig[1..]));
    ws.send_binary(protocol::encode_commit(44, &json.to_string()))
        .await?;
    let (rid, code, message) = next_error(&mut rx).await;
    assert_eq!(rid, 44, "{message}");
    assert_eq!(code, error_code::INVALID_SIGNATURE, "{message}");

    // 4. A commit on a subject that does not exist and is not a genesis.
    let mut json: serde_json::Value = serde_json::from_str(&valid)?;
    json["https://atomicdata.dev/properties/subject"] =
        serde_json::Value::String("did:ad:nonexistent-subject".into());
    json.as_object_mut()
        .unwrap()
        .remove("https://atomicdata.dev/properties/isGenesis");
    ws.send_binary(protocol::encode_commit(45, &json.to_string()))
        .await?;
    let (rid, code, message) = next_error(&mut rx).await;
    assert_eq!(rid, 45, "{message}");
    assert!(
        code == error_code::INVALID_SIGNATURE || code == error_code::UNKNOWN,
        "an unknown subject is refused ({code}): {message}"
    );

    // 5. Two refusals in flight at once each come back on their own id.
    ws.send_binary(protocol::encode_commit(46, &unauthorized))
        .await?;
    ws.send_binary(protocol::encode_commit(47, &unauthorized))
        .await?;
    let mut seen = vec![next_error(&mut rx).await.0, next_error(&mut rx).await.0];
    seen.sort_unstable();
    assert_eq!(seen, vec![46, 47]);

    // 6. The socket is still usable: the owner's valid commit is applied.
    let ok = genesis_commit_json(&client, &alice, &private_drive, "Fine").await?;
    let commit_id = ws.post_commit(48, &ok).await?;
    assert!(
        commit_id.starts_with("did:ad:commit:") || commit_id.contains("/commits/"),
        "{commit_id}"
    );

    Ok(())
}
