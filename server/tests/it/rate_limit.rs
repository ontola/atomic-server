//! Integration test: the write rate limit over real HTTP.
//!
//! `crate::rate_limit` has the bucket math under unit test; this proves the
//! wiring: an unsigned flood of `POST /commit` gets `429` with `Retry-After`
//! once the anonymous budget is spent, and the limit can be switched off.
//!
//! Run: cargo test -p atomic-server --test it rate_limit

use crate::common::{start_server_with_args, wait_for_server};

/// A body that is not a commit at all. It is refused either way; what this
/// suite checks is *which* refusal, so the limiter must run before parsing.
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
    // The first two spend the budget and fail on the body; the third never
    // reaches the parser.
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
