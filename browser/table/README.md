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
