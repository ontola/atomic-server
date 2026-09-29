//! Integration test: the write rate limit over real HTTP.
//!
//! `crate::rate_limit` has the bucket math under unit test; this proves the
//! wiring: an unsigned flood of `POST /commit` gets `429` with `Retry-After`
//! once the anonymous budget is spent, the limit can be switched off, and a
//! commit that merely *names* an agent as its signer cannot spend that
//! agent's budget.
//!
//! Run: cargo test -p atomic-server --test it rate_limit

use atomic_lib::{client::connected::Client, errors::AtomicResult};

use crate::common::{start_server_with_args, wait_for_server};

/// A body that is not a commit at all. It is refused either way; what this
/// suite checks is *which* refusal.
const JUNK: &str = "{}";

#[tokio::test]
async fn anonymous_commit_flood_is_answered_with_429_and_retry_after() {
    let port = start_server_with_args("rate_limit", &["--anonymous-write-rate-limit", "2"]);
    wait_for_server(port).await;
    let url = format!("http://localhost:{port}/commit");
    let client = reqwest::Client::new();

    let mut statuses = Vec::new();
    for _ in 0..3 {
        let response = client.post(&url).body(JUNK).send().await.unwrap();
        statuses.push((
            response.status().as_u16(),
            response
                .headers()
                .get("retry-after")
                .and_then(|v| v.to_str().ok())
                .map(str::to_owned),
        ));
    }
    // The first two spend the budget and are refused for their body; the
    // third is refused for its volume.
    assert_ne!(statuses[0].0, 429, "{statuses:?}");
    assert_ne!(statuses[1].0, 429, "{statuses:?}");
    assert_eq!(statuses[2].0, 429, "{statuses:?}");
    let retry_after: u64 = statuses[2].1.as_deref().unwrap_or("").parse().unwrap();
    assert!(retry_after >= 1, "{statuses:?}");
}

#[tokio::test]
async fn zero_disables_the_anonymous_limit() {
    let port = start_server_with_args("rate_limit_off", &["--anonymous-write-rate-limit", "0"]);
    wait_for_server(port).await;
    let url = format!("http://localhost:{port}/commit");
    let client = reqwest::Client::new();
    for _ in 0..5 {
        let status = client.post(&url).body(JUNK).send().await.unwrap().status();
        assert_ne!(status.as_u16(), 429);
    }
}

/// A signed genesis commit for a new classless resource under `parent`, as
/// the wire JSON `POST /commit` takes.
async fn genesis_commit_json(
    client: &Client,
    signer: &atomic_lib::agents::Agent,
    parent: &str,
    name: &str,
) -> AtomicResult<String> {
    let mut builder = atomic_lib::commit::CommitBuilder::new("placeholder".into());
    builder.set(
        atomic_lib::urls::NAME.into(),
        atomic_lib::Value::String(name.into()),
    );
    builder.set(
        atomic_lib::urls::PARENT.into(),
        atomic_lib::Value::AtomicUrl(parent.into()),
    );
    let commit = atomic_lib::commit::Commit::create_did(builder, signer, client.store()).await?;
    atomic_lib::client::commit_to_wire_json(&commit, client.store()).await
}

async fn post_commit(url: &str, body: String) -> u16 {
    reqwest::Client::new()
        .post(url)
        .header("Content-Type", "application/json")
        .body(body)
        .send()
        .await
        .unwrap()
        .status()
        .as_u16()
}

/// The per-agent budget is charged to the signer the signature proves, not
/// to whoever the body names. Before this held, anyone who knew a victim's
/// public DID could flood `/commit` with forged commits naming the victim
/// and lock the victim out of writing with `429`s.
#[tokio::test]
async fn forged_signer_cannot_spend_the_named_agents_budget() -> AtomicResult<()> {
    // Two signed writes per minute per agent. The anonymous budget is left
    // roomy so the forgeries are refused for their signature, not their
    // volume; that they are refused at all is what the first test covers.
    let port = start_server_with_args(
        "rate_limit_forged",
        &[
            "--write-rate-limit",
            "2",
            "--anonymous-write-rate-limit",
            "1000",
        ],
    );
    wait_for_server(port).await;
    let server_url = format!("http://localhost:{port}");
    let url = format!("{server_url}/commit");

    let client = Client::new(&server_url).await?;
    let alice = client.new_agent("Alice").await?;
    // Alice's first signed write: the drive.
    let drive = client.new_drive(&alice, "Drive").await?;

    // A commit that names Alice as its signer but that she never signed:
    // her own wire JSON with the signature swapped for 64 zero bytes, so it
    // parses fine and fails only at Ed25519 verification.
    let mut forged: serde_json::Value =
        serde_json::from_str(&genesis_commit_json(&client, &alice, &drive, "Forgery").await?)?;
    forged[atomic_lib::urls::SIGNATURE] =
        serde_json::Value::String(atomic_lib::agents::encode_base64(&[0u8; 64]));
    assert_eq!(forged[atomic_lib::urls::SIGNER], alice.subject.to_string());
    let forged = serde_json::to_string(&forged)?;

    for _ in 0..10 {
        let status = post_commit(&url, forged.clone()).await;
        assert_ne!(status, 200, "a forged signature must never apply");
        assert_ne!(
            status, 429,
            "a forgery is refused for its signature, not its volume"
        );
    }

    // Alice's second signed write still fits her budget: the forgeries
    // spent nothing of hers.
    let second = genesis_commit_json(&client, &alice, &drive, "Second").await?;
    assert_eq!(post_commit(&url, second).await, 200);

    // And the budget is live: her third signed write within the minute is
    // over it.
    let third = genesis_commit_json(&client, &alice, &drive, "Third").await?;
    assert_eq!(post_commit(&url, third).await, 429);
    Ok(())
}
