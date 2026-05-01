use atomic_lib::{client::ws::WsClient, errors::AtomicResult, Storelike};
use atomic_server_lib as atomic_server;
use std::time::Duration;

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
        &format!("./.temp/multisync_{}/db", unique),
        "--config-dir",
        &format!("./.temp/multisync_{}/config", unique),
    ]);

    let mut config = atomic_server::config::build_config(opts).expect("config failed");
    config.search_index_path = format!("./.temp/multisync_{}/search", unique).into();

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
    for _ in 0..150 {
        if reqwest::get(&base).await.is_ok() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    panic!("Server did not start within 15 seconds");
}

#[tokio::test]
async fn test_multi_client_gallery_sync() -> AtomicResult<()> {
    let port = start_server();
    wait_for_server(port).await;
    let server_url = format!("http://localhost:{}", port);
    let ws_url = format!("ws://localhost:{}/ws", port);

    // Setup Agent Alice (shared between devices)
    let temp_store = atomic_lib::client::connected::Client::new(&server_url).await?;
    let agent = temp_store.new_agent("Alice").await?;
    let drive_subject = temp_store.new_public_drive(&agent, "Alice's Drive").await?;

    // Device A (Tablet) - Local Redb Store
    let dir_a =
        std::env::temp_dir().join(format!("device_a_{}", atomic_lib::utils::random_string(5)));
    let db_a =
        atomic_lib::Db::init_redb_file(&dir_a, Some(server_url.clone()), &dir_a.join("uploads"))
            .await?;
    db_a.set_default_agent(agent.clone());
    db_a.set_active_drive(&drive_subject)?;

    // Device B (Phone) - Local Redb Store
    let dir_b =
        std::env::temp_dir().join(format!("device_b_{}", atomic_lib::utils::random_string(5)));
    let db_b =
        atomic_lib::Db::init_redb_file(&dir_b, Some(server_url.clone()), &dir_b.join("uploads"))
            .await?;
    db_b.set_default_agent(agent.clone());
    db_b.set_active_drive(&drive_subject)?;

    // Start WS session for Tablet (Device A)
    let ws_a = WsClient::connect(&ws_url).await?;
    ws_a.authenticate(&agent).await?;
    ws_a.subscribe_query(
        atomic_lib::urls::PARENT,
        &drive_subject,
        drive_subject.as_str(),
    )
    .await?;

    // Start WS session for Phone (Device B)
    let ws_b = WsClient::connect(&ws_url).await?;
    ws_b.authenticate(&agent).await?;
    ws_b.subscribe_query(
        atomic_lib::urls::PARENT,
        &drive_subject,
        drive_subject.as_str(),
    )
    .await?;

    // Listen before the commit — broadcast receivers miss messages sent earlier.
    let mut rx_b = ws_b.subscribe();

    // ENSURE SUBSCRIPTION IS REGISTERED
    tokio::time::sleep(Duration::from_millis(1000)).await;

    // 1. Tablet creates a DID canvas (same pattern as Flutter gallery / ws_sync).
    let mut canvas_res = atomic_lib::Resource::new("did:ad:placeholder".into());
    canvas_res.set_unsafe(
        atomic_lib::urls::IS_A.into(),
        vec![atomic_lib::urls::PARAGRAPH].into(),
    )?;
    canvas_res.set_unsafe(
        atomic_lib::urls::PARENT.into(),
        drive_subject.clone().into(),
    )?;
    canvas_res.set_name("Tablet Canvas")?;
    canvas_res.set_unsafe(
        atomic_lib::urls::DESCRIPTION.into(),
        atomic_lib::Value::String("A test canvas".into()),
    )?;
    let response = canvas_res.save_as_genesis(&db_a).await?;
    let canvas_subject = response.commit.subject.clone();

    // Push commit to server
    let commit_json = atomic_lib::client::commit_to_wire_json(&response.commit, &db_a).await?;
    ws_a.post_commit(1, &commit_json).await?;

    // 2. Phone should see the canvas via QUERY_UPDATE
    let received_query_update = tokio::time::timeout(Duration::from_secs(10), async {
        while let Ok(msg) = rx_b.recv().await {
            if let atomic_lib::client::ws::WsMessage::QueryUpdate { .. } = msg {
                return true;
            }
        }
        false
    })
    .await
    .unwrap_or(false);

    assert!(
        received_query_update,
        "Phone should receive QUERY_UPDATE when Tablet adds canvas"
    );

    // Phone subscribes to the newly discovered resource
    ws_b.subscribe_resource(canvas_subject.as_str()).await?;
    tokio::time::sleep(Duration::from_millis(500)).await;

    // 3. Tablet edits the canvas (stroke)
    let mut canvas = db_a.get_resource(&canvas_subject).await?;
    canvas.set_name("Tablet Canvas (Edited)")?;
    let response_edit = canvas.save_locally(&db_a).await?;
    let commit_json_edit =
        atomic_lib::client::commit_to_wire_json(&response_edit.commit, &db_a).await?;
    ws_a.post_commit(2, &commit_json_edit).await?;

    // 4. Phone should receive UPDATE
    let received_update = tokio::time::timeout(Duration::from_secs(10), async {
        while let Ok(msg) = rx_b.recv().await {
            if let atomic_lib::client::ws::WsMessage::Update { subject, .. } = msg {
                if subject == canvas_subject.as_str() {
                    return true;
                }
            }
        }
        false
    })
    .await
    .unwrap_or(false);

    assert!(
        received_update,
        "Phone should receive UPDATE when Tablet edits canvas"
    );

    Ok(())
}
