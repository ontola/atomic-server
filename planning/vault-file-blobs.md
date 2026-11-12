# Cloud Vault file contents

Goal: files count toward Vault storage and restore with the drive, with the same
end-to-end encryption as the rest of the vault.

## Design

- **Sealed per vault.** Every chunk of a file is an envelope of kind `Blob`
  (`vault/envelope.rs`), encrypted on the device under the drive key's blob
  subkey. The control plane and the bucket only see ciphertext.
- **Addressed by a keyed hash.** A file's id is
  `DriveVaultKey::blob_id(plaintext)`, keyed BLAKE3 of its bytes, derived from
  the drive key (stable across key epochs). Identical files in one vault collapse
  to one object set; identical bytes in two vaults produce unrelated ids, so
  nothing links two vaults and nothing is shared or deduplicated across them.
- **Layout.** `vault/<drive_pseudonym>/blobs/<keyed-hash hex>/<chunk:06>`, inside
  the drive prefix (removing a vault removes its files). 8 MiB plaintext chunks,
  growing in whole MiB past 64 chunks (`blob_chunks`, a pure function of the
  length; at most 63 MiB per chunk, so about 4 GiB per file). A sealed chunk is
  `BLOB_SEAL_OVERHEAD` (46) bytes larger.
- **Control plane (atomic-saas `main`).** Objects of kind `blob` with
  `content_hash` = the keyed id and `chunk_index`; `size_bytes` is the sealed
  size and is what the vault is charged. `upload-urls` answers `already_stored`
  per object for the same enrollment (no PUT, no confirm). No `chunk_count`, no
  proofs, no conditional PUT, no cross-vault anything.
- **Plain hash stays local.** The plain BLAKE3 (`File.internalId`) never leaves
  the device. A restore opens every stored file, computes its plain BLAKE3, and
  stores it only if a File resource of the drive names that hash, so nothing
  unverified reaches the blob store and a swapped, reordered or short chunk set
  fails the keyed-id check in `open_blob`.

## Done

- `lib/src/vault/sync.rs`: `blob_object_key` / `parse_blob_key`, `blob_chunks`,
  `seal_blob_chunk`, `open_blob`, `restore_blob_group`, `export_vault_blobs`,
  `import_vault_blobs`. `import_vault_batch` skips blob objects (they sit under
  the drive prefix but are not history). Tests: sealed round trip with a
  multi-chunk file, same file twice in one vault uploads one blob, two vaults
  with identical bytes have unrelated ids and independent restores, missing and
  corrupt files are counted, chunk swap/reorder/short/wrong-key fail.
- WASM `ClientDb`: `vaultFileHashes`, `vaultBlobPresent`, `vaultBlobOpen(hash,
  key, epoch)` (verifies the bytes against their hash, derives the id, returns
  the plan with sealed sizes), `vaultBlobChunk` (returns the sealed chunk),
  `vaultBlobClose`, `vaultBlobRestore(key, epoch, id, sealedChunks, wanted)`.
  Worker RPC mirrors them.
- Browser (`helpers/managed/vault.ts`): `backupDrive` runs `backupBlobs` after
  the history pass (and when the history had nothing new). `restoreDrive` and
  `restoreDriveToSnapshot` (the snapshot picker) run `restoreDriveBlobs`; the
  snapshot path wants the snapshot's own files (read from `internalId` in its
  resources), not the drive's current ones. Outcomes are reported as restored /
  present / missing / unreadable.
- A small localStorage cache (plain hash to keyed id, per drive) saves reading
  every file on each pass just to learn an id the vault already holds. Pure
  speed: a missing or wrong entry only means the file is read.
- VaultPanel and the docs say files are included, encrypted on the device like
  everything else, and counted toward this backup's storage.

## `retain-blobs`

An ordinary backup never calls it: a device with an incomplete replica would
start the undelete clock on files other devices still use. It is called only
from the explicit "Compress now" / "Discard history" pass (`retainBlobs: true`
through `runVaultBackup`), and then only when every File resource's id resolved
on this device (stored, known from the id cache, or too large to ever be
stored). If any referenced file is missing locally the call is skipped, because
its id is unknown and leaving it out would mark a live blob unused.

## Left

1. Whether "Compress now" is authoritative enough for the live set is a product
   call: it proves this device's checkpoint covers the lanes it names, which is
   the same claim a checkpoint already makes, but it does not prove the device
   has synced every File resource. If that is not acceptable, drop the call and
   reclaim unreferenced blobs another way (for example a dedicated "Free up
   files" action).
2. Memory: the browser store (redb in OPFS) returns a file as one value, so one
   whole file sits in WASM memory while it is uploaded or restored (restore also
   holds its chunks in JS). A ranged read in the blob store would remove that.
3. A restore from a downloaded backup file does not carry files.
4. Restore opens every stored file once to learn its plain hash, including files
   deleted since. A per-vault index of keyed id to plain hash, sealed in a
   checkpoint, would avoid that.
5. Server GC: the control plane's `blob_gc.rs` assumes it owns its bucket
   prefix. Vault objects live under `vault/`, so keep them out of its scope.
