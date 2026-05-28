//! Drive-wide membership signals over WebSocket.
//!
//! After `planning/drop-query-update.md` retired the QUERY_UPDATE /
//! SUBSCRIBE_QUERY channel, drive-wide subscribers receive resource
//! creates as `UPDATE (0x11)` frames (with full snapshot + commit_id)
//! and destroys as `DESTROY (0x12)` frames — same channel that was
//! already carrying edits.
//!
//! This test asserts the create half: a subscriber that has only sent
//! `SUB <drive>` learns about new resources in that drive via UPDATE.
//!
//! Run: cargo test -p atomic-server --test ws_drive_membership

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
        &format!("./.temp/wsdrivemem_{}/db", unique),
        "--config-dir",
        &format!("./.temp/wsdrivemem_{}/config", unique),
    ]);

    let mut config = atomic_server::config::build_config(opts).expect("config failed");
    config.search_index_path = format!("./.temp/wsdrivemem_{}/search", unique).into();

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
async fn drive_subscriber_receives_update_for_new_resource() -> AtomicResult<()> {
    let port = start_server();
    wait_for_server(port).await;
    let server_url = format!("http://localhost:{}", port);
    let ws_url = format!("ws://localhost:{}/ws", port);

    // Author + public drive.
    let client_a = Client::new(&server_url).await?;
    let agent_a = client_a.new_agent("Alice").await?;
    let drive = client_a.new_public_drive(&agent_a, "Membership Drive").await?;

    // Subscriber (Bob) registers drive-wide BEFORE any new resource is created.
    let client_b = Client::new(&server_url).await?;
    let agent_b = client_b.new_agent("Bob").await?;
    let ws_b = WsClient::connect(&ws_url).await?;
    ws_b.authenticate(&agent_b).await?;
    // `subscribe_drive` sends the binary `SUB (0x20)` frame, registering Bob
    // in the server's drive_subscriptions map. Every commit on a resource
    // living under the drive then fans out to him as `UPDATE` / `DESTROY`.
    // (`subscribe_resource` uses the legacy text `SUBSCRIBE` frame, which
    // only registers a per-subject sub — not drive-wide.)
    ws_b.subscribe_drive(&drive).await?;
    let mut rx = ws_b.subscribe();
    // Give the SUB registration a moment to land.
    tokio::time::sleep(Duration::from_millis(200)).await;

    // Alice creates a new DID-subject resource (`did:ad:<signature>`),
    // mirroring how browser / Flutter clients create resources. HTTP-URL
    // subjects rely on a drive-URL prefix match for drive-wide fanout,
    // which doesn't generalize; DID subjects fan out to every drive
    // subscriber unconditionally — the realistic production path.
    let mut canvas_res = atomic_lib::Resource::new("did:ad:placeholder".into());
    canvas_res.set_unsafe(
        atomic_lib::urls::IS_A.into(),
        atomic_lib::Value::ResourceArray(vec![atomic_lib::urls::CLASS.into()]),
    )?;
    canvas_res.set_unsafe(
        atomic_lib::urls::PARENT.into(),
        drive.clone().into(),
    )?;
    canvas_res.set_name("New Member")?;
    canvas_res.set_unsafe(
        atomic_lib::urls::SHORTNAME.into(),
        atomic_lib::Value::Slug("new-member".into()),
    )?;
    canvas_res.set_unsafe(
        atomic_lib::urls::DESCRIPTION.into(),
        atomic_lib::Value::String("Created while Bob is subscribed drive-wide".into()),
    )?;
    let response = canvas_res.save_as_genesis(client_a.store()).await?;
    let commit_json =
        atomic_lib::client::commit_to_wire_json(&response.commit, client_a.store()).await?;
    // Push via a separate WS client so source-id suppression doesn't
    // accidentally hide the broadcast from Bob's connection. We could
    // also POST to /commit, but staying on WS keeps the wire path
    // close to how the browser actually operates.
    let ws_a = WsClient::connect(&ws_url).await?;
    ws_a.authenticate(&agent_a).await?;
    ws_a.post_commit(1, &commit_json).await?;
    let subject = response.commit.subject.clone();

    // Bob should learn about it via an UPDATE frame on the drive SUB.
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

    let (loro_bytes, commit_id, _is_snapshot) = outcome;
    assert!(
        !loro_bytes.is_empty(),
        "drive-wide UPDATE for a new resource should carry the Loro snapshot"
    );
    assert!(
        commit_id.is_some(),
        "drive-wide UPDATE should carry the resource's lastCommit id"
    );

    Ok(())
}
