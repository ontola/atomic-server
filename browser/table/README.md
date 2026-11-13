# @tomic/table

AtomicServer's virtual table grid and storage-independent text, integer, boolean
and date editors. This is the first package boundary for the full table
experience. It also exports the saved-view tab presentation and inline rename
interaction. TablePage, saved-view persistence/menus, schema dialogs and alternate
renderers still live in the Data Browser.

AtomicServer consumes `workspace:*` and resolves `@tomic/table` to `src/index.ts`
in Vite and TypeScript. External applications install the built package using
their package manager. Both import the same public entry point; no Data Browser
aliases or Atomic Store are required by the package.

```tsx
import { FancyTable, Cell, TableHostProvider } from '@tomic/table';
```

`FancyTable<T>` accepts column identities, a finite item count, a row renderer
and callbacks for mutations, clipboard operations, resize/reorder and selection.
The host owns queries, paging, writes, drafts and authorization. `Cell` and the
editor/context exports share one grid context in the built bundle.

Wrap the grid in `TableHostProvider` to provide a control-lock state and a loading
indicator. The Data Browser adapter uses its existing global lock and Spinner;
external hosts receive standalone defaults. Styling uses the surrounding Styled
Components theme with `defaultTableTheme` as a fallback. The package does not
augment the consumer's global DefaultTheme.

Integer/date editors have optional `textDraft` callbacks so hosts can retain raw
invalid input when virtual rows unmount. Atomic-specific number/date formatting
stays in Data Browser display adapters. React, React DOM and Styled Components
are peers; React 19.2 supplies `useEffectEvent`.

`ViewTab`, `ViewTabsBar`, `ViewTabList` and `ViewTabActions` share TablePage's
saved-view tab layout and inline renaming. Pass resolved names/icons, active and
editing flags, and callbacks; no Atomic Resource or Store is needed. Enter or
blur commits a trimmed, nonempty changed name once; Escape cancels it. Hosts own
permissions, menus, drag ordering, navigation and whether rename callbacks save
immediately or become a draft. `renameLabel` lets the host localize the input.

## Page host services

`executeTableRowMutation` runs one scoped update/delete command against a host
backend. Its schema snapshot uses stable field IDs and writable flags. The
service captures command identity, checks optional schema revisions and field
baselines, invokes host validation/write policy, reads back the result, and
releases opened handles on failures as well as success. `clearTableFields`
builds immutable clear updates, including selected languages of localized text.

The backend owns authorization, datatype validation, transaction semantics and
read freshness. Native adapters supply separate bounded ORM reads; Atomic's
bulk-clear adapter uses its live Resource cache and preserves `Resource.save`'s
persisted/offline/no-op policy. These are distinct confirmation guarantees. Preflight and read-back
do not provide cross-peer compare-and-swap or cross-document atomicity. Callers
keep drafts until a command resolves; creation, undo policy, bulk partial-success
handling and schema activation remain host services/follow-up extraction.

`ValueCell` owns shared edit-mode orchestration: first-character buffering,
text seeds for parsed editors, picker behavior, editor/display switching,
context-menu behavior and draft-row advance. Hosts supply a stable cell identity,
value/write callback, editor renderers and a fresh `canAdvance` predicate. Changing
identity resets pending input so virtual reuse cannot carry a seed to another
row/property/language. Text-start policies can report `onSeed` to a host that
retains invalid raw drafts. The host keeps validation, history, permissions and
its own immediate-save or explicit Save/Discard policy.

`IndexedTableRows` is the small identity-access contract used by the Atomic
grid, selection, clipboard, presence and whole-result renderers. It exposes
indexed lookup, exact membership size and enumeration without Resource, Store
or Collection. `tableRowList` captures a finite immutable identity snapshot,
replacing the quick-filter result's previous cast to an Atomic Collection.

`WindowedTableRows` exposes only retained identities. It has no whole-result
enumerator or total count. Shared row lookup accepts either source; full-result
consumers explicitly require the indexed capability. `useTableRowSubject` and
`useTableRowSubjects` reject stale asynchronous results after source changes and
expose read errors. Atomic resource hydration stays in the host adapter.
The TablePage grid still uses indexed results: native window paging and the
availability of whole-result features are not implemented by these interfaces.

`TableQuery` describes explicit table/class/drive scope, property and formula
filters, sorting, whole-collection aggregation and a page size without importing
Atomic Resource, Store or Collection. The Atomic adapter translates that request
to its indexed collection API. Row and totals requests share the same scope and
predicates; both wait for the row class to load.

`tableQueryIssues(request, capabilities)` reports unsupported operators,
expressions, totals, grouping and sorting without changing the request. Hosts
must handle those issues before executing a query; a capability match is not an
authorization check. Property-specific constraints (such as whether a field is
sortable) remain the backend adapter's responsibility. This request boundary does
not yet replace Atomic Collection's indexed result contract or implement native
NextGraph queries.

`TableNavigationProvider` supplies a reactive `{ location, navigate }` host
adapter for saved-view and edit-column state. `navigate(patch, { replace })`
patches the latest host location; an explicit `undefined` clears a field. The
host retains resource/collection routing and supplies updated snapshots after
navigation, including Back/Forward. The table package imports no router.
Atomic's boundary supplies its existing ShowRoute adapter unless an embedding
host already provided one. This is a host seam for the full-page extraction,
not a claim that the package exports the complete TablePage yet.

## Package CI

The dedicated `Table package` workflow runs on package/config changes in pull
requests and develop, and can be dispatched manually. It lints, typechecks and
tests the package, then builds a tarball and installs it in a clean external
consumer. That consumer mounts the browser component in a DOM and checks
NodeNext declarations. The lane needs no server, Rust or WASM build and uploads
the tested preview archive. A separate Atomic adapter job builds its JavaScript
dependencies, typechecks the Data Browser and runs navigation and saved-view tab tests without a
Rust/server build. Full backend integration stays in the main pipeline.

## Build and release

```sh
cd browser
pnpm --filter @tomic/table build
pnpm --filter @tomic/table test
pnpm --filter @tomic/table typecheck
pnpm --filter @tomic/table pack --out /tmp/tomic-table.tgz
```

The packed artifact contains compiled ESM and declarations, README and MIT
license. It excludes tests and source. Runtime imports are declared dependencies
or peers; neither `@tomic/lib` nor `@tomic/react` is required.

The package initially follows AtomicServer's lockstep version/release process.
It is included in `bump-version.mjs` and the npm release build. A maintainer must
configure the new package's npm Trusted Publisher for this repository's
`release.yml` before its first registry release. This PR does not publish to npm.
External integration can be tested with `pnpm add /path/to/tomic-table.tgz` before
that release; the tarball is a preview, not a registry version claim.

Persisted row creation uses `executeTableRowCreation` with a host
`TableCreationBackend`: prepare a final identity and defaults without saving,
validate, persist once, and confirm the scope and initial values through a read.
The command captures its scope and supplied values before asynchronous work and
checks a supplied schema revision before preparation and again before writing.
The host owns creation field/default/permission policy and confirmation strength.
A failed confirmation may follow a successful write; there is no automatic retry
or rollback. Deferred grid drafts remain separate until ready to persist.


`createTableHistory` owns a session-local undo stack and exposes stable snapshots
through `useTableHistoryState`. Hosts capture immutable command values and provide
undo writes. Consecutive single edits can coalesce; explicit batches stay separate
and undo in reverse dependency order. Confirmed undo steps are removed immediately;
on failure, the failed and unattempted steps remain for an explicit retry. Recording
and clearing are blocked while undo is running. There is no redo or transactional
rollback. Native saved-cell undo uses the saved values as conflict baselines through
`executeTableRowMutation`; Atomic retains its existing restoration/save policies.


`PropertyNameField` shares controlled input, autofocus and validation presentation
between property drafts. `nameTableProperty` preserves an existing property's
shortname when changing its display label; only a new draft derives a provisional
shortname. Category controls and schema activation remain adapter work.


`PropertyRangeField` is an unsaved schema-draft control for numeric or text-length
bounds. It retains raw invalid input, publishes only valid finite values, supports
integer/nonnegative rules and equal inclusive limits, and reports validity to the
host form. `parsePropertyRange` returns stable error codes; hosts can localize the
control's messages. Remount the field when changing draft/schema revision.


`PropertyChoiceField` renders controlled radio/dropdown choices by stable value,
blocks disabled/unknown new selections, and preserves unsupported saved bindings
without substituting a default. Host radio/group styling is optional. `FloatCell`
provides the same raw-text/commit editor used by Atomic and native hosts; formatting
of currency/percentages remains in the host display adapter. Numeric schema bounds
may be fractional even for integer-valued columns; integral bounds are a separate
control policy used for lengths, not inferred from the numeric column datatype.


`createTableViewWriteQueue` serializes captured metadata operations within a table.
A failure retains that operation and subsequent edits until explicit Retry. It
exposes stable busy/pending/error snapshots; enqueue/retry promises settle after
the current drain attempt, so hosts must inspect the snapshot for failures.
Adapters must make retrying the same intent safe and retain prepared creation
identities across partial attachment failures. This queue does not make multiple
backend documents transactional or replace native explicit Save/Discard policy.
Atomic configuration setters and debounced filter/sort saves use it. The full
configuration/session model and backend CRUD transactions remain adapter work.


A queued operation receives a `TableViewWriteContext`. Its named `checkpoint`
retains successful phase results across explicit retries of that same operation;
failed phases can run again. Use unique keys for stable inputs/result types.
Checkpoint a prepared identity and confirmed persistence/attachment stages, never
permission or ownership checks. Atomic view creation/copy/type changes/deletion
and reordering now use this lifecycle too. Navigation retains the initiating
intent, so a delayed retry does not override a later tab choice. Backend
transactions, authorization, conflict resolution and offline acceptance semantics
remain the adapter's responsibility.


`TableViewConfiguration` describes the saved bindings used by TablePage's built-in
views: filters/sort, columns/order/languages, grouping, timer settings, dashboard,
derived columns, statistics, row actions and quick-add. Shared codecs retain legacy
formula generators and distinguish an absent derived-column list from an explicit
empty list. Reading performs no persistence or migration. The reader reports
invalid query-bearing shapes; adapters must gate their query on these issues.
Schema references and implicit renderer defaults resolve separately in the session.
Atomic has one reactive metadata binding for reads, typed patches and raw config
copies; backend property IDs and JSON datatype-tagging remain there. This model
and those codecs do not complete the shared saved-view session or the full page.

`createTableViewDraftSession` keeps per-view edits and their original source
revision across navigation. Pristine views read live metadata directly; adapters
can detect incoming conflicts without overwriting dirty work. Save tokens capture
submitted values, retain explicit retry identity and clear only the submitted
version. Editable in-flight sessions supply a rebase policy for subsequent edits.
Prepared implicit views can alias and then move the same draft to their confirmed
identity. Persistence, revision enforcement and navigation remain adapter work.

Atomic filter/sort autosave uses this session with ordered retained writes. Leaving
a view flushes its draft; newer edits drain after an in-flight save even if the
page unmounts. Failed writes require explicit Retry. Per-table queue registries
retain pending/failed work when navigating away and returning. Other built-in
configuration controls and the complete page orchestration still need extraction.

`compileTableViewQuery` compiles stored/resolved filter, sort and statistics
settings into one backend request. Valued filters and totals on missing/incomplete
computed columns return issues and remove the query's row-class readiness; they
are never silently skipped. Empty filter chips remain inactive. Callers must also
gate the stored-configuration reader's shape issues and backend capability/type
checks. Formula evaluation and whole-result aggregation stay with the backend.

Renderer defaults are explicit inputs. `effectiveTableDerivedColumns` preserves
an explicit empty list, and `timerDurationColumn` supplies the same implicit
start/end expression to the timer grid, its filters and its totals. Clock values
are quantized once and timezone offsets travel with the request. Atomic
TablePage uses this compiler and reuses its aggregation for the totals query.
Atomic dashboard stat/chart blocks also use this compiler for borrowed view
filters and their own measures. Their host adapters retain ownership/loading
checks and explicit unavailable states. The full page/renderer port remains open.

`TableFilterValueInput` is the actual typed filter-value control used by Atomic's
filter popovers. It keeps string query values, false/zero, unknown stored choices
and incomplete numeric text. Text numeric inputs use a decimal keyboard hint,
so the browser cannot turn an incomplete value such as `1e` into an empty filter.
JSON canonicalization runs only on complete JSON; numeric canonicalization is an
explicit backend policy and defaults off. Native adapters retain their typed
parser and exactness checks. Hosts supply labels/style primitives, tag labels and
a resource-picker leaf; the shared control owns the actual value UI and change/
blur behavior. The value adapter is also used by the shared chip and active-filter bar.

`TableFilterChip` now owns the real chip, popup state, operator selector,
computed numeric/date modes and removal action. Its default popup uses Radix;
Atomic supplies its existing popup/style primitives for dialog/control-lock
integration. Unsupported stored operators stay visible until explicitly changed,
and numeric `now` text stays editable when it is invalid for that unit. Popup
content is labelled by its column header.

Unavailable targets retain a removable chip instead of disappearing. Atomic's
filter bar uses this recovery path, so removing a missing computed constraint
restores the scoped query without editing raw metadata. Backend-specific value
and reference adapters retain their responsibilities; the full page
orchestration and renderer port remain open.

`TableFilterBar` owns the active chip row and Add-filter candidates. Stable
backend target descriptors provide typed value/reference leaves and labels;
hidden targets keep existing chips without appearing in Add. Missing targets
remain removable. The default searchable Add control needs no host menu, while
Atomic retains its existing dropdown primitive and drive-search action. This
shares filter UI, not the remaining full-page/renderer orchestration.

`TablePropertyHeading` is the actual stored-column heading used by Atomic's
grid: required marker, sort indicator/name command, hover drag affordance and
full-height context-menu target. Backends provide the property label/type icon,
sort capability, language selector and command-menu leaves. Configured computed/
action/virtual headings and full property menus remain host UI for now.

`TableFilterMenu` adds the first filter as well as subsequent filters through
the same stable-target candidate policy as the active bar. It disables empty/
exhausted menus, excludes active and hidden targets, and guards busy selection.
The default searchable selector needs no backend menu; Atomic adapts its existing
column dropdown and drive-search action. This is actual toolbar selection UI,
not an additional row-query path.
