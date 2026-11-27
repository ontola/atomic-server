//! Automatic resource receipts over real QUIC between separate processes.
//!
//! Only discovery is short-circuited by exchanging NodeAddr through a file.
//! Production authentication, reconciliation, live updates and persistent Redb
//! barriers run unchanged. No application-issued receipt probes are used.
//! Run: cargo test -p atomic_lib --features db-redb,iroh --test iroh_receipts
#![cfg(all(feature = "db-redb", feature = "iroh"))]

use atomic_lib::{sync::iroh_receipts::IrohReplicaReceipt, Db, Storelike};
use std::{path::Path, process::Child, time::Duration};

const CHILD_DIR_ENV: &str = "ATOMIC_RECEIPT_CHILD_DIR";
const WAIT: Duration = Duration::from_secs(30);

fn trace_sync() {
    use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt, Layer};
    let _ = tracing_subscriber::registry()
        .with(
            tracing_subscriber::fmt::layer().with_filter(
                tracing_subscriber::filter::Targets::new()
                    .with_target("atomic_lib", tracing::Level::DEBUG),
            ),
        )
        .try_init();
}

#[derive(serde::Serialize, serde::Deserialize)]
struct Address {
    node_id: String,
    relay_url: Option<String>,
    direct_addrs: Vec<String>,
}

async fn open_store(dir: &Path) -> Db {
    Db::init_redb_file(dir, None, &dir.join("uploads"))
        .await
        .expect("open persistent receipt test store")
}

/// Kill and reap even when an assertion fails; a failed test must not leave a
/// remote peer running or holding the receiver database open.
struct ChildGuard(Child);

impl ChildGuard {
    fn stop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

impl Drop for ChildGuard {
    fn drop(&mut self) {
        self.stop();
    }
}

#[test]
#[ignore = "child process entry point, driven by the parent acceptance test"]
fn receipt_receiver_process() {
    let Some(dir) = std::env::var_os(CHILD_DIR_ENV).map(std::path::PathBuf::from) else {
        return;
    };
    trace_sync();
    tokio::runtime::Runtime::new().unwrap().block_on(async {
        let store = open_store(&dir).await;
        let secret = std::fs::read_to_string(dir.join("agent-secret")).unwrap();
        store.load_agent_from_secret(&secret).await.unwrap();
        let (node_id, router) = atomic_lib::sync::peer::start(store).await.unwrap();
        let addr = router.endpoint().node_addr().await.unwrap();
        let address = Address {
            node_id: node_id.to_string(),
            relay_url: addr.relay_url.map(|url| url.to_string()),
            direct_addrs: addr
                .direct_addresses
                .iter()
                .map(ToString::to_string)
                .collect(),
        };
        std::fs::write(
            dir.join("address.json"),
            serde_json::to_vec(&address).unwrap(),
        )
        .unwrap();
        // The parent terminates us after observing a completed receipt. This
        // ceiling bounds an orphan if the parent itself crashes.
        tokio::time::sleep(Duration::from_secs(180)).await;
    });
}

async fn await_address(dir: &Path, child: &mut ChildGuard) -> Address {
    tokio::time::timeout(WAIT, async {
        loop {
            if let Ok(bytes) = std::fs::read(dir.join("address.json")) {
                if let Ok(address) = serde_json::from_slice(&bytes) {
                    return address;
                }
            }
            if let Some(status) = child.0.try_wait().unwrap() {
                panic!("receiver exited before publishing its address: {status}");
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("receiver should publish its direct QUIC address")
}

fn stored_frontier(store: &Db, subject: &str) -> String {
    let snapshot = store.get_loro_snapshot(&subject.into()).unwrap();
    let doc = atomic_lib::loro::AtomicLoroDoc::from_snapshot(&snapshot).unwrap();
    atomic_lib::agents::encode_base64(&doc.doc().state_vv().encode())
}

fn decoded_frontier(version: &str) -> loro::VersionVector {
    let bytes = atomic_lib::agents::decode_base64(version).unwrap();
    loro::VersionVector::decode(&bytes).unwrap()
}

async fn await_receipt(
    events: &mut tokio::sync::broadcast::Receiver<IrohReplicaReceipt>,
    subject: &str,
    version: &str,
) -> IrohReplicaReceipt {
    eprintln!("Waiting for receipt subject={subject} version={version}");
    let expected = decoded_frontier(version);
    tokio::time::timeout(WAIT, async {
        loop {
            let event = events
                .recv()
                .await
                .expect("receipt subscription remains active");
            eprintln!(
                "Observed receipt subject={} version={} node={}",
                event.receipt.subject, event.receipt.version, event.remote_node_id
            );
            // Loro encodes a hash map, so independent captures of the same
            // frontier can order peers differently. Require equality of every
            // counter, not mere coverage by a later frontier. Requester unit
            // tests separately pin byte-for-byte echo of the issued request.
            if event.receipt.subject == subject
                && decoded_frontier(&event.receipt.version) == expected
            {
                return event;
            }
        }
    })
    .await
    .unwrap_or_else(|_| panic!("no automatic receipt for {subject} at {version}"))
}

async fn edit(store: &Db, subject: &str, name: &str) -> String {
    let mut resource = store.get_resource(&subject.into()).await.unwrap();
    resource
        .set_unsafe(
            atomic_lib::urls::NAME.into(),
            atomic_lib::Value::String(name.into()),
        )
        .unwrap();
    resource.save_locally(store).await.unwrap();
    stored_frontier(store, subject)
}

#[tokio::test]
async fn automatic_bulk_and_live_receipts_survive_receiver_reopen() {
    use atomic_lib::sync::peer;
    trace_sync();

    let root = std::env::temp_dir().join(format!(
        "atomic-iroh-receipts-{}-{:016x}",
        std::process::id(),
        rand::random::<u64>(),
    ));
    let source_dir = root.join("source");
    let receiver_dir = root.join("receiver");
    eprintln!("Receipt acceptance artifacts: {}", root.display());
    std::fs::create_dir_all(&source_dir).unwrap();
    std::fs::create_dir_all(&receiver_dir).unwrap();
    let store = open_store(&source_dir).await;
    let (agent, drive) = store.setup("Receipt source").await.unwrap();
    let subject = store
        .create_resource(
            "https://atomicdata.dev/classes/Folder",
            &drive,
            "Receipt C1",
            None,
        )
        .await
        .unwrap();
    let c1 = stored_frontier(&store, &subject);
    eprintln!("Bulk target C1: {c1}");
    let source_identity = store.kv.replica_identity(&drive).unwrap().unwrap();
    let mut events = store.subscribe_replica_receipts();
    std::fs::write(
        receiver_dir.join("agent-secret"),
        agent.build_secret().unwrap(),
    )
    .unwrap();
    let log = std::fs::File::create(root.join("receiver.log")).unwrap();
    let mut child = ChildGuard(
        std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "receipt_receiver_process",
                "--exact",
                "--ignored",
                "--test-threads=1",
                "--nocapture",
            ])
            .env(CHILD_DIR_ENV, &receiver_dir)
            .stdout(log.try_clone().unwrap())
            .stderr(log)
            .spawn()
            .expect("spawn isolated receipt receiver"),
    );
    let remote = await_address(&receiver_dir, &mut child).await;
    let (_, router) = peer::start(store.clone()).await.unwrap();
    let mut addr = iroh::NodeAddr::new(remote.node_id.parse().unwrap());
    if let Some(relay) = remote.relay_url.as_deref().and_then(|url| url.parse().ok()) {
        addr = addr.with_relay_url(relay);
    }
    addr = addr.with_direct_addresses(
        remote
            .direct_addrs
            .iter()
            .map(|address| address.parse::<std::net::SocketAddr>().unwrap()),
    );
    router.endpoint().add_node_addr(addr).unwrap();
    peer::sync_drive_with_peer_using(router.endpoint(), &remote.node_id, &drive, &store, true)
        .await
        .expect("production bulk sync into the receiver");
    let first = await_receipt(&mut events, &subject, &c1).await;

    // Native notifications describe versions the scheduler observed. Wait for
    // each observed C2 before C3: there is no every-save event guarantee here.
    let c2 = edit(&store, &subject, "Receipt C2").await;
    eprintln!("Live target C2: {c2}");
    assert_ne!(decoded_frontier(&c1), decoded_frontier(&c2));
    let second = await_receipt(&mut events, &subject, &c2).await;
    let c3 = edit(&store, &subject, "Receipt C3").await;
    eprintln!("Live target C3: {c3}");
    assert_ne!(decoded_frontier(&c2), decoded_frontier(&c3));
    let third = await_receipt(&mut events, &subject, &c3).await;

    for event in [&first, &second, &third] {
        assert_eq!(event.receipt.drive, drive);
        assert_eq!(event.receipt.barrier, "atomic-redb-flush-v1");
        assert_eq!(
            event.remote_node_id,
            peer::normalize_node_id(&remote.node_id)
        );
        assert_eq!(event.remote_agent, agent.subject.to_string());
        assert_eq!(event.local_agent, agent.subject.to_string());
        assert_eq!(event.source.storage_id, source_identity.storage_id);
        assert_eq!(event.source.generation, source_identity.generation);
        assert_ne!(event.source.storage_id, event.receipt.replica.storage_id);
        assert_eq!(event.receipt.replica, first.receipt.replica);
        assert_eq!(event.connection_generation, first.connection_generation);
        assert_eq!(event.agent_generation, first.agent_generation);
        assert!(event.observed_at > 0);
    }
    assert_ne!(first.receipt.nonce, second.receipt.nonce);
    assert_ne!(second.receipt.nonce, third.receipt.nonce);

    // The receiver does not shut down gracefully or perform a final flush.
    // Once its process is gone, reopen the actual database and verify both the
    // scoped identity and every frontier covered by the earlier receipts.
    child.stop();
    let reopened = open_store(&receiver_dir).await;
    let identity = reopened.kv.replica_identity(&drive).unwrap().unwrap();
    assert_eq!(identity.storage_id, third.receipt.replica.storage_id);
    assert_eq!(identity.generation, third.receipt.replica.generation);
    let snapshot = reopened
        .get_loro_snapshot(&subject.as_str().into())
        .unwrap();
    let restored = atomic_lib::loro::AtomicLoroDoc::from_snapshot(&snapshot).unwrap();
    for version in [&c1, &c2, &c3] {
        assert!(restored
            .doc()
            .state_vv()
            .includes_vv(&decoded_frontier(version)));
    }
    let resource = reopened
        .get_resource(&subject.as_str().into())
        .await
        .unwrap();
    assert_eq!(
        resource.get(atomic_lib::urls::NAME).unwrap().to_string(),
        "Receipt C3"
    );
}

/// Separate interactive entry point: the ordinary persistence test above must
/// still finish on its own and exercise C1/C2/C3 plus receiver reopen.
#[derive(serde::Deserialize)]
struct RendererRequest {
    id: Option<u64>,
    method: String,
    #[serde(default)]
    args: Vec<serde_json::Value>,
}

fn renderer_request(line: &str) -> Result<RendererRequest, String> {
    let request: RendererRequest = serde_json::from_str(line).map_err(|e| e.to_string())?;
    if request.method.is_empty() || (request.method != "__test_stop" && request.id.is_none()) {
        return Err("Renderer call requires a method and request id".into());
    }
    Ok(request)
}

fn renderer_reply(id: Option<u64>, result: Result<serde_json::Value, String>) -> serde_json::Value {
    match result {
        Ok(value) => serde_json::json!({"id": id, "ok": true, "value": value}),
        Err(error) => serde_json::json!({"id": id, "ok": false, "error": error}),
    }
}

struct IrohRendererFixture {
    host: atomic_lib::host::embed::EmbedHost,
    receiver: tokio::sync::Mutex<Option<ChildGuard>>,
    remote: String,
}

impl IrohRendererFixture {
    async fn close_peer(&self) {
        // Use the same production disconnect boundary as an explicit native
        // Disconnect action. No receipt or UI state is manufactured here.
        let child = self.receiver.lock().await.take();
        drop(child); // ChildGuard kills and reaps only this fixture's receiver.
        atomic_lib::sync::peer::remove_live_peer_any(&self.remote);
    }

    async fn call(&self, request: &RendererRequest) -> Result<serde_json::Value, String> {
        if request.method == "__test_close_peer" {
            self.close_peer().await;
            return Ok(serde_json::Value::Null);
        }
        let answer = self
            .host
            .call(
                &request.method,
                &serde_json::to_string(&request.args).unwrap(),
            )
            .await?;
        serde_json::from_str(&answer).map_err(|e| e.to_string())
    }
}

async fn renderer_attachment(store: &Db, drive: &str) -> String {
    use atomic_lib::{urls, Value};
    let content = b"Real native Iroh attachment bytes";
    let hash = blake3::hash(content);
    store.put_blob(hash.as_bytes(), content).await.unwrap();
    let file = store
        .create_resource(
            urls::FILE,
            drive,
            "Native Iroh.txt",
            Some(vec![
                (urls::FILENAME, Value::String("Native Iroh.txt".into())),
                (urls::FILESIZE, Value::Integer(content.len() as i64)),
                (
                    urls::DOWNLOAD_URL,
                    Value::AtomicUrl(
                        format!("https://native.invalid/download/files/{hash}").into(),
                    ),
                ),
                (urls::INTERNAL_ID, Value::String(hash.to_hex().to_string())),
                (
                    urls::BLOB,
                    Value::AtomicUrl(
                        atomic_lib::identifiers::blob_subject(hash.to_hex().as_ref())
                            .as_str()
                            .into(),
                    ),
                ),
            ]),
        )
        .await
        .unwrap();
    let subject = store
        .create_resource(urls::FOLDER, drive, "Receipt C1", None)
        .await
        .unwrap();
    let mut resource = store.get_resource(&subject.as_str().into()).await.unwrap();
    resource
        .set_unsafe(
            urls::ATTACHMENTS.into(),
            Value::ResourceArray(vec![file.into()]),
        )
        .unwrap();
    resource.save_locally(store).await.unwrap();
    store.flush().unwrap();
    subject
}

async fn await_renderer_contents(host: &atomic_lib::host::embed::EmbedHost, subject: &str) {
    // READY means the real automatic metadata and file receipts have arrived;
    // an arbitrary boot delay or a synthetic receipt cannot satisfy it.
    tokio::time::timeout(WAIT, async {
        loop {
            let raw = host
                .call(
                    "getResourcePeerEvidence",
                    &serde_json::json!([[subject]]).to_string(),
                )
                .await
                .unwrap();
            let evidence: serde_json::Value = serde_json::from_str(&raw).unwrap();
            if evidence["connections"]
                .as_array()
                .is_some_and(|connections| {
                    connections.iter().any(|connection| {
                        connection["attachmentReceipts"]
                            .as_array()
                            .is_some_and(|receipts| {
                                receipts.iter().any(|receipt| receipt["subject"] == subject)
                            })
                    })
                })
            {
                return;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("automatic native attachment receipt before renderer readiness");
}

#[test]
#[ignore = "test-owned JSON-lines native host, driven by Playwright with real Iroh"]
fn native_iroh_renderer_host() {
    use atomic_lib::host::{embed::EmbedHost, profiles::AgentProfiles, NoPush};
    use atomic_lib::{runtime::AtomicNode, sync::peer};
    use std::{
        io::{BufRead, Write},
        sync::Arc,
    };
    assert_eq!(
        std::env::var("ATOMIC_NATIVE_RENDERER_HOST").as_deref(),
        Ok("1"),
        "interactive fixture requires the native renderer harness"
    );
    trace_sync();
    let root = std::env::temp_dir().join(format!(
        "atomic-iroh-renderer-{}-{:016x}",
        std::process::id(),
        rand::random::<u64>()
    ));
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        std::fs::DirBuilder::new()
            .mode(0o700)
            .create(&root)
            .unwrap();
    }
    #[cfg(not(unix))]
    std::fs::create_dir(&root).unwrap();
    eprintln!("Native renderer artifacts: {}", root.display());
    // The production peer owns background tasks with database clones. Drop the
    // entire private runtime before removing its files, including on Windows.
    tokio::runtime::Runtime::new().unwrap().block_on(async {
        let source_dir = root.join("source");
        let receiver_dir = root.join("receiver");
        std::fs::create_dir_all(&source_dir).unwrap();
        std::fs::create_dir_all(&receiver_dir).unwrap();
        let store = open_store(&source_dir).await;
        let (agent, drive) = store.setup("Native receipt source").await.unwrap();
        let subject = renderer_attachment(&store, &drive).await;
        let version = stored_frontier(&store, &subject);
        let mut events = store.subscribe_replica_receipts();
        std::fs::write(
            receiver_dir.join("agent-secret"),
            agent.build_secret().unwrap(),
        )
        .unwrap();
        let log = std::fs::File::create(root.join("receiver.log")).unwrap();
        let mut child = ChildGuard(
            std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "receipt_receiver_process",
                    "--exact",
                    "--ignored",
                    "--test-threads=1",
                    "--nocapture",
                ])
                .env(CHILD_DIR_ENV, &receiver_dir)
                .stdout(log.try_clone().unwrap())
                .stderr(log)
                .spawn()
                .unwrap(),
        );
        let remote = await_address(&receiver_dir, &mut child).await;
        let (_, router) = peer::start(store.clone()).await.unwrap();
        let mut addr = iroh::NodeAddr::new(remote.node_id.parse().unwrap());
        if let Some(relay) = remote.relay_url.as_deref().and_then(|url| url.parse().ok()) {
            addr = addr.with_relay_url(relay);
        }
        addr = addr.with_direct_addresses(
            remote
                .direct_addrs
                .iter()
                .map(|address| address.parse::<std::net::SocketAddr>().unwrap()),
        );
        router.endpoint().add_node_addr(addr).unwrap();
        peer::sync_drive_with_peer_using(router.endpoint(), &remote.node_id, &drive, &store, true)
            .await
            .unwrap();
        await_receipt(&mut events, &subject, &version).await;
        let fixture = Arc::new(IrohRendererFixture {
            host: EmbedHost::new(
                AtomicNode::from_db(store.clone()),
                Arc::new(NoPush),
                AgentProfiles::none(),
            ),
            receiver: tokio::sync::Mutex::new(Some(child)),
            remote: remote.node_id,
        });
        await_renderer_contents(&fixture.host, &subject).await;
        println!(
            "NATIVE_HOST_READY {}",
            serde_json::json!({"drive": drive, "subject": subject})
        );
        std::io::stdout().flush().unwrap();
        let (send, mut receive) = tokio::sync::mpsc::channel::<String>(32);
        let input_thread = std::thread::spawn(move || {
            for line in std::io::stdin().lock().lines() {
                let Ok(line) = line else { break };
                let stop =
                    renderer_request(&line).is_ok_and(|request| request.method == "__test_stop");
                if send.blocking_send(line).is_err() || stop {
                    break;
                }
            }
        });
        let mut tasks = tokio::task::JoinSet::new();
        while let Some(line) = receive.recv().await {
            let request = match renderer_request(&line) {
                Ok(request) => request,
                Err(error) => {
                    println!("NATIVE_HOST_REPLY {}", renderer_reply(None, Err(error)));
                    std::io::stdout().flush().unwrap();
                    continue;
                }
            };
            if request.method == "__test_stop" {
                break;
            }
            let fixture = fixture.clone();
            tasks.spawn(async move {
                let answer = fixture.call(&request).await;
                println!("NATIVE_HOST_REPLY {}", renderer_reply(request.id, answer));
                std::io::stdout().flush().unwrap();
            });
        }
        fixture.close_peer().await;
        tasks.abort_all();
        while tasks.join_next().await.is_some() {}
        router.shutdown().await.unwrap();
        drop(router);
        drop(fixture);
        drop(store);
        input_thread.join().expect("fixture stdin reader stopped");
    });
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn native_renderer_protocol_correlates_calls_and_accepts_clean_shutdown() {
    use serde_json::json;
    let request = renderer_request(r#"{"id":7,"method":"__test_close_peer","args":[]}"#).unwrap();
    assert_eq!(request.id, Some(7));
    assert_eq!(request.method, "__test_close_peer");
    assert!(request.args.is_empty());
    assert_eq!(
        renderer_reply(request.id, Ok(json!(null))),
        json!({"id":7,"ok":true,"value":null})
    );
    assert_eq!(
        renderer_reply(Some(8), Err("unknown host method".into())),
        json!({"id":8,"ok":false,"error":"unknown host method"})
    );
    assert!(renderer_request(r#"{"method":"__test_stop","args":[]}"#).is_ok());
    for invalid in [
        r#"{"method":"getResource","args":[]}"#,
        r#"{"id":1,"method":"","args":[]}"#,
        r#"{"id":1,"method":"getResource","args":{}}"#,
        "not JSON",
    ] {
        assert!(
            renderer_request(invalid).is_err(),
            "invalid request: {invalid}"
        );
    }
}
