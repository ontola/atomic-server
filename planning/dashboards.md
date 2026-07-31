# Dashboards: user- and LLM-composable views over data

> Status: **First slice shipped (2026-07-31)** — the `Dashboard`/`Block` ontology,
> a grid renderer, all four v1 block kinds (stat, chart, view, text), the block
> config UI, and `create_dashboard` / `describe_dashboard` / `configure_block`.
> Its analytics half was already built (2026-07-30). Builds on the Table View
> pattern ([[table-view-filters]]) and the `create_table` LLM-authoring precedent.
> What is *not* built is interactivity — see that section, which is now the next
> slice and is mostly table work.
>
> The aggregation engine this plan specified shipped for table totals instead —
> see step 4 of [[table-templates-and-mini-apps]]. It landed as designed here (an
> aggregate clause on the shared `Query`, one implementation serving both the
> server and the browser's WASM DB), so a stat block's number is now a call, not
> a project. What remains is what this document said was genuinely new: the
> `Dashboard`/`Block` ontology, a layout model, and chart rendering.
>
> Extended 2026-07-31 with **interactivity** — a dashboard as an app shell rather
> than a report — after walking every table template to see what each one's app
> would actually be. Charts: store a Vega-Lite-shaped spec, draw it with our own
> SVG (decided 2026-07-31; the grammar is the contract, a few hundred kB of chart
> library for a bar chart is not).

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

That caveat is gone: step 7 of [[table-templates-and-mini-apps]] added
`Aggregate.expression`, so a computed column *can* be summed. A stat block over a
total duration or qty × price is `{function, derived}` naming a computed column of
the block's view, which `toBlockAggregation` translates with `toExpression`.

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

### Interactivity: a dashboard as an app shell (2026-07-31)

Everything above *displays*. Prior art below skips Retool-class app builders on
the grounds that write actions are a much larger surface — that judgement stands
for arbitrary components, but it draws the line in the wrong place for the mini
apps we actually build. Walk the thirteen table templates (next section) and every
one of them wants the same shape: **one button you press constantly, two or three
numbers, and a list to fix mistakes in.** The numbers and the list exist. The
button is what's missing, and it is small.

What "interactive" decomposes into, ordered by how much new concept each needs
rather than by usefulness:

1. **Edit in place** — an embedded view block *is* our table: editable cells, a
   draggable kanban. Free today; a report you can edit.
2. **Row actions** — a button per row running a bounded mutation. Already exists
   as code (the timer's Start/Stop) and is already on the table plan's list of
   recurring capabilities, unbuilt.
3. **One-tap create** — a button that appends a row with defaults ("Log a feed",
   "Start timer"). The timer's "what are you working on?" bar, generalised. For
   personal apps this is *the* widget.
4. **A control bound to one value** — a toggle or counter on a known resource's
   property, rather than on a row of a list.
5. **Parameters** — a control whose value narrows *other* blocks (a date window, a
   category, "mine only"). Grafana's template variables.
6. **Navigation tiles** — open a resource, a filtered view, another dashboard.
   Turns a dashboard into a home screen.
7. **Arbitrary UI** — [[llm-wasm-gui-plugins]]. Different safety model, its own
   doc.

Only 2–5 are new, and they are new in two different ways.

#### Actions are data, not code

The rule this codebase has held: a fixed vocabulary the store can execute, that an
LLM can write and a person can edit in a dialog — five derived-column generators,
five aggregate functions. An action follows it: a **patch template**, not a
script.

    { label: 'Watered', set: { 'last-watered': 'now' } }

The value forms are a closed set, and the template survey below says which ones
actually recur: **set to a literal**, **set to now**, **toggle**, **increment**,
**create with defaults**, and **clear/patch every row a filter matches** (the one
that isn't per-row: "clear bought"). Six. That is the whole vocabulary those
thirteen apps need.

Every press stays an ordinary commit: rights-checked, synced, in history,
undoable. The moment an action can run arbitrary code it stops being
configuration and becomes the plugin platform — which is fine, but it is a
different document.

This is also **not** [[actions]]. That registry unifies built-in resource verbs
(delete, share, favourite) so every surface projects one definition; those are
code, deliberately. A dashboard would be another surface projecting it. Domain
mutations — "mark done", "log a feed" — are the missing middle: neither a built-in
verb nor generated code.

#### Parameters are what make it an app

Today every block is an independent query, which is why per-block filtering needs
nothing new. The moment one control narrows several blocks, the Dashboard needs
shared state: declared parameters that blocks reference in their filters. This is
the one thing this document has no model for, and it is the difference between a
report and an interface. It is also where relative time belongs (`today`,
`this month`, `last 7 days`) — which the template survey wants almost everywhere,
and which is a filter capability, not a dashboard one.

#### Where each piece gets built

Row actions and one-tap create belong **in the table first**, exactly as derived
columns and aggregates did: they are already on that plan, and building them
there deletes the last bespoke code in the timer view. Blocks then reuse the same
configuration. A dashboard that invokes a *built-in* verb projects [[actions]]
rather than inventing its own.

Two costs to design in rather than discover:

- **Rights.** A button must not render where the viewer cannot write. A shared
  read-only dashboard offering an action that fails is worse than no action.
- **Feedback.** A press must feel instant while the commit is in flight, and must
  show that something happened — the same problem the timer's start/stop already
  has, solved once.

### A dashboard per template

Walking the catalogue (`chunks/TablePage/tableTemplates.ts`) rather than
theorising. "Numbers" are stat blocks; every one of them is a
`CollectionBuilder` + `setAggregation` call today unless noted.

| Template | The shell | Beyond what exists |
| --- | --- | --- |
| Issue Tracker | **New issue** · open count per status · oldest open · board | "mine only" parameter (and `me` as a parameter value) |
| Project tasks | **Add task** · overdue count · hours left (sum Estimate where not Done) · calendar | overdue = filter on a computed due-date (engine done, no UI) |
| Time tracker | **Start / Stop** · today's total · per project · today's entries | the button; week buckets for "this week" |
| Expenses | **Add expense** · this month's total · per category · receipts missing | relative month window; "is empty" filter for the missing receipt |
| Deals (CRM) | **Log contact** (set Last contact = now) · pipeline value per stage · stale count · board | the canonical set-to-now row action; stale = computed-column filter |
| Job applications | **New application** · count per stage · longest waiting · board | follow-up = set-to-now action |
| Reading list | **Mark finished** (Status + Finished on, one patch) · finished this year · average rating · currently reading | two-property patch; a year window |
| Grocery list | **Add item** · left to buy · basket total · list by aisle | toggle action per row; **clear bought** (the set-level action) |
| Workout log | **Log set** · sessions this week · best lift per exercise · recent sets | defaults from the previous row; week buckets |
| Plant care | **Watered** (set to now) · due today · overdue list · per room | due = filter on the `offset` column (engine done, no UI) |
| Inventory | **+1 / −1** · total stock value · low stock count · stock list | increment action |
| Guest list | **Yes / No** · headcount (count + plus-ones) · per RSVP · guest list | set-to-literal action per row |
| Bookmarks | **Add bookmark** (one URL field) · count per kind · recently added | quick-add with a typed field |

What falls out of doing this thirteen times:

- **The shell is the same every time.** One primary action, one to three numbers,
  one list. That argues for *generating* a template's dashboard (Metabase's X-ray)
  rather than hand-authoring thirteen of them — and for a template shipping a
  dashboard the way it already ships views.
- **The action vocabulary closes at six** (above). Nothing in the catalogue needed
  a seventh. Four of them shipped as row actions on 2026-07-31; the two that are
  not per-row ("create with defaults", "clear every matching row") remain.
- **The same three gaps keep appearing**, and none of them is a dashboard
  feature: relative date windows, week/quarter buckets, and "this field is
  empty". Fixing those pays off in tables first and dashboards second.
- **Two block kinds carry almost everything**: "count/sum of a filtered set" and
  "the thing you press". The chart is the third, and the least urgent.

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
- Skipped: Retool/Appsmith-class app builders — *arbitrary components* are a
  much larger surface than "views over your data"
  ([[llm-wasm-gui-plugins]] covers that direction separately). Write *actions*
  are no longer skipped: see Interactivity above, where they are a closed set of
  patch templates rather than components.

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

The slice that makes it an *app* rather than a report is the next one, and it is
mostly not dashboard work: **one-tap create and a row action, built in the table**
(where they delete the timer's last bespoke code), then offered as block kinds.
A Time tracker dashboard — one Start/Stop button, today's total, today's entries —
is the smallest thing that proves the whole idea, and it is one action away.

### What the first slice actually shipped (2026-07-31)

Built to the design above, with the deviations noted.

- **Ontology** (`lib/defaults/dashboard.json`, seeded by `populate.rs` and by the
  browser's `bootstrap.ts`): `Dashboard` (`dashboard-blocks`, `dashboard-layout`)
  and `Block` (`block-kind`, `block-source`, `block-view`, `block-query`,
  `block-aggregate`, `block-chart-spec`; a text block's body is `description`).
  **Open question 1 is answered: one `Block` class with a `block-kind` string**,
  the same shape `View` uses — a new kind is then a renderer and a label rather
  than an ontology change, and an unknown kind renders as a labelled placeholder
  instead of breaking the page.
- **`block-view` is new and load-bearing.** A stat or chart block *borrows* a
  View's filters and computed columns rather than restating them, so "open issues"
  is the open-issues view plus a count. That is why `block-query` (extra
  constraints ANDed on top) is honoured by `useBlockQuery` but written by neither
  the UI nor the tool yet: a capability lands with both or neither, and pointing at
  a view covered every case the template survey wanted.
- **Renderer**: `chunks/DashboardPage/`, lazily chunked and dispatched from
  `ResourcePage.tsx`. A 12-column CSS grid, collapsing to one column under 50rem.
  A block with no stored placement gets a per-kind default size and flows, so a
  block an assistant added without writing a layout is never invisible.
- **Blocks**: `stat` (the table's own `useTableAggregates` — one implementation of
  "a number over a filtered set", not two), `chart`, `view` (the real
  `TableResource`, editable), `text` (markdown).
- **Chart**: horizontal bars, drawn with a CSS grid rather than a chart library.
  Horizontal because bucket labels are category names, dates and tag names, which
  read at any width. The *spec* is Vega-Lite-shaped and parsed from either the flat
  form a dialog writes or the `encoding.x` form an LLM writes, so a real Vega
  renderer stays a drop-in. A mark other than `bar` is rejected rather than drawn
  as bars.
- **Embedding a table needed one change to it**: `TableResource` grew
  `viewSubject` (which view to render) and `embedded` (drop the view tabs and
  filter bar). Both were unavoidable — the active view lives in `?view=`, one
  param for the whole page, and a dashboard has a view per block.
- **Authoring, both halves**: `create_dashboard` (blocks + auto-layout in one
  call, resolving column and view *names*), `describe_dashboard`, `configure_block`
  (touches only the fields it is given, like `configure_view`), and the
  `BlockConfigDialog` behind each block's ⋯ menu, which can change everything the
  tool can write. A block created from the Add menu opens its dialog immediately.
- **A dashboard is creatable from the New-resource palette** and has an icon.

Two traps found by building it, both worth knowing:

- **A plain object written with `set(prop, value, false)` is stored as a JSON
  *string*.** `loroSetProperty` gives arrays native `LoroList`s but
  `JSON.stringify`s objects, and the read path only parses them back when the
  Loro `datatypes` tag says `json` — a tag that is only written when the Property
  is loaded in the store, which is exactly what `false` skips. `block-aggregate`
  silently round-tripped as a string until this was found. Every JSON-datatype
  write here therefore validates (no `false`), **and** the parsers accept a string
  as well as an object. This generalises beyond dashboards: the existing
  `view-*` JSON config gets away with `false` only because it is all arrays.
- **A config dialog must not drop config it cannot offer.** The breakdown rule
  deliberately keeps free-text columns out of "group by"; a chart already grouped
  by one showed an empty picker, and saving would have destroyed it. Stored values
  are now appended to the offered list.

### Handover: what to read, what to build next

Written 2026-07-31 so this can be picked up cold.

**Read first**, in this order: the Analytics section above (the engine is built,
and knowing its shape stops you rebuilding it), then step 4 and step 7 of
[[table-templates-and-mini-apps]] for how a capability got from a `Query` field to
a UI to a tool, since a dashboard block repeats that path exactly.

**What already exists, and where:**

| Need | Use |
| --- | --- |
| A stat's number | `CollectionBuilder` + `setAggregation` — copy `chunks/TablePage/useTableAggregates.ts`, which asks for one row plus the numbers and re-reads on save/delete with a debounce |
| A number over a computed value (a duration, qty × price) | `Aggregate.expression`; build it with `toExpression(spec)` from `chunks/TablePage/derivedColumns.ts` |
| A block filtered to a subset | `QueryFilter.filters` (indexed) and `expression_filters` (computed); `splitFilters` in `chunks/TablePage/tableFiltering.ts` already translates view config into both |
| Bars per category/day/month | the same call with `group_by`; buckets are `exact` / `day` / `month` + a timezone offset |
| An embedded editable table/kanban/calendar | `chunks/TablePage/TableResource.tsx` renders from a Table + a View subject |
| Ontology plumbing for a new class | `lib/defaults/table.json` + `browser/lib/src/ontologies/dataBrowser.ts` (regenerate, then `pnpm build` in lib **and** react) |
| A new page for a class | dispatch in `views/ResourcePage.tsx`, like `TablePage` |
| The tool surface | `chunks/AI/useAtomicTools.ts` + the skill in `chunks/AI/skills/tables/` |

**Order of work.** ~~Ontology → `DashboardPage` → view block → stat block →
`create_dashboard` → block-config UI → bar chart~~ — all shipped; see the section
above. What is left, in order:

1. ~~**Row actions**, in the table~~ — shipped 2026-07-31 as `view-row-actions`
   (four verbs: `setNow`, `setValue`, `toggle`, `increment`), with a config dialog
   and tool support, and shipped on the Plant care, Inventory and Grocery
   templates. **Still to do:** offer them as a dashboard block kind (a big button
   over a whole view rather than one per row), and **one-tap create** — the
   quick-add bar generalised, which is the other half of what makes a dashboard an
   app. Of the six verbs the template survey found, four are done; "create with
   defaults" and the set-level "clear every matching row" are not.
2. **The three filter gaps** the template survey kept hitting, none of them
   dashboard features: relative date windows (`today`, `this month`,
   `last 7 days`), week/quarter buckets, and "this field is empty".
3. **Parameters** — one control narrowing several blocks. Needs shared dashboard
   state; open question 6 is still open.
4. **Drag-and-drop layout.** The grid already reads `{x, y, w, h}`; only width and
   reordering are exposed, via the block menu (keyboard-reachable, which
   drag-and-drop alone would not be).
5. **A dashboard per template** — and whether it is generated or shipped
   (open question 7).

**Constraints that are not negotiable** (each one was learned the hard way):

- JSON-shaped config uses the JSON datatype natively, never a stringified string.
  See the `json-property-native-storage` rule.
- A capability lands with **both** its tool and its UI, or the assistant builds
  dashboards their owner cannot edit.
- Anything derived from a query must key its React deps on the *serialized* shape
  of that query, not on object identity — parsed JSON config gets a new identity
  every render, and the grid taught us what that costs.
- If a value depends on `now`, quantize it (the tables use a minute) before it
  enters a query, or the query re-runs on every render.
- Malformed stored config is dropped, never thrown on: a person or an LLM can
  write it, and one bad block must not take a page down.
- A JSON-datatype write must let `set` validate, and its parser must accept a
  string as well as an object — see the two traps above.
- A config UI must keep whatever is already stored in its option lists, even when
  it would not offer that choice itself.

**Filtered queries are safe to lean on.** The two bugs that were meant to block
this work (recorded 2026-07-31 in [[table-templates-and-mini-apps]]'s gaps) are
both closed. One was real — a whole-resource write evicted stale query-index
entries against the new resource, so a row edited out of a filter stayed in it;
one was a test measuring `pendingDirtyCount` instead of the resource it was
waiting on. Both entries there explain themselves; neither constrains this design.

## Open questions

1. ~~One `Block` class with `block-kind`, or a class per kind?~~ Answered by
   building it: one class with a kind string, like `View`. A new kind is then a
   renderer plus a label, and an unknown kind degrades to a labelled placeholder.
2. Exact Vega-Lite subset: v1 accepts `mark: 'bar'` plus an x field and a
   day/month/exact bucket, in either the flat or the `encoding.x` spelling, and
   rejects any other mark. Still open: which marks come next (line for a time
   series is the obvious one), and whether the tool should carry a zod schema for
   the spec rather than the flattened `chartBy` it takes today.
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
6. Do parameters live on the Dashboard (declared, blocks reference them by name)
   or on each block (a control block names its targets)? Declared-on-the-dashboard
   matches Grafana and survives block reordering; naming targets keeps a block
   self-contained.
7. Is a template's dashboard *generated* on demand (X-ray from the class + views)
   or *shipped* as part of the template spec? Generated stays correct as a table
   changes; shipped is inspectable and editable like the views already are.
8. Does an action need a confirmation model? "Clear bought" touches every matching
   row, and there is no undo affordance on a dashboard yet — though every action
   is a commit, so the history has one.
