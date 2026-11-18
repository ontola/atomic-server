# Table workspace package

Status: complete TablePage/shared-UI source extraction is implemented and
validated in Atomic (18 November 2026). ELFA full-page adoption and catalog
evolution remain open. State-management improvements are deferred; see [the scope reset](tablepage-extraction-reset.md).
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
- [x] Move the complete saved-view tabs with TablePage; avoid an intermediate
      presentation-only extraction.

The original #2434 stack is preserved as reference. The replacement extraction
starts at #2535 and keeps functionality changes in deferred drafts. The current
grid boundary does not make the complete TablePage storage-independent.

## Full TablePage gate

- [x] Move complete TablePage/TableResource orchestration with the existing SDK
      query, schema/property, mutation/draft, saved-view and permission APIs;
      navigation crosses the small host boundary.
- [x] Share schema/property and row dialogs, typed cells, saved-view lifecycle,
      page-owned menus/defaults, filters/order/paging, totals, clipboard/undo,
      derived columns/actions and built-in renderers.
- [x] Inventory and retain title/cover/export, files/relations, comments/presence,
      forms, connections and automation controls; track explicit external
      backend/integration requirements.
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
declarations, full moved-page behavior and preserved locales. ELFA complete-page
backend acceptance remains a separate gate.

- [x] Include Atomic adapter and affected shared-library/host paths in triggers.
- [x] Test shared page behavior and the Atomic wrapper.
- [x] Test a clean external adapter consumer with pinned inputs; separate native
      backend/browser jobs when broker/WASM infrastructure is required.
- [x] Add browser keyboard/navigation and actual desktop/mobile screen evidence.
- [ ] Add catalog/lens compatibility, unavailable/offline/version persistence and
      scoped-frame lifecycle tests when their milestones begin.

The table/UI/helper packages are private. An npm release is not a prerequisite. A pinned Git submodule can build and
consume compiled modules while preserving the tested package boundary.
`@tomic/table` returned npm 404 on 11 November 2026. SDK distributions embed the private pure helpers, so this extraction does not
require a new registry package for existing SDK consumers.


## Complete-page extraction boundary (resumed November 2026)

The next extraction starts at `bd4fa0ed54c466e392b1d42e42480adba132b19d`,
independently of the review-ready candidate stack. Its source ownership is:

- `browser/table-page`: the entire TablePage subtree, plus DashboardPage because
  its blocks embed TableResource. This includes the existing built-in views,
  saved view tabs, query orchestration, history, forms, filters, exports and
  resource-aware cell editors. Atomic becomes a real consumer of this page.
- `browser/resource-ui`: whole shared SDK-aware forms, value renderers, record
  fields, links, title/cover/file controls and their bounded editor dependencies.
  Public `resource`/`property` JSX and existing SDK hooks retain their behavior.
- `browser/ui` and `browser/utils`: canonical SDK-free controls and pure helpers;
  moved resource code imports these implementations rather than copying them.

A small host provider supplies router/search navigation, shell settings,
comment-panel actions, executable app/workspace integration and the generic
embedded-resource dispatcher. It does not supply built-in view implementations
or replace forms/filters/history with host-rendered slots. Existing app-wide
contexts keep one identity through compatibility re-exports. The generic column
label helper belongs with resource fields, avoiding a resource-ui → page cycle.
The stateless WASM loader currently located in managed-account recovery is a
shared utility; account/session/passkey code does not belong in the page graph.

Localization is part of this move: retain all six existing Atomic catalogs and
translated values. Move the existing Wuchale runtime/catalog ownership into the
SDK-aware dependency, scan both moved sources and the Atomic shell, and export
its provider/runtime for packed consumers. The preloader must remain free of
React imports. Locale loading must address the Atomic catalog without changing
an unrelated host catalog. Verify a non-English interaction in both Atomic and
a clean packed consumer; an English-only library fallback does not pass parity.

Validation gates are import-boundary/cycle checks, focused existing behavior
tests, canonical context identity, package declarations/packing, Atomic full-page
consumption and actual desktop/mobile browser evidence. Heavy SDK/WASM/server
or whole-app checks use `/tmp/atomic-candidate-heavy-check.lock` and are scheduled
behind the candidate validation. This future branch is excluded from candidate26.

Current future-branch validation:

- [x] All 213 original TablePage/Dashboard source/test files accounted for.
- [x] SDK/UI/grid/shared-resource/page distributions and declarations build.
- [x] Whole Atomic app typecheck uses the extracted page and canonical contexts.
- [x] Clean external packed consumer edits a real SDK Resource through
  `InputString`, validates in Dutch, preserves a foreign Wuchale catalog and the
  patched keyed-message helper, and checks NodeNext declarations.
- [x] Six canonical catalogs preserve all 3041 active message IDs and translated
  values per locale; a second clean is stable and the read-only audit is green.
- [x] Shared resource behavior tests pass (41), and every moved page suite passes
  (39 files, 545 tests) using this worktree’s real optimized formula WASM.
- [x] Native production Atomic app build consumes the complete extracted page.
- [x] Desktop/mobile Dutch page journeys use this worktree’s native server and
  source frontend (real create/edit/computed/configuration persistence).
- [x] Existing native browser regressions pass (9): forms, comments, templates,
  filters, saved-view persistence, editing, bulk deletion and resource menus.
- [x] Normal commit hooks pass: full-workspace browser lint/format and Rust
  Clippy on the staged snapshot, without bypasses.
- [ ] Integrate the full page into ELFA through a future candidate and complete
  the external backend acceptance gate.

The generic app-wide resource menu and right comments panel remain shell
services using the canonical shared trigger/state contexts. An external host
must wire those real services; default contexts do not implement the UI. This
boundary needs explicit review alongside the generic embedded-resource
dispatcher, before declaring ELFA full-page behavior complete.


The retained CSV export specifically requires Atomic's `/export` endpoint via
`Store.getServerUrl()`. ELFA must implement a real export capability or expose
an unavailable state; a placeholder server URL is not parity. Other SDK-native
query, upload, permissions and history requirements remain subject to the same
backend acceptance gate. The source extraction does not redesign these APIs.

A native browser check also reproduces a baseline React Compiler issue: after
a reload, a constant computed column can remain blank until its inputs change.
Original and moved `DerivedCell` produce byte-identical compiler output: the
`useFormulaReady()` return is ignored and is absent from the memo dependencies.
Keep that readiness/state fix in a separate improvement PR; do not change the
component during its extraction.

Native browser harness notes: the E2E setup route is intentionally development
only, so browser journeys use own Vite + own native server; production app and
embedded-server builds are validated separately. Override the checked-in
managed development server URL with the isolated server’s URL. The temporary
harness retains the original direct Google stylesheet (as production does)
because this environment’s Node development-font proxy returns HTTP502. No
backend operations or record persistence are mocked.
