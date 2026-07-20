//! A local edit must not lose a peer's update when the two land at once.
//!
//! Persisting either one is a read-modify-write of the same stored Loro
//! snapshot, ending in a *replace*. Before `subject_lock` existed they raced
//! and the second writer won wholesale: at 40 rounds a side, typically only
//! 53-56 of 80 operations survived. That is almost certainly what was behind
//! strokes vanishing on a device drawing while a peer synced.
//!
//! Specifically, `Db::apply_commit` reads the resource in
//! `validate_and_build_response`, builds new state from that read, and writes
//! it back in its transaction — with nothing re-reading in between. Anything
//! `sync::ws_apply::persist_update` landed in that window was overwritten.
//!
//! Both paths now hold a per-subject lock across the whole read-modify-write.
//! The sequential control below is the thing that makes the concurrent test
//! meaningful: it runs the identical operations without concurrency, so if it
//! ever fails the problem is the operations, not the race.

#![cfg(all(feature = "db-redb", feature = "iroh"))]

use atomic_lib::Storelike;

const CANVAS: &str = "https://atomicdata.dev/ontology/canvas/Canvas";
const STROKE_DATA: &str = "https://atomicdata.dev/ontology/canvas/strokeData";
const ROUNDS: usize = 40;

async fn new_canvas(store: &atomic_lib::Db, name: &str) -> String {
    let (_agent, drive) = store.setup("Alice").await.unwrap();

    store
        .create_resource(
            CANVAS,
            &drive,
            name,
            Some(vec![(
                STROKE_DATA,
                atomic_lib::Value::Json(serde_json::Value::Array(vec![])),
            )]),
        )
        .await
        .unwrap()
}

async fn stroke_count(store: &atomic_lib::Db, subject: &str) -> usize {
    let resource = store.get_resource(&subject.into()).await.unwrap();

    match resource.get(STROKE_DATA) {
        Ok(atomic_lib::Value::Json(v)) => v.as_array().map(|a| a.len()).unwrap_or(0),
        _ => 0,
    }
}

/// One local edit: read, append, commit — what drawing a stroke does.
async fn local_edit(store: &atomic_lib::Db, canvas: &str, round: usize) {
    let mut resource = store.get_resource(&canvas.into()).await.unwrap();
    resource.ensure_materialized().unwrap();
    resource
        .push_list_item(STROKE_DATA, serde_json::json!({ "local": round }))
        .unwrap();
    resource.save_locally(store).await.unwrap();
}

/// One peer update, through the same `resolve_update` / `persist_update` pair
/// the Iroh and WS receive sides use.
async fn peer_apply(store: &atomic_lib::Db, canvas: &str, round: usize) {
    let mut peer = store.get_resource(&canvas.into()).await.unwrap();
    peer.ensure_materialized().unwrap();
    peer.push_list_item(STROKE_DATA, serde_json::json!({ "remote": round }))
        .unwrap();
    let update = peer.materialized_state().unwrap();

    if let Some(resolved) = atomic_lib::sync::ws_apply::resolve_update(store, canvas, &update).await
    {
        atomic_lib::sync::ws_apply::persist_update(store, canvas, resolved)
            .await
            .unwrap();
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_local_edit_racing_a_peer_update_keeps_both() {
    let store = atomic_lib::Db::init_temp("concurrent_commit_race")
        .await
        .unwrap();
    let canvas = new_canvas(&store, "Race canvas").await;

    let local = {
        let store = store.clone();
        let canvas = canvas.clone();
        tokio::spawn(async move {
            for round in 0..ROUNDS {
                local_edit(&store, &canvas, round).await;
                tokio::task::yield_now().await;
            }
        })
    };

    let remote = {
        let store = store.clone();
        let canvas = canvas.clone();
        tokio::spawn(async move {
            for round in 0..ROUNDS {
                peer_apply(&store, &canvas, round).await;
                tokio::task::yield_now().await;
            }
        })
    };

    local.await.unwrap();
    remote.await.unwrap();

    let survived = stroke_count(&store, &canvas).await;
    eprintln!("{survived} of {} operations survived", ROUNDS * 2);

    assert_eq!(
        survived,
        ROUNDS * 2,
        "a concurrent local commit and peer apply clobbered each other"
    );
    // Guard against the fix degenerating into a no-op: this many rounds lost
    // roughly a third of everything before the lock existed.
}

/// The control that makes the test above meaningful: the same operations,
/// interleaved but never concurrent, keep every one. If this ever fails, the
/// problem is the operations rather than the race.
#[tokio::test]
async fn the_same_operations_sequentially_keep_everything() {
    let store = atomic_lib::Db::init_temp("concurrent_commit_control")
        .await
        .unwrap();
    let canvas = new_canvas(&store, "Control canvas").await;

    for round in 0..ROUNDS {
        local_edit(&store, &canvas, round).await;
        peer_apply(&store, &canvas, round).await;
    }

    assert_eq!(
        stroke_count(&store, &canvas).await,
        ROUNDS * 2,
        "sequential local edits and peer applies must not lose anything"
    );
}
