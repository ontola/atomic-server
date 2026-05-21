# Loro as the single source of truth

> **Status:** Active plan (2026-05). Defines the storage end-state that
> [`unified-data-layer.md`](./unified-data-layer.md) and [`unified-sync.md`](./unified-sync.md)
> assume but do not specify. Concerns `lib/src` (core `Db`) and the Flutter
> embedding (`flutter/rust`, `flutter/lib`).

## Goal

For mutable resources, the **Loro CRDT document is the authoritative state**.
The flat `PropVals` map becomes a **derived read/index projection**, rebuilt
from the doc on every write and never authored independently.

Today the dependency runs backwards: `PropVals` is the primary write target and
the Loro doc is seeded *from* it. The same logical state is also persisted
twice and re-copied up the stack — see [Current state](#current-state).

## Current state (honest)

A single resource's mergeable state exists in up to five representations:

| # | Representation | Where | Notes |
| --- | --- | --- | --- |
| 1 | Loro oplog snapshot | `Tree::LoroSnapshots`, key `pure_id()` | The real merge truth. |
| 2 | `loroUpdate` propval **inside** the `Tree::Resources` blob | `Tree::Resources` | Redundant; after a commit it can be a *stale incremental delta* (see `db.rs` `get_resource` comment). |
| 3 | Flat queryable `PropVals` | `Tree::Resources` | The index/query projection. |
| 4 | Live `Resource` (in-memory doc + undo stack) | Flutter `CANVAS_CACHE` static (`flutter/rust/src/api/simple.rs`) | Undo history persisted nowhere. |
| 5 | Materialized display copies | Dart `CanvasEntry.strokes`, `InfiniteCanvas._strokes`, `_loroStrokeStates` | Two parallel undo trees. |

`encode_propvals` (`db/encoding.rs`) serializes everything, so #2 always lands
in the `Resources` blob. `get_resource` reads `Tree::Resources` then overlays
`Tree::LoroSnapshots` last — i.e. #2 is already treated as disposable on read,
and is allowed to lag on a crash. Making it explicitly derived is the cleanup.

### Independent bugs found while tracing (fix regardless of this plan)

- **Orphaned snapshots.** `recursive_remove` / `remove_resource` (`db.rs`) delete
  the `Tree::Resources` row but never the `Tree::LoroSnapshots` row. Only
  `ws_apply::apply_destroy` cleans snapshots, so local deletes leak forever.
- **Keying mismatch.** `ws_apply::apply_destroy` removes the snapshot with the
  raw frame `subject.as_bytes()`, while every *write* keys by `pure_id()`. A
  subject carrying `?drive=` params misses the row → orphan + resurrection risk.

## The blocker: the Loro doc is a lossy projection

`AtomicLoroDoc::set_property` (`lib/src/loro.rs`) flattens Atomic's typed
`Value` into Loro primitives; `loro_value_to_atomic_value` re-infers the type
heuristically on read. Losses:

| Atomic `Value` | Stored as | Comes back as |
| --- | --- | --- |
| `String` / `Markdown` / `Slug` / `Date` | Loro `String` | `String` — or `AtomicUrl` if it looks like a URL |
| `Integer` / `Timestamp` | Loro `I64` | always `Integer` |
| `ResourceArray` vs `JsonArray` | Loro `List` | sniffed from first element |
| empty list | Loro `List` | always `ResourceArray` |
| other | display string | `String` |

`apply_state_doc` *replaces* propvals with `materialize_propvals_from_loro_doc`,
so **any resource that has been through a sync import already has degraded
datatypes today.** It is tolerated because Atomic's datatype authority is the
*Property* resource, not the `Value` variant — but extenders/validators that
pattern-match `Value::AtomicUrl` and `check_required_props` do care.

A lossy projection cannot be promoted to source of truth. Fixing this is the
gate; nothing else below is safe first.

**Two ways to fix (decide in Phase 1):**

- **A — datatype-aware materialization.** `materialize_propvals_from_loro_doc`
  looks up each Property's `datatype` and parses accordingly. Faithful and in
  the Atomic spirit (datatype lives on the Property), but the function is
  currently pure and would need an `&impl Storelike` handle.
- **B — type-tagged encoding.** Store a datatype discriminant alongside each
  value in the doc. Self-contained, no store lookup, but a doc-format change
  and a migration.

Recommendation: **A**, falling back to a tag only for values whose datatype
cannot be resolved from the Property (unknown/external properties).

## Other things in the way

1. **Write paths author `PropVals` directly.** `add_resource_opts` seeds the
   doc from propvals (see its own comment in `db.rs`). For Loro-as-truth every
   mutation must land in the doc first; `Resource::set*` writes into
   `self.loro`; `sync_propvals_from_loro` becomes the *only* propvals producer.
2. **Commits are not CRDTs.** Signed, immutable, content-addressed — a
   permanent exception (`is_commit_did()` already special-cased). `Tree::Resources`
   stays as native storage for commits and the projection for everything else.
   The model bifurcates: **CRDT resources** vs **native resources**.
3. **Signing determinism.** The doc-seeding hazard (`db.rs` comment: "LWW
   becomes a coin-flip") goes away if signing derives from the doc — but
   `commit.rs`'s `live-doc → propvals.loroUpdate → build_state_doc` fallback
   chain must collapse to one source.
4. **Migration / non-CRDT-origin resources.** Old DBs may lack snapshots;
   external fetched resources and bootstrap vocab arrive as plain propvals.
   Each needs a one-time "ensure a faithful snapshot" pass — correct only
   *after* the Phase 1 fidelity fix.

## Not in the way

- The index/query layer reading `PropVals` — the projection stays, and is good
  for read performance.
- `Tree::LoroSnapshots` already exists and the sync engine already treats it as
  authoritative.

## Target model

```text
write:  mutation → Loro doc (faithful, typed) → snapshot + projection
                       │                            │
                       ▼                            ▼
              Tree::LoroSnapshots            Tree::Resources (PropVals)
              (authoritative, CRDT)          (derived: query/index cache)
                                             — no `loroUpdate` persisted here

read:   get_resource → load projection (fast path: query/display)
                     → load doc only when history/merge is needed

commits & native resources: PropVals-native in Tree::Resources, no doc
```

- One on-disk home for CRDT state: `Tree::LoroSnapshots`.
- `loroUpdate` exists only in-memory and on the wire (commits, JSON-AD); it is
  never persisted inside the `Tree::Resources` blob.
- Snapshot + projection written in **one transaction** (today the sync paths
  `ws_apply.rs` / `engine.rs` do two non-atomic writes).

## Implementation phases

### Phase 0 — independent bug fixes (no model change)

- [ ] `recursive_remove`: also remove `Tree::LoroSnapshots` row (by `pure_id()`)
      and record a tombstone.
- [ ] `ws_apply::apply_destroy`: key the snapshot removal by `pure_id()`.
- [ ] Tests: local delete leaves no orphan snapshot; destroy of a
      `?drive=`-suffixed subject removes the snapshot.

### Phase 1 — faithful typed round-trip (the gate)

- [ ] Decide A vs B (recommend A).
- [ ] Make `materialize_propvals_from_loro_doc` datatype-aware (Property
      lookup); tag fallback for unresolved properties.
- [ ] Property-based test: every `Value` variant round-trips
      doc → propvals → doc unchanged.
- [ ] Verify extenders / `check_required_props` against post-sync resources.

### Phase 2 — flip write authority to the doc

- [ ] `Resource::set*` write into `self.loro`; `PropVals` materialized via
      `sync_propvals_from_loro`.
- [ ] `add_resource_opts` no longer seeds the doc from propvals; persist doc +
      projection in one transaction.
- [ ] Stop persisting `loroUpdate` in the `Tree::Resources` blob (strip in
      `encode_propvals` or before `add_resource_tx`).
- [ ] Collapse the `commit.rs` signing fallback chain to the doc.

### Phase 3 — CRDT / native split

- [ ] Explicit predicate for "is this resource CRDT-backed?" (commits and,
      optionally, bootstrap vocab are native).
- [ ] `build_state_doc` / `materialized_state` simplified — drop the 3-way
      fallback now that there is one source.

### Phase 4 — migration

- [ ] Startup pass: every CRDT resource has a faithful snapshot; backfill from
      propvals via the Phase 1 conversion.
- [ ] `migrate_from_sled` updated to normalize snapshot keys to `pure_id()`.

### Phase 5 — Flutter

- [ ] Decide whether `CANVAS_CACHE` undo history should persist (currently lost
      on remote-import cache eviction — see `unified-sync.md`).
- [ ] Reconcile Dart's two undo trees (`_allActions` vs `_loroStrokeStates`).

## Open questions

1. Bootstrap vocabulary — CRDT-backed (a snapshot per property/class) or native?
2. Phase 1: pure type-tag (B) as a safety net for external properties, or
   accept lossy fallback for those?
3. Does promoting Loro to truth change the `loroUpdate` payload on the wire, or
   only what is persisted? (Plan assumes wire format unchanged.)

## Related plans

| Doc | Relationship |
| --- | --- |
| [`unified-data-layer.md`](./unified-data-layer.md) | Browser cache/outbox assume one authoritative state per resource. |
| [`unified-sync.md`](./unified-sync.md) | Sync engine already treats `Tree::LoroSnapshots` as authoritative. |
| [`sync.md`](./sync.md) | `loroUpdate` delta on the WS `COMMIT` wire — unchanged by this plan. |
| [`atomic-lib-runtime.md`](./atomic-lib-runtime.md) | `Db` is the local node; this defines its storage invariant. |
