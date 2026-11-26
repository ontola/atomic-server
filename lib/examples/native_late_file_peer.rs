// SPDX-License-Identifier: MIT
//! Acceptance fixture for a file arriving in the native app after recovery times out.
//!
//! Start with a fresh, owned fixture directory and the embedded node's HTTP origin:
//! `cargo run -p atomic_lib --features iroh,db-redb --example native_late_file_peer -- <fixture-dir> http://localhost:9883`
//!
//! `ready.json` names the public-readable drive, file, content hash, and real Iroh
//! endpoint. Join that drive in the native app and open its file preview. The real
//! peer engine waits for this backend's file read while metadata sync completes.
//! After the mounted preview's recovery has timed out, create `<fixture-dir>/release`.
//! The existing engine then sends the actual file bytes over the same Iroh link.
//! `events.jsonl` records request/release times for the acceptance evidence.
//!
//! This fixture creates an invented agent in its own database. It never prints
//! or exports its secret. It has no Cloud Vault account and performs no backup.

#[cfg(all(feature = "iroh", feature = "db", not(target_arch = "wasm32")))]
mod fixture {
    use std::{
        fs::{File, OpenOptions},
        io::Write,
        path::{Path, PathBuf},
        sync::{
            atomic::{AtomicUsize, Ordering},
            Arc, Mutex,
        },
        time::{Duration, SystemTime, UNIX_EPOCH},
    };

    use async_trait::async_trait;
    use atomic_lib::{
        db::blob_backend::BlobBackend, errors::AtomicResult, urls, Db, Storelike, Value,
    };

    const IMAGE: &str = r##"<svg xmlns="http://www.w3.org/2000/svg" width="240" height="160" viewBox="0 0 240 160"><rect width="240" height="160" fill="#e7f0f4"/><circle cx="120" cy="66" r="37" fill="#267c93"/><path d="M30 143L86 94l34 27 35-39 55 61z" fill="#244c56"/></svg>"##;

    struct HeldFile {
        inner: Arc<dyn BlobBackend>,
        hash: [u8; 32],
        hash_hex: String,
        release: PathBuf,
        events: Mutex<File>,
        requests: AtomicUsize,
    }

    impl HeldFile {
        fn record(&self, event: &str, request: usize) -> AtomicResult<()> {
            let time = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_err(|e| e.to_string())?
                .as_millis();
            let row = serde_json::json!({
                "event": event,
                "atMs": time,
                "request": request,
                "hash": self.hash_hex,
            });
            let mut events = self
                .events
                .lock()
                .map_err(|_| "fixture event log poisoned")?;
            writeln!(events, "{row}").map_err(|e| e.to_string())?;
            events.flush().map_err(|e| e.to_string())?;
            Ok(())
        }
    }

    #[async_trait]
    impl BlobBackend for HeldFile {
        async fn get(&self, key: &[u8]) -> AtomicResult<Option<Vec<u8>>> {
            if key == self.hash {
                let request = self.requests.fetch_add(1, Ordering::Relaxed) + 1;
                self.record("blob-get-started", request)?;
                while !self.release.exists() {
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
                self.record("blob-get-released", request)?;
            }
            self.inner.get(key).await
        }

        async fn put(&self, key: &[u8], bytes: &[u8]) -> AtomicResult<()> {
            self.inner.put(key, bytes).await
        }

        async fn size(&self, key: &[u8]) -> AtomicResult<Option<u64>> {
            self.inner.size(key).await
        }
    }

    fn native_origin(raw: &str) -> anyhow::Result<String> {
        let parsed = url::Url::parse(raw)?;
        anyhow::ensure!(
            parsed.scheme() == "http"
                && matches!(parsed.host_str(), Some("localhost" | "127.0.0.1"))
                && parsed.port().is_some_and(|port| port > 0)
                && parsed.username().is_empty()
                && parsed.password().is_none()
                && parsed.path() == "/"
                && parsed.query().is_none()
                && parsed.fragment().is_none(),
            "supply a loopback HTTP origin with an explicit nondefault port and no credentials, path, query or fragment"
        );
        Ok(parsed.origin().ascii_serialization())
    }

    // Only address hints are written, with the recipient stopped. Authentication,
    // resource sync and file delivery still use the real Iroh connection. Local
    // hints keep CI independent of public discovery services and multicast.
    async fn seed_peer(recipient: &str, source: &str) -> anyhow::Result<()> {
        let recipient = Path::new(recipient).canonicalize()?;
        let source = Path::new(source).canonicalize()?;
        let regular = |path: &Path| -> anyhow::Result<()> {
            anyhow::ensure!(
                std::fs::symlink_metadata(path)?.file_type().is_file(),
                "fixture file must be regular and not a symlink"
            );
            Ok(())
        };
        let ready_path = source.join("ready.json");
        let marker_path = recipient.join("NATIVE_PEER_ACCEPTANCE_ONLY");
        regular(&ready_path)?;
        regular(&marker_path)?;
        let ready: serde_json::Value = serde_json::from_slice(&std::fs::read(ready_path)?)?;
        let marker: serde_json::Value = serde_json::from_slice(&std::fs::read(marker_path)?)?;
        anyhow::ensure!(
            marker["purpose"] == "native-peer-acceptance"
                && marker["nodeId"] == ready["nodeId"]
                && marker["drive"] == ready["drive"]
                && ready["releaseFile"].as_str() == source.join("release").to_str()
                && !source.join("release").exists(),
            "marker must name this exact unreleased source fixture"
        );
        let node_id = ready["nodeId"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("fixture has no node id"))?;
        let _: iroh::NodeId = node_id.parse()?;
        let direct = ready["directAddresses"]
            .as_array()
            .ok_or_else(|| anyhow::anyhow!("fixture has no direct addresses"))?
            .iter()
            .map(|raw| -> anyhow::Result<String> {
                let address: std::net::SocketAddr = raw
                    .as_str()
                    .ok_or_else(|| anyhow::anyhow!("invalid source address"))?
                    .parse()?;
                anyhow::ensure!(address.port() > 0, "source address has no port");
                // Both processes are in the same CI container. Use the actual
                // source endpoint's UDP port over loopback, never a public relay.
                let ip = if address.is_ipv4() {
                    std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST)
                } else {
                    std::net::IpAddr::V6(std::net::Ipv6Addr::LOCALHOST)
                };
                Ok(std::net::SocketAddr::new(ip, address.port()).to_string())
            })
            .collect::<anyhow::Result<Vec<_>>>()?;
        anyhow::ensure!(!direct.is_empty(), "source has no local UDP address");
        let store = recipient.join("store");
        anyhow::ensure!(
            store.canonicalize()? == store,
            "store must not be a symlink"
        );
        regular(&store.join("atomic.redb"))?;
        let db = Db::init_redb_file_with_policy(
            &store,
            None,
            &recipient.join("uploads"),
            &atomic_lib::db::compaction::CompactionPolicy::disabled(),
        )
        .await?;
        anyhow::ensure!(
            db.blob_store().list().await?.is_empty(),
            "only an empty acceptance recipient may receive fixture hints"
        );
        atomic_lib::sync::peer::remember_peer_addr(&db, node_id, None, direct);
        db.flush()?;
        println!("{{\"seededLocalPeerAddress\":true}}");
        Ok(())
    }

    pub async fn run() -> anyhow::Result<()> {
        let mut args = std::env::args().skip(1);
        let first = args.next().ok_or_else(|| {
            anyhow::anyhow!("usage: native_late_file_peer <fresh-fixture-dir> <native-http-origin>")
        })?;
        if first == "seed-peer" {
            let recipient = args
                .next()
                .ok_or_else(|| anyhow::anyhow!("missing recipient"))?;
            let source = args
                .next()
                .ok_or_else(|| anyhow::anyhow!("missing source"))?;
            anyhow::ensure!(args.next().is_none(), "unexpected argument");
            return seed_peer(&recipient, &source).await;
        }
        let directory = PathBuf::from(first);
        let raw_origin = args
            .next()
            .ok_or_else(|| anyhow::anyhow!("supply the native embedded node's HTTP origin"))?;
        anyhow::ensure!(args.next().is_none(), "unexpected argument");
        let origin = native_origin(&raw_origin)?;
        anyhow::ensure!(!directory.exists(), "use a fresh fixture directory");
        std::fs::create_dir_all(&directory)?;
        let directory = directory.canonicalize()?;
        let events = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(directory.join("events.jsonl"))?;
        let release = directory.join("release");
        let mut db = Db::init_redb_file(
            &directory.join("source.redb"),
            None,
            &directory.join("uploads"),
        )
        .await?;
        let (agent, drive) = db.setup("Late file acceptance fixture").await?;
        let mut root = db.get_resource(&drive.as_str().into()).await?;
        root.set_unsafe(
            urls::READ.into(),
            Value::ResourceArray(vec![urls::PUBLIC_AGENT.into()]),
        )?;
        root.save_locally(&db).await?;
        let hash = blake3::hash(IMAGE.as_bytes());
        let hash_hex = hash.to_hex().to_string();
        std::fs::write(directory.join("expected.svg"), IMAGE.as_bytes())?;
        db.put_blob(hash.as_bytes(), IMAGE.as_bytes()).await?;
        let file = db
            .create_resource(
                urls::FILE,
                &drive,
                "Late peer image.svg",
                Some(vec![
                    (
                        urls::BLOB,
                        Value::AtomicUrl(atomic_lib::identifiers::blob_subject(&hash_hex).into()),
                    ),
                    (urls::INTERNAL_ID, Value::String(hash_hex.clone())),
                    (urls::MIMETYPE, Value::String("image/svg+xml".into())),
                    (urls::FILESIZE, Value::Integer(IMAGE.len() as i64)),
                    (urls::FILENAME, Value::String("late-peer-image.svg".into())),
                    (
                        urls::DOWNLOAD_URL,
                        Value::AtomicUrl(format!("{origin}/download/files/{hash_hex}").into()),
                    ),
                ]),
            )
            .await?;
        db.blob_backend = Some(Arc::new(HeldFile {
            inner: db.blob_store(),
            hash: *hash.as_bytes(),
            hash_hex: hash_hex.clone(),
            release: release.clone(),
            events: Mutex::new(events),
            requests: AtomicUsize::new(0),
        }));
        let (node_id, router) = atomic_lib::sync::peer::start(db).await?;
        let address = router.endpoint().node_addr().await?;
        let ready = serde_json::json!({
            "nodeId": node_id.to_string(),
            "relayUrl": address.relay_url.map(|url| url.to_string()),
            "directAddresses": address.direct_addresses.iter().map(|address| address.to_string()).collect::<Vec<_>>(),
            "agent": agent.subject.to_string(),
            "drive": drive,
            "file": file,
            "hash": hash_hex,
            "imageFile": directory.join("expected.svg"),
            "releaseFile": release,
            "eventsFile": directory.join("events.jsonl"),
        });
        std::fs::write(
            directory.join("ready.json"),
            serde_json::to_vec_pretty(&ready)?,
        )?;
        println!("{ready}");
        std::future::pending::<()>().await;
        Ok(())
    }

    #[cfg(test)]
    mod tests {
        use super::native_origin;

        #[test]
        fn validates_and_normalizes_the_native_loopback_origin() {
            assert_eq!(
                native_origin("http://localhost:9883").unwrap(),
                "http://localhost:9883"
            );
            assert_eq!(
                native_origin("http://127.0.0.1:9883/").unwrap(),
                "http://127.0.0.1:9883"
            );
            for input in [
                "http://localhost:9883@evil.example",
                "http://evil.example:9883",
                "http://user@localhost:9883",
                "http://localhost:9883/download",
                "http://localhost:9883/?file=1",
                "http://localhost:9883/#file",
                "https://localhost:9883",
                "http://localhost",
                "http://localhost:80",
                "http://localhost:0",
            ] {
                assert!(native_origin(input).is_err(), "accepted {input}");
            }
        }
    }
}

#[cfg(all(feature = "iroh", feature = "db", not(target_arch = "wasm32")))]
#[tokio::main]
async fn main() -> anyhow::Result<()> {
    fixture::run().await
}

#[cfg(not(all(feature = "iroh", feature = "db", not(target_arch = "wasm32"))))]
fn main() {
    eprintln!("native_late_file_peer requires a native target and --features iroh,db-redb");
    std::process::exit(1);
}
