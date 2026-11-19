# @tomic/table

AtomicServer's virtual table grid and storage-independent text, integer, boolean
and date editors. This is the first package boundary for the full table
experience. TablePage, saved-view persistence/menus, schema dialogs and alternate
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

Atomic-specific number/date formatting stays in Data Browser display adapters. React, React DOM, Styled Components and `@tomic/ui`
are peers; React 19.2 supplies `useEffectEvent`.

## Package CI

The dedicated `Table package` workflow runs on package/config changes in pull
requests and develop, and can be dispatched manually. It lints, typechecks and
tests the package, then builds a tarball and installs it in a clean external
consumer. That consumer mounts the browser component in a DOM and checks
NodeNext declarations. The lane needs no server, Rust or WASM build and uploads
the tested preview archive. Full AtomicServer integration stays in the main
pipeline.

## Build and pinned-submodule consumption

```sh
cd browser
pnpm --filter @tomic/table... build
pnpm --filter @tomic/table test
pnpm --filter @tomic/table typecheck
pnpm --filter @tomic/ui pack --out /tmp/tomic-ui.tgz
pnpm --filter @tomic/table pack --out /tmp/tomic-table.tgz
```

The packed artifact contains compiled ESM and declarations, README and MIT
license. It excludes tests and source. Runtime imports are declared dependencies
or peers; neither `@tomic/lib` nor `@tomic/react` is required.

The table and UI packages are private and consumed from the pinned submodule;
no npm publication or Trusted Publisher setup is required. Build the dependency
graph with `@tomic/table...`, then install both built directories or both preview
archives. The peer UI dependency gives the host and grid one implementation and
one set of overlay contexts. Versions still follow `bump-version.mjs`.

`@tomic/utils` is a dependency-free build input shared with the SDK. The SDK
bundles it and the UI build includes its standalone compiled modules/declarations;
external consumers do not install a third runtime package. The canonical SDK
civil-date validator is retained, including rejection of year zero.

This remains preparation for the complete TablePage extraction. No saved-view
sessions, write receipts, retry queues or new dialog lifecycle are included.
