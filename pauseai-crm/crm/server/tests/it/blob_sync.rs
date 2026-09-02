//! Integration test: blob roundtrip over WebSocket.
//!
//! Alice uploads a file via HTTP `/upload`. Bob authenticates over WS and
//! pulls the bytes back with a binary `BLOB_REQUEST` (0x34) — exercising the
//! full server-side dispatch path (`web_sockets::handle_binary` →
//! `sync::engine::handle_frame` → `Tree::Blobs` lookup → `BLOB_RESPONSE`).
//!
//! Run with: cargo test -p atomic-server --test blob_sync

use atomic_lib::{
    client::{connected::Client, ws::WsClient},
    errors::AtomicResult,
};

use crate::common::{start_server, wait_for_server};

/// POST a single file to `<server_url>/upload?parent=...` as `agent`.
/// Returns the raw response body (JSON-AD array of File resources).
async fn upload_file(
    server_url: &str,
    parent: &str,
    filename: &str,
    bytes: Vec<u8>,
    agent: &atomic_lib::agents::Agent,
) -> AtomicResult<String> {
    let upload_url = format!(
        "{}/upload?parent={}",
        server_url,
        urlencoding_encode(parent)
    );
    let headers = atomic_lib::client::get_authentication_headers(&upload_url, agent)?;

    let part = reqwest::multipart::Part::bytes(bytes).file_name(filename.to_string());
    let form = reqwest::multipart::Form::new().part("file", part);

    let mut req = reqwest::Client::new().post(&upload_url).multipart(form);
    for (k, v) in headers {
        req = req.header(k, v);
    }
    let resp = req
        .send()
        .await
        .map_err(|e| format!("Upload request failed: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("Upload returned {}: {}", status, body).into());
    }
    Ok(resp.text().await.map_err(|e| e.to_string())?)
}

/// Minimal URL-component encoder for the `parent=` query value. Keeps the
/// test self-contained — pulling `urlencoding` in just for one call is
/// unnecessary, and the values we encode are well-formed `did:ad:` URIs.
fn urlencoding_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char);
            }
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

#[tokio::test]
async fn ws_blob_roundtrip() -> AtomicResult<()> {
    let port = start_server("blob_sync");
    wait_for_server(port).await;
    let server_url = format!("http://localhost:{}", port);
    let ws_url = format!("ws://localhost:{}/ws", port);

    // Alice creates a public drive and uploads a file via HTTP.
    let client_a = Client::new(&server_url).await?;
    let agent_a = client_a.new_agent("Alice").await?;
    let drive = client_a
        .new_public_drive(&agent_a, "Blob Test Drive")
        .await?;

    let file_bytes = b"hello blob world, this is a test payload".to_vec();
    let hash = blake3::hash(&file_bytes);
    let hash_bytes: [u8; 32] = *hash.as_bytes();

    let upload_response = upload_file(
        &server_url,
        &drive,
        "hello.txt",
        file_bytes.clone(),
        &agent_a,
    )
    .await?;
    tracing::info!("Uploaded file. Response: {}", upload_response);

    // Bob is a separate authenticated agent. He doesn't need read access to
    // the File resource for this test — content-addressed bytes are bearer
    // capabilities (see docs/src/files.md).
    let client_b = Client::new(&server_url).await?;
    let agent_b = client_b.new_agent("Bob").await?;

    let ws_b = WsClient::connect(&ws_url).await?;
    ws_b.authenticate(&agent_b).await?;

    let received = ws_b.fetch_blob(&hash_bytes).await?;
    assert_eq!(
        received, file_bytes,
        "WS-fetched blob bytes should match the uploaded file exactly"
    );

    Ok(())
}
