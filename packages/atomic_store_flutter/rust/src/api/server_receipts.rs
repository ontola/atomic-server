//! Continuous, handle-scoped delivery of automatic server storage evidence.

use std::sync::{Arc, Mutex};

use atomic_lib::client::ws_receipts::ServerReplicaReceipt;
use atomic_lib::sync::protocol::{StorageReceipt, StorageReceiptReplica};
use tokio::sync::{broadcast, watch};

use super::simple::ws_sync::SyncSession;
use crate::frb_generated::StreamSink;

#[derive(Clone, Debug)]
pub struct ReplicaIdentityData {
    pub storage_id: String,
    pub generation: String,
}

#[derive(Clone, Debug)]
pub struct StorageReceiptData {
    pub nonce: String,
    pub drive: String,
    pub subject: String,
    pub version: String,
    pub replica: ReplicaIdentityData,
    pub barrier: String,
}

/// Historical evidence, not a promise of future retention or independence.
#[derive(Clone, Debug)]
pub struct ServerReplicaReceiptData {
    pub receipt: StorageReceiptData,
    pub source: Option<ReplicaIdentityData>,
    pub server_origin: String,
    pub connection_id: String,
    pub authentication_generation: u64,
    pub authenticated_agent: String,
    pub local_agent: String,
    pub agent_generation: u64,
    pub observed_at: u64,
}

impl From<StorageReceiptReplica> for ReplicaIdentityData {
    fn from(value: StorageReceiptReplica) -> Self {
        Self {
            storage_id: value.storage_id,
            generation: value.generation,
        }
    }
}

impl From<ReplicaIdentityData> for StorageReceiptReplica {
    fn from(value: ReplicaIdentityData) -> Self {
        Self {
            storage_id: value.storage_id,
            generation: value.generation,
        }
    }
}

impl From<ServerReplicaReceipt> for ServerReplicaReceiptData {
    fn from(value: ServerReplicaReceipt) -> Self {
        Self {
            receipt: StorageReceiptData {
                nonce: value.receipt.nonce,
                drive: value.receipt.drive,
                subject: value.receipt.subject,
                version: value.receipt.version,
                replica: value.receipt.replica.into(),
                barrier: value.receipt.barrier,
            },
            source: value.source.map(Into::into),
            server_origin: value.server_origin,
            connection_id: value.connection_id,
            authentication_generation: value.authentication_generation,
            authenticated_agent: value.authenticated_agent,
            local_agent: value.local_agent,
            agent_generation: value.agent_generation,
            observed_at: value.observed_at,
        }
    }
}

impl From<ServerReplicaReceiptData> for ServerReplicaReceipt {
    fn from(value: ServerReplicaReceiptData) -> Self {
        Self {
            receipt: StorageReceipt {
                nonce: value.receipt.nonce,
                drive: value.receipt.drive,
                subject: value.receipt.subject,
                version: value.receipt.version,
                replica: value.receipt.replica.into(),
                barrier: value.receipt.barrier,
            },
            source: value.source.map(Into::into),
            server_origin: value.server_origin,
            connection_id: value.connection_id,
            authentication_generation: value.authentication_generation,
            authenticated_agent: value.authenticated_agent,
            local_agent: value.local_agent,
            agent_generation: value.agent_generation,
            observed_at: value.observed_at,
        }
    }
}

/// One continuous broadcast subscription, registered synchronously before
/// connecting. Closing cancels an idle stream too; reconnect does not replace it.
#[flutter_rust_bridge::frb(opaque)]
pub struct ServerReceiptSubscription {
    receiver: Mutex<Option<broadcast::Receiver<ServerReplicaReceipt>>>,
    stop: watch::Sender<bool>,
    session: Arc<SyncSession>,
}

impl ServerReceiptSubscription {
    #[flutter_rust_bridge::frb(ignore)]
    pub(crate) fn new(db: &atomic_lib::Db, session: Arc<SyncSession>) -> Self {
        let (stop, _) = watch::channel(false);
        Self {
            receiver: Mutex::new(Some(db.subscribe_server_replica_receipts())),
            stop,
            session,
        }
    }

    pub async fn stream(&self, sink: StreamSink<ServerReplicaReceiptData>) {
        self.forward(|event| sink.add(event).is_ok()).await;
    }

    #[flutter_rust_bridge::frb(ignore)]
    async fn forward(&self, emit: impl Fn(ServerReplicaReceiptData) -> bool) {
        let Some(mut receiver) = self.receiver.lock().unwrap().take() else {
            return;
        };
        let mut stop = self.stop.subscribe();
        loop {
            if *stop.borrow() {
                break;
            }
            tokio::select! {
                _ = stop.changed() => break,
                event = receiver.recv() => match event {
                    Ok(event) if self.session.accepts_receipt(&event) => {
                        if !emit(event.into()) { break; }
                    }
                    Ok(_) | Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(broadcast::error::RecvError::Closed) => break,
                },
            }
        }
    }

    #[flutter_rust_bridge::frb(sync)]
    pub fn close(&self) {
        self.stop.send_replace(true);
        self.receiver.lock().unwrap().take();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::resources::AtomicStore;
    use atomic_lib::{agents::ForAgent, loro::AtomicLoroDoc, Storelike};
    use std::time::Duration;

    #[tokio::test]
    async fn closing_an_idle_receipt_subscription_releases_its_receiver() {
        let (sender, receiver) = broadcast::channel(8);
        let (stop, _) = watch::channel(false);
        let subscription = Arc::new(ServerReceiptSubscription {
            receiver: Mutex::new(Some(receiver)),
            stop,
            session: Arc::new(SyncSession::default()),
        });
        let task_subscription = subscription.clone();
        let task = tokio::spawn(async move {
            task_subscription
                .forward(|_| panic!("idle subscription emitted"))
                .await;
        });
        tokio::task::yield_now().await;
        subscription.close();
        tokio::time::timeout(Duration::from_secs(1), task)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(sender.receiver_count(), 0);
    }

    struct Server(std::process::Child);
    impl Drop for Server {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

    fn version(
        db: &atomic_lib::Db,
        subject: &str,
    ) -> atomic_lib::sync::protocol::StorageReceiptRequest {
        let snapshot = db.get_loro_snapshot(&subject.into()).unwrap();
        let doc = AtomicLoroDoc::from_snapshot(&snapshot).unwrap();
        let mut frontier = doc.doc().state_vv();
        frontier.retain(|_, counter| *counter > 0);
        atomic_lib::sync::protocol::StorageReceiptRequest {
            nonce: "a".repeat(64),
            drive: "atomic:test".into(),
            subject: subject.into(),
            version: atomic_lib::agents::encode_base64(&frontier.encode()),
        }
    }

    async fn edit(handle: &AtomicStore, subject: &str, name: &str) {
        handle
            .save_resource_changes(
                subject.to_string(),
                vec![crate::api::resources::PropValue {
                    property: atomic_lib::urls::NAME.into(),
                    value: crate::api::resources::AtomicValue {
                        datatype: crate::api::resources::Datatype::String,
                        text: name.into(),
                        items: vec![],
                        props: vec![],
                        unsupported_datatype: None,
                    },
                }],
                vec![],
            )
            .await
            .unwrap();
    }

    async fn evidence(
        handle: &AtomicStore,
        events: &mut tokio::sync::mpsc::UnboundedReceiver<ServerReplicaReceiptData>,
        target: &atomic_lib::sync::protocol::StorageReceiptRequest,
    ) -> ServerReplicaReceiptData {
        tokio::time::timeout(Duration::from_secs(45), async {
            loop {
                let event = events.recv().await.expect("continuous receipt stream");
                // Mirror Dart's post-FFI check: already-delivered historical
                // events in a consumer queue do not become current on reconnect.
                if !handle.is_server_replica_receipt_current(event.clone()) {
                    continue;
                }
                let observed = atomic_lib::sync::protocol::StorageReceiptRequest {
                    nonce: event.receipt.nonce.clone(),
                    drive: event.receipt.drive.clone(),
                    subject: event.receipt.subject.clone(),
                    version: event.receipt.version.clone(),
                };
                if observed.subject == target.subject {
                    let covers = matches!(
                        observed
                            .frontier()
                            .unwrap()
                            .partial_cmp(&target.frontier().unwrap()),
                        Some(std::cmp::Ordering::Equal | std::cmp::Ordering::Greater)
                    );
                    if covers {
                        return event;
                    }
                }
            }
        })
        .await
        .expect("automatic bridge receipt for stored target")
    }

    /// Explicit real-server acceptance run; no manual receipt requests.
    /// ATOMIC_TEST_SERVER=/absolute/path/atomic-server cargo test --manifest-path
    /// packages/atomic_store_flutter/rust/Cargo.toml bridge_receipts_real_server -- --ignored
    #[tokio::test]
    #[ignore = "requires ATOMIC_TEST_SERVER built from the same checkout"]
    async fn bridge_receipts_real_server() {
        use std::io::{Read, Write};
        let binary = std::env::var("ATOMIC_TEST_SERVER").expect("set ATOMIC_TEST_SERVER");
        let root = std::env::temp_dir().join(format!(
            "atomic-bridge-receipts-{}",
            atomic_lib::utils::random_string(10)
        ));
        std::fs::create_dir_all(&root).unwrap();
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let log = std::fs::File::create(root.join("server.log")).unwrap();
        let _server = Server(
            std::process::Command::new(binary)
                .args([
                    "--initialize",
                    "--ip",
                    "127.0.0.1",
                    "--port",
                    &port.to_string(),
                ])
                .arg("--data-dir")
                .arg(root.join("server-db"))
                .arg("--config-dir")
                .arg(root.join("server-config"))
                .stdout(log.try_clone().unwrap())
                .stderr(log)
                .spawn()
                .unwrap(),
        );
        let ready = tokio::time::timeout(Duration::from_secs(60), async {
            loop {
                if let Ok(mut stream) = std::net::TcpStream::connect(("127.0.0.1", port)) {
                    stream
                        .set_read_timeout(Some(Duration::from_millis(100)))
                        .unwrap();
                    let _ = stream.write_all(
                        format!("GET / HTTP/1.0\r\nHost: localhost:{port}\r\n\r\n").as_bytes(),
                    );
                    let mut response = [0; 64];
                    if let Ok(n) = stream.read(&mut response) {
                        if String::from_utf8_lossy(&response[..n]).contains("200") {
                            break;
                        }
                    }
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        })
        .await;
        assert!(
            ready.is_ok(),
            "server readiness; inspect {}",
            root.join("server.log").display()
        );
        let handle = AtomicStore::open(
            root.join("client").to_string_lossy().into(),
            None,
            None,
            None,
        )
        .await
        .unwrap();
        let setup = handle.setup("Bridge receipt owner".into()).await.unwrap();
        let drive = setup.drive;
        let subject = handle
            .db
            .create_resource(atomic_lib::urls::FOLDER, &drive, "C1", None)
            .await
            .unwrap();
        let target = version(&handle.db, &subject);
        // Bootstrap through actual ordinary replication, then exercise the
        // bridge's own connect/live/outbox/reconnect requester lifecycle.
        let agent = handle.db.get_default_agent().unwrap();
        atomic_lib::sync::replicate::replicate_drive_to_remote(
            &handle.db,
            &drive,
            &format!("ws://localhost:{port}/ws"),
            &ForAgent::AgentSubject(agent.subject.clone()),
            atomic_lib::sync::replicate::ReplicateAuth::Agent(Box::new(agent.clone())),
        )
        .await
        .unwrap();
        let subscription = Arc::new(handle.subscribe_server_replica_receipts());
        let (events, mut received) = tokio::sync::mpsc::unbounded_channel();
        let forwarding = subscription.clone();
        let task = tokio::spawn(async move {
            forwarding.forward(|event| events.send(event).is_ok()).await;
        });
        let origin = format!("http://localhost:{port}");
        handle.open_ws_sync(origin.clone()).await.unwrap();
        let first = evidence(&handle, &mut received, &target).await;
        assert!(first.source.is_some());
        assert_eq!(first.server_origin, origin);
        assert!(handle.is_server_replica_receipt_current(first.clone()));
        edit(&handle, &subject, "C2 live").await;
        let live = evidence(&handle, &mut received, &version(&handle.db, &subject)).await;
        assert_eq!(live.connection_id, first.connection_id);
        let other = AtomicStore::open(
            root.join("client").to_string_lossy().into(),
            Some(agent.build_secret().unwrap()),
            Some(drive),
            None,
        )
        .await
        .unwrap();
        assert!(
            !other.is_server_replica_receipt_current(first.clone()),
            "same-file handle does not own this connection"
        );
        handle.close_ws_sync().await;
        assert!(!handle.is_server_replica_receipt_current(first.clone()));
        edit(&handle, &subject, "C3 offline").await;
        let target = version(&handle.db, &subject);
        handle.open_ws_sync(origin.clone()).await.unwrap();
        let second = evidence(&handle, &mut received, &target).await;
        assert_ne!(first.connection_id, second.connection_id);
        assert_eq!(
            first.receipt.replica.storage_id,
            second.receipt.replica.storage_id
        );
        handle.close_ws_sync().await;
        handle.open_ws_sync(origin).await.unwrap();
        let third = evidence(&handle, &mut received, &target).await;
        assert_ne!(second.connection_id, third.connection_id);
        handle.db.clear_default_agent();
        handle.db.set_default_agent(agent);
        assert!(!handle.is_server_replica_receipt_current(third));
        subscription.close();
        tokio::time::timeout(Duration::from_secs(1), task)
            .await
            .unwrap()
            .unwrap();
        handle.close_ws_sync().await;
    }
}
