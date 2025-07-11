//! Integration test: subscribing to a query and receiving live updates.
//!
//! Starts an embedded AtomicServer, creates two agents. Agent A creates a
//! parent resource (like a chatroom/table). Agent B subscribes to the query
//! "resources where parent = <parent>". Agent A creates a child resource.
//! Agent B should receive a QUERY_UPDATE notification with the child's subject.
//!
//! Run with: cargo test -p atomic-server --test query_subscribe

use atomic_lib::{
    client::{
        connected::Client,
        ws::{WsClient, WsMessage},
    },
    errors::AtomicResult,
};
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
        &format!("./.temp/qsub_{}/db", unique),
        "--config-dir",
        &format!("./.temp/qsub_{}/config", unique),
    ]);

    let mut config =
        atomic_server::config::build_config(opts).expect("config failed");
    config.search_index_path =
        format!("./.temp/qsub_{}/search", unique).into();

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
async fn query_subscribe_receives_new_child() -> AtomicResult<()> {
    let port = start_server();
    wait_for_server(port).await;
    let server_url = format!("http://localhost:{}", port);
    let ws_url = format!("ws://localhost:{}/ws", port);

    // --- Agent A: create a public drive and a parent resource ---
    let client_a = Client::new(&server_url).await?;
    let agent_a = client_a.new_agent("Alice").await?;
    let drive = client_a.new_public_drive(&agent_a, "Test Drive").await?;

    // Create a parent resource (like a ChatRoom or Table)
    let mut parent = client_a.new_resource(&drive);
    parent.set_name("Test Parent");
    parent.set_unsafe(
        atomic_lib::urls::IS_A.into(),
        atomic_lib::Value::ResourceArray(vec![atomic_lib::urls::CLASS.into()]),
    );
    parent.set_unsafe(
        atomic_lib::urls::SHORTNAME.into(),
        atomic_lib::Value::Slug("test-parent".into()),
    );
    parent.set_unsafe(
        atomic_lib::urls::DESCRIPTION.into(),
        atomic_lib::Value::String("A test parent resource".into()),
    );
    let parent_subject = parent.save_remote(client_a.store()).await?;

    // --- Agent B: connect via WS, subscribe to query "parent = parent_subject" ---
    let client_b = Client::new(&server_url).await?;
    let agent_b = client_b.new_agent("Bob").await?;

    let ws_b = WsClient::connect(&ws_url).await?;
    ws_b.authenticate(&agent_b).await?;

    // Subscribe to the query
    let query_json = serde_json::json!({
        "property": atomic_lib::urls::PARENT,
        "value": parent_subject,
    });
    ws_b.send_raw(&format!("SUBSCRIBE_QUERY {}", query_json)).await?;

    let mut rx = ws_b.subscribe();

    // Give subscription time to register
    tokio::time::sleep(Duration::from_secs(1)).await;

    // --- Agent A: create a child resource ---
    let mut child = client_a.new_resource(&parent_subject);
    child.set_name("New Child");
    child.set_unsafe(
        atomic_lib::urls::IS_A.into(),
        atomic_lib::Value::ResourceArray(vec![atomic_lib::urls::CLASS.into()]),
    );
    child.set_unsafe(
        atomic_lib::urls::SHORTNAME.into(),
        atomic_lib::Value::Slug("new-child".into()),
    );
    child.set_unsafe(
        atomic_lib::urls::DESCRIPTION.into(),
        atomic_lib::Value::String("A test child resource".into()),
    );
    let child_subject = child.save_remote(client_a.store()).await?;

    // --- Agent B: should receive a QUERY_UPDATE with the child subject ---
    let received = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            match rx.recv().await {
                Ok(WsMessage::QueryUpdate { property, value, added, removed }) => {
                    if added.contains(&child_subject) {
                        return Ok::<(Option<String>, Option<String>, Vec<String>, Vec<String>), atomic_lib::errors::AtomicError>(
                            (property, value, added, removed)
                        );
                    }
                }
                Ok(WsMessage::Error(e)) => {
                    tracing::warn!("WS error: {}", e);
                }
                Ok(_) => continue,  // Skip other messages (COMMIT, etc.)
                Err(e) => {
                    return Err(format!("WS channel error: {}", e).into());
                }
            }
        }
    })
    .await
    .map_err(|_| "Timeout: Agent B did not receive QUERY_UPDATE within 5 seconds")??;

    let (property, value, added, removed) = received;

    // Verify the QUERY_UPDATE has the right structure
    assert_eq!(
        property.as_deref(),
        Some(atomic_lib::urls::PARENT),
        "QUERY_UPDATE property should be 'parent'"
    );
    assert_eq!(
        value.as_deref(),
        Some(parent_subject.as_str()),
        "QUERY_UPDATE value should be the parent subject"
    );
    assert!(
        added.contains(&child_subject),
        "QUERY_UPDATE should contain the child subject in 'added'"
    );
    assert!(
        removed.is_empty(),
        "QUERY_UPDATE should have no 'removed' entries"
    );

    Ok(())
}

#[tokio::test]
async fn drive_wide_subscription_receives_any_change() -> AtomicResult<()> {
    let port = start_server();
    wait_for_server(port).await;
    let server_url = format!("http://localhost:{}", port);
    let ws_url = format!("ws://localhost:{}/ws", port);

    // --- Agent A: create a public drive ---
    let client_a = Client::new(&server_url).await?;
    let agent_a = client_a.new_agent("Alice").await?;
    let drive = client_a.new_public_drive(&agent_a, "Test Drive").await?;

    // --- Agent B: subscribe to ALL changes in the drive ---
    let client_b = Client::new(&server_url).await?;
    let agent_b = client_b.new_agent("Bob").await?;

    let ws_b = WsClient::connect(&ws_url).await?;
    ws_b.authenticate(&agent_b).await?;

    let query_json = serde_json::json!({
        "drive": drive,
    });
    ws_b.send_raw(&format!("SUBSCRIBE_QUERY {}", query_json)).await?;

    let mut rx = ws_b.subscribe();
    tokio::time::sleep(Duration::from_secs(1)).await;

    // --- Agent A: create any resource in the drive ---
    let mut resource = client_a.new_resource(&drive);
    resource.set_name("Something");
    resource.set_unsafe(
        atomic_lib::urls::IS_A.into(),
        atomic_lib::Value::ResourceArray(vec![atomic_lib::urls::CLASS.into()]),
    );
    resource.set_unsafe(
        atomic_lib::urls::SHORTNAME.into(),
        atomic_lib::Value::Slug("something".into()),
    );
    resource.set_unsafe(
        atomic_lib::urls::DESCRIPTION.into(),
        atomic_lib::Value::String("A resource".into()),
    );
    let resource_subject = resource.save_remote(client_a.store()).await?;

    // --- Agent B: should receive a QUERY_UPDATE ---
    let received = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            match rx.recv().await {
                Ok(WsMessage::QueryUpdate { added, .. }) => {
                    if added.contains(&resource_subject) {
                        return Ok::<bool, atomic_lib::errors::AtomicError>(true);
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
    .map_err(|_| "Timeout: Agent B did not receive drive-wide QUERY_UPDATE within 5 seconds")??;

    assert!(received, "Should have received the resource in a drive-wide update");

    Ok(())
}
