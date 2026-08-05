//! Does what the user just wrote survive the app being killed?
//!
//! Per-commit redb writes use `Durability::None` — no fsync — so redb rolls
//! every commit since the last *durable* one back when the file is opened
//! again. The server pays for that with a periodic flush thread (`serve.rs`);
//! a phone app has no such tick, so a meal logged at 19:00 and an app the OS
//! reaps at 19:05 is a meal that was never written. That is the calorie
//! tracker's "it forgets everything I log" bug, one layer down.
//!
//! Like `identity_durability.rs`, this cannot be tested in one process: a
//! graceful shutdown flushes, so the data would survive for the wrong reason.
//! So the write happens in a real child process that `abort()`s.
//!
//! Run: cargo test -p atomic_lib --features db-redb --test write_durability
#![cfg(feature = "db-redb")]

use std::path::{Path, PathBuf};

use atomic_lib::{storelike::Query, urls, Storelike, Value};

const CHILD_DIR_ENV: &str = "ATOMIC_WRITE_DURABILITY_CHILD_DIR";

async fn open_store(dir: &Path) -> atomic_lib::Db {
    atomic_lib::Db::init_redb_file(dir, None, &dir.join("uploads"))
        .await
        .expect("open store")
}

fn scratch_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "atomic-write-durability-{}-{}",
        name,
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn child_dir() -> Option<PathBuf> {
    std::env::var(CHILD_DIR_ENV).ok().map(PathBuf::from)
}

/// Run one of the `#[ignore]`d child entry points in a real subprocess and wait
/// for it to die. Its exit status is not asserted on beyond "it did not exit
/// cleanly" — what it left on disk is the whole point.
fn run_child(test_name: &str, dir: &Path) {
    let exe = std::env::current_exe().expect("test binary path");
    let output = std::process::Command::new(exe)
        .args([test_name, "--exact", "--ignored", "--test-threads=1"])
        .env(CHILD_DIR_ENV, dir)
        .output()
        .expect("spawn child");

    assert!(
        !output.status.success(),
        "child was supposed to die uncleanly, but exited normally — the test \
         is no longer simulating a kill"
    );
}

const CONSUMED_AT_MS: i64 = 1_700_000_000_000;

#[test]
#[ignore = "child process entry point, driven by the parent test"]
fn child_logs_a_meal_then_dies() {
    let Some(dir) = child_dir() else { return };

    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(async {
        let store = open_store(&dir).await;
        // What every app that can be killed has to ask for. Without it this
        // whole test is what the calorie tracker did: log a meal, get reaped,
        // relaunch to an empty day.
        store.set_durable_writes(true);

        let (agent, drive) = store.setup("Phone").await.expect("setup");
        let secret = agent.build_secret().unwrap();

        // Exactly what the calorie tracker's boot and shutter do: a container
        // under the drive, and a meal under the container.
        let container = store
            .create_resource(urls::FOLDER, &drive, "Meals", None)
            .await
            .expect("create container");
        let meal = store
            .create_resource(
                urls::MEAL,
                &container,
                "Cappuccino",
                Some(vec![
                    (urls::CONSUMED_AT, Value::Timestamp(CONSUMED_AT_MS)),
                    (
                        urls::MEAL_STATUS,
                        Value::AtomicUrl(format!("{}/confirmed", urls::MEAL_STATUS).into()),
                    ),
                    (urls::CALORIES, Value::Integer(120)),
                ]),
            )
            .await
            .expect("create meal");

        std::fs::write(
            dir.join("written.txt"),
            format!("{secret}\n{drive}\n{container}\n{meal}"),
        )
        .unwrap();

        // Leak the store on purpose: dropping it closes redb's `Database`
        // cleanly, which makes every pending `Durability::None` commit durable
        // — precisely what a killed process never gets to do.
        std::mem::forget(store);
    });

    std::process::abort();
}

/// The whole promise of a local-first app: what you logged is on the device.
/// Not "once something else happens to fsync", and not "if you close the app
/// politely" — the OS reaping a backgrounded app is the normal way it ends.
#[tokio::test]
async fn a_meal_logged_before_a_kill_is_still_there_afterwards() {
    let dir = scratch_dir("meal");

    run_child("child_logs_a_meal_then_dies", &dir);

    let written = std::fs::read_to_string(dir.join("written.txt"))
        .expect("child should have recorded what it wrote before dying");
    let mut lines = written.lines();
    let secret = lines.next().unwrap();
    let drive = lines.next().unwrap();
    let container = lines.next().unwrap();
    let meal = lines.next().unwrap();

    let store = open_store(&dir).await;
    store
        .load_agent_from_secret(secret)
        .await
        .expect("the agent's own secret is in the keychain, not in redb");

    // 1. The meal resource itself.
    let resource = store
        .get_resource(&meal.into())
        .await
        .expect("the meal must survive the kill that follows logging it");
    assert_eq!(resource.get(urls::CALORIES).unwrap().to_string(), "120");

    // 2. The query the day list actually runs. A resource that survived but
    //    dropped out of the index is a meal the app still cannot show.
    let listed = store
        .query(&Query::new_prop_val(urls::PARENT, container))
        .await
        .unwrap();
    assert!(
        listed.subjects.iter().any(|s| s.to_string() == meal),
        "the meal must still be listed under its container, got {:?}",
        listed.subjects
    );

    // 3. And the lookup the next launch does first: find the meals container
    //    under the drive. Lose this and the app mints a second container, and
    //    every meal in the first one stops existing as far as it is concerned.
    let containers = store
        .query(&Query::new_prop_val(urls::PARENT, drive))
        .await
        .unwrap();
    assert!(
        containers.subjects.iter().any(|s| s.to_string() == container),
        "the meals container must still hang off the drive, got {:?}",
        containers.subjects
    );
}
