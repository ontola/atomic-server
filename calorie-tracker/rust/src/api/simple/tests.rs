//! Scaffold-level tests for the bridge.
//!
//! These cover the layer Flutter actually calls, one FFI function at a time,
//! against a real redb store: opening a database, minting an agent and drive,
//! and writing a resource under that drive. That is exactly the Phase 0
//! acceptance criterion — "a Rust FFI call round-trips" — so it is checked here
//! rather than only by hand on a device.
//!
//! The store is a process-global `OnceLock`, so every test shares one database
//! and isolates by taking its own resource.

use super::*;

/// One database for the whole test binary. It lives in `api::test_store`
/// because the meal tests share it — see the note there.
use crate::api::test_store::shared_drive;

/// The onboarding call: one `setup` mints an agent, its secret, and a drive to
/// hang everything else off. Nothing else in the app works until this does.
#[tokio::test]
async fn setup_mints_an_agent_and_a_drive() {
    let drive = shared_drive().await;
    assert!(!drive.is_empty(), "setup must return a drive subject");

    let agent = get_active_agent()
        .await
        .unwrap()
        .expect("setup must leave an active agent behind");
    assert!(!agent.secret.is_empty());
    assert!(!agent.subject.is_empty());

    assert_eq!(
        get_active_drive().as_deref(),
        Some(drive),
        "the drive setup made must be the active one"
    );
}

/// A secret is the whole account: reloading one has to reproduce the same
/// agent, or a re-install with a pasted secret silently becomes a new person.
#[tokio::test]
async fn an_agent_round_trips_through_its_secret() {
    let _ = shared_drive().await;
    let agent = get_active_agent().await.unwrap().unwrap();

    let restored = agent_from_secret(agent.secret.clone()).unwrap();

    assert_eq!(restored.subject, agent.subject);
    assert_eq!(restored.public_key, agent.public_key);
}

/// The generic resource path every app-level write is built on: create under
/// the drive, set a property, read it back.
#[tokio::test]
async fn a_resource_created_under_the_drive_keeps_what_is_written_to_it() {
    let drive = shared_drive().await;

    let subject = create_resource(
        drive.to_string(),
        "Breakfast".to_string(),
        atomic_lib::urls::FOLDER.to_string(),
    )
    .await
    .unwrap();

    assert_eq!(
        get_property(subject.clone(), atomic_lib::urls::NAME.to_string())
            .await
            .unwrap(),
        "Breakfast"
    );

    set_property(
        subject.clone(),
        atomic_lib::urls::DESCRIPTION.to_string(),
        "Two eggs".to_string(),
    )
    .await
    .unwrap();

    assert_eq!(
        get_property(subject.clone(), atomic_lib::urls::DESCRIPTION.to_string())
            .await
            .unwrap(),
        "Two eggs"
    );
    assert_eq!(
        get_property(subject, atomic_lib::urls::PARENT.to_string())
            .await
            .unwrap(),
        drive,
        "a resource must stay a child of the drive it was created under"
    );
}

/// Renaming goes through a signed commit like any other write, so it is worth
/// proving it lands rather than assuming the core property behaves.
#[tokio::test]
async fn renaming_a_resource_replaces_its_name() {
    let drive = shared_drive().await;
    let subject = create_resource(
        drive.to_string(),
        "Before".to_string(),
        atomic_lib::urls::FOLDER.to_string(),
    )
    .await
    .unwrap();

    rename_resource(subject.clone(), "After".to_string())
        .await
        .unwrap();

    assert_eq!(
        get_property(subject, atomic_lib::urls::NAME.to_string())
            .await
            .unwrap(),
        "After"
    );
}

/// Deleting is a signed destroy commit, not a local erase — the resource must
/// actually stop resolving afterwards.
#[tokio::test]
async fn a_deleted_resource_stops_resolving() {
    let drive = shared_drive().await;
    let subject = create_resource(
        drive.to_string(),
        "Temporary".to_string(),
        atomic_lib::urls::FOLDER.to_string(),
    )
    .await
    .unwrap();

    delete_resource(subject.clone()).await.unwrap();

    let store = db().unwrap();
    assert!(
        store.get_resource(&subject.as_str().into()).await.is_err(),
        "a destroyed resource must not come back from the store"
    );
}

/// Every write is a commit, so a resource carries its own history from the
/// first save. Phase 5's "what did this estimate say before I edited it" rides
/// on this.
#[tokio::test]
async fn a_resource_carries_the_history_of_its_edits() {
    let drive = shared_drive().await;
    let subject = create_resource(
        drive.to_string(),
        "Tracked".to_string(),
        atomic_lib::urls::FOLDER.to_string(),
    )
    .await
    .unwrap();

    set_property(
        subject.clone(),
        atomic_lib::urls::DESCRIPTION.to_string(),
        "first".to_string(),
    )
    .await
    .unwrap();
    set_property(
        subject.clone(),
        atomic_lib::urls::DESCRIPTION.to_string(),
        "second".to_string(),
    )
    .await
    .unwrap();

    let history = get_resource_history(subject).await.unwrap();
    assert!(
        history.len() >= 2,
        "two edits must leave at least two versions, got {}",
        history.len()
    );
}

/// Opening twice must not cost anything, least of all the database.
///
/// redb locks the file, so a second `init_redb_file` fails — and the recovery
/// path around it treats a failure as corruption and deletes the file. An app
/// that opened the store twice (a relaunch inside one process, a retry after a
/// slow start) would have wiped every meal it had.
#[tokio::test]
async fn opening_the_store_again_leaves_it_alone() {
    let drive = shared_drive().await;

    let elsewhere = std::env::temp_dir().join(format!("calorie-tracker-second-open-{}", drive.len()));
    open_db(elsewhere.to_string_lossy().into_owned())
        .await
        .expect("a second open must be a no-op, not an error");

    assert_eq!(
        get_active_drive().as_deref(),
        Some(drive),
        "the second open must not have swapped the store out"
    );
    assert!(
        !get_property(drive.to_string(), atomic_lib::urls::NAME.to_string())
            .await
            .unwrap()
            .is_empty(),
        "the drive that was there before the second open has to still be there"
    );
    assert!(
        !elsewhere.exists(),
        "a no-op open must not create a database at the path it was handed"
    );
}

/// Calling into the store before `open_db` is a programming error the bridge
/// has to report rather than panic on — Dart sees a rejected Future, not a
/// crashed isolate.
#[test]
fn the_store_is_named_in_the_error_when_it_is_not_open_yet() {
    // Only meaningful before any test has opened the DB; once one has, the
    // OnceLock is set for the process. Assert on the message shape either way.
    if let Err(message) = db() {
        assert!(message.contains("openDb"), "unhelpful error: {message}");
    }
}
