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

### The fix: coarse materialization + a sparse `datatypes` map — decided

An audit of every `Value`-variant dependency across `lib/` and `server/`
(71 call sites) settles what must be preserved:

- **Collapse (21 sites — COSMETIC + SCALAR).** `Markdown` / `Slug` / `Date` /
  `Uri` → `String`; `Timestamp` → `Integer`. Nothing matches these variants
  meaningfully; `.to_int()` already abstracts `Integer`/`Timestamp`. Loro can
  be naive here, exactly like JSON-AD.
- **Preserve (47 sites — STRUCTURAL-REF + STRUCTURAL-SHAPE).** Whether a value
  is a *reference* (`AtomicUrl` / `ResourceArray` / `NestedResource`) and, for
  lists, whether it holds refs or objects (`ResourceArray` vs `JsonArray`).
  This drives reference indexing (`to_indexable_atoms`,
  `to_reference_index_strings`), hierarchy/permission checks (`hierarchy.rs`),
  class membership (`to_subjects`) and export traversal. The
  `starts_with("http"|"did:")` heuristic in `loro_value_to_atomic_value` is the
  unsafe stand-in — it mis-types URL-shaped plain strings, misses relative-path
  refs, and **cannot classify an empty list**.

So the goal is not "preserve all 14 `Value` variants" — it is **preserve
reference-ness and array shape, collapse the rest.**

Two options were considered for the bit that must survive:

- **A — datatype-aware materialization.** Look up each Property's `datatype`.
  Costs a per-property lookup on the hot read path, for a distinction that is
  "plain string" the large majority of the time.
- **B — sparse type tag (chosen).** Persist the load-bearing tag in the doc.
  No store handle, no read-time lookup; materialization stays pure and total,
  and the heuristic is deleted. Nothing is deployed, so re-encoding costs zero.

**Reference-ness is a per-property fact**, not per-value — a property always
holds references or never does (it *is* the Property's `datatype`). So the tag
is a sparse, stable, per-property mark, not a per-value wrapper.

**Encoding — sibling `datatypes` map.** Do **not** wrap values in a nested
`{d, v}` LoroMap: that changes the CRDT merge unit, and field-wise LWW can
splice a type from one peer onto another peer's value. Instead:

- `properties` LoroMap — unchanged: native primitives, numbers stay numbers,
  arrays stay `LoroList`s. Each value remains a single LWW register / native
  container.
- `datatypes` LoroMap (sibling) — `property_url → tag`, written **only** for
  properties whose Loro primitive is load-bearing-ambiguous (ref-strings,
  lists, maps). One LWW register per such property; changes only if the
  property's type changes.

**Materialized `Value` set.** Materialization produces only these; lists and
maps always carry a tag, scalars and plain strings never do:

| Loro primitive | `datatypes` tag | materialized `Value` |
| --- | --- | --- |
| `Bool` | (none) | `Boolean` |
| `Double` | (none) | `Float` |
| `I64` | (none) | `Integer` |
| `String` | (none) | `String` |
| `String` | `atomicUrl` | `AtomicUrl` |
| `String` | `json` | `Json` |
| `List` | `resourceArray` | `ResourceArray` |
| `List` | `jsonArray` | `JsonArray` |
| `Map` | `resource` | `NestedResource` |

`Markdown` / `Slug` / `Date` / `Uri` / `Timestamp` are **never materialized** —
they collapse. The `starts_with` heuristic and the `value.to_string()` fallback
in `loro_value_to_atomic_value` / `set_property` are both removed. The five
tags (`atomicUrl`, `json`, `resourceArray`, `jsonArray`, `resource`) are the
entire vocabulary.

**Cross-language convention.** The tag rides the `loroUpdate` wire payload, so
the Rust (`lib/src/loro.rs`) and TypeScript (`browser/lib`, see `AGENTS.md`
§"Loro value serialization") Loro layers must adopt the `datatypes` map in
lockstep. Flutter rides the Rust layer. Document the convention (update the
`AGENTS.md` note).

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

**One canonical representation: the Loro document (a snapshot, *with* its
oplog history).** Everything else is a derived cache.

| Layer | Canonical | Derived cache |
| --- | --- | --- |
| On disk | Loro snapshot — `Tree::LoroSnapshots` | `Tree::Resources` (`PropVals`) — query/index cache, rebuildable |
| In transport | Loro bytes — commit `loroUpdate`, sync snapshots/deltas | — |
| In memory | the `Resource`'s Loro doc | `Resource.propvals` — a memoized projection |
| Current-state read (HTTP GET, query) | — | `PropVals` (in-memory + on-disk cache) |

A Loro snapshot already carries history, so "persist the doc" = persist
history (the History page reads it). The `PropVals` cache is never authored
directly — it is materialized from the doc and may be dropped/rebuilt.

```text
write:  set*(prop, val) → Loro doc  (fallible: doc writes can fail)
                              │
                              ├──▶ Resource.propvals  (memoized cache, refreshed)
                              ▼
        persist:  Tree::LoroSnapshots (snapshot)  +  Tree::Resources (projection)
                  ── one transaction, snapshot derived via build_state_doc() ──

sync:   receive Loro bytes → merge into Tree::LoroSnapshots
                           → refresh projection + index from the merged doc
                           (never get_resource — no auth/extender/endpoint work)

read:   get_resource → Tree::Resources projection (fast path: query/display)
                     → Tree::LoroSnapshots only when history/merge is needed
```

- **One canonical store per layer** — no split where the doc is canonical on
  disk but `PropVals` is canonical in memory. Mutations target the doc;
  `PropVals` (in `Resource` and in `Tree::Resources`) is always derived.
- Because doc writes are fallible, **mutation methods are fallible** — no
  `let _` swallowing. `set_unsafe` is the legacy infallible holdout to fix.
- `loroUpdate` exists only in-memory and on the wire (commits, JSON-AD); it is
  never persisted inside the `Tree::Resources` blob.
- Snapshot + projection written in **one transaction**.
- **Commits & native resources are the exception** — a commit is signed and
  immutable, never a CRDT; it stays a `PropVals`-native row in
  `Tree::Resources` with no Loro doc. (Bootstrap vocabulary may join them —
  Phase 3.)
- **Sync never calls `get_resource`.** Its transport + merge logic is pure Loro
  (already true in `engine.rs` / `peer.rs`). After merging it refreshes the
  derived projection + index directly from the merged doc — a lightweight
  `doc → PropVals → atoms → index` step, with no auth / extender / endpoint
  machinery. `get_resource` stays the heavy *reader* path for a requesting
  agent.

## Implementation phases

### Phase 0 — independent bug fixes (no model change) — done

- [x] `recursive_remove`: also remove `Tree::LoroSnapshots` row (keyed by
      `pure_id()`, in the same transaction) and collect removed subjects;
      `remove_resource` tombstones them after the transaction applies.
      `recursive_remove` now also looks resources up by `pure_id()` so
      `?drive=`-hinted subjects are not silently missed.
- [x] `ws_apply::apply_destroy`: dropped the mis-keyed
      `kv.remove(LoroSnapshots, subject.as_bytes())`; snapshot removal now
      happens inside `remove_resource` keyed by `pure_id()`.
- [x] Tests in `lib/src/db/test.rs`: `remove_resource_deletes_loro_snapshot`
      (no orphan + tombstone) and
      `remove_resource_with_drive_hint_subject_deletes_snapshot`.
- [x] Regression: full `atomic_lib` suite + `sync::` tests green; no new
      clippy warnings.

### Phase 1 — faithful typed round-trip (the gate)

- [x] Decide approach → **B**, coarse materialization + sparse `datatypes`
      map. Audit of `lib/`+`server/` (71 sites) confirmed cosmetic variants
      collapse; ~47 sites need reference-ness / array shape.
- [x] Rust: `set_property` writes a tag into a sibling `datatypes` LoroMap for
      ref-strings, lists and nested objects (`datatype_tag` in `loro.rs`);
      `loro_value_to_atomic_value_tagged` reads it, used by
      `materialize_propvals_from_loro_doc` and `import_update_with_diff`. The
      `starts_with` heuristic is **retained as a fallback** for untagged
      values — needed until the browser also emits the map.
- [x] Round-trip test (Rust): `datatype_tags_preserve_load_bearing_variants`
      in `loro.rs` — tagged variants + empty `ResourceArray` survive a
      snapshot round-trip; plain strings stay untagged.
- [x] TypeScript (write side): `browser/lib` stamps the `datatypes` map at
      sign time — `Resource.writeDatatypeTags` (cache-only, no fetch) +
      `datatypeTag` helper in `datatypes.ts`, unit-tested. Tags `atomicUrl` /
      `resourceArray` / `json`; `jsonArray` and nested `resource` have no TS
      `Datatype` and stay untagged (rare in the browser → server heuristic).
      No read side: TS materializes to JSON and has no typed `Value` enum —
      datatype comes from the ontology, so it stays naive by design.
- [x] Verify extenders / `check_required_props`: the full regression suite
      (`atomic_lib` 153, `atomic-server` 26, `--test sync`) exercises both with
      tags active and stays green. The defensive `AtomicUrl || String` matches
      (`plugin.rs`, `parse.rs`) intentionally stay until the heuristic is gone.
- [x] Update the `AGENTS.md` Loro-serialization note to the new convention.
- [ ] **Remaining gate-completion step.** Add an explicit `string` tag (and
      tags for the rest) so *every* value is tagged — only then is an untagged
      string unambiguous. Then delete the `starts_with` heuristic, the
      `value.to_string()` fallback and the no-tag fallback path, and simplify
      the defensive `AtomicUrl || String` matches. Needs full Rust + TS tag
      coverage first.

### Phase 2 — the Loro doc is canonical; `PropVals` is a derived cache

The doc is the write target both in memory and on disk. `Resource.propvals`
becomes a memoized projection of the doc; `Tree::Resources` becomes a
rebuildable on-disk cache. No layer has a second source of truth.

#### 2a — mutation is doc-first and fallible — **deferred (attempted, reverted)**

> **Attempted and reverted.** Making `set_unsafe` materialize a doc for every
> resource broke commit signing: a commit is a native, signed, immutable
> resource, but `set_unsafe` gave the *commit resource* a Loro doc, and
> `propvals_for_serialization` then re-derived the commit's `loroUpdate` field
> from `doc.export_snapshot()`. A Loro snapshot embeds a random peer id, so
> client-sign and server-verify produced different bytes → "Incorrect
> signature for Commit". An `is_commit_did()` guard cannot fix this: the
> commit's subject is a placeholder when the client signs and
> `did:ad:commit:…` when the server verifies, so any subject-based gate makes
> the two sides serialize differently.
>
> **The real blocker is the serialization layer**, not the setters:
> `propvals_for_serialization` injects `loroUpdate` whenever a doc exists.
> Before 2a can land safely:
> 1. Commit signing/verification must serialize the explicit `propvals`
>    only — never re-derive `loroUpdate` from `self.loro`.
> 2. `loroUpdate` injection into JSON-AD must be an explicit transport
>    decision, not an automatic side-effect of "a doc exists".
>
> Only then is making `set_unsafe` doc-first (and the ~120-call-site
> fallibility sweep) safe. 2a is also not required for the disk/transport
> vision — 2b/2c already deliver that. Best bundled with the legacy
> `CommitBuilder` removal. The doc-first in-memory `Resource` is a real
> redesign, deferred deliberately.

#### 2b — `add_resource_opts`: snapshot + projection in one transaction — done

- [x] `add_resource_opts` derives the snapshot via `build_state_doc()?` and
      writes `Tree::LoroSnapshots` + `Tree::Resources` in one transaction for
      every non-commit resource — the `!contains_key(LORO_UPDATE)` conditional
      is gone. Invariant established: every CRDT-resource blob write is paired
      with a current snapshot. Test:
      `add_resource_opts_always_writes_loro_snapshot`.

#### 2c — stop persisting `loroUpdate` in the `Tree::Resources` blob — done

- [x] `add_resource_opts` and `add_resource_tx` strip the `loroUpdate` propval
      from the blob for non-commit subjects (commits keep it — it is their
      signed payload). `Tree::Resources` is now a pure derived cache; the
      snapshot lives only in `Tree::LoroSnapshots`. `loroUpdate` still rides
      the wire via `propvals_for_serialization`. Test asserts the blob has no
      `loroUpdate` while the in-memory resource still does (snapshot overlay).

#### 2d — collapse the fallback chains — **deferred**

> The `build_state_doc` / `materialized_state` fallback (live doc →
> `loroUpdate` propval → seed from propvals) is **not** gratuitous: it adapts
> three genuine input forms — an in-memory live doc, a wire-received
> `loroUpdate` propval (still carried in JSON-AD so the browser can seed its
> LoroDoc), and a raw-propvals resource (freshly built / bootstrap). The
> `loroUpdate`-propval rung is still load-bearing for any resource parsed from
> the wire before it is promoted to a live doc. Collapsing the chain needs one
> input form eliminated — i.e. 2a (everything has a doc) or a wire-format
> change. The `commit.rs` signing chain is likewise tied to the legacy
> `CommitBuilder`. Deferred with 2a.

- [x] Sync write path (`engine.rs`): dropped the `get_resource` call in
      `import_sync_push` and `handle_sync_deltas` — `apply_state_doc` replaces
      propvals wholesale, so the read was discarded.
      `ws_apply::apply_state_update_inner` still uses `get_resource` for the
      live UPDATE path; fold it into 2b's one-transaction rework.

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
2. Tag vocabulary — short tokens (`markdown`, as in the table) or the canonical
   Atomic datatype URLs? Tokens are compact; URLs match the Property's
   `datatype` field directly. Leaning tokens — snapshots compress repeated
   strings anyway.

Resolved: B changes the `loroUpdate` wire payload (it now carries the
`datatypes` map). Since nothing is deployed, no compatibility shim is needed —
Rust and TS just adopt it together.

## Related plans

| Doc | Relationship |
| --- | --- |
| [`unified-data-layer.md`](./unified-data-layer.md) | Browser cache/outbox assume one authoritative state per resource. |
| [`unified-sync.md`](./unified-sync.md) | Sync engine already treats `Tree::LoroSnapshots` as authoritative. |
| [`sync.md`](./sync.md) | `loroUpdate` delta on the WS `COMMIT` wire — unchanged by this plan. |
| [`atomic-lib-runtime.md`](./atomic-lib-runtime.md) | `Db` is the local node; this defines its storage invariant. |
