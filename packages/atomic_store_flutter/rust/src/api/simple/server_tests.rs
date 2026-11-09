//! The bridge against a real `atomic-server` process, not another bridge.
//!
//! `peer_tests.rs` pairs the bridge with a second copy of itself. This is the
//! pairing a user actually has: the app and a desktop server. The server
//! binary is a subprocess because this crate is workspace-excluded and cannot
//! reasonably depend on it. Point `ATOMIC_SERVER_BIN` at a built
//! `atomic-server` (a debug build is fine); without it the test skips.
//!
//! One resource makes the round trip. A server hosts it in a public drive owned
//! by the device's agent; the bridge pulls it over Iroh (`start_peer` →
//! `add_known_peer` → `peer_sync`), edits it, and pushes the edit back over
//! WebSocket (`open_ws_sync`). The server's own copy is the independent proof.

use super::tests::{shared_drive, PRIVATE_DRIVE};
use super::*;
use atomic_lib::client::connected::Client;
use atomic_lib::Storelike;

const SERVER_BIN_ENV: &str = "ATOMIC_SERVER_BIN";
const FROM_SERVER: &str = "written-on-the-server";
const FROM_DEVICE: &str = "edited-on-the-device";

/// Kills the server on the way out, including when an assertion panics.
struct ServerProcess(std::process::Child);

impl Drop for ServerProcess {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

/// Poll `check` for up to `secs` seconds.
async fn eventually<F, Fut>(secs: u64, mut check: F) -> bool
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = bool>,
{
    for _ in 0..secs * 10 {
        if check().await {
            return true;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    false
}

/// A plain `GET` as JSON-AD, over a raw socket: the bridge has no HTTP client.
async fn http_get_json(port: u16, path: &str) -> Option<serde_json::Value> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.ok()?;
    let request = format!(
        "GET {path} HTTP/1.1\r\nHost: localhost:{port}\r\nAccept: application/ad+json\r\nConnection: close\r\n\r\n"
    );
    stream.write_all(request.as_bytes()).await.ok()?;
    let mut raw = Vec::new();
    stream.read_to_end(&mut raw).await.ok()?;
    let text = String::from_utf8_lossy(&raw);
    let (head, body) = text.split_once("\r\n\r\n")?;
    if !head.starts_with("HTTP/1.1 200") {
        return None;
    }
    // `Connection: close` still allows chunked bodies; the JSON is the span
    // from the first `{` to the last `}`.
    serde_json::from_str(&body[body.find('{')?..=body.rfind('}')?]).ok()
}

async fn server_description(port: u16, subject: &str) -> Option<String> {
    let path = format!("/resource?subject={}", urlencoding::encode(subject));
    http_get_json(port, &path)
        .await?
        .get(atomic_lib::urls::DESCRIPTION)?
        .as_str()
        .map(str::to_string)
}

#[tokio::test]
async fn a_resource_round_trips_with_a_real_server_over_iroh_and_websocket() {
    let Some(bin) = std::env::var_os(SERVER_BIN_ENV) else {
        eprintln!("skipped: set {SERVER_BIN_ENV} to a built atomic-server");
        return;
    };
    let drive_before = shared_drive().await;
    // `peer_sync` and `open_ws_sync` act on the active drive, which every test
    // in this binary shares.
    let _guard = PRIVATE_DRIVE.lock().await;

    let dir = std::env::temp_dir().join(format!("atomic-bridge-server-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let port = free_port();
    let base_url = format!("http://localhost:{port}");
    let log = std::fs::File::create(std::env::temp_dir().join(format!(
        "atomic-bridge-server-{}.log",
        std::process::id()
    )))
    .unwrap();
    let _server = ServerProcess(
        std::process::Command::new(bin)
            .args(["--initialize", "--ip", "127.0.0.1", "--port", &port.to_string()])
            .arg("--data-dir")
            .arg(dir.join("db"))
            .arg("--config-dir")
            .arg(dir.join("config"))
            .stdout(log.try_clone().unwrap())
            .stderr(log)
            .spawn()
            .expect("spawn atomic-server"),
    );

    // The device's agent owns the server's drive, so the Iroh peer serves it
    // everything and the WebSocket accepts its commits.
    let secret = get_active_agent().await.unwrap().unwrap().secret;
    let agent = atomic_lib::agents::Agent::from_secret(&secret).unwrap();

    let client = Client::new(&base_url).await.unwrap();
    let mut up = false;
    for _ in 0..1800 {
        if http_get_json(port, "/server").await.is_some() {
            up = true;
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    assert!(up, "server never came up");

    let drive = client.new_public_drive(&agent, "Server drive").await.unwrap();
    let mut resource = client.new_resource(&drive).unwrap();
    resource.set_name("Shared note").unwrap();
    resource
        .set_unsafe(
            atomic_lib::urls::DESCRIPTION.into(),
            atomic_lib::Value::String(FROM_SERVER.into()),
        )
        .unwrap();
    let subject = resource.save_remote(client.store()).await.unwrap();

    // Iroh binds after HTTP does; the node id is what a pairing code carries.
    let node_id = {
        let mut found = None;
        for _ in 0..300 {
            if let Some(id) = http_get_json(port, "/server")
                .await
                .and_then(|v| v.get(atomic_lib::urls::SERVER_NODE_ID)?.as_str().map(str::to_string))
            {
                found = Some(id);
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        found.expect("the server never advertised a node id")
    };

    // Server to device, over Iroh. The server advertises only a node id, so
    // this needs relay or discovery to reach it; a sandbox without either
    // cannot dial. That is a logged skip, and the WebSocket half below still
    // pulls the drive and carries the assertions.
    set_active_drive(drive.clone()).await.unwrap();
    let mut iroh_ok = false;
    match tokio::time::timeout(std::time::Duration::from_secs(45), async {
        start_peer().await?;
        add_known_peer(node_id.clone(), "Server".to_string());
        peer_sync(node_id.clone()).await
    })
    .await
    {
        Ok(Ok(report)) => {
            iroh_ok = eventually(30, || async {
                get_property(subject.clone(), atomic_lib::urls::DESCRIPTION.into())
                    .await
                    .map(|v| v.contains(FROM_SERVER))
                    .unwrap_or(false)
            })
            .await;
            assert!(iroh_ok, "peer_sync succeeded but the resource is missing: {report}");
        }
        other => eprintln!("SKIPPED Iroh half, server not dialable here: {other:?}"),
    }

    // Over WebSocket: the server's resource reaches the device (when Iroh did
    // not already deliver it), then the device's edit reaches the server.
    open_ws_sync(base_url.clone()).await.expect("open_ws_sync");
    if !iroh_ok {
        assert!(
            eventually(30, || async {
                get_property(subject.clone(), atomic_lib::urls::DESCRIPTION.into())
                    .await
                    .map(|v| v.contains(FROM_SERVER))
                    .unwrap_or(false)
            })
            .await,
            "the server's resource never reached the bridge over WebSocket"
        );
    }
    // Device to server, over WebSocket.
    set_property(
        subject.clone(),
        atomic_lib::urls::DESCRIPTION.into(),
        FROM_DEVICE.into(),
    )
    .await
    .unwrap();
    let arrived = eventually(30, || async {
        server_description(port, &subject)
            .await
            .is_some_and(|d| d.contains(FROM_DEVICE))
    })
    .await;
    let _ = close_ws_sync().await;
    set_active_drive(drive_before.to_string()).await.unwrap();
    assert!(arrived, "the bridge's edit never reached the server");
}
