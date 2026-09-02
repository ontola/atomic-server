# Encrypted vault format (open spec)

> **Status:** v1 implemented in `lib/src/vault/` (2026-08-04). Phase 0 (keys)
> and Phase 1 (envelope, pack, backup/restore) are in; incremental cursors,
> checkpoints and compression are Phase 2 and will extend this document without
> changing what is written here.

This is the **format** half of Cloud Vault. The product plan and the hosted
control plane are internal to atomic-saas; the format is deliberately not,
because a blind backup you cannot independently verify or restore is a promise
rather than a property. Everything needed to write a third-party restore tool
is in this file and in `lib/src/vault/`.

## What the vault is

Encrypted, append-only backup of a drive's CRDT history, stored as opaque
objects. The party holding the objects can see how many objects exist, how big
they are, when they arrived and which device lane they belong to. It cannot see
subjects, property values, resource contents, resource counts, or file bytes.

Clients encrypt locally and talk to object storage directly via presigned URLs.
The hosted control plane brokers those URLs, quota and checkpoint publication;
object bytes never pass through it.

## Key hierarchy

```text
agent Ed25519 identity ──wraps──▶ DriveVaultKey (random 256-bit, per drive, epoch-numbered)
                                        │ BLAKE3 derive_key
                                        ├─▶ pack/envelope subkey
                                        ├─▶ blob-chunk subkey
                                        ├─▶ blob-id subkey (keyed hashing)
                                        └─▶ index/checkpoint-metadata subkey
```

Subkeys are `blake3::derive_key(context, drive_key)` with these exact context
strings — they are format, not implementation detail, and changing one changes
every subkey derived from it:

| Purpose | Context string |
| --- | --- |
| Pack / checkpoint | `atomic-vault 2026 pack envelope` |
| Blob chunk | `atomic-vault 2026 blob chunk` |
| Blob id | `atomic-vault 2026 blob id` |
| Index / checkpoint metadata | `atomic-vault 2026 index metadata` |

Notes that matter for anyone reimplementing this:

- **The agent key never encrypts bulk data.** Key rotation, drive sharing and
  multi-agent drives all depend on the wrapping key being separable from the
  data key. It *wraps* the `DriveVaultKey` — the KEK is
  `blake3::derive_key("atomic-vault 2026 agent secret wrapper", agent_secret)`,
  derived rather than used directly so the same bytes never both sign commits
  and decrypt backups.

  This is what lets a device be wiped and recovered with no extra secret:
  whatever restores the identity restores every drive key. Additional wrappers
  (a passkey PRF assertion, a generated recovery code) can be added to the same
  envelope later without re-encrypting anything, because what is wrapped is a
  32-byte DEK rather than the data.
- **Blob ids are keyed hashes**, `blake3::keyed_hash(blob_id_subkey, plaintext)`.
  Keyed rather than plain so two drives holding identical bytes produce
  different ids — a plain content hash would let the storage operator detect
  that two users hold the same file.
- **Blob ids derive from the drive key, not the epoch key**, so re-keying does
  not orphan every chunk already uploaded.
- **Epochs travel with the object**, never inferred. A key at epoch N refuses
  objects sealed at epoch N-1 rather than attempting them.

## Object envelope

Every stored object is `header ‖ nonce ‖ ciphertext+tag`.

| Field | Bytes | Notes |
| --- | --- | --- |
| version | 1 | Currently `1`. Unknown versions are refused, not partially parsed. |
| kind | 1 | `1` pack, `2` checkpoint, `3` index, `4` blob |
| key_epoch | 4 | big-endian |
| nonce | 24 | random per seal |
| ciphertext | rest | XChaCha20-Poly1305, includes the 16-byte tag |

**Cipher:** XChaCha20-Poly1305 over the subkey for `kind`'s purpose.
XChaCha rather than ChaCha because its 192-bit nonce is safe to draw at random
with no counter state. Vault objects are produced by several devices that never
coordinate, so any scheme requiring globally unique counters would be a
correctness hazard the first time two devices backed up at once.

**The 6-byte header is authenticated as AEAD associated data.** It is
cleartext, because the storage operator must be able to route and garbage-
collect objects without a key, but it cannot be altered: relabelling a pack as
an index makes the object fail to open rather than be reinterpreted under a
different subkey.

The header is deliberately dull. Everything in it is visible to the operator,
so anything identifying a resource, subject or count belongs in the ciphertext.

## Pack format

The plaintext inside a `kind = pack` object is MessagePack:

```rust
struct Pack {
    format: u8,            // currently 1
    entries: Vec<PackEntry>,
    tombstones: Vec<String>,  // deleted subjects, pure_id() form
}

struct PackEntry {
    subject: String,       // pure_id(), matching Tree::LoroSnapshots keys
    update: Vec<u8>,       // AtomicLoroDoc::export_updates_since output
}
```

Two invariants carry the design:

1. **Entries hold Loro *updates*, never snapshots.** Update size tracks edit
   size; snapshot size tracks document size. Backing up a one-word change must
   cost one word. A restore imports these with `import_update`.
2. **Tombstones travel with the updates they accompany.** A restore applying
   updates without them would resurrect deleted resources — a delete is data,
   not an absence of it.

   A deletion is detected by comparing the drive walk against what this lane
   backed up last time, held in each device's local `Db` and never uploaded
   (decision 2: incremental cursors are local, never shared metadata). Only
   subjects carrying a local tombstone are claimed: a subject that merely
   vanished could be a transient read failure, and an invented tombstone would
   *delete real data* on restore. A restorer applying a tombstone must remove
   the resource and its children, not merely record a marker — the marker alone
   leaves an earlier segment's oplog free to bring it back.

MessagePack rather than JSON because these are byte payloads, and base64ing
every CRDT update into JSON would inflate the one thing the format exists to
keep small.

Batching many resources into one object is also what hides resource counts:
the operator sees one object of some size, not a countable per-resource stream.

## Object layout

```text
vault/<drive-pseudonym>/
  lanes/<device-pubkey>/seg-000001.pack   ← append-only per device
  checkpoints/ckpt-<n>.loro               ← Phase 2
  indexes/ckpt-<n>.idx                    ← Phase 2
  blobs/<keyed-hash>/<chunk>              ← Phase 2
```

The drive pseudonym is a salted hash of the drive DID, computed by the control
plane; a self-hosted vault may use any stable string.

**Segment numbers are zero-padded to six digits** so lexical listing order
matches segment order. Both S3 listing and filesystem traversal sort lexically,
and `seg-10` sorting before `seg-2` would replay history backwards.

**Each device appends only to its own lane.** No shared manifest, no
compare-and-swap, no merge-retry path. Concurrent backup from several devices
is correct by construction because Loro deduplicates ops by `(peerId, counter)`:
importing the same pack twice, or importing overlapping lanes in any order,
converges on the same state.

## Restore

```rust
import_vault_batch(store, key, vault, prefix)
```

Reads every object under `prefix` in sorted order, opens it, decodes the pack,
and merges each entry into the store. Restore **merges rather than overwrites**,
so running it over a partially-synced device converges instead of clobbering
local edits.

Restore imports with validation disabled. It replays history that was already
valid when written, and re-imposing today's required-property rules on old data
would make a schema change retroactively unrestorable — precisely when a backup
matters most.

## What v1 does not do yet

- **Incremental cursors.** Export currently walks a drive and exports each
  resource's full oplog. The format does not change when cursors land: only the
  version vector passed to `export_updates_since` does.
- **Checkpoints, indexes, blob chunking** — Phase 2. The `kind` byte already
  reserves their values.
- **Per-object signatures.** Integrity today comes from the AEAD tag, which
  proves the object was sealed by someone holding the drive key. Signing
  objects with the agent key is a planned addition for provenance across
  multi-agent drives.
- **Compression.** Per-drive trained zstd dictionaries are Phase 2 and will
  apply before encryption (compress-then-encrypt, pack-level).

## Verifying this yourself

`lib/src/vault/` is the reference implementation, and its tests are written to
be readable as claims about the format:

- `a_wiped_store_is_restored_from_the_vault` — back up, discard the store
  entirely, restore into an empty one, compare materialized contents.
- `a_restore_without_the_right_key_fails` — the blind-vault claim.
- `sealed_packs_do_not_reveal_subjects` / `ciphertext_does_not_contain_the_plaintext`.
- `importing_the_same_pack_twice_is_idempotent`.
- `tampering_with_the_header_breaks_decryption`.

Run them with `cargo test --features db-redb vault::`. No server, bucket or
network required — which is the point: a restore path that needs the vendor's
infrastructure is not an independent restore path.

## Related

- `encryption.md` — the broader E2EE exploration this specialises.
- `opfs-per-agent-encryption.md` — local encryption at rest, a different layer.
- `cloud-sync-managed-node.md` — the non-blind hosted tier above this one.
- The hosted control plane, quota model and product strategy live in
  atomic-saas `planning/CLOUD_VAULT_ARCHITECTURE.md` (internal).
