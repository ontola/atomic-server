# Table view: multi-property filtering UI (+ Views)

> Status: **In progress** (started 2026-06-13). Builds on the completed
> full-stack multi-property (AND) filtering core
> ([[multi-property-filter]] / `planning/multi-property-filter.md`).

## Goal

Let users filter a table on multiple properties (AND), Notion-style:

- A **filter** entry in each column's `…` dropdown menu (`TableHeadingMenu`).
- A **filter bar above the columns** showing active filters as chips.
- Each chip is editable: pick the value (and, where meaningful, how it
  matches) per property.

## Backend reality (operators)

The query index supports **equality** (scalars) and **membership / "contains"**
(resource-arrays & single references) only — both via `contains_value`. So the
chip shows a datatype-derived operator **label** (`is` for scalars, `contains`
for references/arrays); a true operator *picker* arrives with backend support.

### Operator status

**Level 1 — predicate operators — DONE & tested.** `PropVal` gained an
`operator` field (`FilterOperator`: `Equal` default, `GreaterThan(OrEqual)`,
`LessThan(OrEqual)`, `StartsWith`, `Contains`). `constraint_matches` honours it
via `value_matches`/`compare_values` (numeric when both parse as numbers, else
lexical). It runs in the **shared** Rust match code, so server `/query` AND the
WASM/OPFS path agree, and the filtered membership is still stored in the
QueryMembers index. Threaded full-stack: `filters` JSON carries `operator`
(server `construct_collection_from_params` + WASM bridge parse it via
`filter_operator_from_str`); `@tomic/lib` `PropVal.operator` + `valueMatches`
in `applyResourceChange`; the table chip has a datatype-aware operator
`<select>` (`operatorsForDatatype`). Tree versions bumped `v4 → v5` (operator
changes encoded key bytes). Rust test `operator_filters`; live-verified
(`starts with`/`contains` on the local WASM path). **Level 2 (index-accelerated
bounded scans) remains the later optimisation below.**

### Operator roadmap (how to get `contains` / `starts with` / `>` / `is not`)

The data model should be `{property, operator, value}` with an `operator` enum;
the UI exposes per-datatype only the operators the backend can currently honor
and shows the rest disabled. Roll out by cost (cheapest first):

1. **`is` / `contains` (membership)** — now. Equality scan + array membership.
2. **Ranges (`>`, `<`, `>=`, `<=`, between) and `starts with`** — *cheap*: the
   index is already a **sorted tree with `start_val`/`end_val` bounds** (used by
   chatroom paging). A range/prefix on the index's value-ordered key maps to a
   bounded scan. Needs: order-preserving key encoding (zero-pad ints; ISO
   dates/timestamps already sort right), an `operator` field on `PropVal`, and
   the query path translating gt/lt/prefix into bounds. One ranged constraint
   per query (it must be the scanned key); the planner picks which.
3. **Text `contains` (substring)** — route to the existing **Tantivy full-text
   search index**, not the query index; intersect the search hits with the
   collection. Different subsystem, moderate work.
4. **`is not` / `is empty` / OR** — need the query planner (option C in
   [[multi-property-filter]]): scan a base set and post-filter / set-difference,
   or union AND-collections for OR. Largest build.

## Bugfixes (post-Phase-A, found via live testing)

- **"Index out of bounds"** when a filter shrank the collection: `TableResource`
  froze `memberCount` at first load, so after filtering it exceeded
  `collection.totalMembers` and `getMemberWithIndex` threw. Fixed by (a) clamping
  `memberCount` to the live total, (b) rebasing (recapture baseline + reseed
  session rows) on active-filter change like sort does, and (c) a defensive
  `.catch` in `useMemberFromCollection`.
- **Local WASM DB "Indexed queries require a drive scope"**: multi-filter goes
  through `query_complex`, which needs a drive. `Collection.fetchPageFromLocalDb`
  now passes `drive` when extra filters are present (single-filter still omits it
  to keep the basic path).

## Phases

### Phase A — interactive filter UI (session state) ✅ target now

State lives in React (like sorting does today). One filter per property
(keyed by property subject); empty-value filters are ignored by the query so
adding a filter doesn't blank the table before a value is chosen.

- `tableFiltering.ts` — `TableFilter` type + `useTableFilters` hook
  (`filters`, `addFilter`, `setFilterValue`, `removeFilter`, `clearFilters`).
- `useTableData.ts` — thread `filters` into `queryFilter.filters`
  (`{property, value}`, non-empty only). The primary `parent = <table>`
  constraint stays; extra filters AND onto it via the combined index.
- `tablePageContext.ts` — expose `filters` + mutators.
- `TableHeadingMenu.tsx` — add a **Filter** item → `addFilter(property)`.
- `TableFilterBar.tsx` (new) — renders above `FancyTable`; chips + a subtle
  `+ Filter` property picker (limited to table columns).
- `TableFilterChip.tsx` (new) — `Popover`: property title + operator label +
  value input + remove. Auto-opens when the filter has no value yet.
- `TableFilterValueInput.tsx` (new) — datatype-switched value editor:
  references/arrays → `ResourceSelector`; boolean → `BasicSelect`; number/date
  → `InputStyled`; else text.

Reuses existing primitives (`Popover`, `ResourceSelector`, `BasicSelect`,
`InputStyled`, `Dropdown`, `Row`/`Column`). Build stays green; `pnpm typecheck`.

### Phase B — persist via a **View** resource — IMPLEMENTED

**Ontology** (`lib/defaults/table.json`): new `View` class (requires `name`,
`view-kind`; recommends `view-filters` (json), `view-sort-by`, `view-sort-desc`,
`view-columns`) + `Table.table-views`/`table-default-view`. Hand-synced into
`browser/lib/src/ontologies/dataBrowser.ts` (codegen pulls from remote
atomicdata.dev, which doesn't have these yet). The dead `ATOMIC_REPOPULATE_DEFAULTS`
flag was wired in `server/src/appstate.rs` to re-import defaults into an existing
store (`populate_default_store`), so the running store picks up the new schema
without a wipe.

**Frontend**: `useTableView` hook — local React state (instant UX) hydrated once
from the active View and debounce-persisted back; lazily creates a "Default View"
(parent = table) on the first change, writing `table-default-view` + pushing
`table-views`. Filters + sort live on the View (`view-filters` JSON,
`view-sort-by`/`view-sort-desc`). `useTableColumns` layers `view-columns` for
per-view order + visibility; reorder/hide/show persist to the View. New
`TableToolbar` shows the editable view name + a Columns visibility menu. The row
query gained an `isA = classtype` constraint (B2) so View children don't appear
as rows.

**Verified live** (charlotte): filter + view name persist across reload; lazy
View creation; isA filter keeps Views out of rows.

**Known issues / remaining:**
- **404 noise**: the new `atomicdata.dev/*` properties only exist on the local
  server, so the client fetches real atomicdata.dev first (404) then falls back
  to local. Functional but noisy. Fix: publish to atomicdata.dev, or namespace
  the new props under the local server. (Decision for the owner.)
- **Multi-view switcher** (create / switch / delete multiple views) not built —
  only the auto-managed default view + naming + columns. The data model
  (`table-views` array + `table-default-view`) already supports it.
- Rename persists on real blur (verified via the underlying set+save).

### Phase B (original notes) — persist via a **View** resource

A table has one or more **Views**; each View holds its config (filters, sort,
and a `view-kind` so a future Kanban view can reuse the same plumbing). The
filter UI from Phase A reads/writes the active View instead of session state.

- New ontology class `View` (e.g. props: `name`, `view-kind`, `filters` (JSON),
  `sort-by`, `sort-desc`, parent = table). Precedent for native-JSON view
  config on a table resource already exists (column widths via
  `useHandleColumnResize`).
- Table → `views` (ordered) + `default-view`. A view switcher in the table
  header ("Default View ▾"), `Save` / `Reset` like Notion.
- Decide ontology authoring path (server-published class vs code-first schema —
  see [[code-first-no-build-step]]) before implementing.

Order is flexible but must keep the build green; Phase A is independently
useful and its UI is storage-agnostic so Phase B swaps the backing store.
