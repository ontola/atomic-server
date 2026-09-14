//! Exercise the shared HTTP/WS acknowledgement boundary without the periodic
//! flush thread: a successful commit must be durable even between flush ticks.
use atomic_lib::{Db, Storelike};
use std::{
    path::Path,
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};

const CHILD_DIR: &str = "ATOMIC_COMMIT_DURABILITY_DIR";
const UPDATED_NAME: &str = "Acknowledged edit survives a crash";

struct ChildGuard(Child);

impl Drop for ChildGuard {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

async fn open(dir: &Path) -> Db {
    Db::init_redb_file(dir, None, &dir.join("uploads"))
        .await
        .unwrap()
}

#[tokio::test]
#[ignore = "subprocess entry point"]
async fn child_acknowledges_then_exits_uncleanly() {
    let dir = std::path::PathBuf::from(std::env::var(CHILD_DIR).unwrap());
    let store = open(&dir).await;
    store.set_base_url("http://localhost");
    let (agent, drive) = store.setup("Durability test").await.unwrap();
    // The drive is an existing editable resource with a persisted causal history.
    store.flush().unwrap();
    let mut resource = store.get_resource(&drive.clone().into()).await.unwrap();
    resource.set_name(UPDATED_NAME).unwrap();
    let snapshot = resource.build_state_doc().unwrap().export_snapshot();
    let mut builder = resource.get_commit_builder().clone();
    builder.set_loro_update(snapshot);
    let commit = builder.sign(&agent, &store, &resource).await.unwrap();
    let json = atomic_lib::client::commit_to_wire_json(&commit, &store)
        .await
        .unwrap();
    let response = super::apply_commit_json(&store, "http://localhost", &json, None)
        .await
        .unwrap();
    assert!(!response.is_empty());
    // An independent ledger is written only after the acknowledgement boundary.
    std::fs::write(dir.join("acknowledged-subject"), &drive).unwrap();
    // No Db::drop, runtime cleanup or periodic flush may rescue this write.
    std::mem::forget(store);
    std::process::exit(73);
}

#[tokio::test]
async fn acknowledged_commit_survives_unclean_exit() {
    let dir = tempfile::tempdir().unwrap();
    let log_path = dir.path().join("child.log");
    let log = std::fs::File::create(&log_path).unwrap();
    let mut child = ChildGuard(
        Command::new(std::env::current_exe().unwrap())
            .args([
                "handlers::commit::durability_tests::child_acknowledges_then_exits_uncleanly",
                "--exact",
                "--ignored",
                "--nocapture",
            ])
            .env(CHILD_DIR, dir.path())
            .stdout(Stdio::from(log.try_clone().unwrap()))
            .stderr(Stdio::from(log))
            .spawn()
            .unwrap(),
    );
    let deadline = Instant::now() + Duration::from_secs(30);
    let status = loop {
        if let Some(status) = child.0.try_wait().unwrap() {
            break status;
        }
        assert!(
            Instant::now() < deadline,
            "child timed out: {}",
            std::fs::read_to_string(&log_path).unwrap()
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    };
    assert_eq!(
        status.code(),
        Some(73),
        "child failed before acknowledgement: {}",
        std::fs::read_to_string(&log_path).unwrap()
    );
    let subject = std::fs::read_to_string(dir.path().join("acknowledged-subject")).unwrap();
    let store = open(dir.path()).await;
    let resource = store.get_resource(&subject.into()).await.unwrap();
    assert_eq!(
        resource.get(atomic_lib::urls::NAME).unwrap().to_string(),
        UPDATED_NAME
    );
}
