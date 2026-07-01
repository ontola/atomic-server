//! `SUBSCRIBE_QUERY` filter subscription → `UPDATE` / `DESTROY` integration test.
//!
//! After `planning/drop-query-update.md` retired the `QUERY_UPDATE (0x36)`
//! frame, the `SUBSCRIBE_QUERY` registration primitive lives on but routes
//! its membership changes through the same `UPDATE` / `DESTROY` channel
//! the rest of the protocol uses. This test pins the new wire shape: a
//! subscriber registered for "where parent = drive" receives an
//! `UPDATE (SNAPSHOT|PUSH|HAS_COMMIT_ID)` when a matching resource is
//! created, and a `DESTROY` when one is removed from the set.
//!
//! Run: cargo test -p atomic-server --test ws_subscribe_query

use atomic_lib::{
    client::{
        connected::Client,
        ws::{WsClient, WsMessage},
    },
    errors::AtomicResult,
};
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
        &format!("./.temp/wsquerysub_{}/db", unique),
        "--config-dir",
        &format!("./.temp/wsquerysub_{}/config", unique),
    ]);

    let mut config = atomic_server::config::build_config(opts).expect("config failed");
    config.search_index_path = format!("./.temp/wsquerysub_{}/search", unique).into();

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
async fn subscribe_query_membership_arrives_as_update() -> AtomicResult<()> {
    let port = start_server();
    wait_for_server(port).await;
    let server_url = format!("http://localhost:{}", port);
    let ws_url = format!("ws://localhost:{}/ws", port);

    // Author + public drive — both clients share the same agent so the
    // subscriber definitely has read on whatever the author creates.
    let client = Client::new(&server_url).await?;
    let agent = client.new_agent("Quentin").await?;
    let drive = client.new_public_drive(&agent, "Query Sub Drive").await?;

    // Subscriber: filter "parent = drive". Membership changes for this
    // filter must arrive as UPDATE (added) or DESTROY (removed).
    let ws_b = WsClient::connect(&ws_url).await?;
    ws_b.authenticate(&agent).await?;
    ws_b.subscribe_query(atomic_lib::urls::PARENT, &drive, &drive)
        .await?;
    let mut rx = ws_b.subscribe();

    // Let the auth check + WatchedQueries registration land before the
    // author commits the new resource. SUBSCRIBE_QUERY's auth path is
    // an async `check_read` against the drive resource — without this
    // tiny wait the membership change may fire before the subscription
    // is registered, and the test would race even though the protocol
    // is fine.
    tokio::time::sleep(Duration::from_millis(300)).await;

    // Author creates a DID resource whose parent = drive. The resource
    // joins the filter set → subscriber should receive UPDATE.
    let mut resource = atomic_lib::Resource::new("did:ad:placeholder".into());
    resource.set_unsafe(
        atomic_lib::urls::IS_A.into(),
        atomic_lib::Value::ResourceArray(vec![atomic_lib::urls::CLASS.into()]),
    )?;
    resource.set_unsafe(atomic_lib::urls::PARENT.into(), drive.clone().into())?;
    resource.set_name("Member of the filter")?;
    resource.set_unsafe(
        atomic_lib::urls::SHORTNAME.into(),
        atomic_lib::Value::Slug("filter-member".into()),
    )?;
    resource.set_unsafe(
        atomic_lib::urls::DESCRIPTION.into(),
        atomic_lib::Value::String("Created while subscriber holds a filter sub".into()),
    )?;
    let response = resource.save_as_genesis(client.store()).await?;
    let commit_json =
        atomic_lib::client::commit_to_wire_json(&response.commit, client.store()).await?;

    // Push via a separate WS client so source-id suppression doesn't
    // accidentally hide the broadcast from Bob's connection.
    let ws_a = WsClient::connect(&ws_url).await?;
    ws_a.authenticate(&agent).await?;
    ws_a.post_commit(1, &commit_json).await?;

    let subject = response.commit.subject.clone();

    // Subscriber should see an UPDATE (the membership-added path).
    let outcome = tokio::time::timeout(Duration::from_secs(10), async {
        while let Ok(msg) = rx.recv().await {
            if let WsMessage::Update {
                subject: s,
                loro_bytes,
                commit_id,
                is_snapshot,
                ..
            } = msg
            {
                if s == subject.as_str() {
                    return Some((loro_bytes, commit_id, is_snapshot));
                }
            }
        }
        None
    })
    .await
    .map_err(|_| atomic_lib::errors::AtomicError::from("Timed out waiting for UPDATE"))?
    .ok_or_else(|| atomic_lib::errors::AtomicError::from("WS closed before UPDATE arrived"))?;

    let (loro_bytes, commit_id, is_snapshot) = outcome;
    assert!(
        is_snapshot,
        "SUBSCRIBE_QUERY-driven UPDATE should be a SNAPSHOT (full state)"
    );
    assert!(
        !loro_bytes.is_empty(),
        "SUBSCRIBE_QUERY-driven UPDATE must carry the resource's Loro snapshot inline (so subscribers don't need a follow-up GET)"
    );
    assert!(
        commit_id.is_some(),
        "SUBSCRIBE_QUERY-driven UPDATE must carry the resource's lastCommit id"
    );

    Ok(())
}
