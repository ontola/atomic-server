//! Shared server-lifecycle helpers for the integration-test suites.

use atomic_server_lib as atomic_server;
use std::time::Duration;

/// Start an AtomicServer on a random port in a background thread.
/// `name` namespaces the on-disk state under ./.temp/; a random suffix keeps
/// concurrent and repeated runs isolated.
pub fn start_server(name: &str) -> u16 {
    let unique = format!("{}_{}", name, atomic_lib::utils::random_string(10));
    let port = pick_port();

    use clap::Parser;
    let opts = atomic_server::config::Opts::parse_from([
        "atomic-server",
        "--initialize",
        // Loopback IPv4 rather than the `::` default: the tests connect to
        // `localhost` anyway, and a host without IPv6 (containers, some CI
        // sandboxes) cannot bind `::` at all, which used to kill every suite
        // at startup.
        "--ip",
        "127.0.0.1",
        "--port",
        &port.to_string(),
        "--data-dir",
        &format!("./.temp/{unique}/db"),
        "--config-dir",
        &format!("./.temp/{unique}/config"),
    ]);

    let mut config = atomic_server::config::build_config(opts).expect("config failed");
    config.search_index_path = format!("./.temp/{unique}/search").into();

    std::thread::spawn(move || {
        let rt = actix_web::rt::System::new();
        rt.block_on(async {
            atomic_server::serve::serve(config).await.unwrap();
        });
    });

    port
}

/// A free TCP port on localhost. `portpicker` insists that the port be free
/// for TCP *and* UDP on both IPv4 and IPv6, and reports "no free port" on a
/// host without a loopback IPv6 address (containers, some CI sandboxes),
/// which failed every suite here before any server started. The server only
/// needs IPv4 TCP, so fall back to asking the OS for one.
fn pick_port() -> u16 {
    if let Some(port) = portpicker::pick_unused_port() {
        return port;
    }
    std::net::TcpListener::bind("127.0.0.1:0")
        .and_then(|l| l.local_addr())
        .map(|a| a.port())
        .expect("no free port")
}

/// Poll until the server answers HTTP. Every suite in this binary boots its
/// own server and they all run concurrently, so a single boot can take far
/// longer than it would alone; the deadline only bounds a wedged server.
pub async fn wait_for_server(port: u16) {
    let base = format!("http://localhost:{port}");

    for _ in 0..600 {
        if reqwest::get(&base).await.is_ok() {
            return;
        }

        tokio::time::sleep(Duration::from_millis(100)).await;
    }

    panic!("Server did not start within 60 seconds");
}
