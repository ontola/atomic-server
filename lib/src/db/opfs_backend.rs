//! OPFS StorageBackend for redb.
//! Uses the Origin Private File System (FileSystemSyncAccessHandle) for
//! persistent storage in Web Workers.
//!
//! The FileSystemSyncAccessHandle API is synchronous, which is exactly what
//! redb's StorageBackend trait requires. It's only available in Web Workers.

use std::io;
use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::JsFuture;

/// A redb StorageBackend that persists to OPFS (Origin Private File System).
/// Must be created in a Web Worker — `FileSystemSyncAccessHandle` is not
/// available on the main thread.
pub struct OpfsBackend {
    handle: web_sys::FileSystemSyncAccessHandle,
}

impl std::fmt::Debug for OpfsBackend {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("OpfsBackend").finish()
    }
}

// Safety: WASM is single-threaded. These impls satisfy redb's trait bounds.
unsafe impl Send for OpfsBackend {}
unsafe impl Sync for OpfsBackend {}

impl OpfsBackend {
    /// Open (or create) a file in OPFS and return a synchronous access handle.
    /// This is async because getting the directory/file handle requires promises,
    /// but once created, all subsequent I/O is synchronous.
    pub async fn open(filename: &str) -> Result<Self, JsValue> {
        let global: web_sys::WorkerGlobalScope = js_sys::global().unchecked_into();
        let navigator = global.navigator();
        let storage = navigator.storage();
        let root_dir: web_sys::FileSystemDirectoryHandle =
            JsFuture::from(storage.get_directory()).await?.unchecked_into();

        let opts = web_sys::FileSystemGetFileOptions::new();
        opts.set_create(true);
        let file_handle: web_sys::FileSystemFileHandle =
            JsFuture::from(root_dir.get_file_handle_with_options(filename, &opts))
                .await?
                .unchecked_into();

        let sync_handle: web_sys::FileSystemSyncAccessHandle =
            JsFuture::from(file_handle.create_sync_access_handle())
                .await?
                .unchecked_into();

        Ok(OpfsBackend {
            handle: sync_handle,
        })
    }
}

fn js_err(msg: &str, e: JsValue) -> io::Error {
    io::Error::new(
        io::ErrorKind::Other,
        format!("{}: {:?}", msg, e),
    )
}

impl redb::StorageBackend for OpfsBackend {
    fn len(&self) -> io::Result<u64> {
        let size = self
            .handle
            .get_size()
            .map_err(|e| js_err("OPFS get_size", e))?;
        Ok(size as u64)
    }

    fn read(&self, offset: u64, out: &mut [u8]) -> io::Result<()> {
        let opts = web_sys::FileSystemReadWriteOptions::new();
        opts.set_at(offset as f64);

        let bytes_read = self
            .handle
            .read_with_u8_array_and_options(out, &opts)
            .map_err(|e| js_err("OPFS read", e))?;

        if (bytes_read as usize) < out.len() {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                format!(
                    "OPFS read: requested {} bytes at offset {}, got {}",
                    out.len(),
                    offset,
                    bytes_read
                ),
            ));
        }

        Ok(())
    }

    fn write(&self, offset: u64, data: &[u8]) -> io::Result<()> {
        let opts = web_sys::FileSystemReadWriteOptions::new();
        opts.set_at(offset as f64);

        self.handle
            .write_with_u8_array_and_options(data, &opts)
            .map_err(|e| js_err("OPFS write", e))?;

        Ok(())
    }

    fn set_len(&self, len: u64) -> io::Result<()> {
        self.handle
            .truncate_with_u32(len as u32)
            .map_err(|e| js_err("OPFS truncate", e))
    }

    fn sync_data(&self) -> io::Result<()> {
        self.handle
            .flush()
            .map_err(|e| js_err("OPFS flush", e))
    }

    fn close(&self) -> io::Result<()> {
        self.handle.close();
        Ok(())
    }
}
