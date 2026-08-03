# Commit Performance

> **Status:** In progress (2026-08-03). Diagnosis + first tranche of fixes.
> Related: [`disk-storage-and-persistence-optimization.md`](./disk-storage-and-persistence-optimization.md)
> (full-snapshot `loroUpdate` growth), [`index-performance.md`](./index-performance.md)
> (read/query side).

## Goal

Cut the per-commit CPU and payload cost on the library apply/sign path
(`Resource::save_locally` / `Db::apply_commit`), which the lifecycle bench
puts at ~3–4ms/op for small resources.

## Findings

### Finding 1 — `Resource::clone` / `build_state_doc` snapshot round-trip

`Resource::clone` and `build_state_doc` (when a live doc exists) both did
`export_snapshot()` + `from_snapshot()`. Every commit applied through
`validate_and_build_response` paid this **twice** (outer clone into
`apply_changes`, inner clone for `resource_old`) plus a third round-trip
inside `build_state_doc` for the working doc.

Loro already exposes `LoroDoc::fork()` for an in-memory independent copy
(different PeerID, O(n) structure clone, no serialize/deserialize).

### Finding 2 — double clone of `resource_old`

`validate_and_build_response` cloned into `apply_changes`, which cloned
again for `CommitApplied.resource_old`. The caller already holds the
pre-edit resource; one clone (for the response / rights check) is enough.

### Finding 3 — `sign_at` always exported a full snapshot

Documented in `disk-storage-and-persistence-optimization.md`: when
`CommitBuilder` set/remove ran on an existing resource, `sign_at` called
`export_snapshot()` despite its docstring promising an incremental update.
That bloated per-commit `loroUpdate` payloads and storage (O(edits ×
resource size)).

**Pitfall:** the incremental baseline must be a *really persisted* snapshot
(the `loroUpdate` propval / `LoroSnapshots` row). A propvals-rebuilt working
copy is not a baseline the receiver shares — exporting a delta against it
makes first-save / genesis commits land empty (`push_propval` regression).

### Finding 4 — redundant snapshot export after apply (deferred)

`apply_state_doc` exports a snapshot into the `loroUpdate` propval; then
`set(lastCommit)` mutates the live doc; then `materialized_state()`
exports again for `Tree::LoroSnapshots`. Skipping the first export needs
care around tests that assert a propval snapshot immediately after
`apply_changes`. Left for a follow-up.

## Fixes (this pass)

| Fix | Status |
| --- | --- |
| `AtomicLoroDoc::fork` + use in `Resource::clone` / `build_state_doc` | **this pass** |
| Drop inner clone in `apply_changes`; caller keeps `resource_old` | **this pass** |
| `sign_at` exports `export_updates_since(base_vv)` when prior state exists | **this pass** |
| `sign()` forks live doc instead of export→reimport before set/remove | **this pass** |
| Defer first post-apply snapshot export | deferred |
| Criterion `commit_bench` for clone / sign / apply stages | **this pass** |

## Benchmarks

```
cargo bench -p atomic_lib --bench commit_bench --features db-redb
cargo bench -p atomic_lib --bench lifecycle_bench --features db-redb
```
