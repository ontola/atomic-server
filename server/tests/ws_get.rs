//! WebSocket binary GET → UPDATE integration test.
//!
//! Regression test for `planning/fix-canvas-genesis-save.md`: the server
//! must include the `lastCommit` value (with the `HAS_COMMIT_ID` flag) on
//! every WS `GET` response, otherwise a client that learned the resource
//! purely over WS has no `previousCommit` to set on its next save and
//! incorrectly stamps `isGenesis: true` — which the server then rejects
//! because the resource already exists.
//!
//! Run: cargo test -p atomic-server --test ws_get

use atomic_lib::{
    client::{
        connected::Client,
        ws::{WsClient, WsMessage},
    },
    errors::AtomicResult,
    sync::protocol,
};
use atomic_server_lib as atomic_server;
use std::sync::atomic::{AtomicU16, Ordering};
use std::time::Duration;

static REQ_ID: AtomicU16 = AtomicU16::new(1);

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
        &format!("./.temp/wsget_{}/db", unique),
        "--config-dir",
        &format!("./.temp/wsget_{}/config", unique),
    ]);

    let mut config = atomic_server::config::build_config(opts).expect("config failed");
    config.search_index_path = format!("./.temp/wsget_{}/search", unique).into();

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

#[tokio::test]
async fn ws_get_carries_commit_id() -> AtomicResult<()> {
    let port = start_server();
    wait_for_server(port).await;
    let server_url = format!("http://localhost:{}", port);
    let ws_url = format!("ws://localhost:{}/ws", port);

    // Set up an agent + public drive + a saved resource over HTTP, so the
    // resource has a real lastCommit when we GET it over WS.
    let client = Client::new(&server_url).await?;
    let agent = client.new_agent("GetTester").await?;
    let drive = client.new_public_drive(&agent, "Get Drive").await?;

    let mut resource = client.new_resource(&drive)?;
    resource.set_name("WS GET Target")?;
    resource.set_unsafe(
        atomic_lib::urls::IS_A.into(),
        atomic_lib::Value::ResourceArray(vec![atomic_lib::urls::CLASS.into()]),
    )?;
    resource.set_unsafe(
        atomic_lib::urls::SHORTNAME.into(),
        atomic_lib::Value::Slug("ws-get-target".into()),
    )?;
    resource.set_unsafe(
        atomic_lib::urls::DESCRIPTION.into(),
        atomic_lib::Value::String("Resource that proves WS GET carries lastCommit".into()),
    )?;
    let subject = resource.save_remote(client.store()).await?;

    // Reload so we know what lastCommit the server thinks is current.
    let server_resource = client.get_resource(&subject).await?;
    let expected_last_commit = server_resource
        .get(atomic_lib::urls::LAST_COMMIT)
        .ok()
        .map(|v| v.to_string())
        .filter(|s| !s.is_empty())
        .expect(
            "resource just created via save_remote should have a non-empty lastCommit on the server",
        );

    // Connect a fresh WS client and send a binary GET (0x10).
    let ws = WsClient::connect(&ws_url).await?;
    ws.authenticate(&agent).await?;
    let mut rx = ws.subscribe();

    let request_id = REQ_ID.fetch_add(1, Ordering::Relaxed);
    let frame = protocol::encode_get(request_id, &subject);
    ws.send_binary(frame).await?;

    let update = tokio::time::timeout(Duration::from_secs(10), async {
        while let Ok(msg) = rx.recv().await {
            if let WsMessage::Update {
                subject: s,
                loro_bytes,
                commit_id,
                is_snapshot,
                is_push,
            } = msg
            {
                if s == subject {
                    return Some((loro_bytes, commit_id, is_snapshot, is_push));
                }
            }
        }
        None
    })
    .await
    .map_err(|_| atomic_lib::errors::AtomicError::from("Timed out waiting for UPDATE"))?
    .ok_or_else(|| atomic_lib::errors::AtomicError::from("WS closed before UPDATE arrived"))?;

    let (loro_bytes, commit_id, is_snapshot, is_push) = update;

    assert!(is_snapshot, "GET response should set the SNAPSHOT flag");
    assert!(
        !is_push,
        "GET response is a direct reply, not a subscription PUSH"
    );
    assert!(
        !loro_bytes.is_empty(),
        "GET response should carry a non-empty Loro snapshot"
    );
    assert_eq!(
        commit_id.as_deref(),
        Some(expected_last_commit.as_str()),
        "UPDATE response to a binary GET must carry the resource's current lastCommit \
         (HAS_COMMIT_ID flag) — see planning/fix-canvas-genesis-save.md",
    );

    Ok(())
}
