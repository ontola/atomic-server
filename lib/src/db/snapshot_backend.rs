//! Main-thread persistence for the client-side redb store.
//!
//! [`super::opfs_backend::OpfsBackend`] needs `FileSystemSyncAccessHandle`,
//! which only exists in Web Workers. An app running on the main thread of a
//! wasm32 page (no workers, no wasm threads) cannot use it. [`SnapshotBackend`]
//! keeps the whole database in memory (redb's `InMemoryBackend`), tracks
//! whether anything changed, and lets the caller export the bytes and save
//! them with the *async* OPFS API, which the main thread does have.
//!
//! The trade-off is explicit: the whole file is held in memory and written as
//! one blob, and a tab killed between two saves loses the changes since the
//! last one. Call [`flush_snapshot`] on `visibilitychange` (when hidden) and
//! `pagehide`, and after important writes. The worker backend is unchanged.
//!
//! Export only between transactions (always true on one thread when no write
//! transaction is open across an `await`).

use std::io;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use redb::{backends::InMemoryBackend, StorageBackend};

/// An in-memory redb backend that tracks changes and can export its bytes.
///
/// Cloning shares the same storage: hand one clone to redb (possibly wrapped
/// in `EncryptedBackend`, in which case exports are ciphertext) and keep
/// another to save from.
#[derive(Clone, Debug)]
pub struct SnapshotBackend {
    inner: Arc<InMemoryBackend>,
    dirty: Arc<AtomicBool>,
}

impl SnapshotBackend {
    /// Start from a previously exported snapshot, or empty.
    pub fn new(bytes: Option<&[u8]>) -> io::Result<Self> {
        let inner = InMemoryBackend::new();
        if let Some(bytes) = bytes.filter(|b| !b.is_empty()) {
            inner.set_len(bytes.len() as u64)?;
            inner.write(0, bytes)?;
        }
        Ok(Self {
            inner: Arc::new(inner),
            dirty: Arc::new(AtomicBool::new(false)),
        })
    }

    /// Whether anything was written since the last [`Self::take_dirty_bytes`].
    pub fn is_dirty(&self) -> bool {
        self.dirty.load(Ordering::SeqCst)
    }

    /// The current bytes, regardless of the dirty flag.
    pub fn export(&self) -> io::Result<Vec<u8>> {
        let mut buf = vec![0u8; self.inner.len()? as usize];
        self.inner.read(0, &mut buf)?;
        Ok(buf)
    }

    /// The bytes to persist, or `None` when nothing changed. Clears the flag;
    /// on a failed save call [`Self::mark_dirty`] again.
    pub fn take_dirty_bytes(&self) -> io::Result<Option<Vec<u8>>> {
        if !self.dirty.swap(false, Ordering::SeqCst) {
            return Ok(None);
        }
        self.export().inspect_err(|_| self.mark_dirty()).map(Some)
    }

    pub fn mark_dirty(&self) {
        self.dirty.store(true, Ordering::SeqCst);
    }
}

impl StorageBackend for SnapshotBackend {
    fn len(&self) -> io::Result<u64> {
        self.inner.len()
    }

    fn read(&self, offset: u64, out: &mut [u8]) -> io::Result<()> {
        self.inner.read(offset, out)
    }

    fn set_len(&self, len: u64) -> io::Result<()> {
        self.mark_dirty();
        self.inner.set_len(len)
    }

    fn sync_data(&self) -> io::Result<()> {
        self.inner.sync_data()
    }

    fn write(&self, offset: u64, data: &[u8]) -> io::Result<()> {
        self.mark_dirty();
        self.inner.write(offset, data)
    }
}

#[cfg(target_arch = "wasm32")]
pub use opfs::{flush_snapshot, snapshot_load, snapshot_save};

/// Async OPFS file access that works on the main thread.
#[cfg(target_arch = "wasm32")]
mod opfs {
    use super::SnapshotBackend;
    use wasm_bindgen::prelude::*;
    use wasm_bindgen_futures::JsFuture;

    async fn root() -> Result<web_sys::FileSystemDirectoryHandle, JsValue> {
        // `navigator` exists on both Window and WorkerGlobalScope.
        let nav = js_sys::Reflect::get(&js_sys::global(), &"navigator".into())?;
        let nav: web_sys::Navigator = nav.unchecked_into();
        Ok(JsFuture::from(nav.storage().get_directory())
            .await?
            .unchecked_into())
    }

    /// Read the snapshot saved under `name`; `None` if there is none yet.
    pub async fn snapshot_load(name: &str) -> Result<Option<Vec<u8>>, JsValue> {
        let root = root().await?;
        let handle: web_sys::FileSystemFileHandle =
            match JsFuture::from(root.get_file_handle(name)).await {
                Ok(h) => h.unchecked_into(),
                Err(e)
                    if e.clone()
                        .dyn_into::<web_sys::DomException>()
                        .is_ok_and(|ex| ex.name() == "NotFoundError") =>
                {
                    return Ok(None)
                }
                Err(e) => return Err(e),
            };
        let file: web_sys::File = JsFuture::from(handle.get_file()).await?.unchecked_into();
        let buf = JsFuture::from(file.array_buffer()).await?;
        Ok(Some(js_sys::Uint8Array::new(&buf).to_vec()))
    }

    /// Replace the snapshot saved under `name`. Uses `createWritable`, which
    /// writes to a swap file and replaces the original on `close`, so a failed
    /// save leaves the previous snapshot intact.
    pub async fn snapshot_save(name: &str, bytes: &[u8]) -> Result<(), JsValue> {
        let root = root().await?;
        let opts = web_sys::FileSystemGetFileOptions::new();
        opts.set_create(true);
        let handle: web_sys::FileSystemFileHandle =
            JsFuture::from(root.get_file_handle_with_options(name, &opts))
                .await?
                .unchecked_into();
        let writable: web_sys::FileSystemWritableFileStream =
            JsFuture::from(handle.create_writable())
                .await?
                .unchecked_into();
        JsFuture::from(writable.write_with_u8_array(bytes)?).await?;
        JsFuture::from(writable.close()).await?;
        Ok(())
    }

    /// Save `backend` under `name` only if it changed. Returns whether it
    /// wrote. Call on `visibilitychange` (hidden) and `pagehide`; a failed
    /// save keeps the dirty flag so the next call retries.
    pub async fn flush_snapshot(name: &str, backend: &SnapshotBackend) -> Result<bool, JsValue> {
        let Some(bytes) = backend
            .take_dirty_bytes()
            .map_err(|e| JsValue::from_str(&e.to_string()))?
        else {
            return Ok(false);
        };
        if let Err(e) = snapshot_save(name, &bytes).await {
            backend.mark_dirty();
            return Err(e);
        }
        Ok(true)
    }
}

#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests {
    use super::*;

    #[test]
    fn dirty_flag_tracks_writes_and_roundtrips() {
        let b = SnapshotBackend::new(None).unwrap();
        assert!(!b.is_dirty());
        assert!(b.take_dirty_bytes().unwrap().is_none());

        b.set_len(8).unwrap();
        b.write(0, b"snapshot").unwrap();
        let bytes = b.take_dirty_bytes().unwrap().expect("dirty after write");
        assert_eq!(bytes, b"snapshot");
        assert!(b.take_dirty_bytes().unwrap().is_none());

        let b2 = SnapshotBackend::new(Some(&bytes)).unwrap();
        assert!(!b2.is_dirty());
        assert_eq!(b2.export().unwrap(), b"snapshot");
    }

    #[test]
    fn redb_store_survives_a_snapshot_roundtrip() {
        use crate::db::{kv_store::KvStore, redb_store::RedbStore, trees::Tree};
        let (store, handle) = RedbStore::new_snapshot(None, None).unwrap();
        store.insert(Tree::Resources, b"k", b"v").unwrap();
        store.flush().unwrap();
        let bytes = handle.take_dirty_bytes().unwrap().unwrap();
        drop(store);

        let (store, _) = RedbStore::new_snapshot(Some(bytes), None).unwrap();
        assert_eq!(store.get(Tree::Resources, b"k").unwrap().unwrap(), b"v");
    }

    #[test]
    fn encrypted_snapshot_roundtrips_and_rejects_wrong_key() {
        use crate::db::{kv_store::KvStore, redb_store::RedbStore, trees::Tree};
        let key = [7u8; 32];
        let (store, handle) = RedbStore::new_snapshot(None, Some(&key)).unwrap();
        store
            .insert(Tree::Resources, b"k", b"secret-value")
            .unwrap();
        store.flush().unwrap();
        let bytes = handle.export().unwrap();
        drop(store);
        assert!(!bytes.windows(12).any(|w| w == b"secret-value"));

        let (store, _) = RedbStore::new_snapshot(Some(bytes.clone()), Some(&key)).unwrap();
        assert_eq!(
            store.get(Tree::Resources, b"k").unwrap().unwrap(),
            b"secret-value"
        );
        drop(store);
        assert!(RedbStore::new_snapshot(Some(bytes), Some(&[8u8; 32])).is_err());
    }
}
