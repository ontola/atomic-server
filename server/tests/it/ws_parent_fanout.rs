//! A resource shared out of a drive the recipient can't read must still get
//! its new children live.
//!
//! Bob shares one chatroom from his private drive with Alice. Alice can read
//! the room, not the drive, so she subscribes to the room. A new message is a
//! new subject in Bob's drive: without fanning out to subscribers of the
//! parent, it reached neither her resource subscription nor a drive
//! subscription she could hold, and she never saw Bob's messages after the
//! ones she loaded.
//!
//! Run: cargo test -p atomic-server --test it ws_parent_fanout

use atomic_lib::{
    client::{
        connected::Client,
        ws::{WsClient, WsMessage},
    },
    errors::AtomicResult,
    Storelike, Value,
};
use std::time::Duration;

use crate::common::{start_server, wait_for_server};

/// A genesis `did:ad:` commit for a resource under `parent`, signed by
/// `store`'s default agent. Returns `(subject, wire-JSON commit)`.
async fn make_child(
    store: &atomic_lib::Store,
    parent: &str,
    name: &str,
    read: Option<&str>,
) -> AtomicResult<(String, String)> {
    let mut res = atomic_lib::Resource::new("did:ad:placeholder".into());
    res.set_unsafe(
        atomic_lib::urls::IS_A.into(),
        Value::ResourceArray(vec![atomic_lib::urls::CLASS.into()]),
    )?;
    res.set_unsafe(atomic_lib::urls::PARENT.into(), parent.to_string().into())?;
    res.set_name(name)?;
    res.set_unsafe(
        atomic_lib::urls::SHORTNAME.into(),
        Value::Slug(name.to_lowercase().replace(' ', "-")),
    )?;
    res.set_unsafe(
        atomic_lib::urls::DESCRIPTION.into(),
        Value::String("parent fan-out test resource".into()),
    )?;
    if let Some(agent) = read {
        res.set_unsafe(
            atomic_lib::urls::READ.into(),
            Value::ResourceArray(vec![agent.into()]),
        )?;
    }

    let agent = store.get_default_agent()?;
    let mut commit_builder = res.get_commit_builder().clone();
    commit_builder.is_genesis = true;
    let commit = atomic_lib::Commit::create_did(commit_builder, &agent, store).await?;
    let commit_json = atomic_lib::client::commit_to_wire_json(&commit, store).await?;

    Ok((commit.subject.to_string(), commit_json))
}

/// Everything `rx` delivers until `until` arrives or the timeout passes.
async fn drain_until(
    rx: &mut tokio::sync::broadcast::Receiver<WsMessage>,
    until: &str,
) -> (bool, Vec<String>) {
    let mut seen = Vec::new();
    let arrived = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            match rx.recv().await {
                Ok(WsMessage::Update { subject, .. }) => {
                    let done = subject == until;
                    seen.push(subject);
                    if done {
                        return true;
                    }
                }
                Ok(_) => {}
                Err(_) => return false,
            }
        }
    })
    .await
    .unwrap_or(false);

    (arrived, seen)
}

#[tokio::test]
async fn children_of_a_shared_resource_reach_its_subscribers() -> AtomicResult<()> {
    let port = start_server("ws_parent_fanout");
    wait_for_server(port).await;
    let server_url = format!("http://localhost:{}", port);
    let ws_url = format!("ws://localhost:{}/ws", port);

    let client_a = Client::new(&server_url).await?;
    let agent_a = client_a.new_agent("Alice").await?;
    let client_b = Client::new(&server_url).await?;
    let agent_b = client_b.new_agent("Bob").await?;
    let drive_b = client_b.new_drive(&agent_b, "Bob private drive").await?;

    let ws_b = WsClient::connect(&ws_url).await?;
    ws_b.authenticate(&agent_b).await?;

    // Bob makes a room Alice may read, and a sibling she may not.
    let (room, room_commit) = make_child(
        client_b.store(),
        &drive_b,
        "Shared Room",
        Some(&agent_a.subject.to_string()),
    )
    .await?;
    ws_b.post_commit(1, &room_commit).await?;
    let (secret, secret_commit) =
        make_child(client_b.store(), &drive_b, "Secret Room", None).await?;
    ws_b.post_commit(2, &secret_commit).await?;

    // Alice holds the room, not the drive.
    let ws_a = WsClient::connect(&ws_url).await?;
    ws_a.authenticate(&agent_a).await?;
    ws_a.subscribe_resource(&room).await?;
    let mut rx_a = ws_a.subscribe();
    tokio::time::sleep(Duration::from_millis(300)).await;

    // A child of the secret room first, then a message in the shared room.
    let (hidden, hidden_commit) =
        make_child(client_b.store(), &secret, "Hidden Message", None).await?;
    ws_b.post_commit(3, &hidden_commit).await?;
    let (message, message_commit) =
        make_child(client_b.store(), &room, "Room Message", None).await?;
    ws_b.post_commit(4, &message_commit).await?;

    let (arrived, seen) = drain_until(&mut rx_a, &message).await;

    assert!(
        arrived,
        "Alice, subscribed to the room {room} Bob shared with her, never received \
         the new message {message} in it. Seen: {seen:?}"
    );
    assert!(
        !seen.contains(&hidden),
        "SECURITY LEAK: Alice received {hidden}, a child of a room she can't read."
    );

    Ok(())
}
