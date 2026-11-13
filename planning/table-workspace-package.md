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

## Shared typed filter-value control

The actual Atomic filter popup now delegates value UI to the shared package:
text, numeric text, dates, booleans, declared choices and canonical JSON. Atomic
retains datatype IDs, reference search, tag labels and style primitives. Incomplete
numeric strings remain intact instead of the browser clearing number inputs;
unknown choices and false values remain visible. Numeric string normalization is
an opt-in backend policy, while typed backend parsing/range checks remain there.
Existing translated picker labels are explicitly retained during extraction.

ELFA adoption is in progress with its public ORM query parser; the entire filter
bar/chip/menu and remaining page/renderer orchestration still need extraction.
Catalog discovery continues to follow the full-page gate.

## Shared filter chip and unavailable-target recovery

ELFA's typed filter adoption shipped in #109 with 28 real-SDK browser cases,
including retained invalid numeric text, zero row queries for invalid integer
filters and a persisted false value under its stable Property ID.

The actual Atomic filter chip now uses shared popup/edit/remove orchestration,
operator selection and computed numeric/date modes. Backend adapters retain
resource labels, reference search, datatype mapping and existing host style/
control-lock primitives. The package includes a default Radix popup and explicit
header labelling. Unsupported operators stay visible, and invalid numeric `now`
text remains editable.

A missing computed target no longer makes its filter disappear from the bar.
The retained unavailable chip offers removal; the normal scoped draft/write
controller performs that metadata change. Tests cover the package control and
actual Atomic page-context removal path in the dedicated CI lane. This recovery
is for unresolved targets; malformed stored configuration and the remaining
full-page/schema/renderer services still need extraction.

## Shared active-filter bar

The actual Atomic active-filter row now uses `TableFilterBar` from the package.
It owns stable-key chip dispatch, hidden-target retention, unavailable-target
removal, and exclusion of already active/hidden targets from Add. Targets are
backend metadata descriptors; value/reference leaves retain backend identity.
A default searchable Add control works without an Atomic dropdown; Atomic keeps
its existing menu primitive and drive-search affordance. Equality-only backends
can also repair a previously stored unsupported operator without removing the
filter. Package tests exercise these state transitions; the actual Atomic page
checks unavailable-target removal and persisted recovery. ELFA's full stored
configuration and remaining page orchestration still need adoption.

## Shared stored-property heading

Atomic's actual property heading now uses `TablePropertyHeading` for label/
required state, sort indicators and command, hover/drag presentation and the
full-height context-menu target. Property metadata, datatype icons, language
selectors and property-command menus stay in the backend adapter. Package tests
cover sorting, disabled capabilities and drag/context dispatch; the dedicated
adapter lane resolves real required-property metadata and checks stable-ID sort
dispatch. Actual local-drive browser checks verify ascending/descending numeric
ordering and the retained backend context menu. ELFA adoption follows its full
configuration increment (#110); complete configured headings, schema/menu and
page/renderer orchestration remain open before catalog discovery.

## Shared first-filter selector

ELFA's full saved configuration and active-filter bar shipped in #110; shared
property-heading sorting shipped in #111. The actual Atomic toolbar now uses
`TableFilterMenu` with the same target-exclusion policy as the active bar. It
adds filters before any active chip exists, disables exhausted/empty menus and
guards selection during backend operations. A default searchable control works
without a host menu; Atomic retains its dropdown primitive and drive search.
Package tests cover first selection, exhausted menus and busy guards. Actual
local-drive browser checks add numeric and text filters through the toolbar,
verify active-field exclusion and preserve both across reload. Shared selector
and bar compile cleanly; the pre-existing seven sortable-tab ref diagnostics
remain unchanged. Full column menus, schema controls and page/renderer
orchestration remain open before catalog discovery.

## Shared column visibility selector

ELFA's toolbar selector shipped in #112, including a full-constraint reset after
row creation/sample loading and a query guard scoped to confirmed unsupported
metadata. Atomic's actual property visibility menu now uses `TableColumnsMenu`
for check marks, renderer locks, minimum-visible policy and stable-ID guarded
toggles. Backends supply titles, persistence and their menu primitive; a default
checkbox selector is available without Atomic UI. Atomic retains its zero-minimum
policy, while ELFA will retain one visible column and native hidden-column
semantics. Package tests cover locked columns, minimum visibility and busy
guards. Actual local-drive browser checks hide a property, verify persistence
after reload and restore it. The shared component compiles cleanly; the same
seven sortable-tab ref diagnostics remain in the host. Full property/schema
menus and page/renderer orchestration remain open before catalog discovery.

## Column removal intent correction

ELFA's column menu shipped in #113 with all 34 native port browser cases, types
and production build passing. Reviewing the next property-menu seam exposed an
existing Atomic bug: an internally owned definition was destroyed regardless
of the unchecked delete checkbox. The actual menu now uses explicit intent and
separate detach/delete capabilities through `executeTableColumnRemoval`. It
awaits detachment before definition deletion and surfaces backend failures.
External definitions are unavailable for deletion from this menu. Package and
actual metadata/menu adapter regressions cover unchecked/checked intent, ordering,
permission rejection and failed detachment; the actual local-drive page confirms
unchecked removal preserves the definition. The existing confirmation closes
before backend completion; retaining an asynchronous removal dialog and full
property/schema menu UI remain follow-up work. No cross-resource atomicity is
claimed.

## Shared property action menu

The actual Atomic property menu now uses `TablePropertyMenu` for command labels/
icons, capability guards and imperative context opening. Its default popup
supports keyboard navigation without invoking grid shortcuts and avoids stealing
focus from a newly opened filter/editor. Atomic retains its dropdown primitive
and schema-dialog services. Package checks cover enabled/disabled dispatch,
context opening and keyboard focus. The existing actual heading/menu adapter
regressions and local-drive sorting/removal checks continue passing. Native
Filter/Hide adoption is in progress; property viewing and targeted edit/remove
dialog services remain unavailable there and are explicitly disabled. Full
property/schema forms, asynchronous removal confirmation and page/renderer
orchestration remain open before catalog discovery.


### Page-owned asynchronous removal confirmation

`TableColumnRemovalDialog` now owns the actual confirmation UI, delete selection,
busy lock and retained error state. Atomic opens it through the page context and
mounts its metadata/services adapter beside other page dialogs, outside column
headings. Optimistic schema detachment can unmount a heading while its dialog
continues to report the backend outcome. The captured row-class/property scope
cannot retarget to a different active row class. Definition deletion still needs
explicit selection and capability, after a successful schema save.

This supersedes the earlier note about confirmation closing before completion.
It does not make schema detachment and definition deletion atomic, provide
rollback, or complete property forms and page/renderer extraction. Native targeted
Edit/Remove services remain disabled pending their own implementation.


### Remaining property-format controls

The real Atomic decimal-precision input and date-format choice/preview UI now use
shared `PropertyPrecisionField` and `PropertyDateFormatField` controls. Atomic
retains Resource bindings, validation-context integration, locale formatting and
its precision-to-datatype policy. Invalid fractional, partial or out-of-range
precision drafts no longer truncate into a different persisted precision or
datatype. Date radio groups are isolated per form and unsupported stored formats
remain visible without substitution.

These are property-form controls, not a claim that the complete property form,
creation/edit dialogs or TablePage orchestration have finished extraction. Native
format metadata services and unsupported category controls still need explicit
capability handling when the complete form is adopted.


### Shared property form and category layout

The actual Atomic PropertyForm now uses `TablePropertyForm` for the name field,
form submission guard and field layout. Text, number, date, relation and select
adapters now render `TablePropertyFields` from typed models. The shared UI owns
category headings, format switching, time/multiple toggles and option layout;
the currency/precision branch follows the current format without waiting for
asynchronous metadata class updates. Unknown categories remain explicit.

Atomic retains its Resource hooks, metadata defaulting, permissions, draft
mutations, class constraints and tag services. Resource/class, currency and tag
widgets remain backend leaves. Creation/edit dialog lifecycle and persistence
are still host code, and are the next integration boundary. This does not mark
complete TablePage/page-renderer consumption or the catalog-discovery gate done.


### Page-owned shared property editor

`TablePropertyDialog` now owns actual edit-dialog preparation, validation/save
lifecycle, failures, pending dismissal and scope handling. Atomic adapts its
existing modal primitives and metadata services and mounts the editor above
column headings. Replacing a property can no longer unmount the pending editor.

Atomic datatype replacement checkpoints the materialized property and frozen
constraint snapshot. A failed attachment keeps that intent locked for retry;
reference targets are retained so pending writes still flush when optimistic
lists already contain the new ID. Definition, references and constraints remain
separate writes. Existing supported lens policy is retained; this does not
promise conversion between every datatype or cross-resource atomicity.

The new-column dialog, Native targeted editing, complete page/renderer adoption
and the catalog-discovery gate remain open. No restart durability is claimed.


### Shared new-column dialog and request scope

Atomic NewPropertyDialog now uses the shared property dialog/form lifecycle.
Metadata genesis, select-tag seeds, definition creation and class attachment live
in Atomic services. The created subject is retained across attachment failures;
retries attach that same definition instead of minting another one.

New-column requests are held above grid headers and retain table, active view,
row class and category. Navigation disables an idle captured draft instead of
retargeting it. Completion updates column visibility only when the captured
scope is still active, using the latest scoped visibility callback. An already
running backend operation may finish for its captured owner; this does not imply
rollback or a cross-resource transaction.

Native column creation, the add-column selector, computed/action/external-property
dialogs and full page/renderer orchestration remain subsequent extraction work.

- [x] Extract the actual add-column category menu and guard unsupported actions, with AtomicServer retaining only presentation and backend dialog callbacks.
- [x] Adopt shared add-column creation for native text, number and checkbox fields, including saved-view visibility and schema revision checks (database-apps #117, merged). Other categories remain explicitly unavailable.


### External property attachment lifecycle

The actual external-property attachment dialog now uses `TablePropertyDialog`.
The Atomic adapter retains its resource picker and attachment service, while the
shared controller owns validation gating, pending saves, retained errors,
dismissal and retry. TableResource owns the request and captured table/view/class
scope, just as for new definitions. A class-heading unmount cannot discard it.
The selection is locked after attachment starts because ontology and class writes
are separate; Retry finishes the same intent. Only confirmed success notifies the
captured view. Invalid non-Property resources fail before attachment.

This does not provide rollback or cross-document CAS. Computed/action dialogs,
full page/renderer orchestration and catalog/lens discovery remain unfinished.

Validation for external attachment: 149 Atomic adapter tests, host typecheck,
changed-component React compiler checks and actual desktop/mobile SDK browser
verification pass. The browser fixture rejects class attachment once, retries
the same selection and independently reads exactly one persisted class reference
from the WASM database. Screenshots remain outside Git in
`/workspace/artifacts/table-external-property`.

### Quick-add control extraction

Move the actual quick-add input/button and serial queue to `TableQuickAddBar`.
Atomic table and dashboard adapters supply their existing primitives, translated
labels and `createQuickAddRow` backend. Explicit view/block scopes isolate local
input and completion callbacks. Accepted requests retain their backend binding
while finishing; they are not redirected after navigation. Failure text retains
the submitted value and no automatic retry can create another row.

Package tests cover serial Enter submissions, preserving text typed during a save,
failed values, scope changes and reentrant queue subscriptions. Backend identity,
row defaults and save policy remain in the existing Atomic creation adapter.
Native quick-add adoption and full page/renderer orchestration remain unfinished.

Quick-add validation: 183 package tests, 149 Atomic adapter tests, package/host
typechecks, clean packed-consumer installation and real SDK desktop/mobile
browser verification pass. The browser holds the first save open, queues a second
Enter submission and independently reads both stored values in order, with at
most one save active and newly typed text preserved. Changed new control and
adapters have clean compiler checks; TableResource retains its existing rule
suppression diagnostic. Screenshots remain outside Git in
`/workspace/artifacts/table-quick-add`.


### Shared action configuration fields

Extract the actual row-action fields into `TableRowActionFields`: action kind,
compatible property and tag selections, button label and literal/step input.
Kind/property changes clear the previous target/literal as appropriate. Raw
numeric text remains editable and blocks Save until it is a finite decimal;
zero is preserved. Local edits keep their original action identity when incoming
metadata rerenders the editor. Metadata adapters supply subscribed option labels,
compatibility and backend execution. The dialog lifecycle remains host-bound.

Native shared quick-add adoption is now merged in database-apps #118. Native
configured row actions remain explicitly unsupported. Full page/renderer adoption
and catalog/lens discovery remain unfinished.

Action-field validation: all 185 package tests and 149 Atomic adapter tests,
package/host typechecks, packed external consumer and changed-component compiler
checks pass. Actual SDK desktop/mobile verification retains `-` with Save
blocked, then independently reads numeric `0` from the saved action metadata.
The Atomic input wrapper is retained for its existing border/focus styling.
Screenshots remain outside Git in `/workspace/artifacts/table-row-action-fields`.


### Computed-column fields and formula binding

`TableDerivedColumnFields` now owns the actual computed-column name/formula
controls, examples, local identity/width, binding suggestions and display-kind
inference. The existing slug/identifier/binding helpers move into the package;
Atomic compatibility, Rust evaluator loading/validation and row-value/date
conversion remain backend adapters. The unavailable validator result retains
its distinct meaning: only explicit successful validation enables Save.

The host's existing formula/backend suite is added to the Atomic adapter lane.
Computed dialog lifecycle, page/renderer orchestration and native computed-query
capabilities remain unfinished; this does not enable local-row query emulation
or advance catalog/lens discovery before the full-page gate.

Computed-field validation: 189 package tests, all 176 tests in the expanded Atomic
adapter lane, package/host typechecks, packed consumer and changed-component
compiler checks pass. Actual SDK desktop/mobile verification retains invalid
syntax, suggests the known Rate column, independently reads the saved formula
and Property binding, and renders `4` for stored Rate `2` with `rate * 2.0`.
Screenshots remain outside Git in `/workspace/artifacts/table-computed-fields`.


### Page-owned configured-column dialogs and write receipts

- [x] Mount action/computed editors at page scope, outside disposable headings.
- [x] Reuse the shared preparation/save/error lifecycle with captured view and
  property definitions; retain and disable stale drafts after navigation.
- [x] Await a tracked queued metadata write, preserve accepted identity on retry,
  reject conflicting edits and preserve unrelated metadata. Materialize implicit
  timer Duration when adding/editing computed columns.
- [x] Allow safe dismissal of proven-unwritten failures without leaving a blocked
  queue. Keep uncertain or partially applied operations pending; no rollback or
  cross-document CAS claim.
- [ ] Complete remaining page/session and renderer adoption before catalog/view
  and lens discovery. Native configured actions/computed queries remain gated.

Validation: 196 package tests, 180 Atomic adapter tests, package/host typechecks and packed external consumer
pass. Actual SDK browser checks cover failed-save retry, unrelated metadata,
view navigation, implicit-view promotion, timer defaults and safe abandonment
of a preflight failure. Screenshots are outside Git in
`/workspace/artifacts/table-configured-dialogs`.

The adapter lane builds the real Rust/WASM evaluator before formula tests and
tracks its Rust inputs. CI on the preceding computed-fields branch exposed the
missing build (local bundles had masked it); formula validation remains backed
by the real evaluator rather than a mock.


### Shared create-button configuration fields

- [x] Move the actual quick-add configuration fields and raw draft conversion
  into the package; table and dashboard callers supply metadata and controls.
- [x] Reject missing/incompatible targets and unfinished or non-finite numeric
  presets before either caller saves. Accept zero without empty-string coercion.
- [x] Retain additional stored presets and explain that this editor edits only
  the first preset.
- [ ] Move this configuration's dialog lifecycle and scoped persistence out of
  disposable saved tabs; full page/session and renderer adoption remain open.

Validation: 199 package tests, package/host typechecks and packed consumer pass.
The actual SDK browser check blocks `-`, accepts numeric zero and independently
reads the stored view preset. Desktop/mobile screenshots remain outside Git in
`/workspace/artifacts/table-quick-add-fields`. Existing compiler suppressions in
QuickAddDialog and BlockConfigDialog remain; the new shared fields and Atomic
metadata adapter compile cleanly.


### Page-owned create-button dialog

- [x] Move the actual create-button dialog out of saved tabs into TableResource.
- [x] Reuse the shared preparation/save/error lifecycle and per-intent write
  receipts, including removal of an invalid configuration. Retried removal stays
  removal, and an optimistic metadata change cannot unmount its editor.
- [x] Capture view, class and property definitions, validate current bindings,
  reject peer configuration conflicts and preserve unrelated view metadata.
- [x] Retain stale drafts and block both Save and Remove after navigation.
- [ ] Complete remaining page/session and renderer adoption before discovery.

Native create-button configuration is merged in database-apps #119, pinning
upstream #2531: Apply changes edits the view draft and Save view persists it.
Its 475 unit/integration and 46 real-SDK browser tests, typecheck and production
build pass; open drafts survive navigation and incoming schema revisions.

Atomic validation: 200 package tests and 180 adapter tests pass. Package/host
typechecks and packed external consumer pass. Actual SDK checks independently
read stored zero/removal outcomes, retry a failed removal, retain a peer edit
and safely abandon its unwritten conflict, and freeze the editor after view
navigation. Screenshots remain outside Git in
`/workspace/artifacts/table-quick-add-dialog`. QuickAddDialog now compiles without
its old suppression; the existing TableResource suppression and TableViewTabs
ref diagnostics remain. No rollback or cross-document CAS is claimed.
