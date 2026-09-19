# Table scale (100k rows)

> **Status:** Measured 2026-09-18; table-open path fixed on this branch.
> `Collection.fetchPageFromLocalDb` now passes `limit` / `offset` / `sort_by`
> so WASM returns a page of bodies. Write amplification (4 GB / 99 ms/row)
> is unchanged — see
> [`disk-storage-and-persistence-optimization.md`](./disk-storage-and-persistence-optimization.md).
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

`Collection.fetchPageFromLocalDb` now passes `limit`, `offset`, and `sort_by`.
WASM returns **this page's bodies** plus a full-set `count` and aggregates.
A subjects-only follow-up fills `_queriedMembers` so off-page hydrates do
not inflate `totalMembers`. Stubs that ignore `limit` still take the old
JS sort + slice fallback.

The grid itself is `react-window`. It only mounts the visible rows.

## Findings

Native redb, `--release`, cloud-agent VM, 2026-09-18. Same crate the WASM
OPFS ClientDb compiles. Full log: `table_scale_n100000_release.log`.
Browser numbers (N=1000, Chromium) are in section 3;
`table_stress_e2e_n1000_wait_rows.log`.

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

### 3. Browser (Playwright, N=1000) — same query, plus the worker

`TABLE_STRESS=1` against the Vite app + a real AtomicServer. One signed
`save()` per row. Full log: `table_stress_e2e_n1000_wait_rows.log`.

| Leg | N=1000 |
| --- | --- |
| insert | **99.1 s (99 ms/row)** |
| `resource.persistToClientDb` | 40 ms/row |
| `ws.COMMIT` (server POST) | 55 ms/row |
| collection-open, same session (all bodies) | **307 ms**, 3.75 MB JSON-AD |
| nested page of 30 | **3 ms**, 113 KB |
| subjects-only unpaged | 2 ms |
| remount `queryLocalDb` (empty JS store) | **639 ms**, still 1000 bodies |
| open grid to `aria-rowcount=1001` | **4.1 s** |
| ClientDb init + election + `allSubjects` | 418 ms |
| WS auth + drive version-vectors | ~1.3 s |
| rendered rows after open / after scroll | **18 / 18** |
| heap after open | ~199 MB |
| scroll bottom→top | 335 ms |

Browser create is ~40× native (2.4 ms/row at 1k): each `save()` waits on
an OPFS worker put **and** a WS commit. Signing is 0.2 ms. 100k
interactive creates at this rate are ~2.8 hours, not a session.

Same-session unpaged bodies are ~100× a page of 30 — the same cliff as
native, plus JSON-AD across the worker (`3.8 KB/row`, matches the 4.3
KB/row native figure). Remount is slower (639 ms) because
`store.resources` is empty and every body is parsed again. The 4.1 s
"open grid" wall clock is ClientDb re-init + auth + drive sync **plus**
that hydrate, not the list widget.

`FancyTable` now gets `busy={!ready || answeredQuery !== requestedQuery}`.
The empty entry row still paints (so a fresh table is typeable) but
`aria-busy` is true until the collection answers.

### 4. UI — not the 100k problem

`react-window` only renders the viewport. At 1000 rows the DOM held **18
rows** after open and after a bottom→top scroll, with `aria-rowcount=1001`.
Scroll stays cheap **if** the collection does not dump every member onto
the main thread first. That dump is step 2.

## Ranked bottlenecks

1. **Collection local fetch hydrates every row** — **fixed.**
   `fetchPageFromLocalDb` now passes `limit`/`offset`/`sort_by`. Pre-fix
   cost: **4.6 s store-only at 100k**, plus ~430 MB of JSON-AD. A page of
   30 was already 33 ms in the same store.
2. **Write amplification / store growth** — 6.9 ms/row by 100k native,
   4 GB file. Browser `save()` is **99 ms/row** at 1k (40 ms OPFS + 55 ms
   WS). Dominates *creating* a huge table. Opening an already-written one
   is (1).
3. **Aggregates re-walk every match** — 1.0 s extra at 100k. Fine on a
   small table; another full pass at this N.
4. **Exact `totalMembers` walks the whole index** — 21–33 ms even for a
   30-row page at 100k. Planned as cursor pagination + `hasMore` in
   `index-performance.md`. Not built.
5. **WASM cannot sort DID-scoped queries**, so (1) exists. Fixing sort in
   the local query index would let the worker return the right 30 rows.
6. **The grid (react-window)** — 18 DOM rows at 1000 members. Not the
   limiter. `FancyTable` now sets `aria-busy` until the collection is
   ready, so the empty entry row no longer looks settled while loading.

## What not to do

- Virtualise harder. The list is already virtual.
- Add a table-specific store. The collection query is generic; tables just
  hit the worst case (parent + class filter + default sort + optional totals).
- Expect 100k interactive creates in the browser. Bulk import needs a
  batched, possibly unsigned-replica, write path that does not exist.

## Next slices

1. ~~Pass `limit`/`offset`/`sort_by` through `queryLocalDb`.~~ Done — page
   bodies only; JS fallback if the worker still returns the full set.
2. Cursor / `hasMore` instead of exact `totalMembers` (`index-performance.md`).
   The count walk is still O(matches) (~33 ms at 100k) but no longer ships
   430 MB of JSON-AD.
3. Write path: batched / unsigned-replica import so 100k creates are not
   one genesis commit each
   ([`disk-storage-and-persistence-optimization.md`](./disk-storage-and-persistence-optimization.md)).
