//! Import acknowledgement must survive abrupt process death, without Drop/flush.
#![cfg(feature = "db-redb")]
use atomic_lib::{urls, Db, Resource, Storelike, Value};
use std::path::Path;
const CHILD: &str = "ATOMIC_IMPORT_CRASH_DIR";
const SYNC_CHILD: &str = "ATOMIC_SYNC_CRASH_DIR";
async fn open(path: &Path) -> Db {
    Db::init_redb_file(path, None, &path.join("uploads"))
        .await
        .unwrap()
}
#[test]
#[ignore = "subprocess entry; invoked by parent"]
fn child_import_then_abort() {
    let Ok(path) = std::env::var(CHILD) else {
        return;
    };
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(async {
        let store = open(Path::new(&path)).await;
        let (agent, drive) = store.setup("Import crash test").await.unwrap();
        std::fs::write(
            Path::new(&path).join("test-agent"),
            agent.build_secret().unwrap(),
        )
        .unwrap();
        store.flush().unwrap(); // Setup completed before this import began.
        let mut resource = Resource::new("https://localhost/import-support".into());
        resource
            .set_unsafe(urls::PARENT.into(), Value::AtomicUrl(drive.clone().into()))
            .unwrap();
        resource
            .set_unsafe(
                urls::LOCAL_ID.into(),
                Value::String("provider:project:1".into()),
            )
            .unwrap();
        resource
            .set_unsafe(urls::NAME.into(), Value::String("Imported project".into()))
            .unwrap();
        resource.save_as_genesis(&store).await.unwrap();
        assert!(
            atomic_lib::import_identity::find_existing(
                &store,
                &drive.clone().into(),
                "provider:project:1"
            )
            .await
            .unwrap()
            .is_some(),
            "identity must be indexed before kill"
        );
        std::fs::write(
            Path::new(&path).join("ack.json"),
            serde_json::to_vec(&(drive, resource.get_subject().to_string())).unwrap(),
        )
        .unwrap();
        std::mem::forget(store); // Never let redb's destructor make this test pass.
    });
    std::process::abort();
}
#[tokio::test]
async fn acknowledged_import_survives_process_kill_and_retry_reuses_identity() {
    let temp = std::env::temp_dir().join(format!(
        "atomic-import-crash-{}",
        atomic_lib::utils::random_string(12)
    ));
    std::fs::create_dir_all(&temp).unwrap();
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "child_import_then_abort",
            "--exact",
            "--ignored",
            "--test-threads=1",
        ])
        .env(CHILD, &temp)
        .output()
        .unwrap();
    assert!(!output.status.success(), "child must terminate abnormally");
    let ack = std::fs::read(temp.join("ack.json")).unwrap_or_else(|e| {
        panic!(
            "child did not reach acknowledgement: {e}; {}",
            String::from_utf8_lossy(&output.stdout)
        )
    });
    let (drive, subject): (String, String) = serde_json::from_slice(&ack).unwrap();
    let store = open(&temp).await;
    let found = atomic_lib::import_identity::find_existing(
        &store,
        &drive.clone().into(),
        "provider:project:1",
    )
    .await
    .unwrap();
    assert_eq!(
        found.as_deref(),
        Some(subject.as_str()),
        "acknowledged record/identity rolled back on process death"
    );

    store.set_default_agent(
        atomic_lib::agents::Agent::from_secret(
            &std::fs::read_to_string(temp.join("test-agent")).unwrap(),
        )
        .unwrap(),
    );
    let mut child = Resource::new("https://localhost/import-entry".into());
    child
        .set_unsafe(
            urls::PARENT.into(),
            Value::AtomicUrl(subject.clone().into()),
        )
        .unwrap();
    child
        .set_unsafe(
            urls::LOCAL_ID.into(),
            Value::String("provider:entry:1".into()),
        )
        .unwrap();
    child
        .set_unsafe(
            urls::DESCRIPTION.into(),
            Value::String("Resumed entry".into()),
        )
        .unwrap();
    child
        .set_unsafe(urls::IS_A.into(), Value::ResourceArray(vec![]))
        .unwrap();
    child.save_as_genesis(&store).await.unwrap();
    assert_eq!(
        store
            .get_resource(&subject.into())
            .await
            .unwrap()
            .get(urls::NAME)
            .unwrap()
            .to_string(),
        "Imported project"
    );
    drop(store);
    std::fs::remove_dir_all(temp).unwrap();
}

#[test]
#[ignore = "subprocess entry; invoked by parent"]
fn child_sync_last_then_abort() {
    let Ok(path) = std::env::var(SYNC_CHILD) else {
        return;
    };
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(async {
        use atomic_lib::{
            agents::ForAgent,
            db::trees::Tree,
            sync::{engine, protocol},
        };
        let root = Path::new(&path);
        let source = open(&root.join("source")).await;
        let (agent, drive) = source.setup("Sync crash source").await.unwrap();
        let mut resource = Resource::new("atomic:sync-crash-row".into());
        resource
            .set_unsafe(urls::PARENT.into(), Value::AtomicUrl(drive.clone().into()))
            .unwrap();
        resource
            .set_unsafe(urls::LOCAL_ID.into(), Value::String("sync-crash:1".into()))
            .unwrap();
        resource
            .set_unsafe(
                urls::NAME.into(),
                Value::String("Durable synced row".into()),
            )
            .unwrap();
        resource.save_as_genesis(&source).await.unwrap();
        let subject = resource.get_subject().to_string();
        let envelope = atomic_lib::envelopes::latest_envelope(&source, &subject).unwrap();
        let snapshots: Vec<_> = [&drive, &subject]
            .iter()
            .map(|id| {
                source
                    .kv
                    .get(Tree::LoroSnapshots, id.as_bytes())
                    .unwrap()
                    .unwrap()
            })
            .collect();
        let sink = open(&root.join("sink")).await;
        sink.add_resource(&agent.to_resource().unwrap())
            .await
            .unwrap();
        sink.flush().unwrap(); // Startup is complete before either sync chunk.
        let entries = [
            (drive.as_str(), snapshots[0].as_slice()),
            (subject.as_str(), snapshots[1].as_slice()),
        ];
        let frame = protocol::encode_sync_push_with_envelopes(
            &drive,
            &entries,
            &[(subject.as_str(), envelope.json.as_str())],
            false,
        );
        let push = protocol::decode_sync_push(&frame[1..]).unwrap();
        assert_eq!(
            engine::import_sync_push(&push, &sink, &ForAgent::from(agent.clone()), false)
                .await
                .unwrap()
                .0,
            2
        );
        // An empty LAST must flush earlier chunks as well as envelope history.
        let frame = protocol::encode_sync_push(&drive, &[], true);
        let push = protocol::decode_sync_push(&frame[1..]).unwrap();
        engine::import_sync_push(&push, &sink, &ForAgent::from(agent), false)
            .await
            .unwrap();
        std::fs::write(
            root.join("sync-ack.json"),
            serde_json::to_vec(&(drive, subject, envelope.signature)).unwrap(),
        )
        .unwrap();
        std::mem::forget(sink); // Never let redb's destructor supply durability.
        std::mem::forget(source);
    });
    std::process::abort();
}

#[tokio::test]
async fn sync_last_survives_process_kill_with_indexes_snapshot_and_envelope() {
    use atomic_lib::{db::trees::Tree, storelike::Query};
    let temp = std::env::temp_dir().join(format!(
        "atomic-sync-crash-{}",
        atomic_lib::utils::random_string(12)
    ));
    std::fs::create_dir_all(&temp).unwrap();
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "child_sync_last_then_abort",
            "--exact",
            "--ignored",
            "--test-threads=1",
        ])
        .env(SYNC_CHILD, &temp)
        .output()
        .unwrap();
    assert!(!output.status.success(), "child must terminate abnormally");
    let ack = std::fs::read(temp.join("sync-ack.json")).unwrap_or_else(|e| {
        panic!(
            "child did not reach LAST: {e}; {} {}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        )
    });
    let (drive, subject, signature): (String, String, String) =
        serde_json::from_slice(&ack).unwrap();
    let store = open(&temp.join("sink")).await;
    let row = store.get_resource(&subject.as_str().into()).await.unwrap();
    assert_eq!(
        row.get(urls::NAME).unwrap().to_string(),
        "Durable synced row"
    );
    assert_eq!(
        atomic_lib::import_identity::find_existing(&store, &drive.clone().into(), "sync-crash:1")
            .await
            .unwrap()
            .as_deref(),
        Some(subject.as_str())
    );
    let mut query = Query::new().filter(urls::PARENT, Value::AtomicUrl(drive.clone().into()));
    query.drive = Some(drive.into());
    assert!(store
        .query(&query)
        .await
        .unwrap()
        .subjects
        .iter()
        .any(|s| s.pure_id() == subject));
    assert!(store
        .kv
        .get(Tree::LoroSnapshots, subject.as_bytes())
        .unwrap()
        .is_some());
    assert!(atomic_lib::envelopes::envelopes(&store, &subject)
        .iter()
        .any(|e| e.signature == signature));
    drop(store);
    std::fs::remove_dir_all(temp).unwrap();
}
