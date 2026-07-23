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

/// The OPFS root directory of this origin.
async fn opfs_root() -> Result<web_sys::FileSystemDirectoryHandle, JsValue> {
    let global: web_sys::WorkerGlobalScope = js_sys::global().unchecked_into();
    let storage = global.navigator().storage();
    Ok(JsFuture::from(storage.get_directory())
        .await?
        .unchecked_into())
}

/// Whether a file exists in the OPFS root. Errors other than NotFound
/// propagate.
pub async fn file_exists(filename: &str) -> Result<bool, JsValue> {
    let root = opfs_root().await?;
    match JsFuture::from(root.get_file_handle(filename)).await {
        Ok(_) => Ok(true),
        Err(e) => {
            if e.clone()
                .dyn_into::<web_sys::DomException>()
                .is_ok_and(|ex| ex.name() == "NotFoundError")
            {
                Ok(false)
            } else {
                Err(e)
            }
        }
    }
}

/// Delete a file from the OPFS root.
pub async fn remove_file(filename: &str) -> Result<(), JsValue> {
    let root = opfs_root().await?;
    JsFuture::from(root.remove_entry(filename)).await?;
    Ok(())
}

/// One-time migration of the pre-split single database file into a per-agent
/// database. Copies `legacy` into `target` (encrypting when `key` is given),
/// then deletes `legacy`. Returns whether a migration happened.
///
/// No-ops when `legacy` is missing or `target` already exists — the copy must
/// never clobber an existing per-agent database. Both files' sync-access
/// handles are closed before returning so the caller can open `target`
/// normally afterwards (OPFS handles are exclusive per file).
pub async fn migrate_legacy_db(
    legacy: &str,
    target: &str,
    key: Option<&[u8; 32]>,
) -> Result<bool, String> {
    let err = |m: &str, e: JsValue| format!("{m}: {e:?}");

    if !file_exists(legacy).await.map_err(|e| err("check legacy", e))? {
        return Ok(false);
    }
    if file_exists(target).await.map_err(|e| err("check target", e))? {
        return Ok(false);
    }

    let src = OpfsBackend::open(legacy)
        .await
        .map_err(|e| err("open legacy", e))?;
    let len = redb::StorageBackend::len(&src).map_err(|e| e.to_string())?;
    if len == 0 {
        redb::StorageBackend::close(&src).map_err(|e| e.to_string())?;
        remove_file(legacy).await.map_err(|e| err("remove legacy", e))?;
        return Ok(false);
    }

    let dst_raw = OpfsBackend::open(target)
        .await
        .map_err(|e| err("open target", e))?;
    let copy_result = match key {
        Some(key) => {
            let dst = super::encrypted_backend::EncryptedBackend::new(dst_raw, key)
                .map_err(|e| e.to_string())?;
            copy_backend(&src, &dst, len).and_then(|_| {
                redb::StorageBackend::sync_data(&dst)?;
                redb::StorageBackend::close(&dst)
            })
        }
        None => copy_backend(&src, &dst_raw, len).and_then(|_| {
            redb::StorageBackend::sync_data(&dst_raw)?;
            redb::StorageBackend::close(&dst_raw)
        }),
    };
    let _ = redb::StorageBackend::close(&src);
    copy_result.map_err(|e| format!("copy legacy db: {e}"))?;

    remove_file(legacy).await.map_err(|e| err("remove legacy", e))?;
    Ok(true)
}

/// Copy `len` bytes between two storage backends in chunks.
fn copy_backend(
    src: &impl redb::StorageBackend,
    dst: &impl redb::StorageBackend,
    len: u64,
) -> std::io::Result<()> {
    const CHUNK: usize = 1 << 20;
    let mut buf = vec![0u8; CHUNK];
    let mut offset = 0u64;
    while offset < len {
        let n = CHUNK.min((len - offset) as usize);
        src.read(offset, &mut buf[..n])?;
        dst.write(offset, &buf[..n])?;
        offset += n as u64;
    }
    Ok(())
}

impl OpfsBackend {
    /// Open (or create) a file in OPFS and return a synchronous access handle.
    /// This is async because getting the directory/file handle requires promises,
    /// but once created, all subsequent I/O is synchronous.
    pub async fn open(filename: &str) -> Result<Self, JsValue> {
        let root_dir = opfs_root().await?;

        let opts = web_sys::FileSystemGetFileOptions::new();
        opts.set_create(true);
        let file_handle: web_sys::FileSystemFileHandle =
            JsFuture::from(root_dir.get_file_handle_with_options(filename, &opts))
                .await?
                .unchecked_into();

        // Retry createSyncAccessHandle a few times — in dev (HMR), a previous
        // worker may still hold the lock briefly before being GC'd.
        let mut last_err = JsValue::NULL;
        for attempt in 0..5 {
            match JsFuture::from(file_handle.create_sync_access_handle()).await {
                Ok(handle) => {
                    return Ok(OpfsBackend {
                        handle: handle.unchecked_into(),
                    });
                }
                Err(e) => {
                    last_err = e;
                    if attempt < 4 {
                        // Wait 200ms before retrying
                        let promise = js_sys::Promise::new(&mut |resolve, _| {
                            let global: web_sys::WorkerGlobalScope =
                                js_sys::global().unchecked_into();
                            global
                                .set_timeout_with_callback_and_timeout_and_arguments_0(
                                    &resolve, 200,
                                )
                                .unwrap();
                        });
                        JsFuture::from(promise).await.unwrap();
                    }
                }
            }
        }

        Err(last_err)
    }
}

fn js_err(msg: &str, e: JsValue) -> io::Error {
    io::Error::other(format!("{}: {:?}", msg, e))
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
        self.handle.flush().map_err(|e| js_err("OPFS flush", e))
    }

    fn close(&self) -> io::Result<()> {
        self.handle.close();
        Ok(())
    }
}
