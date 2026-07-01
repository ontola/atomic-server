# NextGraph interop — `did:ng:` resources via a pluggable Store backend

> Scope note: this is about making Atomic and **NextGraph** (`did:ng:`,
> RDF + CRDT graph store, [nextgraph.org]) interoperate at the browser data
> layer. It builds on the `Store`/`Resource` contract described in
> [`unified-data-layer.md`](./unified-data-layer.md) and the lib-as-runtime
> boundary in [`atomic-lib-runtime.md`](./atomic-lib-runtime.md). The schema/DX
> angle connects to [`json-schema-code-first.md`](./json-schema-code-first.md);
> the Loro-coupling caveat connects to [`loro-source-of-truth.md`](./loro-source-of-truth.md).
> A working proof of the headless-UI-on-NextGraph pattern already exists in the
> sibling repo `../elfa-tables` (Atomic's headless table editor + a hand-written
> NextGraph data layer).

## Goals (from product intent)

1. **Atomic components usable in a NextGraph app**, without Atomic's sidebar/chrome.
2. **Read + edit `did:ng:` resources inside atomic-browser.**
3. **Developers can use `did:ng:` resources in their Atomic projects** — e.g.
   `useResource("did:ng:…")` works alongside `useResource("https://…")`.

## Key insight: all three are one abstraction

Atomic components are **subject-addressed and store-mediated** — `<ResourcePage
subject>`, the table editor, value editors all just call `useResource` /
`useValue` against whatever `Store` is in React context. Therefore:

> If the `Store` resolves `did:ng:` subjects against NextGraph, then *every*
> Atomic component, unchanged, reads and edits NextGraph data.

The three goals are the same sentence from three sides:

| Goal | Mechanism |
| --- | --- |
| Components in a NextGraph app (no chrome) | render them with a **NextGraph-only store** + `did:ng:` subjects |
| Edit `did:ng:` in atomic-browser | the browser's store is **scheme-aware** (`did:ad:`/`https:`→Atomic, `did:ng:`→NextGraph) |
| `did:ng:` in Atomic projects | the store routes per-subject by scheme |

So the artifact is: **a NextGraph backend for the Atomic `Store`, keyed on the
`did:ng:` scheme**, plus a component-packaging story for the chrome-free case.

This generalizes `../elfa-tables`: there we hand-wrote a NextGraph data layer for
*one* component. A store backend does it **once for all** components — you'd
render Atomic's real `<TablePage subject="did:ng:…">` with no per-component glue.

## Data mapping — and why Loro is mostly a non-issue here

Atomic resources are RDF (subject → predicate → value + `isA`); NextGraph's
**graph** side is also RDF. So:

- `did:ng:` graph subject → Atomic `Resource`: triples become propvals,
  `rdf:type` → `getClasses()`, edits go through the graph ORM (`useShape`
  deep-signal write / `sparql_update`). **Clean; no Loro involved.**
- The Loro-oplog coupling only bites Atomic-*specific* features —
  **version history, undo/redo, `createdAt`/`createdBy`-from-oplog**. For
  `did:ng:` those **degrade gracefully** (`getLoroDoc()→undefined`) or later map
  onto NextGraph's own commit history. (See [`loro-source-of-truth.md`](./loro-source-of-truth.md)
  — the `PropVals`-as-projection direction is what makes a non-Loro backend feasible.)

Reactivity bridge is a one-liner: NextGraph returns a `DeepSignal`; wrap it with
`watchDeepSignal(sig, cb)` and fire Atomic's `store.subscribe` / `resource.on`
callbacks that feed `useSyncExternalStore`.

## The Store/Resource contract a backend must satisfy

The React hooks touch ~25 methods. Condensed (full audit in the appendix):

- **Store:** `getResourceLoading`, `getResource`, `getResourceSnapshot`,
  `getProperty`, `createSubject`/`normalizeSubject`, `newResource`,
  `removeResource`, `notifyResourceManuallyCreated`, `subscribe`, `on`,
  `getAgent`/`setAgent`, `getServerUrl`, `search`, `buildCollection`.
- **Resource:** `subject`, `loading`, `error`, `new`, `isReady`, `title`,
  `props`, `get`, `getArray`, `getClasses`, `hasClasses`, `set`, `remove`,
  `push`, `save`, `destroy`, `canWrite`, `on`, `getChildrenCollection`,
  `getCreatedAt/By` (Loro), `getLoroDoc`/`importLoroUpdate` (Loro).
- **Collection:** `totalMembers`, `getMemberWithIndex`, `getMembersOnPage`,
  `applyResourceChange`, `refresh`, sort/filter params.
- **Subscription:** callback-based, feeding `useSyncExternalStore`
  (`store.subscribe(subject)` + `resource.on(LocalChange)` + `store.on(...)`).

What a NextGraph backend **deletes** (the verifier/broker owns it): commit
signing (`commit.ts`), the outbox + sign-at-drain, `websockets.ts`/`ws-v2.ts`
transport, `clientDb`/OPFS persistence, drives/`check_rights` routing. So a
NextGraph backend is **substantially smaller** than today's `Store`.

## Two architecture paths

**Path A — standalone `NextGraphStore`** implementing the contract; NextGraph-only.
- Serves goals #1 and #3 in NextGraph-first apps immediately. Fast.
- Weakness: a single app can't seamlessly mix `did:ad:` and `did:ng:` → goal #2
  is awkward.

**Path B — backend-pluggable `Store`** (refactor `@tomic/lib` so `Store`
delegates fetch/commit/subscribe to a per-scheme `Backend`; atomic-server becomes
`AtomicBackend`, NextGraph becomes `NextGraphBackend`).
- All three goals + **mixed graphs** from one abstraction.
- Cost: real surgery. Today's `Store`/`Resource` fuse transport + outbox +
  signing + Loro + cache; carving a clean `Backend` seam and making `Resource`
  not *assume* Loro is the hard part. This is the natural extension of
  [`atomic-lib-runtime.md`](./atomic-lib-runtime.md) and
  [`unified-data-layer.md`](./unified-data-layer.md) (one ingress → per-backend ingress).

**Recommendation:** prototype **Path A to de-risk** (reactivity + RDF↔propval +
typed editing on one `did:ng:` view), then **extract the `Backend` interface
(Path B)** once the seam is proven. Don't refactor the lib blind.

## Orthogonal axis: component packaging (the "no chrome" goal)

Goal #1 has a blocker independent of the store: the reusable components live
**inside the `data-browser` app**, not a published package, and many assume
react-router, navigation, DnD providers, sidebar context. The hooks
(`@tomic/react`) are clean; the components aren't all portable. Order by how
headless each already is:

- **Portable now:** the table editor (proven in elfa-tables), pure value renderers.
- **Near-portable:** value editors, `ResourceInline`/`ResourceCard`, forms —
  need router/navigation stubbed via a small `NavigationContext`.
- **App-bound (leave behind):** sidebar, drive switcher, app shell.

Target a `@tomic/components` (chrome-free) package whose only required context is
`<StoreContext>` + a thin nav adapter. (Aligns with [`SDK-API-design.md`](./SDK-API-design.md).)

## Sharp edges (the real design decisions)

1. **Property/datatype metadata.** Typed editors need `getProperty(predicate)` →
   datatype + shortname. For `did:ng:` predicates, source it from a **shape**:
   reuse the `defineShape` builder (proven in elfa-tables) to feed *both* table
   columns and the store's `getProperty`. Ties into
   [`json-schema-code-first.md`](./json-schema-code-first.md). This is the DX
   contract: a dev declares a shape → typed editing everywhere.
2. **Session/auth bootstrap.** A `did:ng:` resource needs a NextGraph wallet
   session (the iframe redirect flow). In a NextGraph-first app it exists; in
   atomic-browser it's a new auth surface to mount, plus reconciling Atomic's
   `agent` with the NextGraph user for `canWrite`.
3. **History/undo degradation.** Decide per-feature: disable for `did:ng:`, or
   later map Atomic's history/undo panels onto NextGraph's commit log.
4. **Identity & collections.** `did:ng:` as subject is fine, but
   `parent`/children/`buildCollection`/`search` must translate to **SPARQL**.
   Bounded, medium work.

## UX / DX walkthroughs

**Goal #3 (mixed project, cleanest):**
```tsx
store.registerBackend('did:ng', nextGraphBackend(session));
<StoreProvider store={store}>
  <ResourceInline subject="https://my.app/thing" />  {/* Atomic */}
  <ResourceInline subject="did:ng:o:…" />            {/* NextGraph */}
</StoreProvider>
```
`npm i @tomic/react @tomic/nextgraph`. Every hook works by scheme.

**Goal #1 (Atomic components in NextGraph app, no chrome):** a NextGraph app
(like elfa-tables) wraps in a NextGraph-only store and drops in `@tomic/components`
with `did:ng:` subjects. No atomic-server, no sidebar. elfa-tables done right —
real components instead of hand-rolled.

**Goal #2 (`did:ng:` in atomic-browser):** navigate to a `did:ng:` subject →
scheme-aware store routes to NextGraph → first touch triggers wallet auth →
resource renders in the normal `ResourcePage` → edits commit to NextGraph.
Wrinkle: drives/sidebar are Atomic concepts; for `did:ng:` use NextGraph-flavored
nav or address-bar navigation (matches the "without sidebar" intent).

## Phased roadmap

1. **Slice 0 — prove the seam (Path A, in `../elfa-tables`).** A read+write
   `NextGraphStore` satisfying `getResourceLoading` + `subscribe` +
   `getResourceSnapshot` + `Resource.get/set/save`, with the
   `watchDeepSignal→callback` bridge, RDF-triples↔propvals for one `did:ng:`
   graph subject, and `getProperty` fed by a `defineShape`. Render **one real
   `@tomic/react`-driven component** (a value editor / `ResourceInline`) against
   a `did:ng:` resource. Proves reactivity + mapping + typed editing end-to-end
   and reveals the true cost of Path B.
2. **Slice 1 — collections + search → SPARQL**; `getChildrenCollection`,
   `buildCollection`.
3. **Slice 2 — component packaging:** extract the near-portable components into
   `@tomic/components` with a `NavigationContext` stub.
4. **Slice 3 — extract `Backend` interface in `@tomic/lib` (Path B):** make
   `Resource` Loro-optional; atomic-server → `AtomicBackend`; scheme router;
   mixed graphs.
5. **Slice 4 — atomic-browser integration (goal #2):** scheme-aware store,
   NextGraph auth surface, minimal `did:ng:` nav.
6. **Slice 5 — advanced features:** decide history/undo mapping vs degradation.

## Open questions

- Path B `Backend` seam vs the directions already in
  [`unified-data-layer.md`](./unified-data-layer.md)/[`atomic-lib-runtime.md`](./atomic-lib-runtime.md)
  — the per-backend ingress should be designed *with* the unified-data-layer
  refactor, not bolted on after.
- `@ng-org/*` version coupling to the deployed wallet (a real bug we hit in
  elfa-tables: orm method names `orm_start_graph`/`graph_orm_update` must match
  the wallet's WASM). A NextGraph backend must pin/verify compatible versions.
- Whether to require a NextGraph shape per class (typed) or support untyped
  `did:ng:` resources with a generic editor fallback.

## Appendix: where the contract was audited

`browser/react/src/` (hooks), `browser/lib/src/store.ts`, `resource.ts`,
`collection.ts`, `commit.ts`, `agent.ts`, `websockets.ts`/`ws-v2.ts`. The
NextGraph side: `../nextgraph-rs/sdk/js/orm` (`useShape`/`useDiscrete`,
`GraphOrmSubscription`), `sdk/js/web` (session/auth), and the `../elfa-tables`
proof (`src/table/defineShape.ts`, `columns.ts`, `NgTablePage.tsx`).
