//! Does this device stay the *same* device across a hard kill?
//!
//! Everything the sync layer builds on assumes a stable identity: the Iroh
//! NodeID a QR code hands out, and the routing data that lets a re-dial reach a
//! peer behind NAT. Both live in redb under `Durability::None` — no fsync per
//! commit — so redb rolls them back on an unclean kill unless a durable commit
//! has landed since. That is not hypothetical: an Android app that never
//! flushed minted a fresh NodeID on every kill, so the paired server became a
//! stranger and the user had to re-scan the QR each launch.
//!
//! A single-process test cannot catch this. A graceful shutdown flushes, so the
//! data survives for the wrong reason. These tests therefore fork a real child
//! process that writes and then `abort()`s — no destructors, no flush on the
//! way out, exactly like the OS killing a backgrounded app.
//!
//! Run: cargo test -p atomic_lib --features db-redb,iroh --test identity_durability
#![cfg(all(feature = "db-redb", feature = "iroh"))]

use std::path::{Path, PathBuf};

/// Set by the parent to hand the child its working directory. Its presence is
/// also what turns the `#[ignore]`d child entry points into real work.
const CHILD_DIR_ENV: &str = "ATOMIC_DURABILITY_CHILD_DIR";

async fn open_store(dir: &Path) -> atomic_lib::Db {
    atomic_lib::Db::init_redb_file(dir, None, &dir.join("uploads"))
        .await
        .expect("open store")
}

fn scratch_dir(name: &str) -> PathBuf {
    let dir =
        std::env::temp_dir().join(format!("atomic-durability-{}-{}", name, std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// Run one of the `#[ignore]`d child entry points below in a real subprocess
/// and wait for it to die.
///
/// The child is expected to abort, so its exit status is deliberately not
/// asserted on — what it left on disk is the whole point. A side-channel file
/// carries values back, because the child's redb state is exactly what is
/// under suspicion and cannot be trusted to report on itself.
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

fn child_dir() -> Option<PathBuf> {
    std::env::var(CHILD_DIR_ENV).ok().map(PathBuf::from)
}

// ── Iroh node identity ─────────────────────────────────────────────────────

#[test]
#[ignore = "child process entry point, driven by the parent test"]
fn child_starts_a_node_then_dies() {
    let Some(dir) = child_dir() else { return };

    let runtime = tokio::runtime::Runtime::new().unwrap();
    runtime.block_on(async {
        let store = open_store(&dir).await;
        let _ = store.setup("Durability device").await;
        let (node_id, _router) = atomic_lib::sync::peer::start(store)
            .await
            .expect("start peer");
        std::fs::write(dir.join("node-id.txt"), node_id.to_string()).unwrap();
    });

    // No unwinding, no destructors, no flush — the app being killed.
    std::process::abort();
}

#[tokio::test]
async fn the_node_identity_survives_an_unclean_kill() {
    let dir = scratch_dir("identity");

    run_child("child_starts_a_node_then_dies", &dir);

    let before = std::fs::read_to_string(dir.join("node-id.txt"))
        .expect("child should have recorded its node id before dying");

    let store = open_store(&dir).await;
    let (after, _router) = atomic_lib::sync::peer::start(store)
        .await
        .expect("start peer after restart");

    assert_eq!(
        after.to_string(),
        before,
        "restarting after a kill must reuse the stored secret. A new NodeID \
         here means every paired device sees a stranger and the user has to \
         re-scan the pairing code."
    );
}

// ── Known peers and their routing data ─────────────────────────────────────

const PEER_ID: &str =
    "did:ad:node:1111111111111111111111111111111111111111111111111111111111111111";
const RELAY: &str = "https://relay.example/";

#[test]
#[ignore = "child process entry point, driven by the parent test"]
fn child_records_a_peer_then_dies() {
    let Some(dir) = child_dir() else { return };

    let runtime = tokio::runtime::Runtime::new().unwrap();
    runtime.block_on(async {
        let store = open_store(&dir).await;
        atomic_lib::sync::peer::add_known_peer(&store, PEER_ID, "Paired phone");
        atomic_lib::sync::peer::remember_peer_addr(
            &store,
            PEER_ID,
            Some(RELAY.to_string()),
            vec!["192.168.0.10:41234".to_string()],
        );
        // Leak the store on purpose. Dropping it would drop redb's `Database`,
        // whose own `Drop` closes the file cleanly and makes every pending
        // `Durability::None` commit durable — which is precisely the thing a
        // killed process never gets to do. Without this the test passes for the
        // wrong reason: it would be exercising a graceful shutdown.
        std::mem::forget(store);
    });

    std::process::abort();
}

/// Pairing writes the peer list once and may not be touched again for days, so
/// it has to be durable on its own — there is no later write to carry it to
/// disk. Losing it costs the user a re-pair; losing just the relay and direct
/// addresses is subtler but nearly as bad, because a bare-NodeID dial times out
/// behind NAT.
#[tokio::test]
async fn a_paired_peer_and_its_route_survive_an_unclean_kill() {
    let dir = scratch_dir("peers");

    run_child("child_records_a_peer_then_dies", &dir);

    let store = open_store(&dir).await;
    let peers = atomic_lib::sync::peer::get_known_peers(&store);

    let peer = peers
        .iter()
        .find(|p| {
            atomic_lib::sync::peer::normalize_node_id(&p.node_id)
                == atomic_lib::sync::peer::normalize_node_id(PEER_ID)
        })
        .expect("the paired peer must still be known after a kill");

    assert_eq!(peer.name, "Paired phone");
    assert_eq!(
        peer.relay_url.as_deref(),
        Some(RELAY),
        "without the stored relay, re-dialing falls back to a bare NodeID, \
         which times out behind NAT"
    );
    assert_eq!(peer.direct_addrs, vec!["192.168.0.10:41234".to_string()]);
}
