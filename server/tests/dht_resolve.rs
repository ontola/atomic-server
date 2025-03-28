use assert_cmd::cargo::cargo_bin;
use atomic_lib::agents::Agent;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

#[tokio::test]
async fn test_dht_resolve() {
    let bin = cargo_bin("atomic-server");

    // Start a local DHT testnet for testing.
    // Needs enough nodes (>=10) to populate routing tables; single-node testnets
    // have empty routing tables and cause "Could not bootstrap" failures.
    let testnet = mainline::Testnet::new(10).expect("Failed to start Testnet");
    // Testnet nodes bind to 0.0.0.0 but local_addr() returns 0.0.0.0:PORT.
    // Replace with 127.0.0.1 so child processes can actually reach them.
    let fixed_bootstrap: Vec<String> = testnet
        .bootstrap
        .iter()
        .map(|addr| addr.replace("0.0.0.0", "127.0.0.1"))
        .collect();
    let bootstrap_addrs = fixed_bootstrap.join(",");
    eprintln!("DHT testnet bootstrap addresses: {}", bootstrap_addrs);

    // Verify the testnet is reachable: try an in-process DHT that bootstraps from it.
    {
        let probe = mainline::Dht::builder()
            .bootstrap(&fixed_bootstrap)
            .build()
            .expect("Failed to build probe DHT");
        std::thread::sleep(Duration::from_secs(3));
        eprintln!("In-process DHT bootstrapped: {}", probe.bootstrapped());
    }

    // Use absolute paths so servers and test binary agree on locations regardless of CWD.
    let base = std::env::temp_dir().join("atomic_dht_test");
    let db_dir_a = base.join("a_db");
    let cfg_dir_a = base.join("a_cfg");
    let cache_dir_a = base.join("a_cache");
    let db_dir_b = base.join("b_db");
    let cfg_dir_b = base.join("b_cfg");
    let cache_dir_b = base.join("b_cache");

    let _ = std::fs::remove_dir_all(&base);

    // Run Server A on port 9011
    let server_a = Command::new(&bin)
        .env("ATOMIC_DHT_BOOTSTRAP", &bootstrap_addrs)
        .env("RUST_LOG", "warn")
        .args([
            "--port",
            "9011",
            "--data-dir",
            db_dir_a.to_str().unwrap(),
            "--config-dir",
            cfg_dir_a.to_str().unwrap(),
            "--cache-dir",
            cache_dir_a.to_str().unwrap(),
            "--mainline-dht",
            "--initialize",
        ])
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .spawn()
        .expect("Failed to start server A");

    // Run Server B on port 9012
    let server_b = Command::new(&bin)
        .env("ATOMIC_DHT_BOOTSTRAP", &bootstrap_addrs)
        .env("RUST_LOG", "warn")
        .args([
            "--port",
            "9012",
            "--data-dir",
            db_dir_b.to_str().unwrap(),
            "--config-dir",
            cfg_dir_b.to_str().unwrap(),
            "--cache-dir",
            cache_dir_b.to_str().unwrap(),
            "--mainline-dht",
            "--initialize",
        ])
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .spawn()
        .expect("Failed to start server B");

    // Ensure servers are stopped if the test panics
    struct Cleanup(std::process::Child, std::process::Child);
    impl Drop for Cleanup {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.1.kill();
        }
    }
    let _cleanup = Cleanup(server_a, server_b);

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .unwrap();

    // Wait for server A to start and get its drive hash
    let mut drive_hash = None;
    let start = Instant::now();
    while start.elapsed() < Duration::from_secs(30) {
        if let Ok(resp) = client
            .get("http://localhost:9011/")
            .header("Accept", "application/ad+json")
            .send()
            .await
        {
            if resp.status().is_success() {
                if let Ok(text) = resp.text().await {
                    if let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) {
                        if let Some(hash) =
                            json["https://atomicdata.dev/properties/drive/hash"].as_str()
                        {
                            drive_hash = Some(hash.to_string());
                            break;
                        }
                    }
                }
            }
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }

    let drive_hash = drive_hash.expect("Server A did not start or provide a drive hash");

    // Wait for Server B to start
    let start = Instant::now();
    let mut b_started = false;
    while start.elapsed() < Duration::from_secs(30) {
        if let Ok(resp) = client
            .get("http://localhost:9012/")
            .header("Accept", "application/ad+json")
            .send()
            .await
        {
            if resp.status().is_success() {
                b_started = true;
                break;
            }
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
    assert!(b_started, "Server B did not start");

    // Read Agent secret from Server A's config to get its agent DID.
    let config_path_a = cfg_dir_a.join("config.toml");
    let cfg_a = atomic_lib::config::read_config(Some(&config_path_a))
        .expect("failed to read config a");
    let agent_a = Agent::from_secret(&cfg_a.shared.agent_secret).expect("failed to parse secret");

    // Resolve Server A's agent DID from Server B via DHT.
    // The ?drive= hint tells the DHT which drive to look up peers for.
    let did_subject = format!("{}?drive={}", agent_a.subject, drive_hash);

    // Give DHT some time to propagate
    tokio::time::sleep(Duration::from_secs(5)).await;

    // Now request this resource from Server B — it should resolve via DHT.
    let mut resolved = false;
    let start = Instant::now();
    while start.elapsed() < Duration::from_secs(120) {
        if let Ok(resp) = client
            .get(&format!("http://localhost:9012/{}", did_subject))
            .header("Accept", "application/ad+json")
            .send()
            .await
        {
            if resp.status().is_success() {
                resolved = true;
                break;
            } else {
                eprintln!(
                    "DHT test: Server B returned {} for {}",
                    resp.status(),
                    did_subject
                );
            }
        }
        tokio::time::sleep(Duration::from_secs(5)).await;
    }

    assert!(
        resolved,
        "Server B failed to resolve the resource from Server A via DHT within the timeout"
    );
}
