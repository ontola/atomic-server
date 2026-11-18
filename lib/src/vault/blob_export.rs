//! Shared preparation and chunk sealing for the browser and native file caches.

use crate::{errors::AtomicResult, Db};

use super::{
    dek::DriveVaultKey,
    sync::{blob_chunks, blob_id_hex, read_verified_blob, seal_blob_chunk, BLOB_SEAL_OVERHEAD},
};

/// What opening one local file found; the serialized shape is shared by IPC
/// and WASM. Only `ready` has a vault id, chunks and cacheable bytes.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlobExportPlan {
    pub status: &'static str,
    pub size: u64,
    pub blob_id: String,
    pub chunks: Vec<BlobExportChunk>,
}

/// One plaintext slice and its sealed upload size.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlobExportChunk {
    pub index: u32,
    pub offset: u64,
    pub length: u64,
    pub sealed_length: u64,
}

/// Read and verify a file once. The caller moves the returned bytes into its
/// single-open-file cache; chunk exports then borrow them without reloading.
pub async fn prepare_blob_export(
    store: &Db,
    hash: &str,
    key: &DriveVaultKey,
) -> AtomicResult<(BlobExportPlan, Option<Vec<u8>>)> {
    let mut plan = BlobExportPlan {
        status: "missing",
        size: 0,
        blob_id: String::new(),
        chunks: vec![],
    };
    let Some(bytes) = read_verified_blob(store, hash).await? else {
        return Ok((plan, None));
    };
    plan.size = bytes.len() as u64;
    let Some(chunks) = blob_chunks(plan.size) else {
        plan.status = "tooLarge";
        return Ok((plan, None));
    };
    plan.status = "ready";
    plan.blob_id = blob_id_hex(key, &bytes);
    plan.chunks = chunks
        .into_iter()
        .map(|chunk| BlobExportChunk {
            index: chunk.index,
            offset: chunk.offset,
            length: chunk.length,
            sealed_length: chunk.length + BLOB_SEAL_OVERHEAD as u64,
        })
        .collect();
    Ok((plan, Some(bytes)))
}

/// Seal exactly one chunk of verified bytes held by the platform cache.
pub fn seal_export_chunk(key: &DriveVaultKey, bytes: &[u8], index: u32) -> AtomicResult<Vec<u8>> {
    let chunk = blob_chunks(bytes.len() as u64)
        .and_then(|chunks| chunks.get(index as usize).copied())
        .ok_or("This file has no such chunk.")?;
    let start = chunk.offset as usize;
    seal_blob_chunk(key, &bytes[start..start + chunk.length as usize])
}
