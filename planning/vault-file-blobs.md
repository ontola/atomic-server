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

## Left (not wired, so UI/docs still must NOT claim files are included)

1. atomic-saas: global blob key; per-enrollment reference record per hash
   (quota); `already_stored` when the hash exists, still recording the
   reference; delete object only at refcount 0; reconcile/drive-removal/
   `retain_blobs` must ignore the shared prefix or be refcount aware. Test:
   A and B reference Z, A retains without it, object stays, B downloads it.
2. WASM: expose plan/chunks/commit per file (avoid whole-drive staging); the
   browser `backupDrive` uploads blob chunks and calls `retain-blobs`.
3. Restore in the browser: `import_vault_blobs` equivalent over downloaded
   chunks; surface missing/unreadable like `objects_unreadable`.
4. Then: remove "file contents excluded" wording (none on develop yet), and
   state in VaultPanel + `docs/src/app/folders-and-drives.md` that files are
   included, stored once and count toward storage; `pnpm clean-translations`.
5. Memory: `get_blob` reads whole files; stream for large files.

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
