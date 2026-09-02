//! Shared server-lifecycle helpers for the integration-test suites.

use atomic_server_lib as atomic_server;
use std::time::Duration;

/// Start an AtomicServer on a random port in a background thread.
/// `name` namespaces the on-disk state under ./.temp/; a random suffix keeps
/// concurrent and repeated runs isolated.
pub fn start_server(name: &str) -> u16 {
    let unique = format!("{}_{}", name, atomic_lib::utils::random_string(10));
    let port = portpicker::pick_unused_port().expect("no free port");

    use clap::Parser;
    let opts = atomic_server::config::Opts::parse_from([
        "atomic-server",
        "--initialize",
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
