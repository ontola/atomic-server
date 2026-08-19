//! UniFFI surface over `atomic_lib`.
//!
//! Same product API as the Python SDK: local redb + Iroh P2P, plus HTTP GET
//! of `https://` subjects (schema / external resources), optional `server`
//! for `/search` and `saveRemote()`. Kotlin (and later Swift) generate from
//! this crate. PyO3 stays in `python/`.

uniffi::setup_scaffolding!();

mod convert;
mod peer;
mod resource;
mod store;

use std::sync::OnceLock;

pub use peer::{PeerInfo, SyncReport};
pub use resource::Resource;
pub use store::Store;

#[derive(Debug, thiserror::Error, uniffi::Error)]
#[uniffi(flat_error)]
pub enum AtomicSdkError {
    #[error("{0}")]
    Failed(String),
}

impl From<String> for AtomicSdkError {
    fn from(msg: String) -> Self {
        Self::Failed(msg)
    }
}

impl From<&str> for AtomicSdkError {
    fn from(msg: &str) -> Self {
        Self::Failed(msg.to_string())
    }
}

pub(crate) fn err(e: impl ToString) -> AtomicSdkError {
    AtomicSdkError::Failed(e.to_string())
}

pub(crate) fn runtime() -> &'static tokio::runtime::Runtime {
    static RT: OnceLock<tokio::runtime::Runtime> = OnceLock::new();
    RT.get_or_init(|| {
        tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .thread_name("atomic-ffi")
            .build()
            .expect("failed to start tokio runtime")
    })
}

pub(crate) fn block_on<F: std::future::Future>(fut: F) -> F::Output {
    runtime().block_on(fut)
}

#[derive(uniffi::Record)]
pub struct SetupInfo {
    pub agent_subject: String,
    pub agent_secret: String,
    pub drive_subject: String,
}

#[derive(uniffi::Record)]
pub struct AgentInfo {
    pub subject: String,
    pub secret: String,
    pub public_key: String,
    pub name: Option<String>,
    pub drive_needs_sync: bool,
}

#[derive(uniffi::Record)]
pub struct DriveInfo {
    pub subject: String,
    pub name: String,
}

/// Well-known Atomic Data URLs, matching `atomic_data.urls` in Python.
#[uniffi::export]
pub fn url_folder() -> String {
    atomic_lib::urls::FOLDER.to_string()
}

#[uniffi::export]
pub fn url_plain_text() -> String {
    atomic_lib::urls::PLAIN_TEXT.to_string()
}

#[uniffi::export]
pub fn url_drive() -> String {
    atomic_lib::urls::DRIVE.to_string()
}

#[uniffi::export]
pub fn url_name() -> String {
    atomic_lib::urls::NAME.to_string()
}

#[uniffi::export]
pub fn url_description() -> String {
    atomic_lib::urls::DESCRIPTION.to_string()
}

#[uniffi::export]
pub fn url_parent() -> String {
    atomic_lib::urls::PARENT.to_string()
}

#[uniffi::export]
pub fn url_is_a() -> String {
    atomic_lib::urls::IS_A.to_string()
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;
    use crate::store::Store;

    #[test]
    fn setup_creates_agent_and_drive() {
        let store = Store::in_memory(None).unwrap();
        assert!(store.agent().unwrap().is_none());
        assert!(store.active_drive().is_none());

        let info = store.setup("Ada".into()).unwrap();
        assert!(info.agent_subject.starts_with("did:ad:agent:"));
        assert!(info.drive_subject.starts_with("did:ad:"));
        assert!(!info.agent_secret.is_empty());
        assert_eq!(
            store.active_drive().as_deref(),
            Some(info.drive_subject.as_str())
        );
        assert!(store.has(info.drive_subject.clone()));
        assert_eq!(store.drives().unwrap().len(), 1);
    }

    #[test]
    fn create_read_update() {
        let store = Store::in_memory(None).unwrap();
        store.setup("Test agent".into()).unwrap();
        let mut props = HashMap::new();
        props.insert("description".into(), "first draft".into());
        let note = store
            .create(url_plain_text(), "Hello".into(), None, Some(props))
            .unwrap();
        assert!(note.subject().starts_with("did:ad:"));
        assert_eq!(note.get("name".into()), Some("Hello".into()));
        assert_eq!(note.get("description".into()), Some("first draft".into()));
        assert!(note.contains(url_parent()));

        note.set("description".into(), "second draft".into())
            .unwrap();
        note.set_name("Hello again".into()).unwrap();
        note.save().unwrap();

        let got = store.get(note.subject()).unwrap().unwrap();
        assert_eq!(got.get("name".into()), Some("Hello again".into()));
        assert_eq!(got.get("description".into()), Some("second draft".into()));
    }

    #[test]
    fn query_by_parent_and_class() {
        let store = Store::in_memory(None).unwrap();
        store.setup("Test agent".into()).unwrap();
        let drive = store.active_drive().unwrap();
        let folder = store
            .create(url_folder(), "Alpha".into(), None, None)
            .unwrap();
        let text = store
            .create(
                url_plain_text(),
                "Beta".into(),
                None,
                Some(HashMap::from([("description".into(), "body".into())])),
            )
            .unwrap();
        store
            .create(
                url_plain_text(),
                "Gamma".into(),
                None,
                Some(HashMap::from([("description".into(), "body".into())])),
            )
            .unwrap();

        let children = store
            .query(Some(drive.clone()), None, None, None, None, 0)
            .unwrap();
        let names: Vec<_> = children.iter().filter_map(|r| r.name()).collect();
        assert!(names.contains(&"Alpha".to_string()));
        assert!(names.contains(&"Beta".to_string()));
        assert!(names.contains(&"Gamma".to_string()));

        let folders = store
            .query(Some(drive), Some(url_folder()), None, None, None, 0)
            .unwrap();
        assert_eq!(folders.len(), 1);
        assert_eq!(folders[0].subject(), folder.subject());

        let texts = store
            .query(None, Some(url_plain_text()), None, None, None, 0)
            .unwrap();
        let subjects: Vec<_> = texts.iter().map(|r| r.subject()).collect();
        assert!(subjects.contains(&text.subject()));
        assert!(!subjects.contains(&folder.subject()));
    }

    #[test]
    fn destroy_folder() {
        let store = Store::in_memory(None).unwrap();
        store.setup("Agent".into()).unwrap();
        let folder = store
            .create(url_folder(), "Tmp".into(), None, None)
            .unwrap();
        let subject = folder.subject();
        folder.destroy_resource().unwrap();
        assert!(!store.has(subject.clone()));
        assert!(store.get(subject).unwrap().is_none());
    }

    #[test]
    fn delete_removes_resource() {
        let store = Store::in_memory(None).unwrap();
        store.setup("Agent".into()).unwrap();
        let folder = store
            .create(url_folder(), "ephemeral".into(), None, None)
            .unwrap();
        let subject = folder.subject();
        drop(folder);
        store.delete(subject.clone()).unwrap();
        assert!(store.get(subject).unwrap().is_none());
    }

    #[test]
    fn missing_get_returns_none() {
        let store = Store::in_memory(None).unwrap();
        store.setup("Agent".into()).unwrap();
        assert!(store.get("did:ad:does-not-exist".into()).unwrap().is_none());
    }

    #[test]
    fn create_requires_parent_or_drive() {
        let store = Store::in_memory(None).unwrap();
        store.create_agent("No drive".into()).unwrap();
        let err = store
            .create(url_folder(), "orphan".into(), None, None)
            .unwrap_err();
        assert!(err.to_string().contains("parent or an active drive"));
    }

    #[test]
    fn independent_in_memory_stores() {
        let a = Store::in_memory(None).unwrap();
        let b = Store::in_memory(None).unwrap();
        let setup_a = a.setup("A".into()).unwrap();
        b.setup("B".into()).unwrap();
        let note = a
            .create(url_folder(), "only-in-a".into(), None, None)
            .unwrap();
        assert!(b.get(note.subject()).unwrap().is_none());
        assert!(a.get(setup_a.drive_subject).unwrap().is_some());
    }

    #[test]
    fn to_json_includes_subject() {
        let store = Store::in_memory(None).unwrap();
        store.setup("Agent".into()).unwrap();
        let note = store
            .create(url_folder(), "serial".into(), None, None)
            .unwrap();
        let json = note.to_json().unwrap();
        assert!(json.contains(&note.subject()));
        assert!(json.contains("serial"));
    }

    #[test]
    fn known_peers_persist_locally() {
        let store = Store::in_memory(None).unwrap();
        store.setup("Ada".into()).unwrap();
        store.add_peer(format!("did:ad:node:{}", "cd".repeat(32)), "Phone".into());
        let peers = store.peers();
        assert_eq!(peers.len(), 1);
        assert_eq!(peers[0].name, "Phone");
        assert!(peers[0].node_id.starts_with("did:ad:node:"));
    }

    #[test]
    fn sync_with_requires_start_peer() {
        let store = Store::in_memory(None).unwrap();
        store.setup("Ada".into()).unwrap();
        let err = store
            .sync_with(format!("did:ad:node:{}", "ab".repeat(32)), None)
            .unwrap_err();
        assert!(err.to_string().contains("startPeer"));
    }

    #[test]
    fn wait_for_times_out() {
        let store = Store::in_memory(None).unwrap();
        store.setup("Ada".into()).unwrap();
        let err = store
            .wait_for("did:ad:does-not-change".into(), 0.2)
            .unwrap_err();
        assert!(err.to_string().contains("timed out"));
    }

    #[test]
    fn reopen_file_store() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().to_string_lossy().to_string();
        let (subject, secret, drive) = {
            let store = Store::open(path.clone(), None).unwrap();
            let setup = store.setup("Ada".into()).unwrap();
            let mut props = HashMap::new();
            props.insert("description".into(), "on disk".into());
            let note = store
                .create(url_plain_text(), "Persisted".into(), None, Some(props))
                .unwrap();
            let subject = note.subject();
            store.flush().unwrap();
            drop(note);
            drop(store);
            (subject, setup.agent_secret, setup.drive_subject)
        };

        {
            let store = Store::open(path.clone(), None).unwrap();
            let loaded = store.get(subject.clone()).unwrap().unwrap();
            assert_eq!(loaded.get("name".into()), Some("Persisted".into()));
            assert_eq!(loaded.get("description".into()), Some("on disk".into()));
            assert!(store.has(drive.clone()));
            store.load_agent(secret).unwrap();
            store.set_active_drive(drive).unwrap();
            loaded
                .set("description".into(), "edited after reopen".into())
                .unwrap();
            loaded.save().unwrap();
            store.flush().unwrap();
        }

        let store = Store::open(path, None).unwrap();
        let got = store.get(subject).unwrap().unwrap();
        assert_eq!(
            got.get("description".into()),
            Some("edited after reopen".into())
        );
    }

    #[test]
    fn bundled_schema_is_local() {
        let store = Store::in_memory(None).unwrap();
        assert!(store.has(url_name()));
        let prop = store.get(url_name()).unwrap().unwrap();
        assert!(prop.get("shortname".into()).is_some() || prop.get("name".into()).is_some());
    }

    #[test]
    fn search_requires_server() {
        let store = Store::in_memory(None).unwrap();
        let err = store.search("folder".into(), None).unwrap_err();
        assert!(err.to_string().contains("server"));
    }

    #[test]
    fn server_getter_setter() {
        let store = Store::in_memory(None).unwrap();
        assert!(store.server().is_none());
        store.set_server("https://atomicdata.dev".into());
        assert_eq!(store.server().as_deref(), Some("https://atomicdata.dev"));
        let with = Store::in_memory(Some("https://example.com".into())).unwrap();
        assert_eq!(with.server().as_deref(), Some("https://example.com"));
    }

    #[test]
    fn get_fetches_http_resource() {
        let store = Store::in_memory(None).unwrap();
        let subject = "https://atomicdata.dev".to_string();
        assert!(!store.has(subject.clone()));
        if let Ok(Some(resource)) = store.get(subject.clone()) {
            assert!(resource.subject().starts_with("https://"));
            assert!(store.has(subject));
        }
    }
}
