//! SECURITY: commits must NOT leak across drives over WebSocket.
//!
//! Two independent agents each mint their OWN private drive and each subscribe
//! ONLY to their own drive. A commit by Bob, under Bob's private drive, must
//! NEVER be delivered to Alice (who is subscribed to her own drive and has no
//! rights on Bob's). Alice cannot even discover Bob's drive — so she must never
//! receive its commits.
//!
//! This guards against the `commit_monitor` drive-subscriber fan-out: a
//! `did:ad:` subject can't be prefix-matched to a drive, and the fan-out
//! historically sent every DID commit to *every* drive subscriber, with no
//! ownership or read-rights check. That is a cross-tenant leak — this test
//! fails if it ever regresses.
//!
//! Run: cargo test -p atomic-server --test ws_commit_isolation

use atomic_lib::{
    client::{
        connected::Client,
        ws::{WsClient, WsMessage},
    },
    errors::AtomicResult,
    Storelike,
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
        &format!("./.temp/wscommitiso_{}/db", unique),
        "--config-dir",
        &format!("./.temp/wscommitiso_{}/config", unique),
    ]);

    let mut config = atomic_server::config::build_config(opts).expect("config failed");
    config.search_index_path = format!("./.temp/wscommitiso_{}/search", unique).into();

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
    // The server's vector-search (fastembed) init can take ~15-20s cold, and
    // longer when multiple test servers boot under CPU contention. Give it
    // ample headroom — the readiness signal is the bind, not a fixed timeout.
    for _ in 0..400 {
        if reqwest::get(&base).await.is_ok() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    panic!("Server did not start within 40 seconds");
}

/// Create a `did:ad:` Class resource under `parent`, sign it as `store`'s
/// default agent, and return `(derived subject, wire-JSON commit)`.
async fn make_did_commit(
    store: &atomic_lib::Store,
    parent: &str,
    name: &str,
    shortname: &str,
) -> AtomicResult<(String, String)> {
    let mut res = atomic_lib::Resource::new("did:ad:placeholder".into());
    res.set_unsafe(
        atomic_lib::urls::IS_A.into(),
        atomic_lib::Value::ResourceArray(vec![atomic_lib::urls::CLASS.into()]),
    )?;
    res.set_unsafe(atomic_lib::urls::PARENT.into(), parent.to_string().into())?;
    res.set_name(name)?;
    res.set_unsafe(
        atomic_lib::urls::SHORTNAME.into(),
        atomic_lib::Value::Slug(shortname.into()),
    )?;
    res.set_unsafe(
        atomic_lib::urls::DESCRIPTION.into(),
        atomic_lib::Value::String("isolation test resource".into()),
    )?;

    // Build the genesis commit via `create_did` — the SAME path the real
    // server uses for new DID resources. Crucially we do NOT pre-set the loro
    // update: `create_did` stamps the resource's `drive` (from its parent) into
    // the commit's `set` and then folds `set` into the loro doc, so the
    // materialized resource carries its `drive` propval. (`save_as_genesis`
    // would skip this stamping entirely.) The drive is what the commit fan-out
    // uses to scope delivery — without it this test couldn't exercise the leak.
    let agent = store.get_default_agent()?;
    let mut commit_builder = res.get_commit_builder().clone();
    commit_builder.is_genesis = true;
    let commit = atomic_lib::Commit::create_did(commit_builder, &agent, store).await?;
    let commit_json = atomic_lib::client::commit_to_wire_json(&commit, store).await?;

    Ok((commit.subject.to_string(), commit_json))
}

#[tokio::test]
async fn commits_do_not_leak_across_drives() -> AtomicResult<()> {
    let port = start_server();
    wait_for_server(port).await;
    let server_url = format!("http://localhost:{}", port);
    let ws_url = format!("ws://localhost:{}/ws", port);

    // Two independent agents, each with their OWN private drive.
    let client_a = Client::new(&server_url).await?;
    let agent_a = client_a.new_agent("Alice").await?;
    let drive_a = client_a.new_drive(&agent_a, "Alice private drive").await?;

    let client_b = Client::new(&server_url).await?;
    let agent_b = client_b.new_agent("Bob").await?;
    let drive_b = client_b.new_drive(&agent_b, "Bob private drive").await?;

    // Alice subscribes ONLY to her own drive.
    let ws_a = WsClient::connect(&ws_url).await?;
    ws_a.authenticate(&agent_a).await?;
    ws_a.subscribe_drive(&drive_a).await?;
    let mut rx_a = ws_a.subscribe();
    // Let the SUB registration land in the server's drive_subscriptions map.
    tokio::time::sleep(Duration::from_millis(300)).await;

    // Bob creates a resource under HIS drive and posts it over HIS connection.
    // `post_commit` is awaited, so the commit is applied + fanned out before we
    // continue — any leaked frame to Alice is already queued ahead of the
    // control frame below.
    let (bob_subject, bob_commit) =
        make_did_commit(client_b.store(), &drive_b, "Bob Secret", "bob-secret").await?;
    let ws_b = WsClient::connect(&ws_url).await?;
    ws_b.authenticate(&agent_b).await?;
    ws_b.post_commit(1, &bob_commit).await?;

    // Control: Alice creates a resource under HER own drive, posted over a
    // SEPARATE connection (so source-id suppression doesn't hide it from her
    // subscriber connection). Alice SHOULD receive this — it proves her
    // subscription is live and anchors the timing (posted AFTER Bob's).
    let (alice_subject, alice_commit) =
        make_did_commit(client_a.store(), &drive_a, "Alice Note", "alice-note").await?;
    let ws_a2 = WsClient::connect(&ws_url).await?;
    ws_a2.authenticate(&agent_a).await?;
    ws_a2.post_commit(1, &alice_commit).await?;

    // Drain Alice's feed until her own resource arrives (proving the channel is
    // live), recording every subject seen. Bob's subject must never appear.
    let mut seen: Vec<String> = Vec::new();
    let control_arrived = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            match rx_a.recv().await {
                Ok(WsMessage::Update { subject, .. }) => {
                    let is_control = subject == alice_subject;
                    seen.push(subject);

                    if is_control {
                        return true;
                    }
                }
                Ok(WsMessage::Destroy { subject }) => seen.push(subject),
                Ok(_) => {}
                Err(_) => return false,
            }
        }
    })
    .await
    .unwrap_or(false);

    assert!(
        control_arrived,
        "inconclusive: Alice never received the UPDATE for her OWN drive resource \
         ({alice_subject}); her subscription/channel is broken, so the leak check can't run"
    );
    assert!(
        !seen.contains(&bob_subject),
        "SECURITY LEAK: Alice (subscribed only to her own drive {drive_a}) received \
         Bob's commit {bob_subject} from Bob's private drive {drive_b}. \
         Commits must never fan out across drives."
    );

    Ok(())
}
