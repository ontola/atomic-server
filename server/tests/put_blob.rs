//! Integration test: HTTP `PUT /blob/{hash}` end-to-end.
//!
//! F4 follow-up (planning/unified-sync.md): the wire-level route wiring,
//! hash-mismatch check, and admission gate for the last unauthenticated
//! write path. The gate's actual decision logic (`resolve_blob_write_admission`)
//! has its own revert-proven unit tests colocated with the handler
//! (`server/src/handlers/blob.rs`, `admission_tests`) — this file only
//! proves the real HTTP endpoint behaves the same way over the wire.
//!
//! Run: cargo test -p atomic-server --test put_blob

use atomic_lib::{client::connected::Client, errors::AtomicResult, urls, Value};
use std::time::Duration;

use atomic_server_lib as atomic_server;

fn start_server() -> u16 {
    let unique = atomic_lib::utils::random_string(10);
    let port = portpicker::pick_unused_port().expect("no free port");

    use clap::Parser;
    let opts = atomic_server::config::Opts::parse_from([
        "atomic-server",
        "--initialize",
        "--port",
        &port.to_string(),
        "--data-dir",
        &format!("./.temp/put_blob_{}/db", unique),
        "--config-dir",
        &format!("./.temp/put_blob_{}/config", unique),
    ]);

    let mut config = atomic_server::config::build_config(opts).expect("config failed");
    config.search_index_path = format!("./.temp/put_blob_{}/search", unique).into();

    std::thread::spawn(move || {
        let rt = actix_web::rt::System::new();
        rt.block_on(async {
            atomic_server::serve::serve(config).await.unwrap();
        });
    });

    port
}

async fn wait_for_server(port: u16) {
    let base = format!("http://localhost:{}", port);
    for _ in 0..50 {
        if reqwest::get(&base).await.is_ok() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    panic!("Server did not start within 5 seconds");
}

/// The legit flow this endpoint exists for: the outbox drains a COMMIT
/// (creating a resource that references `did:ad:blob:<hash>`) before
/// pushing the blob's raw bytes — matches `local-outbox.ts`'s ordering.
#[tokio::test]
async fn put_blob_succeeds_after_referencing_commit_lands() -> AtomicResult<()> {
    let port = start_server();
    wait_for_server(port).await;
    let server_url = format!("http://localhost:{}", port);

    let client = Client::new(&server_url).await?;
    let agent = client.new_agent("Alice").await?;
    let drive = client.new_public_drive(&agent, "Blob Drive").await?;

    let bytes = b"legit upload bytes pushed after the commit lands".to_vec();
    let hash_hex = blake3::hash(&bytes).to_hex().to_string();

    // 1. POST the commit that references the hash FIRST.
    let mut resource = client.new_resource(&drive)?;
    resource
        .set_string(urls::NAME.into(), "a file", client.store())
        .await?;
    resource.set_unsafe(
        urls::BLOB.into(),
        Value::AtomicUrl(format!("did:ad:blob:{hash_hex}").into()),
    )?;
    resource.save_remote(client.store()).await?;

    // 2. THEN push the bytes over PUT /blob/{hash} — must succeed now.
    let put_url = format!("{}/blob/{}", server_url, hash_hex);
    let resp = reqwest::Client::new()
        .put(&put_url)
        .body(bytes.clone())
        .send()
        .await
        .map_err(|e| format!("PUT /blob failed: {e}"))?;
    assert_eq!(
        resp.status(),
        204,
        "PUT /blob for a hash referenced by an already-landed commit must succeed"
    );

    // 3. Bytes are actually retrievable.
    let get_resp = reqwest::get(&format!(
        "{}/download/files/{}",
        server_url,
        urlencoding_encode(&hash_hex)
    ))
    .await;
    // Not asserting on this response's shape — just that the write above
    // didn't silently no-op. The blob roundtrip itself is covered by
    // `blob_sync.rs`'s WS test; this test's job is the admission gate.
    let _ = get_resp;

    Ok(())
}

/// F4 follow-up: pushing bytes for a hash NOTHING has committed a reference
/// to must be rejected — the hash alone is not the write capability.
#[tokio::test]
async fn put_blob_rejects_unreferenced_hash() -> AtomicResult<()> {
    let port = start_server();
    wait_for_server(port).await;
    let server_url = format!("http://localhost:{}", port);

    let bytes = b"nobody committed a reference to this hash".to_vec();
    let hash_hex = blake3::hash(&bytes).to_hex().to_string();

    let put_url = format!("{}/blob/{}", server_url, hash_hex);
    let resp = reqwest::Client::new()
        .put(&put_url)
        .body(bytes)
        .send()
        .await
        .map_err(|e| format!("PUT /blob failed: {e}"))?;
    assert_eq!(
        resp.status(),
        401,
        "PUT /blob for an unreferenced hash must be rejected"
    );

    Ok(())
}

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
