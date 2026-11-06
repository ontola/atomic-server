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

## Package CI

The dedicated `Table package` workflow runs on package/config changes in pull
requests and develop, and can be dispatched manually. It lints, typechecks and
tests the package, then builds a tarball and installs it in a clean external
consumer. That consumer mounts the browser component in a DOM and checks
NodeNext declarations. The lane needs no server, Rust or WASM build and uploads
the tested preview archive. Full AtomicServer integration stays in the main
pipeline.

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
