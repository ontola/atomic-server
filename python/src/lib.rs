//! Python bindings for `atomic_lib`.
//!
//! Same idea as the WASM (`wasm-bindgen`) and Flutter (`flutter_rust_bridge`)
//! bindings: Python talks to the Rust store. Loro, Ed25519 signing, and redb
//! stay in Rust. The Python API is synchronous; each call blocks on a process
//! tokio runtime.

use std::sync::OnceLock;

use pyo3::prelude::*;

mod convert;
mod peer;
mod resource;
mod store;
mod urls;

pub(crate) use convert::{py_err, py_to_value, resolve_property, resource_to_dict, value_to_py};
pub(crate) use peer::{PeerInfo, SyncReport};
pub(crate) use resource::Resource;
pub(crate) use store::{AgentInfo, DriveInfo, SetupInfo, Store};

pub(crate) fn runtime() -> &'static tokio::runtime::Runtime {
    static RT: OnceLock<tokio::runtime::Runtime> = OnceLock::new();
    RT.get_or_init(|| {
        tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .thread_name("atomic-python")
            .build()
            .expect("failed to start tokio runtime")
    })
}

/// Run an async `atomic_lib` call on the process runtime.
///
/// Holds the GIL. Local redb work is short, and some return types (`Resource`)
/// are not `Send`, so `allow_threads` is not worth the bound.
pub(crate) fn block_on<F: std::future::Future>(fut: F) -> F::Output {
    runtime().block_on(fut)
}

/// Atomic Data SDK.
///
/// Opens a redb-backed store (or an in-memory one), creates an agent + drive,
/// and reads / writes resources as signed Loro commits. Local by default.
/// HTTP GET of `https://` subjects loads schema and other external resources;
/// `server=` enables search and `save_remote()`.
#[pymodule]
fn atomic_data(m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add_class::<Store>()?;
    m.add_class::<Resource>()?;
    m.add_class::<SetupInfo>()?;
    m.add_class::<AgentInfo>()?;
    m.add_class::<DriveInfo>()?;
    m.add_class::<SyncReport>()?;
    m.add_class::<PeerInfo>()?;

    let urls_mod = urls::urls_module(m.py())?;
    m.add_submodule(&urls_mod)?;
    m.py()
        .import("sys")?
        .getattr("modules")?
        .set_item("atomic_data.urls", &urls_mod)?;

    m.add(
        "__doc__",
        "Local-first Atomic Data SDK. Wraps atomic_lib (Rust) via PyO3.",
    )?;
    Ok(())
}
