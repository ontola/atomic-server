# Table workspace package

Status: full TablePage extraction is the decided target (11 November 2026).
The package now shares grid/editors, saved-view tabs, navigation/query/row
contracts, row mutation/creation execution and session-local undo. Column form
extraction is in progress; the full page and catalog evolution remain open.
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

### Persisted creation increment

- [x] Shared prepare/validate/persist/read-back creation service with schema and
  scope guards, cleanup and no implicit retries.
- [x] Atomic named-row and quick-add flows use the service, retaining row defaults,
  explicit unset and existing save policy; notify only after confirmation.
- [x] Native adapter applies native defaults, validates with the runtime schema,
  writes through the public ORM and confirms with an independent bounded read.
- [ ] Deferred grid drafts, paste, calendar/timer creation and insert-below still
  need migration; this increment does not claim all creation paths or TablePage.
- [ ] Schema form extraction and remaining creation paths remain follow-up work.


### Shared undo increment

- [x] Session-local history controller: captured commands, single-edit coalescing,
  reverse batches, synchronous in-flight guard and confirmed per-item progress.
- [x] Atomic history hook uses the shared controller; storage restore/destroy
  stays in its adapter, with deep snapshots of old values and deleted rows.
- [x] ELFA saves record reverse commands only for confirmed rows, including partial
  Save success. Undo uses stable fields and saved-value conflict baselines through
  the public ORM adapter; pending drafts block undo.
- [ ] Native creation/deletion undo, durable history and redo are not implemented.
  Native history resets on collection/schema change or reload. Schema forms and
  the rest of TablePage orchestration remain separate work.


### Schema form increment

- [x] Shared controlled property-name field, focus/validation presentation and
  identity-preserving rename policy, used by Atomic and the native schema editor.
- [x] Native port label renames preserve property shortname, ID and RDF predicate;
  newly created columns still receive provisional names before identity minting.
- [x] Text format changes remain on the unsaved Atomic property draft; the category
  control no longer persists a temporary property before dialog confirmation.
- [ ] Category controls, dialog lifecycle and schema activation are still host-bound.
  A shared name field does not complete the schema forms or full TablePage gate.
- [ ] Native creation/deletion undo is blocked on authorized complete-subject
  snapshots/conditional restoration; ELFA/database-apps#91 records why shaped
  snapshots cannot restore all deleted predicates safely.


### Shared schema range controls

- [x] Shared raw numeric/length range field and full-text parser; retains invalid
  input, supports fractional numeric bounds and equal inclusive bounds, and
  validates maximum-only integer bounds without flooring invalid decimals.
- [x] Atomic range forms keep changes on the unsaved draft and report shared
  validation to the dialog; existing host styling and localization are retained.
- [x] Native port exposes the same control for class-level numeric/length rules,
  blocks invalid schema submission, and explicitly discards raw constraint drafts.
- [ ] Remaining category controls, schema lifecycle/dialogs and full page
  orchestration remain unextracted. Catalog evolution has not started.


Native schema guard hardening is implemented in merged
[ELFA/database-apps#98](https://git.elfaconsortium.eu/ELFA/database-apps/pulls/98).
Production commands carry the accepted schema digest and pointer, verify fresh
native schema metadata before writing, and recheck live scope/field baselines and
candidate validation after asynchronous verification. Creation/sample writers
check again after readiness. Nineteen native browser cases and 432 unit tests
passed on the merged tree. These remain preflights, not cross-document atomicity.

### Shared datatype/format choices and float editing

- [x] Shared choice control for radio/dropdown presentation, enabled-value guards,
  independent radio groups and preservation of unsupported saved bindings.
- [x] Atomic text/number format controls use the shared control. Missing display
  precision no longer retypes an existing integer property as float.
- [x] Atomic and native hosts use the same float editor; Atomic retains its
  property-aware display formatting, while native keeps raw drafts and ORM writes.
- [x] Native schema datatype selection uses the shared choice control.
- [x] Numeric bounds may be fractional even for integer-valued columns under JSON
  Schema semantics. Only length bounds require whole numbers; never floor bounds.
- [ ] Remaining category controls, property dialog lifecycle, shared saved-view
  lifecycle and actual TablePage/TableResource orchestration remain open.

## Scoped native queries and property commit lifecycle

- Native [database-apps #100](https://git.elfaconsortium.eu/ELFA/database-apps/pulls/100)
  consumes the shared `TableQuery` and genuine `WindowedTableRows` contracts.
  Public ORM equality/order/paging and live membership remain backend operations;
  unsupported expressions, aggregates, optional sort keys and datatype unions
  fail explicitly. Integer writes now preserve their declared RDF type and
  `16777217` exactly. No existing data is migrated.
- Native [#101](https://git.elfaconsortium.eu/ELFA/database-apps/pulls/101) adds
  explicit double bindings for new columns, with precise filters, conflict/undo
  checks and a guard against metadata-only retyping of existing literals.
  Date/duration writes remain read-only because the pinned native writer rejects
  those declared RDF types; see native #91.
- The shared property/schema commit controller now prevents duplicate submits,
  preserves host working drafts after failed saves, and suppresses stale UI
  completion callbacks after a scope change. It can checkpoint an opaque prepared
  identity, so a failed class attachment retries the same created property.
- Atomic new/edit-column dialogs consume this policy and await the host save
  before closing. New columns defer attachment until their definition is saved;
  partial attachment failures retain the identity and lock the definition while
  retrying. Async draft preparation is scoped to its property/class/category.
  The page-level edit dialog receives the actual table class explicitly.
- Native schema-editor adoption of the commit controller is the next integration.
  Property categories, backend metadata transactions/version preflight, saved-view
  lifecycle and actual TablePage/TableResource orchestration remain open. This
  controller is not a claim of full property-form or full-page extraction, nor
  an atomic rollback of writes already accepted by a backend. Catalog evolution
  still follows the full-page gate.

## Saved-view scope and initialization increment

The package now owns view-reference normalization, explicit selection readiness,
record-owner and reorder validation, plus single-flight implicit-view initialization.
Atomic consumes these policies from `useTableView`: foreign URLs do not fall back
to default filters, row queries remain gated until the selected metadata is ready
and owned, and view mutations cannot target another table's record. Legacy
default-only configurations retain their default tab. Concurrent first filter/
column changes share one materialized default view.

Native [#102](https://git.elfaconsortium.eu/ELFA/database-apps/pulls/102) completed
schema commit-controller adoption. Native adoption of saved-view scope/creation
policies is in progress. Its explicit Save policy and Atomic's immediate-save
policy remain distinct. These primitives do not complete configuration-model,
saved-view persistence/transaction or full-page orchestration extraction.


## Configuration-write lifecycle increment

Native [#103](https://git.elfaconsortium.eu/ELFA/database-apps/pulls/103) merged
shared view selection/initialization policies. Missing/unavailable metadata opens
no native row query. Exact new-view retries freshly confirm the same stored ID
without another write; altered payloads and wrong collections still fail. All 26
native browser cases, 454 unit tests, types and the target build passed.

Atomic configuration setters and debounced filter/sort saves now use a shared
per-table write queue. Saves run in order; a failure retains the operation and
later edits, and the actual TableResource offers an explicit retry. Implicit-view
creation checkpoints its prepared Resource before attachment, so retry cannot
allocate a duplicate default. Retried configuration writes recheck record ownership;
a late save cannot replace the active view's hydration baseline.

Saved-view CRUD transactions, complete configuration/session extraction and full
TablePage orchestration remain open. The queue does not claim cross-document
atomicity or a full page port. Catalog work still follows that full-page gate.


## Saved-view command checkpoint increment

The shared queue now supplies per-intent checkpoints for prepared identities and
successful phases. Atomic create/copy, renderer changes, deletion and reorder use
the same retained-error path as configuration writes. Copies and explicitly created
views reuse a prepared Resource after failed attachment. A failed in-place type
save retains its original change-versus-add decision. A destroy retry resumes
after confirmed detachment, preserving tabs added afterward. Reorder validates
fresh membership, and creation/duplication capture navigation at the initiating
intent rather than at retry. Foreign/unloaded records cannot stand in for the
last owned Table renderer.

These are scoped client lifecycle guarantees under Atomic's existing save/outbox
semantics. They do not supply cross-document transactions, automatic rollback or
backend compare-and-swap. Complete configuration/session modeling and actual
TablePage/TableResource extraction still remain, followed by catalog evolution.


## Complete stored-view model and Atomic metadata binding

The package now owns the model/codecs for all stored built-in view settings,
including legacy derived formulas, actions, quick-add, statistics and column order.
Atomic reads, patches and copies these settings through one backend property map.
A single local/remote subscription keeps parsed arrays stable across unrelated
metadata changes and also observes local parent changes before save.

Malformed query-bearing shapes make the view unavailable rather than falling back
to an unfiltered query. Unavailable metadata mounts no renderer or app frame.
Absent derived-column configuration still differs from an explicitly empty list;
query reference resolution against renderer defaults/schema remains session work.
The closed action/legacy-generator codecs also reject inherited object names.

A real TablePage check uses an invented local-only drive and the actual client
WASM: it creates a table, observes invalid configuration, repairs metadata and
reloads the page successfully. JSON quick-add metadata, false timer settings and
explicit empty derived columns also survive reload. Desktop/mobile screenshots
stay outside Git.
The original formula/aggregate regressions run against the real Rust/WASM engine.
Owned legacy views without names now hydrate by captured loading status rather
than name presence. Readiness waits for the correct table/view filter and sort
state; late implicit-view preparation cannot retarget another table session.
Per-view dirty drafts, incoming-config conflicts and the complete saved-view
session controller remain host work. Native v1 query adapter adoption is in
progress; its legacy hidden-column/width
storage policy is retained. Full session/orchestration extraction and renderer/UI
parity remain open, before any catalog evolution.

## Scoped saved-view drafts

The shared draft session now owns live pristine reads, retained per-view baselines,
conflict detection, immutable save submissions and explicit retry tokens. Implicit
view preparation aliases/moves the same draft rather than reinitializing it.
Atomic filter/sort autosave adopts this controller: changing tabs flushes pending
work, and newer edits drain after an in-flight save even after unmount. Failed
operations remain paused until explicit Retry; returning to a table retains its
queue. Tests cover incoming pristine metadata, navigation before debounce,
failed-save navigation and newer edits during an unmounted save.

This does not move the remaining renderer/configuration UI into the package or
supply backend revision transactions. Native explicit Save/Discard adoption is
next; the full TablePage gate and subsequent catalog work remain open.

## Shared view query compilation

ELFA's explicit Save/Discard draft adoption shipped in database-apps #105.
Version 2 native records now save stable query Property IDs (#107); active legacy
v1 queries need an explicit column choice rather than guessing historical
bindings. Persisted-wallet restart remains a separate integration question (#106):
fresh in-session SDK read-back is not restart evidence.

The shared query compiler now resolves computed filter/statistic references and
builds one request for actual Atomic TablePage rows and collection-wide totals.
Previously, an unresolved computed filter was silently dropped; it now makes the
query unavailable. Implicit timer duration uses the same shared expression for
the grid, filters and totals, while an explicit empty derived list still wins.
Numeric conversion failures and unsupported computed operators also stop the
request. Schema/type checks and backend query capabilities remain adapter work.
Standalone dashboard-block queries still need migration. Full page orchestration,
configuration controls and built-in renderers remain open before catalog work.


## Dashboard stat/chart query adoption

Actual dashboard blocks now borrow an owned view through the same reactive
metadata binding and shared query compiler as TablePage. Block conditions are
ANDed with view conditions; malformed or unresolved valued filters and foreign
views stop aggregation instead of widening it. Implicit timer defaults also
resolve through the common model. Block measures use the same aggregation
compiler, retain the initiating query clock, preserve row-count semantics and
omit the table-footer count measure from chart series.

Stat/chart UI distinguishes unavailable configuration from empty data and hides
previous results during loading. Hook/measure regressions join the dedicated
TablePage CI lane. An actual local-drive dashboard renders a count/chart, blocks
both on invalid/foreign metadata, and recovers after repair; screenshots stay
outside Git. Full dashboard renderer extraction and native aggregation support
remain open, with the full TablePage gate still preceding catalog discovery.
