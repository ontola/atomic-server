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

    let mut config = atomic_server::config::build_config(opts).expect("config failed");
    config.search_index_path = format!("./.temp/qsub_{}/search", unique).into();

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

    // Subscribe to the query. `drive` is required — it's the auth boundary
    // for the subscription (see commit_monitor.rs::SubscribeQuery handler).
    let query_json = serde_json::json!({
        "property": atomic_lib::urls::PARENT,
        "value": parent_subject,
        "drive": drive,
    });
    ws_b.send_raw(&format!("SUBSCRIBE_QUERY {}", query_json))
        .await?;

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
                Ok(WsMessage::QueryUpdate {
                    property,
                    value,
                    added,
                    removed,
                }) => {
                    if added.contains(&child_subject) {
                        return Ok::<
                            (Option<String>, Option<String>, Vec<String>, Vec<String>),
                            atomic_lib::errors::AtomicError,
                        >((property, value, added, removed));
                    }
                }
                Ok(WsMessage::Error(e)) => {
                    tracing::warn!("WS error: {}", e);
                }
                Ok(_) => continue, // Skip other messages (COMMIT, etc.)
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

/// Listener-path coverage: a filter with property + value + drive registers
/// in `Tree::WatchedQueries`, the persisted index emits
/// `DbEvent::QueryMembershipChanged`, the CommitMonitor's listener task
/// forwards it as `MembershipNotification`, and the subscriber receives a
/// binary `QUERY_UPDATE` (0x36) via WsClient.
#[tokio::test]
async fn query_subscribe_listener_path_receives_update() -> AtomicResult<()> {
    let port = start_server();
    wait_for_server(port).await;
    let server_url = format!("http://localhost:{}", port);
    let ws_url = format!("ws://localhost:{}/ws", port);

    let client_a = Client::new(&server_url).await?;
    let agent_a = client_a.new_agent("Alice").await?;
    let drive = client_a
        .new_public_drive(&agent_a, "Listener Drive")
        .await?;

    let mut parent = client_a.new_resource(&drive);
    parent.set_name("Listener Parent");
    parent.set_unsafe(
        atomic_lib::urls::IS_A.into(),
        atomic_lib::Value::ResourceArray(vec![atomic_lib::urls::CLASS.into()]),
    );
    parent.set_unsafe(
        atomic_lib::urls::SHORTNAME.into(),
        atomic_lib::Value::Slug("listener-parent".into()),
    );
    parent.set_unsafe(
        atomic_lib::urls::DESCRIPTION.into(),
        atomic_lib::Value::String("Listener-path parent".into()),
    );
    let parent_subject = parent.save_remote(client_a.store()).await?;

    let client_b = Client::new(&server_url).await?;
    let agent_b = client_b.new_agent("Bob").await?;
    let ws_b = WsClient::connect(&ws_url).await?;
    ws_b.authenticate(&agent_b).await?;

    // Filter has property + value + drive — exercises the listener path.
    let query_json = serde_json::json!({
        "property": atomic_lib::urls::PARENT,
        "value": parent_subject,
        "drive": drive,
    });
    ws_b.send_raw(&format!("SUBSCRIBE_QUERY {}", query_json))
        .await?;
    let mut rx = ws_b.subscribe();
    tokio::time::sleep(Duration::from_secs(1)).await;

    let mut child = client_a.new_resource(&parent_subject);
    child.set_name("Listener Child");
    child.set_unsafe(
        atomic_lib::urls::IS_A.into(),
        atomic_lib::Value::ResourceArray(vec![atomic_lib::urls::CLASS.into()]),
    );
    child.set_unsafe(
        atomic_lib::urls::SHORTNAME.into(),
        atomic_lib::Value::Slug("listener-child".into()),
    );
    child.set_unsafe(
        atomic_lib::urls::DESCRIPTION.into(),
        atomic_lib::Value::String("Listener-path child".into()),
    );
    let child_subject = child.save_remote(client_a.store()).await?;

    let received = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            match rx.recv().await {
                Ok(WsMessage::QueryUpdate { added, .. }) => {
                    if added.contains(&child_subject) {
                        return Ok::<(), atomic_lib::errors::AtomicError>(());
                    }
                }
                Ok(WsMessage::Error(e)) => {
                    tracing::warn!("WS error: {}", e);
                }
                Ok(_) => continue,
                Err(e) => return Err(format!("WS channel error: {}", e).into()),
            }
        }
    })
    .await
    .map_err(|_| "Timeout: listener path did not emit QUERY_UPDATE within 5s")??;

    let _ = received;
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
    ws_b.send_raw(&format!("SUBSCRIBE_QUERY {}", query_json))
        .await?;

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

    assert!(
        received,
        "Should have received the resource in a drive-wide update"
    );

    Ok(())
}

/// Security regression test: a query subscription must be authorized.
///
/// Alice owns a *private* drive (read access for Alice only). Bob is an
/// authenticated agent with no permission on the drive. Bob subscribes to
/// the drive via SUBSCRIBE_QUERY and Alice then creates a child resource.
///
/// Bob must NOT receive a QUERY_UPDATE — the subject of the new resource
/// (and the fact that *something* changed in the drive) is information he
/// has no right to. The `SubscribeQuery` handler in `commit_monitor.rs`
/// runs `hierarchy::check_read` against the drive before registering, so
/// Bob's subscription is silently dropped and no notifications follow.
#[tokio::test]
async fn query_subscribe_requires_read_permission() -> AtomicResult<()> {
    let port = start_server();
    wait_for_server(port).await;
    let server_url = format!("http://localhost:{}", port);
    let ws_url = format!("ws://localhost:{}/ws", port);

    // --- Agent A: create a PRIVATE drive (read access only for Alice) ---
    let client_a = Client::new(&server_url).await?;
    let agent_a = client_a.new_agent("Alice").await?;
    let private_drive = client_a
        .new_drive(&agent_a, "Alice's Private Drive")
        .await?;

    // --- Agent B: authenticated, but has no permission on Alice's drive ---
    let client_b = Client::new(&server_url).await?;
    let agent_b = client_b.new_agent("Bob").await?;

    let ws_b = WsClient::connect(&ws_url).await?;
    ws_b.authenticate(&agent_b).await?;

    // Bob subscribes to Alice's private drive. The server should refuse,
    // since Bob cannot read it.
    let query_json = serde_json::json!({
        "drive": private_drive,
    });
    ws_b.send_raw(&format!("SUBSCRIBE_QUERY {}", query_json))
        .await?;

    let mut rx = ws_b.subscribe();
    tokio::time::sleep(Duration::from_secs(1)).await;

    // --- Agent A: create a child resource inside the private drive ---
    let mut secret = client_a.new_resource(&private_drive);
    secret.set_name("Top Secret");
    secret.set_unsafe(
        atomic_lib::urls::IS_A.into(),
        atomic_lib::Value::ResourceArray(vec![atomic_lib::urls::CLASS.into()]),
    );
    secret.set_unsafe(
        atomic_lib::urls::SHORTNAME.into(),
        atomic_lib::Value::Slug("top-secret".into()),
    );
    secret.set_unsafe(
        atomic_lib::urls::DESCRIPTION.into(),
        atomic_lib::Value::String("Bob must not learn this exists".into()),
    );
    let secret_subject = secret.save_remote(client_a.store()).await?;

    // --- Agent B: must NOT receive a QUERY_UPDATE referencing the secret ---
    let leaked = tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            match rx.recv().await {
                Ok(WsMessage::QueryUpdate { added, removed, .. }) => {
                    if added.contains(&secret_subject) || removed.contains(&secret_subject) {
                        return true;
                    }
                }
                Ok(_) => continue,
                Err(_) => return false,
            }
        }
    })
    .await;

    assert!(
        leaked.is_err(),
        "Bob received a QUERY_UPDATE for a resource in a private drive he cannot read — \
         SubscribeQuery is missing an authorization check"
    );

    Ok(())
}

/// Drive-wide subscribers should NEVER receive `did:ad:commit:<sig>`
/// subjects in `QUERY_UPDATE.added`.
///
/// Each successful commit stores a `did:ad:commit:<sig>` resource as
/// write-time metadata. Without filtering, every commit triggers two
/// `DriveNotification`s (one for the commit resource, one for the resource
/// the commit applies to), and a drive-wide subscriber would see the
/// commit subject in `added`. Clients then GET it — server returns either
/// "not found" (the commit-id strip-prefix fallback) or returns the
/// commit metadata which the UI doesn't render. Either way it's wasted
/// traffic. The `commit_monitor.rs` listener task filters
/// `subject.is_commit_did()` before forwarding the event, so subscribers
/// only see the affected resource subject.
#[tokio::test]
async fn drive_wide_subscription_excludes_commit_subjects() -> AtomicResult<()> {
    let port = start_server();
    wait_for_server(port).await;
    let server_url = format!("http://localhost:{}", port);
    let ws_url = format!("ws://localhost:{}/ws", port);

    let client_a = Client::new(&server_url).await?;
    let agent_a = client_a.new_agent("Alice").await?;
    let drive = client_a
        .new_public_drive(&agent_a, "Commit Filter Drive")
        .await?;

    let client_b = Client::new(&server_url).await?;
    let agent_b = client_b.new_agent("Bob").await?;
    let ws_b = WsClient::connect(&ws_url).await?;
    ws_b.authenticate(&agent_b).await?;

    let query_json = serde_json::json!({ "drive": drive });
    ws_b.send_raw(&format!("SUBSCRIBE_QUERY {}", query_json))
        .await?;
    let mut rx = ws_b.subscribe();
    tokio::time::sleep(Duration::from_secs(1)).await;

    // Trigger a commit with a side-effect: any resource save under the drive.
    let mut resource = client_a.new_resource(&drive);
    resource.set_name("Triggers a commit");
    resource.set_unsafe(
        atomic_lib::urls::IS_A.into(),
        atomic_lib::Value::ResourceArray(vec![atomic_lib::urls::CLASS.into()]),
    );
    resource.set_unsafe(
        atomic_lib::urls::SHORTNAME.into(),
        atomic_lib::Value::Slug("triggers-a-commit".into()),
    );
    resource.set_unsafe(
        atomic_lib::urls::DESCRIPTION.into(),
        atomic_lib::Value::String("anything".into()),
    );
    let resource_subject = resource.save_remote(client_a.store()).await?;

    // Collect every QUERY_UPDATE we see for ~2s after the commit. A correct
    // server emits at least one with the resource subject in `added` and
    // *no* `did:ad:commit:` subjects in any frame's `added`/`removed`.
    let mut saw_resource = false;
    let _ = tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            match rx.recv().await {
                Ok(WsMessage::QueryUpdate { added, removed, .. }) => {
                    for subj in added.iter().chain(removed.iter()) {
                        assert!(
                            !subj.starts_with("did:ad:commit:"),
                            "Drive-wide subscriber received a commit subject in QUERY_UPDATE: \
                             '{}'. The commit_monitor listener should filter \
                             `subject.is_commit_did()` before forwarding to drive subscribers.",
                            subj
                        );
                    }
                    if added.contains(&resource_subject) {
                        saw_resource = true;
                    }
                }
                Ok(_) => continue,
                Err(_) => return,
            }
        }
    })
    .await;

    assert!(
        saw_resource,
        "Drive-wide subscriber should still receive QUERY_UPDATE for the *resource* \
         subject (just not the commit subject)"
    );

    Ok(())
}
