# Dashboards: user- and LLM-composable views over data

> Status: **Proposal (2026-07-15)**, with its analytics half already built
> (2026-07-30). Builds on the Table View pattern ([[table-view-filters]]) and the
> `create_table` LLM-authoring precedent.
>
> The aggregation engine this plan specified shipped for table totals instead —
> see step 4 of [[table-templates-and-mini-apps]]. It landed as designed here (an
> aggregate clause on the shared `Query`, one implementation serving both the
> server and the browser's WASM DB), so a stat block's number is now a call, not
> a project. What remains is what this document said was genuinely new: the
> `Dashboard`/`Block` ontology, a layout model, and chart rendering.

## Motivation

The assistant can now create tables, resources, and ontologies well; the weak
half is **display**. A Drive full of tables (e.g. the perfume-hobby Drive:
Batches, Batch Ingredients, Batch Log, Shopping List) has no way to show
cards-in-a-grid, aggregate stats ("total drops per ingredient"), or a
composed overview page. Notion, Airtable Interfaces, Metabase, and Grafana all
solve this with user-composable dashboards; we should too — authorable both
**through the UI and by the LLM**, via the same resources.

## Why we're close

- **Views are already config-as-resource.** A Table's tabs are `View`
  resources (`view-kind` string + JSON config props: `view-filters`,
  `view-sort-by`, `view-columns`, `view-group-by`), lazily created and
  persisted by `browser/data-browser/src/chunks/TablePage/useTableView.ts`.
  A dashboard is the same idea one level up: a composition root over blocks.
- **LLM authoring is a solved shape.** `create_table`
  (`src/chunks/TablePage/createTableFromSpec.ts`) builds class + properties +
  views + rows in one tool call. A `create_dashboard` tool mirrors it. Since
  UI and LLM both write the same resources through commits, "editable by
  both" falls out for free.
- **`DrivePage.tsx`** is already commented "functions similar to a homepage
  or dashboard" but has a fixed layout — the natural first customer.

What's genuinely new: **chart/aggregation blocks** (nothing chart-like exists
in the codebase) and a **layout model**.

## Design

### Blocks are standalone resources (the key decision)

Model each widget as its own resource so it can render in multiple contexts:
a `Dashboard` grid now, DocumentV2 embeds later (Notion's "dashboard = page
with embedded views" model). Avoids baking the block palette into one page
type.

Ontology sketch (dataBrowser ontology style):

- **`Dashboard`** (class) — `blocks` (ordered ResourceArray of Block
  subjects), `layout` (JSON: per-block `{subject, x, y, w, h}` grid
  placement; native JSON datatype, not stringified).
- **`Block`** (class, or one class per kind like View does with `view-kind`):
  - `block-kind` (string enum): `view` | `stat` | `chart` | `text` (v1 set).
  - **view block** — `block-source` (a Table or existing `View` subject);
    renders the table/kanban/calendar inline, read-only or interactive.
  - **stat block** — `block-source` (Table/collection subject) +
    `block-query` (JSON: filters, reusing the `{property, operator, value}`
    shape from [[multi-property-filter]]) + `block-aggregate` (JSON:
    `{op: count|sum|avg|min|max, property?}`) + label.
  - **chart block** — `block-source` + `block-query` + `block-chart-spec`
    (JSON: a **constrained Vega-Lite subset** — mark, x/y encodings,
    aggregate, color). Declarative, schema-validatable, and LLMs are
    extremely well-trained on Vega-Lite; never generated code.
  - **text block** — markdown/description, for headings and notes.

All JSON-shaped config uses the JSON datatype natively (like
`tableColumnWidths`), never stringified into strings.

### Rendering

- `DashboardPage` in `src/views/`, dispatched from `ResourcePage.tsx` like
  every other class. CSS grid from `layout`; each block dispatches on
  `block-kind`.
- Chart rendering: compile the constrained spec to a small chart lib (or
  embed vega-lite directly; weigh bundle size — it belongs in a lazy chunk
  like `TablePage`).
- Data: view blocks reuse existing table/view components; stat/chart blocks
  run collections/queries with the existing filter machinery and get their
  numbers from the shared Rust aggregation described below.

### Analytics execution: aggregate in the shared Rust query core

Where do count/sum/avg/group-by actually run? Findings (2026-07-15):

- The browser holds a **full local copy** of the drive: a redb DB persisted
  to OPFS (`lib/src/db/opfs_backend.rs`), wrapping the same `atomic_lib`
  query code the server runs (`wasm/src/lib.rs` `ClientDb::query`).
  `collection.ts#fetchPage` is OPFS-first; the server `/query` endpoint is
  only the fallback when no local DB exists.
- The query index (`lib/src/db/query_index.rs`, `Tree::QueryMembers`) is
  lazily built per `QueryFilter` and maintained incrementally on commit.
  Even today's pagination `count` is computed by iterating the index range —
  nothing is materialized.
- There was **no aggregation anywhere** in lib/server/wasm/@tomic; we added it
  from scratch.

Decision: extend the shared `Query` in `atomic_lib` with an optional
`aggregate` clause — `{op: count|sum|avg|min|max, property?, group_by?}` —
executed as the same iterate-the-`QueryMembers`-range pass that computes
`count` today, resolving member values for sum/avg and bucketing on the
`group_by` property for charts. One implementation then serves **both**
paths: exposed through the WASM bridge (`ClientDb.query` result gains an
`aggregates` field) and as extra params on the server `/query` endpoint,
mirroring how multi-property filter operators were threaded full-stack.

**Built, 2026-07-30** — driven by table totals rather than by dashboards, but to
this design:

- `lib/src/aggregate.rs`: `Aggregation { aggregates, group_by }` on `Query`,
  `AggregateOutcome` (with per-group values) on `QueryResult`. `db.rs` runs it as
  a second unpaged pass over the same filter and index path as the page query, so
  a number can never summarize a different set than the rows it claims to.
- `AggregateGrouping { property, granularity, tz_offset_minutes, limit }` with
  `GroupGranularity::{Exact, Day, Month}` — the date bucketing open question 3
  asked about, answered: one level, caller-supplied timezone offset, and a
  bucket limit that reports when it truncated. A select property groups by tag
  subject.
- Wire: the `aggregation` query param, results on `collection/aggregates` (JSON).
  WASM: `ClientDb.query` takes `aggregation` and its result carries `aggregates`
  (`ClientDbQueryOpts.aggregation` in `@tomic/lib`), so the local DB answers the
  same question offline.

A stat block is therefore a `CollectionBuilder` call with `setAggregation` — see
`useTableAggregates.ts`, which does exactly that (one row plus the numbers,
re-read on save/delete). A chart block is the same call with a `group_by`.

One caveat inherited from that work: aggregates read **stored** properties, so a
computed column can't be summed. A dashboard over derived values (a total
duration, qty × price) hits the same wall.

Consequences:

- **No new index types.** The lazily-built, commit-maintained `QueryMembers`
  tree already narrows to matching members; scanning them on demand is fine
  at personal-drive scale (10²–10⁴ rows). No materialized aggregates in v1.
- **Reactivity is free and local.** Dashboard blocks subscribe like
  `useCollection` does; on a membership change or member edit the block
  re-runs the aggregate against the local WASM DB — cheap, no server
  round-trip, live-updating dashboards by default.
- **Not JS-side.** Aggregating in JS over fetched pages would force paging
  every row into the JS heap and duplicate the logic; the rows already live
  in the local Rust store.
- Later, if drives outgrow scan-on-demand: incremental materialized
  aggregates maintained from the existing
  `DbEvent::QueryMembershipChanged` hook (running sum/count are easy;
  min/max need re-scan on removal — defer until proven necessary).

### Authoring

- **LLM:** `create_dashboard` tool in `useAtomicTools.ts` mirroring
  `create_table`: takes a spec (blocks + layout), creates the resource graph
  in one call. Also an `edit_dashboard`/reuse of `edit_atomic_resource`.
  A "generate a dashboard for this table" one-click action (Metabase
  "X-ray" style) is the killer demo: the LLM reads the class schema and
  proposes stat + chart blocks.
- **UI:** v1 needs only add/remove/reorder blocks and a per-block config
  form (source picker, filter chips reused from the table filter bar,
  aggregate picker). Free drag/resize on the grid is v2.

## Prior art studied

- **Airtable Interface Designer** — closest product analog; small curated
  element palette over tables.
- **Grafana** — dashboards as declarative JSON (panels + queries + grid
  positions); why LLMs generate Grafana dashboards well. Our ontology should
  be similarly export/import-friendly.
- **Metabase** — saved questions composed into dashboards; X-ray
  auto-dashboards from a table's schema.
- **Notion** — blocks/embedded-view model; UX bar for non-technical users.
- **Baserow / NocoDB** — minimal viable scope (Baserow shipped dashboards
  with just summary + chart widgets).
- **Vega-Lite** — the chart grammar to constrain and build on.
- Skipped: Retool/Appsmith-class app builders — arbitrary components and
  write actions are a much larger surface than "views over your data"
  ([[llm-wasm-gui-plugins]] covers that direction separately).

## First slice

`Dashboard` class + three block kinds — embedded View, stat (count/sum/avg
over a filtered source), one chart type (bar) — in a simple grid, plus the
`create_dashboard` tool. Test both authoring paths on the perfume Drive
(total drops per ingredient across batches, batches by status, shopping-list
count) before investing in a drag-and-drop editor.

Since the numbers arrived early, the slice is smaller than it was written: the
stat block is a `CollectionBuilder` with `setAggregation`, and the bar chart is
the same call with a `group_by` plus something to draw bars with. What is
untouched is the ontology, the layout, the renderer and the tool — and the rule
step 3 of [[table-templates-and-mini-apps]] established applies here too: **a
capability lands with both its tool and its UI**, or the assistant can build a
dashboard its owner cannot then change.

## Open questions

1. One `Block` class with `block-kind`, or a class per kind? (`View` uses a
   kind string; per-kind classes give better schema validation for the LLM.)
2. Exact Vega-Lite subset: which marks/encodings in v1, and how to validate
   (zod schema in the tool + renderer-side clamp).
3. ~~Aggregate clause shape: one `group_by` level or nested? How do date
   bucketing and select-property buckets encode in the `aggregate` JSON?~~
   Answered by the built engine: one `group_by` level, a `granularity` of
   `exact` / `day` / `month` with a caller-supplied timezone offset, select
   properties bucketed by tag subject. Week and quarter buckets are not built,
   and a time chart will want them.
4. Should the Drive homepage become a default Dashboard resource
   (replacing the fixed `DrivePage` layout), and if so, when is it created?
5. Document embeds: what does a Block need so TipTap (DocumentV2) can host
   it as a node later?
