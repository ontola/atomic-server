//! Benchmark / regression test for anonymous WS GET latency on a private
//! resource under concurrent load.
//!
//! Symptom observed in the e2e suite (`tests/e2e.spec.ts` →
//! `authorization, invite, share menu`): page2 (anon browser context)
//! navigates to a private DID drive, the WS GET hangs for the full
//! 10 s `REQUEST_TIMEOUT`, the SPA never receives the Unauthorized
//! error frame, and the `ErrorPage`'s `isUnauthorized` redirect to
//! the welcome flow never fires. Under suite-wide parallel load this
//! turns into a real test failure because the welcome UI doesn't
//! render within the test window.
//!
//! Root cause hypothesis: the per-connection
//! [`WebSocketConnection`] actor in `server/src/handlers/web_sockets.rs`
//! processes the `GET` tag via `ctx.spawn(...)` on the actor's own
//! futures queue. Under load that queue is contended with
//! drive-broadcast notifications, query updates, and per-connection
//! housekeeping; an Unauthorized fast-fail (which should complete in
//! single-digit ms) gets starved for seconds.
//!
//! ## Why this uses an external server
//!
//! Spinning up an embedded server in tests currently triggers a stack
//! overflow during `populate::bootstrap` on macOS (the actix worker
//! threads have a 2 MiB default stack and the async validation
//! recursion exceeds it). The existing `tests/query_subscribe.rs`
//! shows the same crash. Rather than fight that here, this benchmark
//! talks to an atomic-server the caller already has running locally
//! (defaults to `http://localhost:9883`). Set `ATOMIC_BENCH_SERVER`
//! to override.
//!
//! ## Running
//!
//! With a server running on the default port:
//! ```
//! cargo test -p atomic-server --test ws_get_unauthorized_latency -- --ignored --nocapture
//! ```
//! Tune with `ATOMIC_BENCH_N` (default 20).

use atomic_lib::{
    client::{
        connected::Client,
        ws::{WsClient, WsMessage},
    },
    errors::AtomicResult,
};
use std::time::{Duration, Instant};

fn server_url() -> String {
    std::env::var("ATOMIC_BENCH_SERVER")
        .unwrap_or_else(|_| "http://localhost:9883".to_string())
}

fn ws_url() -> String {
    let url = server_url();
    let trimmed = url.trim_end_matches('/');
    if let Some(rest) = trimmed.strip_prefix("https://") {
        format!("wss://{}/ws", rest)
    } else if let Some(rest) = trimmed.strip_prefix("http://") {
        format!("ws://{}/ws", rest)
    } else {
        format!("ws://{}/ws", trimmed)
    }
}

/// Encode a binary v2 GET frame: `[0x10][u16 BE request_id][subject]`.
/// The server's text handler does not accept `GET <subject>` — only the
/// binary v2 path (`web_sockets.rs:154 ws_v2::tag::GET`) handles it.
fn encode_get(request_id: u16, subject: &str) -> Vec<u8> {
    let mut buf = Vec::with_capacity(3 + subject.len());
    buf.push(atomic_lib::sync::protocol::tag::GET);
    buf.extend_from_slice(&request_id.to_be_bytes());
    buf.extend_from_slice(subject.as_bytes());
    buf
}

/// One anon WS GET on the drive. Returns the time from sending the
/// GET to receiving any response frame (Resource or Error).
async fn anon_get_latency(ws_url: &str, subject: &str) -> AtomicResult<Duration> {
    let ws = WsClient::connect(ws_url).await?;
    let mut rx = ws.subscribe();
    let t = Instant::now();
    ws.send_binary(encode_get(1, subject)).await?;
    // Either form of response counts — error or resource. We only
    // care that the server *responded* in bounded time.
    let timeout = tokio::time::timeout(Duration::from_secs(10), async {
        while let Ok(msg) = rx.recv().await {
            match msg {
                WsMessage::Resource(_) | WsMessage::Error(_) => return Ok(()),
                _ => continue,
            }
        }
        Err::<(), _>(atomic_lib::errors::AtomicError::from("ws closed"))
    })
    .await
    .map_err(|_| atomic_lib::errors::AtomicError::from("ws GET timed out > 10s"))?;
    timeout?;
    Ok(t.elapsed())
}

/// Marked `#[ignore]` because it requires an externally-running
/// atomic-server. CI / one-shot runs invoke it explicitly via
/// `cargo test -- --ignored`.
#[tokio::test]
#[ignore]
async fn anon_ws_get_on_private_drive_is_fast_under_load() -> AtomicResult<()> {
    let server = server_url();
    let ws = ws_url();

    // --- Set up: agent A creates a PRIVATE drive on the live server ---
    let client_a = Client::new(&server).await?;
    let agent_a = client_a.new_agent("BenchAlice").await?;
    let private_drive = client_a
        .new_drive(&agent_a, "Bench Private Drive")
        .await?;

    let n: usize = std::env::var("ATOMIC_BENCH_N")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(20);

    // --- Fire N concurrent anon GETs ---
    let mut handles = Vec::with_capacity(n);
    for _ in 0..n {
        let ws_url = ws.clone();
        let subj = private_drive.clone();
        handles.push(tokio::spawn(async move {
            anon_get_latency(&ws_url, &subj).await
        }));
    }

    let mut latencies: Vec<Duration> = Vec::with_capacity(n);
    let mut failures = 0usize;
    for h in handles {
        match h.await.unwrap() {
            Ok(d) => latencies.push(d),
            Err(e) => {
                eprintln!("anon GET failed: {}", e);
                failures += 1;
            }
        }
    }

    assert_eq!(
        failures, 0,
        "{}/{} anon GETs timed out or errored. Server isn't responding to \
         unauthorized GETs in bounded time — the actor mailbox is likely \
         saturated. See web_sockets.rs:154.",
        failures, n
    );

    latencies.sort();
    let p50 = latencies[n / 2];
    let p95 = latencies[(n * 95) / 100];
    let p99 = latencies[((n * 99) / 100).min(n - 1)];
    let max = *latencies.last().unwrap();

    eprintln!(
        "anon-WS-GET-on-private-drive  (n={n}): \
         p50={:?}  p95={:?}  p99={:?}  max={:?}",
        p50, p95, p99, max
    );

    // 50 ms is a generous ceiling. Healthy baseline on a quiet dev
    // box is sub-millisecond (p95 ≈ 0.8 ms). Anything past 50 ms
    // means the GET handler is being starved by the actor's other
    // work or some new sync codepath added on the read-time
    // hot path. See `server/src/handlers/web_sockets.rs:154` for the
    // spawn-on-actor pattern.
    assert!(
        p95 < Duration::from_millis(50),
        "p95 latency {:?} exceeds 50 ms budget. anon-user fast-fail GETs \
         should respond in sub-ms; if this assertion trips, the GET \
         handler is being starved or a new round-trip was added on \
         the read hot path.",
        p95,
    );

    Ok(())
}
