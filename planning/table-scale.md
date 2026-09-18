# Table scale (100k rows)

> **Status:** Measured 2026-09-18. Not a product change: a stress harness plus
> findings. The write, query, and UI layers were timed separately so a "the
> table is slow" report can name the actual leg.
>
> Related: [`index-performance.md`](./index-performance.md) (query planner,
> exact counts, cursor pagination),
> [`disk-storage-and-persistence-optimization.md`](./disk-storage-and-persistence-optimization.md)
> (full Loro snapshots on every commit),
> [`table-view-filters.md`](./table-view-filters.md) (sort / filter on views).

## How to re-run

```
# Store / query (native redb — the same engine as OPFS WASM)
cargo test -p atomic_lib --features db-redb --test table_scale -- --ignored --nocapture

# Browser write + Collection + grid (default 1000 rows; 100k is hours)
TABLE_STRESS=1 npx playwright test tests/table-stress.spec.ts --workers=1 --reporter=line
TABLE_STRESS=1 TABLE_STRESS_N=5000 npx playwright test tests/table-stress.spec.ts --workers=1 --reporter=line
```

`TABLE_STRESS_N` caps the Rust test (default 100000). `TABLE_STRESS_FULL_BODIES=1`
also serialises every nested body at the largest N.

## What a table open actually does

`useTableData` queries `parent=<table>` **and** `isA=<row class>` with
`pageSize: 30`. Extra AND filters force `query_complex` (the QueryMembers
index). Default sort is `sortOrder`.

`Collection.fetchPageFromLocalDb` then **does not pass `limit`, `offset`, or
`sort_by`**. It asks the WASM DB for every matching subject **with JSON-AD
bodies** (`includeResources: true`), hydrates all of them into the JS store,
sorts in JS (WASM DID-drive sort is still broken), and **then** slices the
page. Aggregates, when the view asks for them, walk every match a second time.

The grid itself is `react-window`. It only mounts the visible rows.

## Findings

Numbers filled in from this session's run (native redb on the cloud agent VM,
and Chromium against the local Vite + AtomicServer stack).

### 1. Write path — one genesis commit per row

Each row is a full resource: Ed25519 genesis, a Loro snapshot, PropValSub /
ValPropSub / search tokens / envelope. Native `Db::create_resource`:

| N | create total | ms/row | redb file | bytes/row |
| --- | --- | --- | --- | --- |
| 1,000 | *(run)* | | | |
| 10,000 | | | | |
| 100,000 | | | | |

Browser `store.newResource` + `save()` is the same commit plus a worker
postMessage, OPFS durability tick, and a server POST. At ~tens of ms/row,
100k rows in the UI is not a realistic session.

This is storage, not the table widget. See
[`disk-storage-and-persistence-optimization.md`](./disk-storage-and-persistence-optimization.md):
every commit stores a **full Loro snapshot**, so size tracks `edits × resource
size`.

### 2. Query path — the open-table bottleneck

`Collection.fetchPageFromLocalDb` is O(matches), not O(page). At 100k rows the
store still has to:

1. Build or scan QueryMembers for `parent ∧ isA` (first open).
2. Walk **every** member to produce `totalMembers` (`query_sorted_indexed`
   documents this in-code; issue #290).
3. Materialise a nested body (shallow row + raw Loro snapshot) for **every**
   match, because `include_nested` is on and `limit` is missing.
4. Serialise those bodies to JSON-AD, postMessage them to the main thread,
   `JSON.parse` + hydrate.
5. Sort 100k keys in JS, slice 30.

A page-sized query (30 nested bodies, subjects-only for the rest) is the
cost the grid actually needs. The gap between "unpaged nested" and "page of
30" is the headroom.

| N | nested unpaged (1st) | nested unpaged (2nd) | subjects unpaged | nested page 30 | subjects page 30 | aggregation |
| --- | --- | --- | --- | --- | --- | --- |
| 1,000 | | | | | | |
| 10,000 | | | | | | |
| 100,000 | | | | | | |

### 3. UI — not the 100k problem

`react-window` only renders the viewport. `aria-rowcount` can be 100k while
the DOM holds ~20–40 rows. Scroll should stay cheap **if** the collection
does not re-hydrate every member on each page fetch.

The UI will still hitch if step 2 dumps 100k JSON-AD strings onto the main
thread before the first paint.

## Ranked bottlenecks (after numbers)

1. **Collection local fetch hydrates every row** — `browser/lib/src/collection.ts`
   `fetchPageFromLocalDb`: no `limit`/`offset`, `includeResources: true`,
   client-side sort. This is the table-open cliff, and it is client-side, not
   OPFS-the-filesystem.
2. **Exact `totalMembers` walks the whole index** — `query_sorted_indexed` /
   `query_basic`. Planned in `index-performance.md` as cursor pagination +
   `hasMore`. Not built.
3. **WASM cannot sort DID-scoped queries**, so (1) exists. Fixing sort in the
   local query index would let the worker return a 30-row page.
4. **Write amplification** — one signed Loro snapshot per row. Dominates
   *creating* 100k rows; irrelevant to opening an already-written table.
5. **Aggregates re-walk every match.** Fine for a totals row on a small
   table; another full pass at 100k. Incremental / indexed sums are not built.
6. **OPFS/redb file size** — scales with snapshots + envelopes + inverted
   indexes, not with the 30 visible cells. Open/fsync cost is
   `disk-storage-and-persistence-optimization.md`, layer 1.
7. **The grid (react-window)** — not the limiter, provided (1) is fixed.

## What not to do

- Virtualise harder. The list is already virtual.
- Add a table-specific store. The collection query is generic; tables just
  hit the worst case (parent + class filter + default sort + optional totals).
- Expect 100k interactive creates in the browser. Bulk import needs a
  batched, possibly unsigned-replica, write path that does not exist.

## Next slices (not done here)

1. Pass `limit`/`offset` through `queryLocalDb` and stop hydrating off-page
   bodies. Blocked on (or paired with) WASM DID-drive sort so the page is
   the right 30 rows.
2. Cursor / `hasMore` instead of exact `totalMembers` (`index-performance.md`).
3. Optionally skip `include_nested` for members already in the JS store;
   fetch the visible page's bodies only.
