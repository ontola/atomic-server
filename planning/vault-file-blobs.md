# Cloud Vault file contents

Goal: files count toward Vault storage and restore with the drive. Decided:

- **Stored once.** One physical object per file, addressed by plain BLAKE3 (the
  hash in `File.internalId` and the server blob store), shared by every vault.
  Not sealed with the drive key; the rest of the vault stays E2E encrypted and
  carries only File metadata + the hash.
- **Charged per reference.** Each vault counts the full size of each file it
  references toward its own quota, even when another vault stored the bytes.
- **Refcounted delete.** The object is deleted only when no vault references it
  (after the undelete window). A deleting `retain-blobs` drops that vault's
  reference only.

## Done (lib, `lib/src/vault/sync.rs`)

- Key layout `vault-blobs/<hash>/<chunk:06>`, 8 MiB chunks, outside
  `vault/<pseudonym>/` so drive listings/removal never touch shared objects.
- `export_vault_blobs`: one upload per distinct hash, skips hashes already in
  the store, returns the live hash set for `retain-blobs`.
- `import_vault_blobs`: after restore, reassembles chunks, verifies BLAKE3 vs
  `internalId`, stores; reports missing and unreadable.
- Tests incl. the A/B scenario at client level.

## Done (wired end to end)

- atomic-saas: global blob key, per-vault reference record, proof-of-possession
  claims, create-only PUT with hash verification on confirm, `retain-blobs`,
  refcounted delete.
- WASM `ClientDb.vaultFileHashes`, `vaultBlobOpen/Chunk/Proof/Close`,
  `vaultBlobPresent`, `vaultBlobRestore`: chunk layout (`blob_chunks`, a pure
  function of the length, up to 64 chunks of 8 to 64 MiB), proof hashes and
  hash-verified assembly are `lib/src/vault/sync.rs`, not TypeScript.
- Browser (`helpers/managed/vault.ts`): `backupDrive` runs `backupBlobs` after
  the history pass (and when the history had nothing new), `restoreDrive` runs
  `restoreDriveBlobs` for the cloud source and reports restored / present /
  missing / unreadable. VaultPanel and the docs say files are included, stored
  once, not end-to-end encrypted, and counted per vault.

## Left

1. Memory: the browser store (redb in OPFS) returns a file as one value, so one
   whole file sits in WASM memory while it is uploaded or restored (restore also
   holds its chunks in JS). A ranged read in the blob store would remove that.
2. A restore from a downloaded backup file or a snapshot does not carry files.
3. `retain-blobs` runs with whatever File resources this device holds. A device
   that has not synced the whole drive yet would start the undelete clock on
   files it simply does not know about; a later pass from a complete device
   clears it.

## Security questions

- **Proof of possession.** A bare hash must not let a vault claim (and be
  charged for / restore) someone else's file. Restore only works if the client
  can fetch; to claim without uploading the client should prove it holds the
  bytes (server-chosen random ranges, or a hash over a nonce-prefixed range the
  server recomputes from the stored object).
- **Poisoning.** Shared plain-hash keys mean the first writer wins; an upload
  of wrong bytes under another's hash corrupts it. The control plane must
  verify the hash on confirm (or use conditional create-only PUTs).
- **Confidentiality.** Unsealed bytes are readable by the operator and a known
  hash confirms a known file. Accepted by this design; say so in the docs.
- **Server GC.** `blob_gc.rs` assumes it exclusively owns its bucket prefix. If
  the shared vault store is the server's blob bucket, GC would delete vault-only
  objects: use a separate prefix or make GC refcount-aware.
