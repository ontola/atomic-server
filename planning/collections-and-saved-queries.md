# Collections, Views, and saved queries

> Status: **Proposal.** Analysis of the Collection / View / `/query` / `/search`
> overlap. No code changes yet. Decide the option, then slice.

The Collection class was the original way to get a list of resources: persist
a resource with `property` + `value` (+ sort, page size), GET it, and the
server fills in `members`. `/query` and `/search` now do that job better.
Tables persist the same idea as a `View`. The names and types have piled up.

The thing worth keeping: **a persistable, named query**. The rest can shrink.

## The four things named "Collection"

| Layer | What it is | Still load-bearing? |
| --- | --- | --- |
| **A. Query engine** | Rust `Query` / `store.query`, WASM `queryLocalDb`, query index | Yes. Tables, sidebar, chat, comments, dashboards, Flutter. |
| **B. Result envelope** | Class `Collection` + `collection/members`, `totalMembers`, `aggregates`, pagination. `/query` builds a throwaway resource of this class. `/all-versions` does too. | Yes, as a *wire shape*. Not as a stored document. |
| **C. Client runner** | TS `Collection` / `CollectionBuilder` / `useCollection`. Hits `/query` or OPFS. Live membership via `applyResourceChange` + `SUBSCRIBE_QUERY`. | Yes. ~3.8k lines of client+server glue around this path. |
| **D. Persisted Collection resource** | User (or `populate_collections`) creates a resource of class Collection. ClassExtender on GET runs the query and writes members onto the same resource. `CollectionPage` / `NewCollectionDialog` / `CollectionCard`. | **No, in product use.** Not in `BaseButtons`. `populate_collections` is test-only. No e2e creates one. |

`/search` is a fifth list API: Tantivy full-text, **different envelope**
(`endpoint/results`, not `collection/members`). Ranking, not the query index.

Public docs still present Collections as the querying model and `/query` as
"virtually identical, but it does not require a Collection Resource"
([`docs/src/core/querying.md`](../docs/src/core/querying.md)). That sentence is
the whole design: the resource was never needed for the query.

## What actually runs in the app

**Lists** go through layer C, never through a stored Collection:

- Table rows: `useTableData` → `useCollection` with `parent = table` (+
  `isA = classtype` so View children are not rows) + View filters.
- Sidebar / folders: `useChildren` → same client Collection on `parent`.
- Chat messages, comments, resource-usage panels, AI context, tags: same.

**Saved query + presentation** is the Table `View`:

- Class `View` (`lib/defaults/table.json`): `name`, `view-kind`, JSON
  `view-filters` (`{property, operator, value}`), `view-sort-by` /
  `view-sort-desc`, `view-columns`, group-by, aggregates, derived columns,
  row-actions, quick-add.
- Table holds `table-views` + `table-default-view`. `useTableView` lazy-creates
  a "Default View" on first change.
- **Multi-view switcher is not built.** Users do not pick among named views.
  The resource exists as persistence for the one default. See
  [`table-view-filters.md`](./table-view-filters.md).

**Dashboard blocks** copy the filter JSON as `block-query`, ANDed onto a
`block-source` (Table or View). Third copy of the same shape.

**Collection UI** still exists but is off the main path:

- `NewCollectionDialog` — property + value only. Not in Base classes.
- `CollectionPage` — cards vs table chrome, assumes `is-a` + Class.
- ClassExtender still registered on every `Db` so GET of an old Collection
  resource still computes members.

The stored Collection class never gained `filters[]`, operators, aggregation,
expression filters, or `drive`. Those exist on `/query` params and on View /
block JSON. A Collection resource is a **stale subset** of the query the
engine already runs.

## Why Collection resources feel wrong now

1. **Definition and result share one resource.** `property` / `value` are
   stored; `members` / `totalPages` / `aggregates` are computed on GET into
   the same document. ClassExtender is the hack that makes that work. Views
   do not do this: they store config, and `useCollection` executes separately.
2. **Dynamic GET is a poor local-first citizen.** Query params on the subject
   (`?current_page=2`) mean the "same" Collection is many subjects. Commits
   cannot usefully version the computed members. Offline, the TS client
   already bypasses this and calls `queryLocalDb`.
3. **Two saved-query models.** Collection: one equality filter, its own page.
   View: full filter JSON + presentation, bound to a table, not its own page.
4. **Search is a parallel universe.** Intersecting Tantivy hits with the query
   index is already the planned path for text `contains`
   ([`table-view-filters.md`](./table-view-filters.md) operator roadmap).
   A saved query that includes `q` needs that, not a new Collection field.
5. **Naming.** "Collection" means the engine result, the client class, the
   ontology class, and (in CollectionPage) a view mode. Docs, SDK, and
   `useCollection` all say Collection when they mean Query.

The ClassExtender + Collection *struct* in Rust (`lib/src/collections.rs`,
~1500 lines) is not dead: `/query` and `/all-versions` go through
`construct_collection_from_params` / `Collection::to_resource`. Deleting
persisted Collection resources does not delete that envelope.

## What to keep

The persistable-query idea, in this shape:

- A **query spec**: drive, AND-filters with operators, sort, optional
  aggregation / expression filters, optional full-text `q` later.
- A **presentation**: kind (table / kanban / calendar / list / cards),
  columns, group-by. Only makes sense when the result has a shared class
  (today: a Table).
- An **ephemeral page**: members + totals + aggregates. Never stored.

View already is (spec + presentation) for tables. Collection resources were
(spec + envelope) for anything. Dashboard `block-query` is (spec fragment).

## Options

### A — Retire Collection resources, leave the rest

Hide/remove `NewCollectionDialog`, `CollectionPage`, `CollectionCard`, and
the class from create flows. Keep class + ClassExtender so old subjects still
GET. Keep TS `Collection` and `/query` envelope.

- **Pros:** Smallest change. Matches current usage. No SDK break.
- **Cons:** Naming stays wrong. Two persistable-query models remain (View vs
  the leftover class). Docs still confusing until rewritten. No product for
  "named query that is not a table."

Good as **step 0** of any other option. Not a destination if we want one
saved-query primitive.

### B — View becomes the saved-query resource (unbound from tables)

Generalize `View`:

- Optional `view-source` (Table, or a parent, or a class). Missing source =
  drive-scoped query (what Collection was).
- Existing `view-filters` / sort / kind / columns stay.
- Opening a View as its own page (list/cards) replaces `CollectionPage`.
- Table tabs become "Views whose source is this table." Dashboard blocks
  point at a View instead of inlining `block-query`.
- Collection class remains the `/query` result envelope until a rename.

- **Pros:** One persistable type we already have. Multi-view switcher
  ([`table-view-filters.md`](./table-view-filters.md) remaining work) and
  "saved query as a document" fall out of the same class. Dashboard
  `block-query` can become "this block's View" or "pointer to a View."
- **Cons:** View today is presentation-heavy (columns, row-actions, kanban
  fields). A "all resources where `isA = Meeting`" saved query does not need
  that. Risk of a god-resource. Table-scoped invariants (`parent = table`,
  `isA = classtype`) must become explicit source constraints, not implied.

Closest to "I like persisting a pre-defined query, and Views already do
this."

### C — Split QuerySpec from View

New class (or JSON datatype) `QuerySpec` / `SavedQuery`: the executable
filters+sort+scope. `View` keeps kind/columns/group-by and *points at* a
QuerySpec (or inlines one). Collection resources migrate to QuerySpec.
Dashboard `block-query` *is* a QuerySpec. `CollectionBuilder` serializes
the same JSON `/query` already accepts.

- **Pros:** Cleanest model. Query is reusable across a table view, a
  dashboard stat, a chat list, an LLM tool. Presentation cannot leak into
  the engine. Matches `Query` in Rust.
- **Cons:** New ontology class, migration of existing Views (filters live
  on the View today), more types before we have deleted any. Easy to
  over-design relative to current UI (one default view per table).

Do this **if** we know dashboards, LLM tools, and non-table lists will
share specs. If the only persistable query for a while is "a table's view,"
B is enough and C is a later extract.

### D — Unify `/query` and `/search` envelopes (orthogonal)

Make `/search` return the Collection/QueryResult shape (members, totals,
optional nested resources) instead of `endpoint/results`. Longer term, a
query spec may include `q` and the store intersects Tantivy with the query
index (already sketched as operator-roadmap item 3).

- **Pros:** One client list type. Saved queries can include search.
- **Cons:** Search is ranked and not stably pageable the same way; totals
  mean something different. Does not remove Collection resources by itself.

Do **alongside** B or C, not instead. Do not block retiring Collection
resources on search unification.

### E — Rename the client: `Collection` → `Query`

TS `Collection` / `useCollection` / `CollectionBuilder` become `Query` /
`useQuery` / `QueryBuilder`. Rust `Collection` struct becomes the HTTP
result mapper or folds into `QueryResult`. Ontology class `Collection`
deprecated.

- **Pros:** Names match the engine and `/query`.
- **Cons:** Loud SDK break (`@tomic/lib`, `@tomic/react`, templates,
  docs). Does not remove complexity; it relabels the load-bearing part.

Worth doing **after** A, not as the first cut. Compat aliases for a
release is enough.

## Recommendation

**A then B, extract C only when a second consumer needs a spec without
presentation.**

1. **A (cleanup, no product change).** Stop offering Collection as a
   creatable class. Point docs at `/query` + `useCollection` / `store.query`.
   Leave ClassExtender for existing subjects. Changelog: Collection
   resources are deprecated.
2. **B (the persistable query).** Treat `View` as the named query. Add an
   explicit source (table / parent / class / drive). Ship the multi-view
   switcher. Allow a View to be opened as a page (list/cards = old
   CollectionPage). Prefer `block-source → View` over a third copy of
   filters on Block.
3. **C when needed.** If dashboard stats, LLM `query` tools, or Flutter
   start needing the spec without columns/kind, pull `view-filters` + sort
   + source into a QuerySpec JSON/class and leave View as presentation.
   The JSON on View today is already that spec; extracting is mechanical.
4. **D and E when convenient.** Envelope unification and the rename are
   independent of whether View or QuerySpec is the stored document.

Default execution of a View is always layer A (`store.query` / `/query` /
OPFS), never "GET the View and hope a ClassExtender fills members." That is
the load-bearing lesson from Collection resources.

## What not to do

- **Do not** grow Collection resources to catch up (add `filters` JSON,
  operators, aggregation on the class). That duplicates View and keeps the
  definition+result GET model.
- **Do not** make `/query` write a stored Collection. It already returns a
  throwaway one; that is correct.
- **Do not** collapse `/search` into `/query` before ranked vs structured
  is explicit on the spec. Intersection, not a single index.
- **Do not** start with the TS rename. It is churn on the path that works.

## Open questions

1. **Is a View without a Table a product we want?** "Saved search" /
   "smart folder" as a first-class document, vs only table tabs and
   dashboard widgets. B is weaker if the answer is no — then A + table
   Views is enough and CollectionPage just dies.
2. **Source model.** `parent = X`, `isA = Class`, `drive = D`, or a list of
   those, is already `Query.filters`. A View can store that as
   `view-filters` plus an optional `view-source` for the UI ("this is a
   view of Table T"). One JSON blob vs a distinguished source field.
3. **Existing Collection resources.** Unlikely in user drives (not in
   BaseButtons, populate is tests). Still: leave GET working, or migrate
   `property`/`value` → a View on sight?
4. **`/all-versions`.** Uses the Collection *struct* as a paginated list
   of version URLs, not the query index. Keep the envelope; it is not a
   Collection *resource*.
5. **LLM / external apps.** [`habits-app.md`](./habits-app.md) wants a
   public `query` RPC, not Collection resources. Whatever we persist should
   be the same JSON `/query` already accepts so tools do not learn a third
   schema.

## Related

- [`table-view-filters.md`](./table-view-filters.md) — View ontology +
  remaining multi-view switcher.
- [`multi-property-filter.md`](./multi-property-filter.md) — AND filters on
  the engine (shipped); Collection *resources* never grew them.
- [`dashboards.md`](./dashboards.md) — `block-query` as a third spec copy.
- [`unify-subscription-primitives.md`](./unify-subscription-primitives.md) —
  `SUBSCRIBE_QUERY` should take the same filter shape.
- [`docs/src/schema/collections.md`](../docs/src/schema/collections.md) /
  [`docs/src/core/querying.md`](../docs/src/core/querying.md) — public story
  still Collection-first.
