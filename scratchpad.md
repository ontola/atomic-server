Atomic-server OpenDAL PR review checklist

- Code changes
  - [x] Added opendal dep w/ services-sled
  - [x] Added `dal_resources: Operator` to Db
  - [x] Init OpenDAL Sled under `<db>/opendal` tree `resources_v1`
  - [x] Read path switched to `dal_resources.read(subject)`
  - [ ] Write path still uses Sled `resources.insert`
  - [ ] Delete path still uses Sled remove
  - [ ] Indexing and queries use Sled trees only
  - [ ] Concurrency/runtime: embedded tokio runtime introduced

- Risks
  - Read-after-write inconsistency (OpenDAL store empty)
  - Double storage cost; unclear source of truth
  - Migration undefined; no backfill from existing sled tree
  - Runtime nesting problems in servers already using Tokio

- Proposed plan
  1) Decide strategy: a) OpenDAL-only with `services-sled` as one profile; or b) dual-write with single-read (fastest) via profiles like terraphim.
  2) If (a): wrap all CRUD in OpenDAL; drop direct sled access for propvals; use sled only for indexes until ported.
  3) If (b): implement `save_to_all` concept in atomic Db for propvals (write to N stores); pick fastest for read; keep indexes coherent on one canonical store.
  4) Remove embedded runtime; move read calls to async surface or blocking shim.
  5) Add migration: backfill OpenDAL from Sled existing items. One-time tool or lazy-on-read write-through.
  6) Tests: CRUD, consistency across stores, performance benchmark selecting fastest profile.

- Notes
  - terraphim-persistence crate already models profiles + speed test + save_to_all + read_fastest. Could reuse patterns and helper code or even the crate.
  - Consider features for memory/dashmap/rocksdb/redb/sqlite - align with atomic-server env.
