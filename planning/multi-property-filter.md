# Multi-property filtering (AND)

> Status: **In progress** (started 2026-06-13). Goal: queries/collections can
> filter on **multiple `(property, value)` constraints combined with AND**,
> index-backed (sorted + paginated), full-stack (Rust core → server `/query` →
> `@tomic/lib` → WASM client-db → React `useCollection`).
>
> **Phase 1 (Rust core) — DONE & tested.** `QueryFilter` now holds
> `filters: Vec<PropVal>` (AND); `Query` keeps `property`/`value` and gains
> `filters` + `.filter()` / `.class_filter()` builders; encoding serialises the
> vec; `Tree` versions bumped `v3 → v4` (old caches abandoned, rebuilt lazily);
> `should_update_property` generalised to AND; `requires_query_index` routes
> multi-filter to the combined index; `query_complex` gates the one-time index
> build on the full constraint set. `query_index` unit tests pass incl. a new
> `multi_property_and_filter` test. (`PropVal` lives in `storelike` so the
> always-compiled `Query` can use it; `query_index` re-exports it.)
>
> **Phase 2 (server) — DONE & tested.** `CollectionBuilder` gains
> `filters: Vec<(String, String)>`; `collect_members` maps them into the
> `Query`; `construct_collection_from_params` parses a `filters` query param
> (JSON array of `{property, value}`). New lib test
> `collection_multi_property_and_filter` asserts the AND intersection.
>
> **Phase 3 (`@tomic/lib`) — DONE.** `QueryFilter`/`CollectionParams` gain a
> `filters?: PropVal[]`; `CollectionBuilder.addFilter()` / `.setFilters()`;
> `Collection.buildSubject` serialises `filters` as a JSON query param;
> `Collection.filters` getter; `applyResourceChange` AND-matches the extra
> constraints (shared `constraintMatches` helper).
>
> **Phase 4 (WASM client-db) — DONE.** `ClientDbQueryOpts.filters`; worker
> passes it as a 9th arg; `wasm/src/lib.rs::query` deserialises the JS filters
> into `Query.filters`. `pkg` rebuilt + copied to `data-browser/public/wasm`.
>
> **Phase 5 (React) — DONE.** `useCollection` threads `filters` through
> `buildCollection`, the rebuild check, the memo deps, and the membership
> effect deps (stable `filtersKey` JSON dep).
>
> **Phase 6 (e2e) — DONE.** `e2e/tests/multi-property-filter.spec.ts` creates
> three folders and asserts a `name = … AND description = …` filter returns
> only the resource matching both — over BOTH the local WASM/OPFS DB
> (`queryLocalDb`) and the server `/query` endpoint.
>
> **Status: full-stack support complete.**

## Problem

A `QueryFilter` (and `Query`) currently holds **one** `property` + **one**
`value`. That's not enough for real collections:

- **Agent activity feed** — `isA = Commit` **AND** `signer = <agent>`, sorted by
  `createdAt`.
- **Commits about a subject** — `isA = Commit` **AND** `subject = X` (the
  `subject` property alone is used by non-commits too, so a single filter is
  ambiguous).
- **Agent by email** (for `/register`) — `isA = Agent` **AND** `email = X`.

All three are **conjunctions of equality + optional sort**.

## Decision

Make `QueryFilter` store a list of constraints and match with **AND**
semantics, keeping the existing "one Sled prefix per filter, sorted by
`sort_by`, scanned + paginated lexicographically" model. (Option **B** from
issue #548 discussion.)

### Why B (combined index), not A (merge sets at query time)

The activity feed is `isA=Commit AND signer=X`. Option A scans the broadest
single filter first — `isA=Commit` = **every commit** — then filters the rest
in memory: O(all commits). Option B builds a narrow combined index
(`isA=Commit AND signer=X` sorted by `createdAt`) so the scan only touches real
hits. B wins exactly where it hurts.

### Why not the index/query-planner (option C) now

C (user-defined `Index` resources + a query planner) is the right long-term
shape for flexibility — user-tunable write cost, compound multi-prop sort,
OR/NOT. But none of the three use cases need it; they're AND + sort. C is a much
larger build. **B is not a dead end toward C**: the `Vec<constraint>` data model
+ a future `index: bool` persist toggle on `Query` is exactly the substrate a
planner would sit on.

### Boolean beyond AND

- **AND** — now, via the constraint list (conjunction).
- **OR** — handle at the query layer as a **union of AND-collections** (N index
  scans, merge/dedupe). Don't bake OR into the index.
- **NOT / ranges / compound multi-prop sort** — defer to option C.

### Write-amplification note

Watched filters scale with **active collections**, not data volume (one feed =
one watched filter per viewed profile). `check_if_atom_matches_watched_query_filters`
already iterates per-drive; a multi-constraint match is a cheap AND over a
handful of props. Pressure valves if it ever bites (later, not now): an
`index`/persist toggle on `Query`, eviction of unused watched queries.

## Data model

```rust
// query_index.rs
pub struct PropVal {
    pub property: Option<String>,
    pub value: Option<Value>,
}

pub struct QueryFilter {
    pub filters: Vec<PropVal>,   // ANDed. Replaces property/value.
    pub sort_by: Option<String>,
    pub drive: Subject,
}
```

`Option/Option` per constraint preserves today's expressiveness: prop-only,
value-only (any-prop scan — same cost as today), and prop+value. `contains_value`
stays the per-prop match (so array membership — tags, `isA` — keeps working).

Ergonomics on `Query`: `.filter(prop, val)`, `.class_filter(class)`.

## Core matching changes (`lib/src/db/query_index.rs`)

- `find_matching_propval` → returns a match only when **all** constraints match;
  needs to surface enough info to know which props are "constraint props" for
  index maintenance.
- `should_update_property` → update the index key when the changed atom is the
  `sort_by` prop **or** any constraint prop, **and** the resource matches all
  constraints. Generalize the current `(property, value, sort_by)` match table.
- `encode`/`from_bytes` → serialize the `Vec`; keep the existing 0xff /
  `SEPARATION_BIT` collision guard (there's already a regression test).
- `watch()` → require ≥1 constraint.
- `query_sorted_indexed`, `create_query_index_key`, `parse_collection_members_key`
  → unchanged in shape (prefix = encoded filter); only the encoded filter grows.

## Full-stack phases

1. **Rust core** (`lib`): `QueryFilter` + `Query` (`filters` vec, builders),
   index matching/encoding, `Storelike::query`. Port existing single-filter
   call sites to the vec (1 constraint). Unit tests: AND match/no-match,
   encode/decode round-trip, sorted pagination.
2. **Server** (`server`): `/query` endpoint + Collection params accept multiple
   `(property,value)` pairs (querystring + JSON-AD). Back-compat with the
   single `property=`/`value=` params.
3. **`@tomic/lib`**: `QueryFilter` type → `filters` array; `CollectionBuilder`
   gains `addFilter({property, value})` (keep `setProperty/setValue` as sugar
   for one filter); collection subject/param building.
4. **WASM client-db** (`lib/src/db` → `client-db.worker`): `queryLocalDb` +
   index accept multiple constraints so **OPFS and server agree**.
5. **React** (`@tomic/react`): `useCollection` `QueryFilter` → `filters`;
   memo/deps over the array.
6. **Use-case wiring + e2e**: agent activity feed, and an e2e that filters a
   collection on two properties and asserts membership.

Order is flexible but **must end in working full-stack support**. Each phase
keeps the build green; single-filter call sites keep working throughout.

## Test plan

- Rust unit: `should_update_property` for 2+ constraints (all combos of
  prop-only / value-only / prop+value, with and without `sort_by`); encode
  round-trip with a 2-constraint filter (0xff guard); `query_sorted_indexed`
  returns only AND-matches, paginated.
- Server: `/query` with two `(property,value)` pairs returns the intersection.
- e2e: create resources, query a collection on two properties, assert only the
  resource matching both shows up.
