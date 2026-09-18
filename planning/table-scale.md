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
# Store / query (native redb — the same engine as OPFS WASM). Release numbers
# are the ones in this doc; debug is ~10× slower on create.
cargo test -p atomic_lib --features db-redb --test table_scale --release -- --ignored --nocapture

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

Native redb, `--release`, cloud-agent VM, 2026-09-18. Same crate the WASM
OPFS ClientDb compiles. Full log: `table_scale_n100000_release.log`.

### 1. Write path — one genesis commit per row

Each row is a full resource: Ed25519 genesis, a Loro snapshot, PropValSub /
ValPropSub / search tokens / envelope. Native `Db::create_resource`:

| N | create total | ms/row | redb file | bytes/row |
| --- | --- | --- | --- | --- |
| 1,000 | 2.4 s | 2.42 | 64 MB | 67 KB |
| 10,000 | 39 s | 3.90 | 514 MB | 54 KB |
| 100,000 | **686 s (11.4 min)** | **6.86** | **4.0 GB** | 43 KB |

Create **slows as the store grows** (2.4 → 6.9 ms/row). The last 90k rows
were 7.2 ms each. That is index + snapshot write amplification, not the
table widget. A 100k-row table is a **4 GB** redb file before anyone opens
it. Browser `save()` also pays a worker postMessage, OPFS tick, and a
server POST — tens of ms/row, so 100k interactive creates are not a
session.

See [`disk-storage-and-persistence-optimization.md`](./disk-storage-and-persistence-optimization.md):
every commit stores a **full Loro snapshot**.

### 2. Query path — the open-table bottleneck

`Collection.fetchPageFromLocalDb` is O(matches), not O(page). At 100k it:

1. Builds/scans QueryMembers for `parent ∧ isA`.
2. Walks **every** member for `totalMembers` (issue #290).
3. Materialises a nested body (shallow row + raw Loro snapshot) for **every**
   match — `include_nested` on, `limit` missing.
4. Serialises those bodies to JSON-AD (~4.3 KB/row with `loroUpdate` →
   **~430 MB** at 100k), postMessages them, `JSON.parse`s + hydrates.
5. Sorts 100k keys in JS, slices 30.

| N | nested unpaged 1st | nested unpaged 2nd | subjects unpaged | nested page 30 | subjects page 30 | aggregation |
| --- | --- | --- | --- | --- | --- | --- |
| 1,000 | 30 ms | 15 ms | 1.3 ms | 0.7 ms | 0.2 ms | 10 ms |
| 10,000 | 239 ms | 171 ms | 11 ms | 3.0 ms | 1.9 ms | 93 ms |
| 100,000 | **4.6 s** | **2.3 s** | 156 ms | **33 ms** | 21 ms | **1.0 s** |

Unpaged nested is ~linear and ~140× a page of 30 at 100k. The page is what
the grid needs. Subjects-only unpaged is 30× cheaper than nested — the
bodies, not the index walk, dominate. Aggregates are a second full pass
(~1 s at 100k).

JSON-AD of 30 nested bodies is 131 KB / 0.3 ms at every N. JSON-AD of
*all* matches is 4.3 KB/row (measured at 1k and 10k).

### 3. UI — not the 100k problem

`react-window` only renders the viewport. `aria-rowcount` can be 100k while
the DOM holds ~20–40 rows. Scroll stays cheap **if** the collection does
not dump every member onto the main thread first. That dump is step 2.

## Ranked bottlenecks

1. **Collection local fetch hydrates every row** — `browser/lib/src/collection.ts`
   `fetchPageFromLocalDb`: no `limit`/`offset`, `includeResources: true`,
   client-side sort. **4.6 s store-only at 100k**, plus ~430 MB of JSON-AD
   across the worker boundary. This is the table-open cliff. Not
   OPFS-the-filesystem; it is the query the client asks OPFS to run.
2. **Write amplification / store growth** — 6.9 ms/row by 100k, 4 GB file.
   Dominates *creating* a huge table. Opening an already-written one is (1).
3. **Aggregates re-walk every match** — 1.0 s extra at 100k. Fine on a
   small table; another full pass at this N.
4. **Exact `totalMembers` walks the whole index** — 21–33 ms even for a
   30-row page at 100k. Planned as cursor pagination + `hasMore` in
   `index-performance.md`. Not built.
5. **WASM cannot sort DID-scoped queries**, so (1) exists. Fixing sort in
   the local query index would let the worker return the right 30 rows.
6. **The grid (react-window)** — not the limiter, provided (1) is fixed.

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
