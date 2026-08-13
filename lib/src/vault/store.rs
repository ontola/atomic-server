//! Where sealed vault objects live — Phase 1 of
//! `atomic-saas/planning/CLOUD_VAULT_ARCHITECTURE.md`.
//!
//! Deliberately the narrowest interface that a backup and a restore need. The
//! hosted path puts presigned S3 URLs behind it and the control plane never
//! sees plaintext; the filesystem implementation here needs no infrastructure
//! at all, which is what lets the format's round-trip tests run as plain unit
//! tests and what makes an independent restore checkable — the point of
//! decision 8.

use crate::errors::AtomicResult;

/// Object storage for sealed vault objects, addressed by key.
///
/// Keys mirror the S3 layout in the architecture doc
/// (`vault/<pseudonym>/lanes/<device>/seg-000001.pack`), so a filesystem
/// vault and a bucket hold the same shape and a restore does not care which it
/// is reading.
pub trait VaultObjectStore {
    fn put(&self, key: &str, bytes: &[u8]) -> AtomicResult<()>;
    fn get(&self, key: &str) -> AtomicResult<Vec<u8>>;
    /// Keys under `prefix`, sorted. Sorted because lane segments must be
    /// replayed in order: `seg-000002` builds on `seg-000001`.
    fn list(&self, prefix: &str) -> AtomicResult<Vec<String>>;
}

/// An in-memory vault. Useful in tests and in WASM, where there is no
/// filesystem to speak of.
#[derive(Default)]
pub struct MemoryVaultStore {
    objects: std::sync::Mutex<std::collections::BTreeMap<String, Vec<u8>>>,
}

impl MemoryVaultStore {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn len(&self) -> usize {
        self.objects.lock().expect("vault store lock").len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

impl VaultObjectStore for MemoryVaultStore {
    fn put(&self, key: &str, bytes: &[u8]) -> AtomicResult<()> {
        self.objects
            .lock()
            .map_err(|_| "vault store lock poisoned")?
            .insert(key.to_string(), bytes.to_vec());
        Ok(())
    }

    fn get(&self, key: &str) -> AtomicResult<Vec<u8>> {
        self.objects
            .lock()
            .map_err(|_| "vault store lock poisoned")?
            .get(key)
            .cloned()
            .ok_or_else(|| format!("vault object not found: {key}").into())
    }

    fn list(&self, prefix: &str) -> AtomicResult<Vec<String>> {
        // BTreeMap iteration is already sorted, which is the ordering guarantee
        // the trait promises.
        Ok(self
            .objects
            .lock()
            .map_err(|_| "vault store lock poisoned")?
            .keys()
            .filter(|k| k.starts_with(prefix))
            .cloned()
            .collect())
    }
}

/// A vault in a directory. Object keys become relative paths, so the layout on
/// disk is readable and diffable — handy when debugging a restore, and it means
/// `find` is a valid vault inspection tool.
#[cfg(not(target_arch = "wasm32"))]
pub struct FilesystemVaultStore {
    root: std::path::PathBuf,
}

#[cfg(not(target_arch = "wasm32"))]
impl FilesystemVaultStore {
    pub fn new(root: impl Into<std::path::PathBuf>) -> Self {
        Self { root: root.into() }
    }

    /// Reject keys that would escape the vault root. These keys come from a
    /// pack index or a server listing, neither of which a restoring client
    /// should trust with the ability to write outside the directory it was
    /// pointed at.
    fn resolve(&self, key: &str) -> AtomicResult<std::path::PathBuf> {
        if key.is_empty() {
            return Err("vault object key must not be empty".into());
        }
        if key.starts_with('/') || key.contains("..") || key.contains('\\') {
            return Err(format!("refusing unsafe vault object key: {key}").into());
        }
        Ok(self.root.join(key))
    }
}

#[cfg(not(target_arch = "wasm32"))]
impl VaultObjectStore for FilesystemVaultStore {
    fn put(&self, key: &str, bytes: &[u8]) -> AtomicResult<()> {
        let path = self.resolve(key)?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("failed to create vault directory: {e}"))?;
        }
        std::fs::write(&path, bytes).map_err(|e| format!("failed to write vault object: {e}"))?;
        Ok(())
    }

    fn get(&self, key: &str) -> AtomicResult<Vec<u8>> {
        let path = self.resolve(key)?;
        std::fs::read(&path).map_err(|e| format!("vault object not found: {key} ({e})").into())
    }

    fn list(&self, prefix: &str) -> AtomicResult<Vec<String>> {
        let mut found = Vec::new();
        collect_files(&self.root, &self.root, &mut found)?;
        found.retain(|k| k.starts_with(prefix));
        found.sort();
        Ok(found)
    }
}

#[cfg(not(target_arch = "wasm32"))]
fn collect_files(
    root: &std::path::Path,
    dir: &std::path::Path,
    out: &mut Vec<String>,
) -> AtomicResult<()> {
    if !dir.exists() {
        return Ok(());
    }
    let entries =
        std::fs::read_dir(dir).map_err(|e| format!("failed to read vault directory: {e}"))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("failed to read vault entry: {e}"))?;
        let path = entry.path();
        if path.is_dir() {
            collect_files(root, &path, out)?;
        } else if let Ok(relative) = path.strip_prefix(root) {
            out.push(relative.to_string_lossy().replace('\\', "/"));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn exercise(store: &dyn VaultObjectStore) {
        store
            .put("vault/p/lanes/d/seg-000002.pack", b"two")
            .unwrap();
        store
            .put("vault/p/lanes/d/seg-000001.pack", b"one")
            .unwrap();
        store
            .put("vault/p/checkpoints/ckpt-1.loro", b"ckpt")
            .unwrap();

        assert_eq!(
            store.get("vault/p/lanes/d/seg-000001.pack").unwrap(),
            b"one"
        );

        // Sorted, so segments replay in the order they were written.
        let lane = store.list("vault/p/lanes/d/").unwrap();
        assert_eq!(
            lane,
            vec![
                "vault/p/lanes/d/seg-000001.pack".to_string(),
                "vault/p/lanes/d/seg-000002.pack".to_string()
            ]
        );

        assert_eq!(store.list("vault/p/").unwrap().len(), 3);
        assert!(store.list("vault/nothing/").unwrap().is_empty());
        assert!(store.get("vault/p/missing").is_err());
    }

    /// Same convention as `tests/cross_process_sync.rs` — this crate has no
    /// tempfile dependency and one test directory is not worth adding it.
    struct TempDir(std::path::PathBuf);

    impl TempDir {
        fn new(name: &str) -> Self {
            let path = std::env::temp_dir().join(format!(
                "atomic-vault-{name}-{}-{:?}",
                std::process::id(),
                std::thread::current().id()
            ));
            let _ = std::fs::remove_dir_all(&path);
            std::fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn memory_store_behaves() {
        exercise(&MemoryVaultStore::new());
    }

    #[test]
    fn filesystem_store_behaves() {
        let dir = TempDir::new("behaves");
        exercise(&FilesystemVaultStore::new(&dir.0));
    }

    #[test]
    fn filesystem_store_survives_a_reopen() {
        let dir = TempDir::new("reopen");
        FilesystemVaultStore::new(&dir.0)
            .put("vault/p/lanes/d/seg-000001.pack", b"durable")
            .unwrap();
        // A restore runs in a different process than the backup did.
        let reopened = FilesystemVaultStore::new(&dir.0);
        assert_eq!(
            reopened.get("vault/p/lanes/d/seg-000001.pack").unwrap(),
            b"durable"
        );
    }

    #[test]
    fn filesystem_store_refuses_to_escape_its_root() {
        let dir = TempDir::new("escape");
        let store = FilesystemVaultStore::new(&dir.0);
        for key in ["../escape", "vault/../../escape", "/etc/passwd", ""] {
            assert!(store.put(key, b"x").is_err(), "should reject {key:?}");
            assert!(store.get(key).is_err(), "should reject {key:?}");
        }
    }
}
