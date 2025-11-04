//! Integration test: two clients sync a resource via AtomicServer.
//!
//! Starts an embedded AtomicServer, creates two agents with the Client API,
//! has one create and edit a resource, verifies the other receives the change
//! via WebSocket subscription.
//!
//! Run with: cargo test -p atomic-server --test sync

use atomic_lib::{
    client::{
        connected::Client,
        ws::{WsClient, WsMessage},
    },
    errors::AtomicResult,
};
use atomic_server_lib as atomic_server;
use std::time::Duration;

/// Start an AtomicServer on a random port in a background thread.
/// Returns the port number.
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
        &format!("./.temp/sync_{}/db", unique),
        "--config-dir",
        &format!("./.temp/sync_{}/config", unique),
    ]);

    let mut config = atomic_server::config::build_config(opts).expect("config failed");
    config.search_index_path = format!("./.temp/sync_{}/search", unique).into();

    // Run server in a separate thread with its own actix runtime
    std::thread::spawn(move || {
        let rt = actix_web::rt::System::new();
        rt.block_on(async {
            atomic_server::serve::serve(config).await.unwrap();
        });
    });

    port
}

/// Wait for the server to be ready.
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
async fn two_clients_sync() -> AtomicResult<()> {
    // Don't init tracing here — the server's serve() does it.
    // If you need logs, run with RUST_LOG=info.

    let port = start_server();
    wait_for_server(port).await;
    let server_url = format!("http://localhost:{}", port);
    let ws_url = format!("ws://localhost:{}/ws", port);

    // --- Client A: create agent, drive, and resource ---
    let client_a = Client::new(&server_url).await?;
    let agent_a = client_a.new_agent("Alice").await?;
    tracing::info!("Agent A: {}", agent_a.subject);

    // Create a public drive so Agent B can subscribe
    let drive_a = client_a.new_public_drive(&agent_a, "Alice's Drive").await?;
    tracing::info!("Drive A: {}", drive_a);

    let mut resource = client_a.new_resource(&drive_a);
    resource.set_name("Hello from Alice");
    resource.set_unsafe(
        atomic_lib::urls::SHORTNAME.into(),
        atomic_lib::Value::Slug("test-resource".into()),
    );
    resource.set_unsafe(
        atomic_lib::urls::DESCRIPTION.into(),
        atomic_lib::Value::String("A test resource for sync".into()),
    );
    resource.set_unsafe(
        atomic_lib::urls::IS_A.into(),
        atomic_lib::Value::ResourceArray(vec![atomic_lib::urls::CLASS.into()]),
    );
    let subject = resource.save_remote(client_a.store()).await?;
    tracing::info!("Created resource: {}", subject);

    // --- Client B: connect via WebSocket, subscribe ---
    let client_b = Client::new(&server_url).await?;
    let agent_b = client_b.new_agent("Bob").await?;
    tracing::info!("Agent B: {}", agent_b.subject);

    tracing::info!("Agent B connecting to WS at {}", ws_url);
    let ws_b = WsClient::connect(&ws_url).await?;
    tracing::info!("Agent B WS connected");
    ws_b.authenticate(&agent_b).await?;
    tracing::info!("Agent B authenticated");
    ws_b.subscribe_resource(&subject).await?;
    tracing::info!("Agent B subscribed to {}", subject);
    // Give the server time to process the subscription
    tokio::time::sleep(Duration::from_secs(1)).await;

    let mut rx = ws_b.subscribe();

    // Give WS subscription time to register
    tokio::time::sleep(Duration::from_millis(300)).await;

    // --- Client A: edit the resource ---
    resource.set_name("Updated by Alice");
    resource.save_remote(client_a.store()).await?;
    tracing::info!("Agent A saved edit");

    // --- Client B: should receive a binary UPDATE frame for the edited resource ---
    let received = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            match rx.recv().await {
                Ok(WsMessage::Update {
                    subject: s,
                    loro_bytes,
                    commit_id,
                    ..
                }) => {
                    if s == subject {
                        return Ok::<(Vec<u8>, Option<String>), atomic_lib::errors::AtomicError>((
                            loro_bytes, commit_id,
                        ));
                    }
                }
                Ok(WsMessage::Error(e)) => {
                    tracing::warn!("WS error: {}", e);
                }
                Ok(_) => continue,
                Err(e) => {
                    return Err(format!("WS channel error: {}", e).into());
                }
            }
        }
    })
    .await
    .map_err(|_| "Timeout: Agent B did not receive the commit within 5 seconds")??;

    let (loro_bytes, commit_id) = received;
    tracing::info!(
        "Agent B received UPDATE: {} loro bytes, commit_id={:?}",
        loro_bytes.len(),
        commit_id
    );
    assert!(
        !loro_bytes.is_empty(),
        "UPDATE frame should carry non-empty Loro bytes"
    );

    // --- Verify: fetch the resource as Client B, check the name ---
    let fetched = client_b.get_resource(&subject).await?;
    let name = fetched.get_name().unwrap_or_default();
    tracing::info!("Fetched name: {}", name);
    assert_eq!(name, "Updated by Alice");

    tracing::info!("Test passed!");
    Ok(())
}
