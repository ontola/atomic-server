//! Native automatic receipt collection against the production WS server.
//! No test sends a STORAGE_RECEIPT_REQUEST itself.
use atomic_lib::{
    agents::{Agent, ForAgent},
    client::{
        ws::WsClient,
        ws_receipts::{ServerReplicaReceipt, WsReceiptSession},
    },
    loro::AtomicLoroDoc,
    sync::{
        outbox::Outbox,
        protocol::StorageReceiptRequest,
        replicate::{replicate_drive_to_remote, ReplicateAuth},
    },
    Db, Storelike,
};
use std::{sync::Arc, time::Duration};

fn version(db: &Db, subject: &str) -> String {
    let snapshot = db.get_loro_snapshot(&subject.into()).unwrap();
    let doc = AtomicLoroDoc::from_snapshot(&snapshot).unwrap();
    let mut frontier = doc.doc().state_vv();
    frontier.retain(|_, counter| *counter > 0);
    atomic_lib::agents::encode_base64(&frontier.encode())
}

async fn receipt(
    rx: &mut tokio::sync::broadcast::Receiver<ServerReplicaReceipt>,
    drive: &str,
    subject: &str,
    target: &str,
) -> ServerReplicaReceipt {
    let request = StorageReceiptRequest {
        nonce: "a".repeat(64),
        drive: drive.into(),
        subject: subject.into(),
        version: target.into(),
    };
    assert!(request.frontier().is_some(), "expected a nonempty target");
    eprintln!("Awaiting automatic receipt for {subject} at {target}");
    tokio::time::timeout(Duration::from_secs(20), async {
        loop {
            let evidence = rx.recv().await.unwrap();
            eprintln!(
                "Observed {} at {} on {}",
                evidence.receipt.subject, evidence.receipt.version, evidence.connection_id
            );
            let observed = StorageReceiptRequest {
                nonce: evidence.receipt.nonce.clone(),
                drive: evidence.receipt.drive.clone(),
                subject: evidence.receipt.subject.clone(),
                version: evidence.receipt.version.clone(),
            };
            // Independent Loro VV captures can encode peers in different order.
            // Compare every counter, not coverage by a later version.
            if observed.drive == drive
                && observed.subject == subject
                && observed.frontier() == request.frontier()
            {
                assert!(evidence.receipt.validate());
                return evidence;
            }
        }
    })
    .await
    .expect("automatic receipt for exact stored frontier")
}

async fn source(memory: bool, name: &str) -> (Arc<Db>, Agent, String, String) {
    let db = if memory {
        Db::init_redb(None).await.unwrap()
    } else {
        Db::init_temp(name).await.unwrap()
    };
    let (agent, drive) = db.setup("Native receipt owner").await.unwrap();
    let subject = db
        .create_resource("https://atomicdata.dev/classes/Folder", &drive, "C1", None)
        .await
        .unwrap();
    (Arc::new(db), agent, drive, subject)
}

async fn replicate(db: &Db, agent: &Agent, drive: &str, url: &str) {
    let outcome = replicate_drive_to_remote(
        db,
        drive,
        url,
        &ForAgent::AgentSubject(agent.subject.clone()),
        ReplicateAuth::Agent(Box::new(agent.clone())),
    )
    .await
    .unwrap();
    assert!(outcome.in_sync, "ordinary replication still completes");
}

async fn connect(
    db: &Arc<Db>,
    agent: &Agent,
    drive: &str,
    url: &str,
) -> (Arc<WsClient>, Arc<WsReceiptSession>) {
    let client = Arc::new(WsClient::connect(url).await.unwrap());
    client.authenticate(agent).await.unwrap();
    let session = WsReceiptSession::start(client.clone(), db.clone());
    session.follow_drive(drive);
    (client, session)
}

async fn edit(db: &Db, subject: &str, name: &str) -> String {
    let mut resource = db.get_resource(&subject.into()).await.unwrap();
    resource
        .set_unsafe(
            atomic_lib::urls::NAME.into(),
            atomic_lib::Value::String(name.into()),
        )
        .unwrap();
    let saved = resource.save_locally(db).await.unwrap();
    Outbox::new(db.clone()).mark_dirty(&saved).await.unwrap();
    version(db, subject)
}

#[tokio::test]
async fn native_replication_automatically_receipts_bulk_and_already_matching_state() {
    let port = crate::common::start_server("native_receipt_bulk");
    crate::common::wait_for_server(port).await;
    let url = format!("ws://localhost:{port}/ws");
    let (db, agent, drive, subject) = source(false, "native_receipt_source_bulk").await;
    let target = version(&db, &subject);
    let mut events = db.subscribe_server_replica_receipts();
    replicate(&db, &agent, &drive, &url).await;
    let first = receipt(&mut events, &drive, &subject, &target).await;
    assert!(first.source.is_some());
    assert_eq!(first.authenticated_agent, agent.subject);
    assert_eq!(first.local_agent, agent.subject);
    assert_eq!(first.server_origin, format!("http://localhost:{port}"));
    let mut reconnected = db.subscribe_server_replica_receipts();
    replicate(&db, &agent, &drive, &url).await;
    let second = receipt(&mut reconnected, &drive, &subject, &target).await;
    assert_ne!(first.connection_id, second.connection_id);
    assert_eq!(first.receipt.replica, second.receipt.replica);
    assert_eq!(first.source, second.source);
}

#[tokio::test]
async fn native_live_outbox_and_reconnect_produce_receipts_without_manual_probes() {
    let port = crate::common::start_server("native_receipt_live");
    crate::common::wait_for_server(port).await;
    let url = format!("ws://localhost:{port}/ws");
    let (db, agent, drive, subject) = source(false, "native_receipt_source_live").await;
    replicate(&db, &agent, &drive, &url).await;
    let mut events = db.subscribe_server_replica_receipts();
    let (client, session) = connect(&db, &agent, &drive, &url).await;
    let first = receipt(&mut events, &drive, &subject, &version(&db, &subject)).await;
    let outbox = Outbox::new(db.as_ref().clone());
    for name in ["C2", "C3"] {
        let target = edit(&db, &subject, name).await;
        let report = outbox.drain(&mut client.clone()).await.unwrap();
        assert!(
            report.sent > 0,
            "the edited state must actually be delivered"
        );
        assert_eq!(report.remaining, 0);
        let next = receipt(&mut events, &drive, &subject, &target).await;
        assert_eq!(next.connection_id, first.connection_id);
        assert_eq!(next.receipt.replica, first.receipt.replica);
    }
    session.close();
    assert!(!session.is_current());
    let offline = edit(&db, &subject, "C4 offline").await;
    let (reconnected, next_session) = connect(&db, &agent, &drive, &url).await;
    assert_eq!(
        outbox
            .drain(&mut reconnected.clone())
            .await
            .unwrap()
            .remaining,
        0
    );
    let fourth = receipt(&mut events, &drive, &subject, &offline).await;
    assert_ne!(fourth.connection_id, first.connection_id);
    next_session.close();
    // No further save: an initial inventory must still obtain new evidence.
    let (_client, final_session) = connect(&db, &agent, &drive, &url).await;
    let again = receipt(&mut events, &drive, &subject, &offline).await;
    assert_ne!(again.connection_id, fourth.connection_id);
    assert_eq!(again.receipt.replica, fourth.receipt.replica);
    final_session.close();
}

#[tokio::test]
async fn native_memory_source_receives_remote_evidence_without_fabricated_identity() {
    let port = crate::common::start_server("native_receipt_memory");
    crate::common::wait_for_server(port).await;
    let url = format!("ws://localhost:{port}/ws");
    let (db, agent, drive, subject) = source(true, "unused").await;
    let mut events = db.subscribe_server_replica_receipts();
    replicate(&db, &agent, &drive, &url).await;
    let observed = receipt(&mut events, &drive, &subject, &version(&db, &subject)).await;
    assert!(observed.source.is_none());
    assert_eq!(observed.receipt.barrier, "atomic-redb-flush-v1");
}

#[tokio::test]
async fn native_delegated_replication_preserves_both_agent_identities() {
    let port = crate::common::start_server("native_receipt_delegated");
    crate::common::wait_for_server(port).await;
    let origin = format!("http://localhost:{port}");
    let url = format!("ws://localhost:{port}/ws");
    let (db, owner, drive, subject) = source(false, "native_receipt_source_delegated").await;
    let host = Agent::new(Some("Local host agent")).unwrap();
    db.set_default_agent(host.clone());
    let target = version(&db, &subject);
    let mut events = db.subscribe_server_replica_receipts();
    let frame = atomic_lib::sync::protocol::encode_auth(&owner, &origin).unwrap();
    let outcome = replicate_drive_to_remote(
        &db,
        &drive,
        &url,
        &ForAgent::AgentSubject(owner.subject.clone()),
        ReplicateAuth::PreSigned(frame),
    )
    .await
    .unwrap();
    assert!(outcome.in_sync);
    let observed = receipt(&mut events, &drive, &subject, &target).await;
    assert_eq!(observed.authenticated_agent, owner.subject);
    assert_eq!(observed.local_agent, host.subject);
    assert_ne!(observed.authenticated_agent, observed.local_agent);
}
