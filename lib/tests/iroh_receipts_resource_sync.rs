//! Automatic resource receipts over real QUIC between separate processes.
//!
//! Only discovery is short-circuited by exchanging NodeAddr through a file.
//! Production authentication, reconciliation, live updates and persistent Redb
//! barriers run unchanged. No application-issued receipt probes are used.
//! Run: cargo test -p atomic_lib --features db-redb,iroh --test iroh_receipts
#![cfg(all(feature = "db-redb", feature = "iroh"))]

use atomic_lib::host::{embed::EmbedHost, profiles::AgentProfiles, NoPush};
use atomic_lib::runtime::AtomicNode;
use atomic_lib::{sync::iroh_receipts::IrohReplicaReceipt, Db, Storelike};
use std::{path::Path, process::Child, sync::Arc, time::Duration};

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

fn embed_host(store: &Db) -> EmbedHost {
    EmbedHost::new(
        AtomicNode::from_db(store.clone()),
        Arc::new(NoPush),
        AgentProfiles::none(),
    )
}

async fn host_evidence(host: &EmbedHost, subject: &str) -> serde_json::Value {
    serde_json::from_str(
        &host
            .call(
                "getResourcePeerEvidence",
                &serde_json::json!([[subject]]).to_string(),
            )
            .await
            .unwrap(),
    )
    .unwrap()
}

async fn await_host_receipt(host: &EmbedHost, subject: &str, version: &str) -> serde_json::Value {
    tokio::time::timeout(WAIT, async {
        loop {
            let snapshot = host_evidence(host, subject).await;
            let found = snapshot["connections"]
                .as_array()
                .unwrap()
                .iter()
                .any(|connection| {
                    connection["receipts"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .any(|receipt| {
                            receipt["subject"] == subject
                                && receipt["version"].as_str().is_some_and(|vv| {
                                    decoded_frontier(vv) == decoded_frontier(version)
                                })
                        })
                });
            if found {
                return snapshot;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .expect("EmbedHost should expose the actual automatic Iroh receipt")
}

async fn await_host_attachment(host: &EmbedHost, subject: &str, file: &str, hash: &str) {
    let expected = serde_json::json!({"files": [{"subject": file, "hash": hash, "chunks": []}]});
    tokio::time::timeout(WAIT + Duration::from_secs(15), async {
        loop {
            let snapshot = host_evidence(host, subject).await;
            if snapshot["connections"]
                .as_array()
                .unwrap()
                .iter()
                .any(|connection| {
                    connection["attachmentReceipts"]
                        .as_array()
                        .is_some_and(|receipts| {
                            receipts.iter().any(|receipt| {
                                receipt["subject"] == subject && receipt["manifest"] == expected
                            })
                        })
                })
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("actual Iroh peer must confirm the complete attachment manifest");
    let local: serde_json::Value = serde_json::from_str(
        &host
            .call(
                "getResourceAttachmentEvidence",
                &serde_json::json!([[subject]]).to_string(),
            )
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(local[0]["state"], "confirmed");
    assert_eq!(local[0]["manifest"], expected);
}

fn spawn_receiver(root: &Path, receiver_dir: &Path) -> ChildGuard {
    let _ = std::fs::remove_file(receiver_dir.join("address.json"));
    let log = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(root.join("receiver.log"))
        .unwrap();
    ChildGuard(
        std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "receipt_receiver_process",
                "--exact",
                "--ignored",
                "--test-threads=1",
                "--nocapture",
            ])
            .env(CHILD_DIR_ENV, receiver_dir)
            .stdout(log.try_clone().unwrap())
            .stderr(log)
            .spawn()
            .expect("spawn isolated receipt receiver"),
    )
}

async fn connect_receiver(
    router: &iroh::protocol::Router,
    remote: &Address,
    drive: &str,
    store: &Db,
) {
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
    atomic_lib::sync::peer::sync_drive_with_peer_using(
        router.endpoint(),
        &remote.node_id,
        drive,
        store,
        true,
    )
    .await
    .expect("production sync into receiver");
}

/// Test-only native shell for the real embedded renderer acceptance. JSON lines
/// carry the existing NativeChannel calls; no receipts or resources are forged.
async fn serve_renderer(host: &EmbedHost, child: &mut ChildGuard, drive: &str, subject: &str) {
    use std::io::{BufRead, Write};
    println!(
        "NATIVE_HOST_READY {}",
        serde_json::json!({"drive": drive, "subject": subject})
    );
    std::io::stdout().flush().unwrap();
    let (send, mut receive) = tokio::sync::mpsc::channel::<String>(16);
    std::thread::spawn(move || {
        for line in std::io::stdin().lock().lines() {
            let Ok(line) = line else {
                break;
            };
            if send.blocking_send(line).is_err() {
                break;
            }
        }
    });
    while let Some(line) = receive.recv().await {
        let request: serde_json::Value = serde_json::from_str(&line).expect("valid test RPC");
        let method = request["method"].as_str().unwrap();
        if method == "__test_stop" {
            break;
        }
        let result = if method == "__test_close_peer" {
            child.stop();
            Ok("null".to_string())
        } else {
            host.call(method, &request["args"].to_string()).await
        };
        let reply = match result {
            Ok(value) => {
                serde_json::json!({"id": request["id"], "ok": true, "value": serde_json::from_str::<serde_json::Value>(&value).unwrap()})
            }
            Err(error) => serde_json::json!({"id": request["id"], "ok": false, "error": error}),
        };
        println!("NATIVE_HOST_REPLY {reply}");
        std::io::stdout().flush().unwrap();
    }
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
    // A real File and direct attachment travel through the normal Iroh blob
    // transfer. Resource metadata alone must not satisfy the renderer's count.
    let attachment_bytes = b"Native attachment bytes independently verified after peer storage";
    let attachment_hash = blake3::hash(attachment_bytes);
    store
        .put_blob(attachment_hash.as_bytes(), attachment_bytes)
        .await
        .unwrap();
    let attachment = store
        .create_resource(
            atomic_lib::urls::FILE,
            &drive,
            "Native evidence.txt",
            Some(vec![
                (
                    atomic_lib::urls::FILENAME,
                    atomic_lib::Value::String("Native evidence.txt".into()),
                ),
                (
                    atomic_lib::urls::FILESIZE,
                    atomic_lib::Value::Integer(attachment_bytes.len() as i64),
                ),
                (
                    atomic_lib::urls::DOWNLOAD_URL,
                    atomic_lib::Value::AtomicUrl(
                        format!("https://embed.invalid/download/files/{attachment_hash}")
                            .as_str()
                            .into(),
                    ),
                ),
                (
                    atomic_lib::urls::INTERNAL_ID,
                    atomic_lib::Value::String(attachment_hash.to_hex().to_string()),
                ),
                (
                    atomic_lib::urls::BLOB,
                    atomic_lib::Value::AtomicUrl(
                        atomic_lib::identifiers::blob_subject(attachment_hash.to_hex().as_ref())
                            .as_str()
                            .into(),
                    ),
                ),
            ]),
        )
        .await
        .unwrap();
    let mut parent = store.get_resource(&subject.as_str().into()).await.unwrap();
    parent
        .set_unsafe(
            atomic_lib::urls::ATTACHMENTS.into(),
            atomic_lib::Value::ResourceArray(vec![attachment.clone().into()]),
        )
        .unwrap();
    parent.save_locally(&store).await.unwrap();
    drop(parent);
    let c1 = stored_frontier(&store, &subject);
    eprintln!("Bulk target C1: {c1}");
    let source_identity = store.kv.replica_identity(&drive).unwrap().unwrap();
    let mut events = store.subscribe_replica_receipts();
    std::fs::write(
        receiver_dir.join("agent-secret"),
        agent.build_secret().unwrap(),
    )
    .unwrap();
    let mut child = spawn_receiver(&root, &receiver_dir);
    let remote = await_address(&receiver_dir, &mut child).await;
    let (_, router) = peer::start(store.clone()).await.unwrap();
    connect_receiver(&router, &remote, &drive, &store).await;
    let first = await_receipt(&mut events, &subject, &c1).await;
    let host = embed_host(&store);
    let first_host = await_host_receipt(&host, &subject, &c1).await;
    assert_eq!(first_host["agent"], agent.subject.to_string());
    assert_eq!(
        first_host["connections"][0]["receipts"][0]["replica"]["storageId"],
        first.receipt.replica.storage_id
    );
    await_host_attachment(
        &host,
        &subject,
        &attachment,
        attachment_hash.to_hex().as_ref(),
    )
    .await;
    await_host_attachment(
        &host,
        &attachment,
        &attachment,
        attachment_hash.to_hex().as_ref(),
    )
    .await;
    if std::env::var_os("ATOMIC_NATIVE_RENDERER_HOST").is_some() {
        tokio::time::timeout(
            Duration::from_secs(180),
            serve_renderer(&host, &mut child, &drive, &subject),
        )
        .await
        .expect("renderer acceptance must finish");
        return;
    }

    // Native notifications describe versions the scheduler observed. Wait for
    // each observed C2 before C3: there is no every-save event guarantee here.
    let c2 = edit(&store, &subject, "Receipt C2").await;
    eprintln!("Live target C2: {c2}");
    assert_ne!(decoded_frontier(&c1), decoded_frontier(&c2));
    let second = await_receipt(&mut events, &subject, &c2).await;
    await_host_receipt(&host, &subject, &c2).await;
    let c3 = edit(&store, &subject, "Receipt C3").await;
    eprintln!("Live target C3: {c3}");
    assert_ne!(decoded_frontier(&c2), decoded_frontier(&c3));
    let third = await_receipt(&mut events, &subject, &c3).await;
    await_host_receipt(&host, &subject, &c3).await;
    await_host_attachment(
        &host,
        &subject,
        &attachment,
        attachment_hash.to_hex().as_ref(),
    )
    .await;

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
    tokio::time::timeout(
        atomic_lib::sync::protocol::LIVENESS_TIMEOUT + Duration::from_secs(10),
        async {
            while !host_evidence(&host, &subject).await["connections"]
                .as_array()
                .unwrap()
                .is_empty()
            {
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        },
    )
    .await
    .expect("a killed native peer must disappear from the renderer evidence");
    let reopened = open_store(&receiver_dir).await;
    assert_eq!(
        reopened
            .get_blob(attachment_hash.as_bytes())
            .await
            .unwrap()
            .as_deref(),
        Some(attachment_bytes.as_slice())
    );
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
    drop(resource);
    drop(reopened);
    let mut fresh_events = store.subscribe_replica_receipts();
    let mut replacement = spawn_receiver(&root, &receiver_dir);
    let replacement_addr = await_address(&receiver_dir, &mut replacement).await;
    connect_receiver(&router, &replacement_addr, &drive, &store).await;
    let fresh = await_receipt(&mut fresh_events, &subject, &c3).await;
    assert_ne!(fresh.connection_generation, third.connection_generation);
    assert_eq!(fresh.receipt.replica, third.receipt.replica);
    await_host_receipt(&host, &subject, &c3).await;
    await_host_attachment(
        &host,
        &subject,
        &attachment,
        attachment_hash.to_hex().as_ref(),
    )
    .await;
}
