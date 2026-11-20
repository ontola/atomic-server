//! One verified local file stays open while its encrypted chunks cross IPC.

use std::sync::{Arc, Mutex};

use atomic_lib::{
  vault::{
    blob_export::{prepare_blob_export, seal_export_chunk},
    dek::DriveVaultKey,
  },
  Db,
};

pub(crate) use atomic_lib::vault::blob_export::BlobExportPlan as Plan;

#[derive(Default)]
pub(crate) struct BlobExport {
  state: Mutex<State>,
}

#[derive(Default)]
struct State {
  generation: u64,
  file: Option<(String, Arc<Vec<u8>>)>,
}

impl BlobExport {
  pub(crate) async fn open(
    &self,
    store: &Db,
    hash: &str,
    key: &DriveVaultKey,
  ) -> Result<Plan, String> {
    let generation = self.clear()?;
    let (plan, bytes) = prepare_blob_export(store, hash, key)
      .await
      .map_err(|e| e.to_string())?;
    let Some(bytes) = bytes else {
      return Ok(plan);
    };
    let mut state = self
      .state
      .lock()
      .map_err(|_| "The open file cache is unavailable.")?;
    if state.generation != generation {
      return Err("The file was closed or replaced while opening.".into());
    }
    state.file = Some((hash.to_ascii_lowercase(), Arc::new(bytes)));
    Ok(plan)
  }

  pub(crate) fn chunk(
    &self,
    hash: &str,
    key: &DriveVaultKey,
    index: u32,
  ) -> Result<Vec<u8>, String> {
    let bytes = self
      .state
      .lock()
      .map_err(|_| "The open file cache is unavailable.")?
      .file
      .as_ref()
      .filter(|(opened, _)| *opened == hash.to_ascii_lowercase())
      .map(|(_, bytes)| bytes.clone())
      .ok_or("Call vaultBlobOpen for this file first.")?;
    seal_export_chunk(key, &bytes, index).map_err(|e| e.to_string())
  }

  pub(crate) fn close(&self) -> Result<(), String> {
    self.clear().map(|_| ())
  }

  fn clear(&self) -> Result<u64, String> {
    let mut state = self
      .state
      .lock()
      .map_err(|_| "The open file cache is unavailable.")?;
    state.generation = state.generation.wrapping_add(1);
    state.file = None;
    Ok(state.generation)
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use atomic_lib::vault::sync::{
    blob_id_hex, open_blob, restore_blob_group, seal_blob_chunk, BlobGroupOutcome, BLOB_CHUNK_BYTES,
  };
  use std::collections::HashSet;

  fn hash_of(bytes: &[u8], key: &DriveVaultKey) -> String {
    let sealed = seal_blob_chunk(key, bytes).unwrap();
    open_blob(key, &blob_id_hex(key, bytes), &[&sealed])
      .unwrap()
      .1
  }

  #[test]
  fn native_file_chunks_restore_exact_bytes_and_close_releases_the_file() {
    let runtime = tokio::runtime::Builder::new_current_thread()
      .enable_all()
      .build()
      .unwrap();
    runtime.block_on(async {
      let source = Db::init_temp("native_blob_export_source").await.unwrap();
      let target = Db::init_temp("native_blob_export_target").await.unwrap();
      let key = DriveVaultKey::from_bytes([7; 32], 3);
      let bytes: Vec<u8> = (0..BLOB_CHUNK_BYTES + 31)
        .map(|index| (index % 251) as u8)
        .collect();
      let hash = hash_of(&bytes, &key);
      let raw_hash = crate::vault_ipc::decode_hash(&hash).unwrap();
      source.put_blob(&raw_hash, &bytes).await.unwrap();
      let exporter = BlobExport::default();
      let plan = exporter.open(&source, &hash, &key).await.unwrap();
      assert_eq!(plan.status, "ready");
      assert_eq!(plan.size, bytes.len() as u64);
      assert_eq!(plan.chunks.len(), 2);
      let sealed: Vec<_> = plan
        .chunks
        .iter()
        .map(|chunk| {
          let sealed = exporter.chunk(&hash, &key, chunk.index).unwrap();
          assert_eq!(sealed.len() as u64, chunk.sealed_length);
          sealed
        })
        .collect();
      let refs: Vec<_> = sealed.iter().map(Vec::as_slice).collect();
      let restored = restore_blob_group(
        &target,
        &key,
        &plan.blob_id,
        &refs,
        &HashSet::from([hash.clone()]),
      )
      .await
      .unwrap();
      assert!(matches!(restored, BlobGroupOutcome::Restored(found) if found == hash));
      assert_eq!(target.get_blob(&raw_hash).await.unwrap().unwrap(), bytes);
      assert!(exporter.chunk(&hash, &key, 2).is_err());
      assert!(exporter.chunk(&"00".repeat(32), &key, 0).is_err());
      exporter.close().unwrap();
      assert!(exporter.state.lock().unwrap().file.is_none());
      assert!(exporter.chunk(&hash, &key, 0).is_err());
    });
  }

  #[test]
  fn absent_or_corrupt_file_bytes_cannot_be_opened_for_backup() {
    let runtime = tokio::runtime::Builder::new_current_thread()
      .enable_all()
      .build()
      .unwrap();
    runtime.block_on(async {
      let store = Db::init_temp("native_blob_export_missing").await.unwrap();
      let key = DriveVaultKey::from_bytes([8; 32], 1);
      let hash = hash_of(b"expected contents", &key);
      let exporter = BlobExport::default();
      assert_eq!(
        exporter.open(&store, &hash, &key).await.unwrap().status,
        "missing"
      );
      let raw_hash = crate::vault_ipc::decode_hash(&hash).unwrap();
      store.put_blob(&raw_hash, b"wrong contents").await.unwrap();
      assert_eq!(
        exporter.open(&store, &hash, &key).await.unwrap().status,
        "missing"
      );
      assert!(exporter.state.lock().unwrap().file.is_none());
      assert!(exporter.chunk(&hash, &key, 0).is_err());
    });
  }
}
