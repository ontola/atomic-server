//! Iroh P2P surface for the Python SDK.
//!
//! Same calls Flutter exposes (`start_peer`, announce, `sync_drive_with_peer`),
//! plus a blocking `wait_for` so a script can observe live updates.

use std::time::Duration;

use atomic_lib::storelike::Storelike;
use atomic_lib::{Db, Subject};
use pyo3::exceptions::{PyTimeoutError, PyValueError};
use pyo3::prelude::*;

use crate::{block_on, py_err};

/// Result of a bulk Iroh sync round-trip.
#[pyclass]
#[derive(Clone)]
pub struct SyncReport {
    #[pyo3(get)]
    pub imported: usize,
    #[pyo3(get)]
    pub pushed: usize,
    #[pyo3(get)]
    pub in_sync: bool,
    #[pyo3(get)]
    pub peer_name: Option<String>,
}

#[pymethods]
impl SyncReport {
    fn __repr__(&self) -> String {
        format!(
            "SyncReport(imported={}, pushed={}, in_sync={})",
            self.imported, self.pushed, self.in_sync
        )
    }
}

/// A remembered Iroh peer.
#[pyclass]
#[derive(Clone)]
pub struct PeerInfo {
    #[pyo3(get)]
    pub node_id: String,
    #[pyo3(get)]
    pub name: String,
}

#[pymethods]
impl PeerInfo {
    fn __repr__(&self) -> String {
        format!("PeerInfo(name={:?}, node_id={:?})", self.name, self.node_id)
    }
}

pub(crate) fn node_uri(id: &str) -> String {
    let hex = atomic_lib::sync::peer::normalize_node_id(id);
    if hex.starts_with("did:ad:node:") {
        hex
    } else {
        format!("did:ad:node:{hex}")
    }
}

pub(crate) fn publish_live(response: &atomic_lib::commit::CommitResponse) {
    if let Some(bytes) = &response.commit.loro_update {
        if !bytes.is_empty() {
            let key = response.commit.subject.pure_id();
            atomic_lib::sync::peer::broadcast_live_update(&key, bytes);
        }
    }
}

pub(crate) fn start_peer(db: &Db) -> PyResult<String> {
    if let Some(existing) = atomic_lib::sync::peer::get_node_id() {
        return Ok(node_uri(existing));
    }
    let (node_id, _router) = block_on(atomic_lib::sync::peer::start(db.clone())).map_err(py_err)?;
    Ok(node_uri(&node_id.to_string()))
}

pub(crate) fn peer_id() -> Option<String> {
    atomic_lib::sync::peer::get_node_id().map(node_uri)
}

pub(crate) fn announce(db: &Db, drive: Option<&str>) -> PyResult<()> {
    let drive = match drive {
        Some(d) => d.to_string(),
        None => db
            .get_active_drive()
            .ok_or_else(|| PyValueError::new_err("announce() needs a drive or an active drive"))?,
    };
    let Some(node_id) = atomic_lib::sync::peer::get_node_id() else {
        return Err(PyValueError::new_err(
            "Peer not started. Call start_peer() first.",
        ));
    };
    block_on(atomic_lib::discovery::publish_node_id(&drive, node_id)).map_err(py_err)
}

pub(crate) fn sync_with(db: &Db, node_id: &str, drive: Option<&str>) -> PyResult<SyncReport> {
    if atomic_lib::sync::peer::get_node_id().is_none() {
        return Err(PyValueError::new_err(
            "Peer not started. Call start_peer() first.",
        ));
    }
    let drive = match drive {
        Some(d) => d.to_string(),
        None => db
            .get_active_drive()
            .ok_or_else(|| PyValueError::new_err("sync_with() needs a drive or an active drive"))?,
    };
    let outcome = block_on(atomic_lib::sync::peer::sync_drive_with_peer_outcome(
        node_id, &drive, db,
    ))
    .map_err(py_err)?;
    Ok(SyncReport {
        imported: outcome.count,
        pushed: outcome.pushed,
        in_sync: outcome.in_sync,
        peer_name: outcome.peer_name,
    })
}

async fn recv_change(db: &Db, target: Subject) -> String {
    let mut rx = db.subscribe_events();
    loop {
        match rx.recv().await {
            Ok(atomic_lib::DbEvent::Changed { subject, .. }) if subject == target => {
                return subject.to_string();
            }
            Ok(atomic_lib::DbEvent::Destroyed { subject, .. }) if subject == target => {
                return format!("!{subject}");
            }
            Ok(_) => continue,
            Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
            Err(_) => {
                tokio::time::sleep(Duration::from_millis(50)).await;
                rx = db.subscribe_events();
            }
        }
    }
}

pub(crate) fn wait_for(db: &Db, subject: &str, timeout: f64) -> PyResult<String> {
    let target = Subject::from_raw(subject, db.get_base_domain().as_deref()).without_params();
    let dur = Duration::from_secs_f64(timeout.max(0.0));
    match block_on(async { tokio::time::timeout(dur, recv_change(db, target)).await }) {
        Ok(s) => Ok(s),
        Err(_) => Err(PyTimeoutError::new_err(format!(
            "timed out waiting for {subject}"
        ))),
    }
}
