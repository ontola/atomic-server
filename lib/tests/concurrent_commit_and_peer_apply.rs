//! A local edit racing a peer's update loses about a third of all operations.
//!
//! **The reproduction is `#[ignore]`d because the bug is real and unfixed** —
//! it is here to be run on demand, not to redden CI. Run it with:
//!
//! ```text
//! cargo test -p atomic_lib --features db-redb,iroh,ws \
//!     --test concurrent_commit_and_peer_apply -- --ignored --nocapture
//! ```
//!
//! ## What happens
//!
//! `Db::apply_commit` reads the resource in `validate_and_build_response`,
//! builds the new state from that read, and then *replaces* the persisted Loro
//! snapshot (`Tree::LoroSnapshots`) inside its transaction. The KV write is an
//! insert, not a merge, and nothing re-reads in between. A peer update that
//! `sync::ws_apply::persist_update` lands in that window is overwritten, and
//! the peer's operations are gone for good.
//!
//! This was previously recorded as a "microsecond TOCTOU". It is not: at 40
//! concurrent rounds a side, roughly **a third of all operations are lost**
//! (typically 53-56 of 80 survive). The control below runs the identical
//! operations sequentially and keeps every one, so the loss is concurrency and
//! not the operations themselves.
//!
//! This is the most likely explanation for strokes disappearing on a device
//! that was drawing while a peer was syncing.
//!
//! ## Why it is not simply fixed here
//!
//! Two candidate fixes, both with a downside that needs a decision about
//! commit semantics rather than a guess:
//!
//! 1. **A per-subject lock across read → write in both paths.** Correct, and
//!    preserves replace semantics. But `apply_commit` runs arbitrary
//!    `before_commit` class-extender handlers between the read and the write,
//!    and those handlers are handed `store` — if any of them commits the same
//!    subject, holding the lock across them deadlocks the write path.
//! 2. **Merge instead of replace when writing the snapshot.** No locking, no
//!    deadlock. But a Loro merge is a union, so it would resurrect operations
//!    that a history checkout (`Resource::checkout`, used by the canvas scrub
//!    and `set_strokes`) deliberately dropped — turning a rollback into a
//!    no-op.
//!
//! Sync-side applies are always additive, so (2) is safe *there*; it is the
//! commit side that needs the call.

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
#[ignore = "reproduces a known unfixed bug — see the module docs"]
async fn a_local_edit_racing_a_peer_update_loses_operations() {
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
}

/// The control that makes the above a bug report rather than a guess: the same
/// operations, interleaved but never concurrent, keep every one. Runs in CI —
/// if this ever fails, the problem is not the race.
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
