# Disk Storage & Persistence Optimization

> **Status:** Proposal (2026-06-04). Diagnoses why server boot time and overall
> performance degrade as the store grows, and proposes fixes. Builds on
> [`commit-retention-and-state-certificates.md`](./commit-retention-and-state-certificates.md)
> (history retention is node policy) and
> [`loro-source-of-truth.md`](./loro-source-of-truth.md) (Loro is the history
> engine). Related: [`s3-blob-storage.md`](./s3-blob-storage.md) (blob backend),
> [`encryption.md`](./encryption.md) (encrypted envelope/checkpoint size +
> blind-replica compaction), and
> [`llm-wasm-gui-plugins.md`](./llm-wasm-gui-plugins.md) (app Loro payloads and
> blob checkpoints inherit the same growth + retention concerns).

## Thesis

Store size grows **much faster than the user's actual data**, and several costs
scale **O(total file size)** rather than O(working set). The two compound: a
file that bloats super-linearly, multiplied by per-boot costs that scale with
that file. The result is a server whose **boot time and write latency degrade
continuously with age**, independent of how much *live* data it serves.

The fix is two-pronged: **stop writing full state on every commit** (write
incremental Loro updates), and **reclaim space automatically** (auto-compaction
+ history pruning) so the file tracks the working set instead of total history.

## Observed symptoms

Measured on a dev store after a long test session (numbers from
`lib/src/db/redb_store.rs` comments + live logs):

- **5.0 GB** ReDB store file (`~/Library/Application Support/atomic-data/store`)
  from test data alone — thousands of throwaway resources.
- **`Database::create` took 61.98s** to open that file. A fresh store opens in
  **~35ms** (~1800× faster).
- Downstream effect: every read / commit / search / index op on the bloated
  server ran slowly, producing pervasive **e2e timing flakiness** (a clean
  store cut a serial suite from ~13 failures to ~1 real failure + rare flakes).
- Stale `did:ad:<sig>` resources persisted across runs, causing genesis-
  collision (`is_genesis: true, but the resource already exists`) errors when a
  later run re-derived a colliding DID.

## Root cause — two layers

### Layer 1: Boot/open cost is O(file size)

`RedbStore::new_file` → `Database::create` (`lib/src/db/redb_store.rs:124`) cost
scales with the file, for two reasons the code already documents:

1. **`fsync` of the whole file on open.** Per `compact_file` (`redb_store.rs:93-97`):
   the open-time `fsync` "is the dominant cost of `Database::create`" — and on a
   multi-GB file, `fsync` is slow (especially macOS).
2. **Full-scan repair on unclean shutdown.** redb rebuilds allocator state with
   a full-file scan if not closed cleanly — *"measured at 44s on a 3.6 GiB
   store, all of it spent in `Database::create` before the actor system even
   starts"* (`redb_store.rs:135-138`). Mitigated by `set_quick_repair(true)`
   (2-phase commit persists allocator state every write so a clean reopen skips
   the scan), but a `SIGKILL` / crash / power loss at the wrong moment, and the
   raw file size, still land on the slow path.

44s @ 3.6 GiB → 62s @ 5 GiB is linearly consistent.

### Layer 2: The file grows super-linearly in usage

Three compounding behaviors, all in code:

1. **Full Loro snapshots on every commit — not deltas.** `sign_at`
   (`lib/src/commit.rs:1121`) calls `doc.export_snapshot()`, serializing the
   resource's **entire** CRDT document after applying the change. A 1-character
   title edit re-stores the whole resource's Loro state. **NB:** the docstring
   at `commit.rs:1088` says *"an incremental update is exported"*, but the call
   is `export_snapshot()` (full). This mismatch looks **unintended** and is the
   single biggest growth lever.
2. **History retention.** Each commit is retained (the `previousCommit` audit
   chain), and each carries that full-snapshot `loroUpdate`. Storage grows as
   **O(edits × resource size)**, not O(change size). (Retention is meant to be
   optional policy per `commit-retention-and-state-certificates.md`, but the
   default keeps everything.)
3. **No automatic compaction; redb never reclaims dead pages.** Overwrites and
   deletes leave dead pages — the file only ever grows, even when data is
   deleted. Compaction exists but is **manual-only** (`atomic-server compact` →
   `compact_file`, wired in `server/src/bin.rs:119`).

Plus blobs/uploads accumulate alongside (`TABLE_BLOBS` + the `uploads/` dir).

### The compounding effect

```text
file_size      ≈ Σ over all commits ( full snapshot of edited resource )   ← Layer 2
                 + dead pages never reclaimed
boot_cost      ≈ O(file_size)   (fsync + possible repair scan)              ← Layer 1
write_latency  ≈ grows with file_size (allocator pressure, fsync)
```

So a resource edited N times costs ~N full snapshots on disk, none reclaimed,
and every boot re-`fsync`s the whole pile. Age, not live data, drives cost.

## Proposed fixes (rough ROI order)

### 1. Store incremental Loro updates, not full snapshots (highest ROI)

On non-genesis commits, export `doc.export(ExportMode::Update { from })` (the
delta since the last stored version) instead of `export_snapshot()`. This is
what the `commit.rs:1088` docstring already intended.

- Genesis commits still store a full snapshot (no prior state).
- The materialized "current state" snapshot per resource (`TABLE_LORO_SNAPSHOTS`)
  can stay full for fast reads; it's the **per-commit `loroUpdate`** that should
  be a delta — that's the part multiplied by history.
- **First step:** confirm `export_snapshot()` at `commit.rs:1121` is an
  unintended full-write (vs. a deliberate choice for import-merge correctness),
  and that `from` (the prior version vector) is available at sign time.
- **Downstream wins:** the per-commit `loroUpdate` is also the payload that gets
  wrapped as a `kind: delta` envelope in
  [`encryption.md`](./encryption.md#possible-encrypted-replication-shape) and
  synced for app Loro payloads in
  [`llm-wasm-gui-plugins.md`](./llm-wasm-gui-plugins.md). Making it a true delta
  shrinks encrypted envelope size and per-update sync, not just on-disk history.

### 2. Automatic compaction

Don't rely on the manual CLI. Options (not exclusive):

- **Boot-time conditional compact:** if `file_size > k × estimated_live_size`,
  run `compact()` during startup (it already exists). Trade boot time once for
  fast boots after.
- **Background/scheduled compact:** during idle windows, behind the exclusive
  lock, with progress logging.
- Surface store-size + dead-page ratio as a metric so the policy is observable.

### 3. History pruning (ties into commit-retention)

Keep the latest full snapshot + recent deltas; collapse old per-commit
`loroUpdate`s beyond a retention window/policy. This is the storage realization
of `commit-retention-and-state-certificates.md`: retention becomes a node policy
that actually bounds disk, not just a semantic note.

The same retention shape recurs for two consumers and should share a policy:

- **Encrypted checkpoints** (`encryption.md` → "Compaction and retention"): a
  verifier issues a signed `EncryptedCheckpoint` so a blind replica can prune
  covered updates without decrypting. That's this fix, expressed for ciphertext.
- **Blob checkpoints** (`llm-wasm-gui-plugins.md` → "Opaque checkpoint
  application"): each `saveCheckpoint` stores full opaque bytes and keeps
  conflicting heads, so retained checkpoints + branches grow unbounded without a
  pruning/GC policy — the same dead-weight problem as retained Loro snapshots.

### 4. Robust unclean-shutdown path

`set_quick_repair(true)` already mitigates repair-on-open, but verify it holds
under `SIGKILL` at arbitrary points; consider a graceful-shutdown handler
(`SIGTERM` → flush + clean close) so production restarts never hit the scan.

### 5. e2e hygiene (immediate, separate from the above)

e2e must never run against a stale/bloated store (it both slows tests and causes
stale-DID collisions). Provision a **fresh `ATOMIC_DATA_DIR` + `ATOMIC_CACHE_DIR`
per run** (the search/vector index lives under the *cache* dir, not the data
dir — both must be isolated, or the tantivy lock collides). This is a test-infra
change, but it's the fastest path to a non-flaky suite and isolates real bugs
(e.g. the `delete resource` cascade failure) from environmental noise.

## Open questions

- Is `export_snapshot()` at `commit.rs:1121` load-bearing for import-merge
  correctness, or safe to switch to an incremental export? (Determines fix #1.)
- What's the dead-page ratio of a real aged store? Run `atomic-server compact`
  on a production-like store and compare before/after size to size the win.
- Should compaction be opportunistic (boot threshold) or scheduled? What's the
  acceptable one-time boot cost vs. ongoing fast boots trade-off?
- How does this interact with `s3-blob-storage.md` (blobs may move out of redb
  entirely, removing one growth source)?

## Code references

- `lib/src/db/redb_store.rs:93-160` — open path, fsync/repair cost notes,
  `compact_file`, `set_quick_repair`.
- `lib/src/commit.rs:1085-1124` — `sign_at`; `export_snapshot()` at line 1121
  (full snapshot despite "incremental" docstring at 1088).
- `server/src/bin.rs:119` — manual `compact` subcommand wiring.
- `TABLE_LORO_SNAPSHOTS`, `TABLE_BLOBS` — per-resource snapshot + blob storage.
