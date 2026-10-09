# Durable writes, incremental backup and a Postgres KvStore

Status: durable writes shipped (issue #2156, group commit), now chosen per
commit by the client; backup and Postgres are design only.

## 1. Durable writes (done)

An acknowledged commit used to be written with `redb::Durability::None` and made
durable by a 100 ms flush tick, so `kill -9` or power loss could drop commits the
client had been told succeeded. First attempt: make every commit durable by
default (group commit). That cost throughput for everyone, so the choice moved to
the client: durability is a property of the REQUEST, not of the signed commit
(signature, hash and sync are unchanged).

`RedbStore` takes a `Durability` (`lib/src/db/redb_store.rs`), the server-side
floor, configured with `--durability` / `ATOMIC_DURABILITY`:

| floor | acknowledged when | notes |
| --- | --- | --- |
| `none` (default) | the write committed in memory | flushed every 100 ms; a request that asks for durability is still honoured |
| `always` (was `group`) | an fsync covering the write finished | concurrent writers share that fsync |
| `immediate` | the write's own fsync finished | tests only; 2-phase commit per write |

Per commit: `KvStore::flush_durable()` (`Db::flush_durable()`) returns once
everything written before the call is fsynced. On `RedbStore` under floor `none`
it queues a sentinel write through the same group commit, so concurrent durable
requests share one fsync and the fsync covers all earlier plain writes. Under
`always`/`immediate` it is a no-op (nothing pending). Request plumbing:

- WebSocket: capability `commit-durable`, frame `COMMIT_DURABLE (0x17)` with the
  `COMMIT` payload; the handler applies the commit, awaits `flush_durable` on
  `spawn_blocking`, then sends `COMMIT_OK`. Plain `COMMIT`s are answered at once.
- HTTP: `POST /commit?durable=true`.
- Iroh engine (`sync/engine.rs`): same, after `apply_peer_commit`. The
  browser-peer (OPFS) responder does not (nothing to fsync).
- `@tomic/lib`: `resource.save({ durable: true })`, `Store` option
  `defaultDurable` / `setDefaultDurable`; the flag lives on the outbox entry
  (persisted), falls back to a plain `COMMIT` when the server lacks the
  capability.

Mixed use is the point: durable commits join the shared fsync, plain ones return
immediately and ride the tick.

Group commit (`RedbStore::group_write`): a writer queues its operations; the
first writer that finds no leader running becomes the leader, takes everything
queued so far, applies it in ONE write transaction with one fsync (redb
two-phase commit, so the allocator state is persisted and the next open after a
crash skips the repair scan) and hands every writer its result. Writers arriving
during that fsync form the next group, so batches grow with load and a lone
writer pays exactly one plain durable commit. A write is acknowledged only after
the transaction holding it was fsynced. A first attempt (commit each write
without fsync, then let a leader run a separate flush) shared almost nothing:
the first writer to finish became leader at once and covered only itself.
The in-memory and OPFS stores stay on `none`: nothing to fsync, and the browser
has one thread.

Also found while measuring: `RedbStore::remove` of an absent key opened a full
write transaction, and the commit path clears a tombstone that way before every
commit, so each commit cost two durable transactions. It now returns without
writing when the key is not there.

Measured (before the per-commit flag; the `group` rows are what floor `always` and a durable request cost; release, 1000 commits, ext4 on a virtio disk shared with other
builds, so absolute numbers move by 2-10x between runs; compare within a run).
Commits per second:

| level | mode (`group` = today's `always`) | 1 writer | 8 writers |
| --- | --- | --- | --- |
| raw store | none (old) | 29051 | 12339 |
| raw store | group | 1350 | 3367 |
| raw store | immediate | 1265 | 1164 |
| full `Db` commit | none (old) | 280 | 641 |
| full `Db` commit | group | 156 | 557 |
| full `Db` commit | immediate | 153 | 335 |

8-way group commit needed about 240-290 fsynced transactions for 1000 commits.
A full commit costs ~3.6 ms of CPU, so durable group commit is 1.8x slower for a
single sequential writer (one 2-fsync transaction, ~2.8 ms here) and within 15%
under concurrency. The default is now `none` (fast); `always` and per-commit durable requests pay this price only when asked for. Dropping redb's
two-phase commit (one fsync instead of two) doubled raw throughput but moved the
full `Db` numbers by less than noise, and it brings back the slow full-scan
repair after a crash, so it was not taken.

- [x] `Durability` enum (`none` default, `always`, `immediate`; `group` parses as `always`), config flag and env var
- [x] per-commit durability: `flush_durable`, `COMMIT_DURABLE`, `?durable=true`, `@tomic/lib` option
- [ ] re-measure the numbers above for `none` + a durable request ratio
- [x] group commit leader/follower in `RedbStore::write_ops`
- [x] `commit_batch` (import path) acknowledged at the same level
- [x] crash test: child process, kill -9 after an acknowledged write (`lib/tests/durable_writes.rs`)
- [x] benchmark (`bench_durability_throughput`, ignored; run with `--release`)
- [ ] Open: callers that block a tokio worker in `apply_batch` now also block while
      waiting for the fsync. If a profile shows reader starvation under write load,
      move the commit pipeline onto `spawn_blocking` rather than lowering durability.
- [ ] Open: callers that need durability on embeds (Flutter, desktop) call
      `Db::flush_durable` themselves after a commit; no UI option yet.

## 2. Online incremental backup (design)

Goal: a running server produces a backup that can be restored to a consistent
state, and the second backup only ships what changed.

What a backup must contain, and why a raw file copy is not enough:

- `Tree::Resources` + `Tree::LoroSnapshots`: the materialized row and the Loro
  snapshot. The snapshot is the source of truth (`planning/loro-source-of-truth.md`);
  rows can be rebuilt from it, so a minimal backup is snapshots only.
- `Tree::Envelopes`: the signed commit envelopes (`lib/src/envelopes.rs`). These
  are the audit floor; they are not derivable from the snapshot. With retention
  `all` they are the signed history and must be backed up with the same
  consistency point as the snapshot they explain.
- `Tree::Blobs` (content addressed, immutable) and uploaded files.
- Identity and config: `PluginMeta` (node key, Iroh peers), `AppAgent`,
  `PluginSecret` (encrypted with the node key, which lives in the config dir and
  has to be backed up separately).
- Not backed up: `QueryMembers`, `WatchedQueries`, `PropValSub`, `ValPropSub`,
  `Search*` are derived and rebuild on demand.

Approach, in order of preference:

1. **Loro-native incremental.** Per resource keep the version vector at the last
   backup; `doc.export(ExportMode::updates(&vv))` yields only the new ops. A
   backup is then a manifest `{taken_at, per-subject vv}` plus a stream of
   `(subject, loro_update)` records, appended to object storage. Restore =
   import every update into a fresh store. This reuses the sync engine's
   `engine.rs` diff (`SYNC_DIFF`), so the backup target is just another peer
   that only receives. Deletions need a tombstone record because a destroy is a
   commit, not a Loro op.
2. **Envelope stream.** Ship each accepted commit envelope (already signed and
   self-verifying) in commit order. Restore replays through `apply_commit`.
   Simple and verifiable, but retention `latest` drops history, so it cannot
   restore a store by itself; use it for the audit trail, not as the only copy.
3. **redb file snapshot.** `Database::begin_read()` gives a consistent MVCC view
   at no write cost; copy the tables out in key order. Full only (redb has no
   page-level incremental), so use it for the monthly baseline.

Consistency: take the read transaction first, record its commit sequence number
(the `commit_seq` used by group commit), then export. Anything committed after
is picked up by the next incremental, keyed by the sequence/vv recorded in the
manifest.

- [ ] manifest format and object layout (`backup/<node>/<ts>/manifest.json`, `updates/<n>.bin`)
- [ ] `atomic-server backup --to <dir|s3-url> [--since <manifest>]`
- [ ] `atomic-server restore --from ...`, restore into an empty store only
- [ ] blobs: copy by hash, skip those already present in the target
- [ ] encrypt backups with a key the operator holds, not the node key
- [ ] restore test: backup, destroy store, restore, compare `all_resources` and envelopes
- [ ] backup of envelopes with retention `latest`: document that history is lost

## 3. Postgres `KvStore` (design)

`KvStore` (`lib/src/db/kv_store.rs`) is the seam: `get/insert/remove/contains_key`,
`scan_prefix`, `range`, `range_page`, `iter_tree`, `clear_tree`, atomic
`apply_batch`, `flush`, `begin_batch/commit_batch`, `len`. A Postgres backend
implements these and nothing above it changes.

Schema: one table, `kv(tree smallint, k bytea, v bytea, primary key (tree, k))`.
`bytea` compares bytewise, which matches redb's lexicographic order, so
`range` and `scan_prefix` are `WHERE tree=$1 AND k >= $2 AND k < $3 ORDER BY k`
(`prefix_upper_bound` already exists in `redb_store.rs`) and `reverse` is
`ORDER BY k DESC`. `Tree::name()` (which carries the layout version) maps to the
`tree` id through a small lookup table so a layout bump is a new id, as with the
redb table names.

Semantics to preserve:

- `apply_batch` atomic across trees: one transaction with `INSERT .. ON CONFLICT
  DO UPDATE` and `DELETE`, batched via `UNNEST` arrays.
- Durability: Postgres already group-commits WAL, so acknowledged means the
  `COMMIT` returned with `synchronous_commit=on`. `Durability::None` maps to
  `synchronous_commit=off` per transaction; `flush` becomes a no-op.
- Read-your-writes inside `begin_batch`: reuse `BatchBuffer`; it is store
  independent and should move out of `redb_store.rs`.
- The trait is synchronous and called from async code. Use `postgres` (blocking)
  with a small `r2d2` pool, or a runtime handle plus `block_in_place`. Pick one
  after measuring; do not introduce an async trait for this.
- Iterators return `Box<dyn Iterator + Send>` over an owned snapshot today
  (`iter_tree` collects). For large trees page by key (`range_page`) rather than
  hold a server-side cursor open.
- Single writer: redb's exclusive file lock gave "one process per store" for free.
  Postgres needs an advisory lock (`pg_try_advisory_lock`) held for the process
  lifetime, otherwise two servers corrupt query indexes.
- WASM/OPFS and the Flutter embed stay on redb; this is server-only
  (`feature = "db-postgres"`).

Why bother: managed backups/PITR, replicas for read scaling, and per-tenant
storage limits for the hosted offering, at the cost of a network hop per
`get`. The resource-row cache and the fetch counters
(`Db::get_resource_call_count`) show how chatty the query path is; measure that
before promising latency.

- [ ] extract `BatchBuffer` and `prefix_upper_bound` into `kv_store.rs`
- [ ] `PostgresStore` behind `db-postgres`, with the schema above and a migration
- [ ] run the shared KvStore conformance tests against it (write them against the trait first; today they are redb-specific)
- [ ] advisory-lock single writer
- [ ] `--database-url` / `ATOMIC_DATABASE_URL`; refuse to start with both a redb file and a URL
- [ ] migration tool: redb -> Postgres via `iter_tree`, then verify counts per tree
- [ ] benchmark: query-heavy workload and 1000-commit sequential/8-way (same harness as section 1)
- [ ] backup: Postgres PITR replaces section 2 option 3; options 1 and 2 still apply
