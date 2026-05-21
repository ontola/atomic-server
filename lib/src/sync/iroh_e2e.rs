//! End-to-end tests: two Iroh endpoints, real QUIC sync (bulk + live).
//!
//! Run (single-threaded — tests share global `LIVE_PEERS` / `ROUTER` state):
//! `cargo test -p atomic_lib --features "iroh,db-redb" --lib -- sync::iroh_e2e -- --test-threads=1`

use crate::{agents::ForAgent, Db, Storelike};
use iroh::protocol::Router;

const STROKE_DATA: &str = "https://atomicdata.dev/ontology/canvas/strokeData";
const FOLDER_PROP: &str = "https://atomicdata.dev/ontology/canvas/folderId";
const CANVAS_CLASS: &str = "https://atomicdata.dev/ontology/canvas/Canvas";
const FOLDER_CLASS: &str = "https://atomicdata.dev/classes/Folder";

/// Two logical devices: A runs `peer::start` (router + live push), B uses a separate endpoint.
struct IrohPair {
    db_a: Db,
    db_b: Db,
    drive: String,
    node_id_a: String,
    _router_a: Router,
    ep_b: iroh::Endpoint,
}

async fn setup_pair(prefix: &str) -> IrohPair {
    use crate::sync::peer;

    let db_a = Db::init_temp(&format!("{prefix}_a")).await.unwrap();
    let (agent_a, drive) = db_a.setup("Alice").await.unwrap();
    let secret = agent_a.build_secret().unwrap();

    let db_b = Db::init_temp(&format!("{prefix}_b")).await.unwrap();
    db_b.load_agent_from_secret(&secret).await.unwrap();

    let (node_id_a, router_a) = peer::start(db_a.clone()).await.unwrap();
    let ep_b = iroh::Endpoint::builder()
        .discovery_n0()
        .discovery_local_network()
        .bind()
        .await
        .unwrap();
    let node_addr_a = router_a.endpoint().node_addr().await.unwrap();
    ep_b.add_node_addr(node_addr_a).unwrap();

    IrohPair {
        db_a,
        db_b,
        drive,
        node_id_a: node_id_a.to_string(),
        _router_a: router_a,
        ep_b,
    }
}

async fn sync_b_from_a(pair: &IrohPair) -> usize {
    use crate::sync::peer;

    peer::sync_drive_with_peer_using(
        &pair.ep_b,
        &pair.node_id_a,
        &pair.drive,
        &pair.db_b,
        true,
    )
    .await
    .expect("B→A sync should succeed")
}

async fn wait_until<F, Fut>(timeout: std::time::Duration, mut check: F) -> bool
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = bool>,
{
    let deadline = tokio::time::Instant::now() + timeout;
    while tokio::time::Instant::now() < deadline {
        if check().await {
            return true;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    false
}

async fn wait_for_live_peers(min: usize, timeout: std::time::Duration) {
    let ok = wait_until(timeout, || async {
        crate::sync::peer::live_peer_count() >= min
    })
    .await;
    assert!(
        ok,
        "expected ≥{min} live peer(s), got {}",
        crate::sync::peer::live_peer_count()
    );
}

async fn stroke_count(db: &Db, canvas: &str) -> usize {
    let r = db.get_resource(&canvas.into()).await.unwrap();
    match r.get(STROKE_DATA) {
        Ok(crate::Value::JsonArray(arr)) => arr.len(),
        _ => 0,
    }
}

async fn folder_id_on(db: &Db, canvas: &str) -> Option<String> {
    let r = db.get_resource(&canvas.into()).await.ok()?;
    r.get(FOLDER_PROP)
        .ok()
        .map(|v| v.to_string())
        .filter(|s| !s.is_empty())
}

async fn assign_folder(db: &Db, canvas: &str, folder: &str) {
    let mut r = db.get_resource(&canvas.into()).await.unwrap();
    r.ensure_materialized().unwrap();
    r.set_unsafe(FOLDER_PROP.into(), crate::Value::String(folder.into()));
    r.save_locally(db).await.unwrap();
}

/// Initial bulk sync: canvases, strokes, and bidirectional merge (same agent / drive).
#[tokio::test]
async fn e2e_bidirectional_bulk_sync() {
    let pair = setup_pair("e2e_bulk").await;

    let canvas_a = pair
        .db_a
        .create_resource(
            CANVAS_CLASS,
            &pair.drive,
            "Canvas A",
            Some(vec![(
                STROKE_DATA,
                crate::Value::JsonArray(vec![serde_json::json!({"color": 1})]),
            )]),
        )
        .await
        .unwrap();

    let canvas_b = pair
        .db_b
        .create_resource(
            CANVAS_CLASS,
            &pair.drive,
            "Canvas B",
            Some(vec![(
                STROKE_DATA,
                crate::Value::JsonArray(vec![serde_json::json!({"color": 2})]),
            )]),
        )
        .await
        .unwrap();

    let imported = sync_b_from_a(&pair).await;
    assert!(imported > 0, "B should import A's resources");

    pair.db_b
        .get_resource(&canvas_a.as_str().into())
        .await
        .expect("B should have A's canvas after bulk sync");

    tokio::time::sleep(std::time::Duration::from_millis(300)).await;

    pair.db_a
        .get_resource(&canvas_b.as_str().into())
        .await
        .expect("A should have B's canvas after bidirectional SYNC_PUSH");
}

/// After bulk sync, an edit on A reaches B via the live stream (or a follow-up bulk sync).
#[tokio::test]
async fn e2e_stroke_append_after_sync() {
    let pair = setup_pair("e2e_stroke").await;

    let canvas = pair
        .db_a
        .create_resource(
            CANVAS_CLASS,
            &pair.drive,
            "Stroke canvas",
            Some(vec![(
                STROKE_DATA,
                crate::Value::JsonArray(vec![serde_json::json!({"color": 1, "path": [[0.0, 0.0]]})]),
            )]),
        )
        .await
        .unwrap();

    sync_b_from_a(&pair).await;
    wait_for_live_peers(1, std::time::Duration::from_secs(3)).await;
    assert_eq!(stroke_count(&pair.db_b, &canvas).await, 1);

    let mut resource_a = pair.db_a.get_resource(&canvas.as_str().into()).await.unwrap();
    resource_a.ensure_materialized().unwrap();
    resource_a.init_undo();
    resource_a
        .push_list_item(
            STROKE_DATA,
            serde_json::json!({"color": 2, "width": 2.0, "path": [[1.0, 1.0]]}),
        )
        .unwrap();
    resource_a.save_locally(&pair.db_a).await.unwrap();

    let live_ok = wait_until(std::time::Duration::from_secs(3), || async {
        stroke_count(&pair.db_b, &canvas).await == 2
    })
    .await;

    if !live_ok {
        let _ = sync_b_from_a(&pair).await;
    }

    assert_eq!(
        stroke_count(&pair.db_b, &canvas).await,
        2,
        "B must see second stroke (live push or bulk resync)"
    );
}

/// Gallery folder moves: `folderId` on a canvas propagates over Iroh.
#[tokio::test]
async fn e2e_canvas_folder_assignment_syncs() {
    let pair = setup_pair("e2e_folder").await;

    let folder = pair
        .db_a
        .create_resource(FOLDER_CLASS, &pair.drive, "Sketches", None)
        .await
        .unwrap();

    let canvas = pair
        .db_a
        .create_resource(CANVAS_CLASS, &pair.drive, "Inbox", None)
        .await
        .unwrap();

    sync_b_from_a(&pair).await;
    wait_for_live_peers(1, std::time::Duration::from_secs(3)).await;

    assign_folder(&pair.db_a, &canvas, &folder).await;

    let live_ok = wait_until(std::time::Duration::from_secs(3), || async {
        folder_id_on(&pair.db_b, &canvas).await.as_deref() == Some(folder.as_str())
    })
    .await;

    if !live_ok {
        let _ = sync_b_from_a(&pair).await;
    }

    assert_eq!(
        folder_id_on(&pair.db_b, &canvas).await.as_deref(),
        Some(folder.as_str()),
        "B must see folderId after A assigns canvas to folder (live or bulk resync)"
    );
}

/// New `did:ad:` resources (genesis commits) reach B via a follow-up bulk sync.
/// Edits to existing resources may arrive live; genesis creation often needs nudge/resync.
#[tokio::test]
async fn e2e_new_resource_after_bulk_resync() {
    let pair = setup_pair("e2e_new_res").await;

    pair.db_a
        .create_resource(CANVAS_CLASS, &pair.drive, "Seed", None)
        .await
        .unwrap();

    sync_b_from_a(&pair).await;

    let new_canvas = pair
        .db_a
        .create_resource(
            CANVAS_CLASS,
            &pair.drive,
            "After sync",
            Some(vec![(
                STROKE_DATA,
                crate::Value::JsonArray(vec![serde_json::json!({"color": 99})]),
            )]),
        )
        .await
        .unwrap();

    assert!(
        pair.db_b
            .get_resource(&new_canvas.as_str().into())
            .await
            .is_err(),
        "B should not have the canvas before resync"
    );

    let imported = sync_b_from_a(&pair).await;
    assert!(imported > 0, "second bulk sync should import new canvas");

    let on_b = pair
        .db_b
        .get_resource(&new_canvas.as_str().into())
        .await
        .expect("B should have new canvas after bulk resync");
    assert_eq!(
        on_b.get(crate::urls::NAME).unwrap().to_string(),
        "After sync"
    );
}

/// Engine pull still works when live is unavailable (documents mobile fallback path).
#[tokio::test]
async fn e2e_engine_pull_after_iroh_bulk_sync() {
    let pair = setup_pair("e2e_engine_pull").await;

    let canvas = pair
        .db_a
        .create_resource(
            CANVAS_CLASS,
            &pair.drive,
            "Pull test",
            Some(vec![(
                STROKE_DATA,
                crate::Value::JsonArray(vec![serde_json::json!({"n": 1})]),
            )]),
        )
        .await
        .unwrap();

    sync_b_from_a(&pair).await;

    let mut resource_a = pair.db_a.get_resource(&canvas.as_str().into()).await.unwrap();
    resource_a.ensure_materialized().unwrap();
    resource_a.init_undo();
    resource_a
        .push_list_item(STROKE_DATA, serde_json::json!({"n": 2}))
        .unwrap();
    resource_a.save_locally(&pair.db_a).await.unwrap();

    // Simulate second bulk sync (nudge_peers / manual sync) via engine frames.
    let drive_subject =
        crate::Subject::from_raw(&pair.drive, pair.db_b.get_base_domain().as_deref());
    let subjects =
        crate::sync::engine::collect_drive_subjects(&pair.db_b, &drive_subject).await;
    let vvs = crate::sync::engine::build_drive_vvs(&pair.db_b, &subjects);
    let hash = crate::sync::engine::compute_drive_hash(&vvs);
    let frames = crate::sync::engine::handle_sync_vv(
        &pair.drive,
        &hash,
        &[],
        &std::collections::HashMap::new(),
        &pair.db_a,
        &ForAgent::Public,
    )
    .await;

    let mut imported = 0;
    for frame in frames {
        if frame.first() == Some(&crate::sync::protocol::tag::SYNC_PUSH) {
            if let Some(push) = crate::sync::protocol::decode_sync_push(&frame[1..]) {
                let (count, _) =
                    crate::sync::engine::import_sync_push(&push, &pair.db_b, &ForAgent::Sudo)
                        .await;
                imported += count;
            }
        }
    }
    assert!(imported > 0, "engine pull should import A's edit");

    assert_eq!(stroke_count(&pair.db_b, &canvas).await, 2);
}
