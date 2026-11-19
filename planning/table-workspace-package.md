# Table workspace package

Status: full TablePage extraction is the decided target (11 November 2026).
The clean extraction branch shares the grid/editors plus reusable UI and pure
helpers. Full page adoption and catalog evolution remain open. State-management
improvements are deferred; see [the scope reset](tablepage-extraction-reset.md).
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
- [x] Include the packages in lockstep version checks and local builds.
- [x] Validate packed table/UI consumers and the unchanged SDK package API.
- [ ] Move the external host pin to the clean extraction once the full page is ready.
- [x] Add an independent package CI lane with a clean packed-consumer check.
- [ ] Move the complete saved-view tabs with TablePage; avoid an intermediate
      presentation-only extraction.

The original #2434 stack is preserved as reference. The replacement extraction
starts at #2535 and keeps functionality changes in deferred drafts. The current
grid boundary does not make the complete TablePage storage-independent.

## Full TablePage gate

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
- [ ] Characterize and preserve baseline persistence/restart, drafts and partial
      failures; review stronger state guarantees separately. Verify conflicting
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

The table/UI/helper packages are private. An npm release is not a prerequisite. A pinned Git submodule can build and
consume compiled modules while preserving the tested package boundary.
`@tomic/table` returned npm 404 on 11 November 2026. SDK distributions embed the private pure helpers, so this extraction does not
require a new registry package for existing SDK consumers.
