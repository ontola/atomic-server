//! WebSocket COMMIT / COMMIT_OK integration test.
//!
//! Run: cargo test -p atomic-server --test ws_commit

use atomic_lib::{
    client::{
        connected::Client,
        ws::{WsClient, WsMessage},
    },
    errors::AtomicResult,
    Storelike,
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
        &format!("./.temp/wscommit_{}/db", unique),
        "--config-dir",
        &format!("./.temp/wscommit_{}/config", unique),
    ]);

    let mut config = atomic_server::config::build_config(opts).expect("config failed");
    config.search_index_path = format!("./.temp/wscommit_{}/search", unique).into();

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
async fn ws_commit_syncs_to_subscriber() -> AtomicResult<()> {
    let port = start_server();
    wait_for_server(port).await;
    let server_url = format!("http://localhost:{}", port);
    let ws_url = format!("ws://localhost:{}/ws", port);

    let client_a = Client::new(&server_url).await?;
    let agent_a = client_a.new_agent("Alice").await?;
    let drive = client_a.new_public_drive(&agent_a, "Commit Drive").await?;

    let mut resource = client_a.new_resource(&drive);
    resource.set_name("Sync Target");
    resource.set_unsafe(
        atomic_lib::urls::IS_A.into(),
        atomic_lib::Value::ResourceArray(vec![atomic_lib::urls::CLASS.into()]),
    );
    resource.set_unsafe(
        atomic_lib::urls::SHORTNAME.into(),
        atomic_lib::Value::Slug("sync-target".into()),
    );
    resource.set_unsafe(
        atomic_lib::urls::DESCRIPTION.into(),
        atomic_lib::Value::String("A test resource for ws commit".into()),
    );
    let subject = resource.save_remote(client_a.store()).await?;
    let subject_str = subject.clone();
    // Reload so local Loro state matches server (same as a real client after save_remote).
    let mut resource = client_a.get_resource(&subject_str).await?;

    let client_b = Client::new(&server_url).await?;
    let agent_b = client_b.new_agent("Bob").await?;
    let ws_b = WsClient::connect(&ws_url).await?;
    ws_b.authenticate(&agent_b).await?;
    ws_b.subscribe_resource(&subject_str).await?;

    let mut rx = ws_b.subscribe();
    tokio::time::sleep(Duration::from_millis(200)).await;

    // Agent A posts a commit over WS (same commit construction as save_remote)
    resource.set_name("Updated via WS commit");
    let snapshot = resource.build_state_doc()?.export_snapshot();
    let mut commitbuilder = resource.get_commit_builder().clone();
    commitbuilder.set_loro_update(snapshot);
    let commit = commitbuilder
        .sign(&agent_a, client_a.store(), &resource)
        .await?;
    let commit_json = atomic_lib::client::commit_to_wire_json(&commit, client_a.store()).await?;

    let ws_a = WsClient::connect(&ws_url).await?;
    ws_a.authenticate(&agent_a).await?;
    let request_id = REQ_ID.fetch_add(1, Ordering::Relaxed);
    let _ok = ws_a.post_commit(request_id, &commit_json).await?;

    // Bob should receive an UPDATE for the resource
    let received = tokio::time::timeout(Duration::from_secs(10), async {
        while let Ok(msg) = rx.recv().await {
            if let WsMessage::Update { subject: s, .. } = msg {
                if s == subject_str {
                    return true;
                }
            }
        }
        false
    })
    .await
    .unwrap_or(false);

    assert!(received, "subscriber should receive UPDATE after WS COMMIT");

    Ok(())
}
