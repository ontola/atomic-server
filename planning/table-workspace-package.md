# TablePage extraction and integration gates

The Atomic source app uses the complete extracted TablePage. This is a code-move
and host-boundary change; component state/retry improvements remain separate.
Execution tracker: [#2484](https://github.com/ontola/atomic-server/issues/2484).
The original #2595 three-commit extraction is ported onto the clean foundation
based on develop `4c8ba2cade`; it does not import the old plugin candidate tree.

## Package ownership

- `browser/table-page` owns TablePage/TableResource and DashboardPage, including
  existing built-in views, saved tabs, query orchestration, dialogs, filters,
  history, exports and resource-aware cells.
- `browser/resource-ui` owns shared SDK-aware forms, record fields, links,
  title/cover/file controls and their existing editor dependencies. The
  `<InputString resource={resource} property={property} />` API and SDK hooks
  retain their behavior.
- `browser/ui` and `browser/utils` remain canonical SDK-free controls and pure
  helpers. The page and resource editors import their shared implementations.
- A host provider supplies routing/search, settings, comment-panel actions,
  executable-app/workspace integration and generic embedded-resource dispatch.
  It does not replace built-in views or forms with host-rendered feature slots.

The page remains SDK-aware. This extraction adds no Rust runtime, WASM protocol,
plugin server feature, new persistence guarantee, or state-management model.
App-wide contexts retain one identity through compatibility re-exports.

All six Atomic catalogs and their translations move to resource-ui. Host,
UI/grid, shared-resource and page sources use one localization pipeline. Locale
preloading remains React-free, and loading Atomic's catalog preserves an
unrelated host catalog. Injected localization runtime imports are resolved by
the host; the dependency-free UI/grid packages do not depend on resource-ui.

## Source validation

The clean port has passed:

- Fresh SDK/UI/grid/resource/page builds and declarations; explicit package and
  actual Data Browser host typechecks; package lint and import/cycle checks.
- Existing suites: 41 shared-resource, 545 moved-page, 14 host-control,
  9 utility and 39 grid tests. These preserve existing behavior rather than
  adding the deferred component improvements.
- Fresh formula WASM compiled from this worktree's source and optimized with
  Binaryen 117; no prebuilt WASM was borrowed.
- A clean seven-package packed consumer edits a real SDK Resource through
  InputString, exercises Dutch required-field validation, preserves the foreign
  host localization namespace and checks NodeNext declarations.
- All 3,051 active messages and translated/plural values in each of six locales
  survive the ownership move unchanged.
- Actual production web and embed builds; the unmodified Flutter shipping
  script; the default unchanged embed-size gate on `flutter/assets/embed`.
- Actual production TablePage grids on desktop/mobile, using invented records
  with genuine SDK causal snapshots through a synthetic read-only native
  channel. Name/Description columns and both rows render with no page errors
  or mutation calls. This is rendering evidence, not backend write, durability
  or peer-sync acceptance.

The original extraction history also contains native-server journey results.
Those are historical evidence, not rerun claims for this clean source port.
The existing constant-computed-column compiler/readiness issue remains a
separate improvement; it is not changed during the move.

The independent `.github/workflows/table-package.yml` lane validates shared
controls, the actual Atomic host, complete-page packages, real formula WASM and
packed SDK/localization consumers. Packages remain usable through the Git
submodule/source graph; this work does not require publishing npm packages.

## External-host full-page acceptance

The source extraction does not declare ELFA backend parity complete. Before an
external host adopts the page, verify its real supported APIs for:

- Scoped queries, aggregates, paging and reactive updates without an app-owned
  full-collection mirror or query bypass.
- Permissions, schema/property operations, draft/partial failures, conflicts,
  distinct same-class collections, navigation and offline/reconnect behavior.
- Files, relations, comments/presence, forms, resource menus, app views and
  connection/automation controls; supply actual host services where required.
- CSV export: the retained implementation uses Atomic's `/export` endpoint and
  Store server URL. Supply a real capability or an unavailable state; a
  placeholder server URL is not parity.

Default contexts do not implement the app-wide resource menu or right comments
panel. External hosts must wire the real shared trigger/state services. Keep
stronger persistence/replica guarantees and component reliability improvements
in their own reviewable changes.

## Catalog evolution after adoption

Coordinate with view registry #1899 and existing app-view/lens protocols.

- [ ] Define a versioned catalog with stable identity, pinned artifacts,
      integrity/provenance and explicit capability requirements.
- [ ] Match verified row classes/properties, datatypes and cardinalities across
      all applicable classes; never match display labels or sampled rows.
- [ ] Keep discovery, installation, saved tabs and authorization separate.
      Preserve existing views and ordinary Table access.
- [ ] Define loading/offline/unavailable behavior; retain bindings when an entry
      disappears and never silently upgrade executable code.
- [ ] Use the scoped frame host for custom renderers, with request identity,
      native authorization and teardown checks.
- [ ] Match lenses by declared source/target schema/property identity,
      direction, supported transforms and content-addressed IDs.
- [ ] Preview losses, ambiguity and unsupported values before explicit
      activation. Discovery does not retype rows or write source records.
- [ ] Start with direct declared mappings, without implicit multi-hop chaining
      or an assumption that transforms are invertible.

## Embed size budget

The original extraction's final commit coalesces only Rolldown's statically
reachable `$initial` modules. Lazy feature modules remain lazy. The unchanged
budgets are 1,000,000 bytes of first-use gzip and 16,777,216 shipped bytes.

The unmodified `flutter/scripts/build_embed.sh` rebuilds the renderer and copies
`embed.html` plus `assets/**` into `flutter/assets/embed`. The default size gate
on that actual payload passes: two initial chunks, 962.6 KB gzip and 14.5472 MB
total. Raw `dist-embed` also contains web-only public assets; its 23.7935 MB is a
different measurement, not the Flutter shipping payload. No budget, copy rule,
valid web asset or optimization requirement was removed to make the gate pass.
