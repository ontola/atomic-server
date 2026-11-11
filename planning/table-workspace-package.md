# Table workspace package

Status: full TablePage extraction is the decided target (11 November 2026).
Only grid/editors and saved-view tab presentation are implemented in the current
package; the full page and catalog evolution remain open.
Execution tracker: [#2484](https://github.com/ontola/atomic-server/issues/2484).

## Sequence

1. Extract the entire reusable TablePage experience and use the same implementation
   in the Data Browser and external hosts.
2. Evolve shared TablePage with custom-view discovery from catalogs by row type.
3. Add compatible-lens discovery from catalogs.

Shared UI, orchestration, built-in renderers, discovery contracts and independent
CI live in atomic-server. Backend adapters own queries, persistence, permissions
and navigation. Provider-specific renderer/lens/catalog content stays with its
owner. A grid wrapper or page made entirely of host-rendered feature slots is
not completion of the full-page target.

## Implemented package boundary

- [x] Isolate grid, context and primitive editors in `browser/table`.
- [x] Retain Data Browser loading/control-lock/formatting adapters.
- [x] Support local source imports and built ESM/declarations from one API.
- [x] Include the package in lockstep version checks and npm release builds.
- [x] Validate a packed external consumer and carry the package pin externally.
- [x] Add an independent package CI lane with a clean packed-consumer check.
- [x] Share saved-view tab presentation and inline rename.

The package-extraction PRs #2434 and #2453 are still under review. They do not
make TablePage's Atomic Resource/Store contracts storage-independent.

## Full TablePage gate

Implementation increment: the shared package now supplies reactive saved-view /
edit-column navigation, with an Atomic router adapter used by TablePage and
TableResource. Embedded hosts can override it without mounting Atomic's router.
The dedicated CI lane also checks Atomic host types and navigation/saved-tab
tests. This removes one host dependency; query, schema, mutation and saved-view
persistence extraction remain open.

Query increment: `TableQuery` now carries scoped requests and backend capability
preflight without Atomic client types. The Atomic collection adapter translates
those requests; rows and totals use identical predicates and class-loading
guards. Indexed query results, aggregate subscriptions and the NextGraph adapter
still need extraction/integration. No new ORM capability is claimed.

Row-result increment: renderers and row operations now depend on the narrow
`IndexedTableRows` identity contract rather than Atomic Collection. Shared
identity lookup/enumeration hooks guard stale results; the quick-filter list is
a real finite implementation, without a Collection cast. A distinct window
snapshot has no enumeration/total-count capability. Windowed grid paging,
backend capability handling for whole-result views, and native row/schema/write
adapters remain open; this is not full NextGraph TablePage integration.

Cell-interaction increment: the shared `ValueCell` now owns editing mode,
first-character buffers, parsed-editor seeds, picker behavior, context menus and
row-advance orchestration. Atomic TableCell supplies Resource reads/writes,
history/save policy and resource-aware renderers. Native host wiring is separate;
schema, mutation-service, saved-view persistence and full-page extraction remain
open.

Mutation increment: shared scoped update/delete execution checks stable field
identities, writable flags, optional schema revisions and baselines, then delegates
validation/transactions/read-back to the backend and releases read handles. Atomic
bulk clearing consumes it, including immutable localized-text clearing and scope
metadata protection. Native adapter integration remains separately pinned; schema
dialogs/activation, creation, undo and full page orchestration are not extracted
by this command service.

- [ ] Extract TablePage/TableResource orchestration and explicit scoped query,
      schema/property, mutation/draft, saved-view, permission and reactive
      navigation services from actual call sites.
- [ ] Share schema/property and row dialogs, typed cells, saved-view lifecycle,
      menus/defaults, filters/order/paging, totals, clipboard/undo,
      derived columns/actions and built-in renderers.
- [ ] Inventory title/cover/export, files/relations, comments/presence, forms,
      connections and automation controls; implement real host capabilities or
      track explicit backend/integration limitations.
- [ ] Both hosts use the same full page; migrate existing saved configurations
      without losing property identities, drafts or collection isolation.
- [ ] Verify persistence/restart, retained drafts and partial failures, conflicting
      writes, two same-class collections, Back/Forward/deep links, read-only,
      distinct-user and offline/reconnect behavior.
- [ ] Record feature-by-feature parity, missing backend operations and performance
      evidence. Do not present page-window totals as collection-wide aggregates.

Queries must use each backend's real supported APIs. No full-collection mirror or
application-owned query bypass may stand in for unsupported backend semantics.
Unavailable operations must stay distinguishable from successful ones.

## Catalog evolution, after the full-page gate

Coordinate with view registry #1899 and existing app-view/lens protocols instead
of creating competing registry identities or a third iframe protocol.

- [ ] Versioned catalog input with stable entry identity, pinned artifact/version,
      integrity/provenance and capability requirements.
- [ ] Match verified row class/property identities, datatype and cardinality;
      consider all applicable classes, never display labels or sampled rows.
- [ ] Keep discovery, installation, saved tabs and authorization separate.
      Adding a compatible view preserves existing views and the ordinary Table.
- [ ] Define loading/offline/unavailable behavior and preserve saved bindings if
      an entry disappears; never silently upgrade executable code.
- [ ] Custom renderers use the scoped frame host with request identity, native
      authorization and teardown tests.
- [ ] Match lenses by declared source/target schema/property identity and
      direction; validate content-addressed IDs and supported transforms.
- [ ] Preview fields, losses, unsupported values and ambiguity before explicit
      activation. A projection, migration and sync bridge are distinct operations.
      Discovery neither retypes rows nor writes source records.
- [ ] Start with direct declared mappings; no implicit multi-hop chaining or claim
      that all transforms are invertible. Reuse identity/transform test vectors.

## Dedicated CI and distribution

Keep `.github/workflows/table-package.yml` as the fast independent lane and
expand it as shared TablePage moves. Existing checks cover package lint,
typecheck, interaction tests, packing, a clean consumer DOM mount and NodeNext
declarations. These are not full TablePage/backend acceptance today.

- [ ] Include Atomic adapter and affected shared-library/host paths in triggers.
- [ ] Test shared page behavior and the Atomic wrapper.
- [ ] Test a clean external adapter consumer with pinned inputs; separate native
      backend/browser jobs when broker/WASM infrastructure is required.
- [ ] Add browser keyboard/navigation and actual desktop/mobile screen evidence.
- [ ] Add catalog/lens compatibility, unavailable/offline/version persistence and
      scoped-frame lifecycle tests when their milestones begin.

An npm release is not a prerequisite. A pinned Git submodule can build and
consume compiled modules while preserving the tested package boundary.
`@tomic/table` returned npm 404 on 11 November 2026. Trusted Publisher setup remains
necessary only before a future registry release, independently of this port.
