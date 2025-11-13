# Performance Plan — DID/WS Branch

The new DID/WS branch (`did-rebased2`) feels noticeably slower than
master, even though the binary WS protocol should be faster than the
old JSON commit/text-message scheme. This document captures the
investigation, the bottlenecks, and the rollout order for fixes.

The runtime profiler that produces the numbers below is wired up in
`browser/data-browser/src/helpers/profiler.tsx`. Reload, hit
**Cmd/Ctrl+Shift+P**, look at the two console tables.

---

## Hot paths (mapped against actual code)

A WS UPDATE → React re-render goes through this chain. Every link is on
the critical path.

| # | Function | File:line | Called per WS UPDATE |
|---|----------|-----------|----------------------|
| 1 | `WSClient.handleBinary` UPDATE branch | `lib/src/websockets.ts:467` | 1 |
| 2 | `Resource.importLoroUpdate` | `lib/src/resource.ts:1922` | 1 |
| 3 | `Resource.rebuildCacheFromLoro` | `lib/src/resource.ts:487` | 1 (full rebuild) |
| 4 | `Store.addResource` | `lib/src/store.ts:830` | 1 |
| 5 | `Store.notify` | `lib/src/store.ts:3011` | 1 |
| 6 | `StoreEvents.ResourceUpdated` listeners | per `useCollection` mounted | N collections |
| 7 | `Collection.applyResourceChange` | `lib/src/collection.ts:195` | N collections |
| 8 | per-subject subscriber callbacks | per `useResource` for that subject | M components |
| 9 | `proxyResource` (new Proxy) | `lib/src/resource.ts:2073` | M components |
| 10 | React render of every `useResource` consumer | depends on tree | M components |

For an initial drive-open this fans out to ~50 incoming UPDATEs ×
~5 collections × ~10 active `useResource` calls = a *lot* of redundant
work, almost all of which was a no-op for the user.

---

## Bottlenecks ranked by impact

### B1 — `proxyResource()` breaks referential equality every notify  *(largest)*

```ts
// browser/lib/src/resource.ts:2073
return new Proxy(resource.__internalObject, {});
```

Empty handler. Its only function is to defeat `useState`'s `Object.is`
check so React re-renders. Three call sites in `useResource`
(`react/src/hooks.ts:67/77/100`) — every WS notify and every
`LoadingChange` builds a new object, which downstream `useValue`,
`useTitle`, memoised children all see as "changed".

**Cost shape**: `O(subscribed_resources × incoming_updates)` allocations
per second on commit bursts. Pages with many cells (tables, sidebars)
are worst.

**Fix**: migrate `useResource` / `useCollection` to React 18's
`useSyncExternalStore`. Per-subject `subscribe`/`getSnapshot`; React
uses identity equality on the *snapshot value* but only re-renders the
hook caller — no proxy wrapping, no fan-out re-renders.

**Effort**: medium (half a day). Needs `getServerSnapshot` for SSR
parity but Atomic doesn't SSR so we can stub it.

---

### B2 — global `ResourceUpdated` fan-out + linear page scan

`useCollection.ts:183` registers one global `ResourceUpdated` listener
per mounted collection. Inside (`collection.ts:195`):

```ts
const propVal = resource?.get(fp);
const matches = ...;
for (const [pageIdx, page] of this.pages) {
  const members = page.getSubjects(...);
  const idx = members.indexOf(subject);   // O(members)
}
```

Sidebar + main + breadcrumbs ≈ 5–10 collections; *each* visits *every*
incoming UPDATE.

**Cost shape**: `O(collections × pages × members_per_page)` array scans
per UPDATE.

**Fixes**:
1. *Quick*: index members in a `Set<string>` per page (or a
   `Map<subject, {pageIdx, arrayIdx}>` per collection) → page scan
   becomes O(1).
2. *Quick*: skip the loop entirely when `matches === false` *and* the
   resource isn't already a known member.
3. *Slower*: index collections by `(property, value)` in the store, so
   `Store.notify` only wakes collections whose filter could possibly
   match.

**Effort**: small (#1 + #2 together is ~30 minutes).

---

### B3 — `rebuildCacheFromLoro` is full-rebuild

`resource.ts:487-499` exports the entire Loro map to JSON and rebuilds
`_cache` from scratch on *every* import. A 20-property resource that
changed 1 property pays the cost of all 20.

Loro has container events (`subscribe`) that report changed keys.

**Cost shape**: `O(properties)` per WS UPDATE; with N resources synced
on drive open, N × P operations.

**Fix**: subscribe to the `LoroMap` per resource on creation, mutate
`_cache` only for changed keys. Drop the full-rebuild calls in
`merge` / `importLoroUpdate` / lazy `getLoroDoc` (the lazy path can stay
full since it's once-per-resource-lifetime).

**Effort**: medium (Loro API + careful invariant work — the cache
must always reflect Loro's view, including deletions).

---

### B4 — `useResource` registers 3 listeners per call

```ts
useEffect(() => store.subscribe(...));            // notify path
useEffect(() => resource.stable.on(LocalChange));  // if track set
useEffect(() => resource.stable.on(LoadingChange));// always
```

For 100 mounted `useResource` calls that's 200–300 active listeners.
Notify fan-out is linear in listener count. Each listener path leads
back to `proxyResource` (B1).

**Fix**: collapses naturally once B1 lands —
`useSyncExternalStore` replaces all three with one external
subscription. As a stop-gap, the `LoadingChange` listener could be
omitted when `resource.loading === false` at mount time (it never
flips back to true).

**Effort**: trivial as a stop-gap; folds into B1's fix otherwise.

---

### B5 — `Resource.merge` deep-clones cache and auxValues

Two `structuredClone` calls per merge for resources that don't yet have
a Loro doc (`resource.ts:823-836`). The source resource is thrown away
after `addResource`, so the clones were defensive against a bug that
can't happen.

**Fix**: take ownership of `_cache`, shallow-copy the `_auxValues` Map.

**Effort**: trivial. *Done — see commit `e89c9da3`.*

---

### B6 — `useChildren` awaits members sequentially

```ts
for (let i = 0; i < collection.totalMembers; i++) {
  const member = await collection.getMemberWithIndex(i);
}
```

200-child folder = 200 × worker RTT before the tree renders.

**Fix**: `Promise.all(Array.from({ length: total }, (_, i) =>
collection.getMemberWithIndex(i)))`.

**Effort**: trivial. *Done — see commit `e89c9da3`.*

---

### B7 — SUB pushes always force notify

`websockets.ts` always calls `addResources(resource, { skipCommitCompare: true })`
on subscription pushes. The store's `lastCommit` gate would otherwise
short-circuit notify when the value hasn't changed — but it can't,
because the WS handler mutates the resource *in place*, so by the time
the gate runs `storeResource === resource` and the comparison is
trivially true.

The server echoes back commits we just sent (same `commitId`); each
echo currently triggers a full notify storm.

**Fix**: capture `lastCommit` *before* `importLoroUpdate`, compare
against the commit announced in the push; if equal, skip
`addResources` (persistence + blob checks still run, they're
idempotent).

**Effort**: trivial. *Done — see commit `e89c9da3`.*

---

### B8 — `Resource.title` reads four properties per render

`resource.ts:199-205`. Falls through `name → shortname → filename →
description → subject`. Each `.get()` checks `_cacheDirty` and may
trigger a full Loro rebuild (B3 amplifies this).

**Fix**: memoise the title at the resource level, invalidate on
relevant property change. Or, more cheaply, after B1 lands the cost
collapses because re-renders are massively reduced.

**Effort**: small.

---

## Profiler usage

The runtime profiler is always-on in dev. After reproducing a slow
flow, hit **Cmd/Ctrl+Shift+P** to dump:

- **Render table** — sorted by total ms; columns `id`, `phase`,
  `count`, `totalMs`, `avgMs`, `maxMs`, `slowRenders` (>16ms).
- **Events table** — `store.ResourceUpdated`, `store.ResourceSaved`,
  `ws.in.UPDATE`, `ws.out.GET`, …, with sample payloads.

Useful patterns:

- **`store.ResourceUpdated` ≫ `ws.in.UPDATE`** → local commits, OPFS
  rehydrations, or echo pushes are firing notifies. Look at sample
  payloads to identify the subject.
- **High `ws.out.GET` count** → too many fetches. Likely a `useResource`
  loop or missing cache. Drill into who's mounting.
- **High `count` + low `avgMs`** on one Profiler id → re-rendering too
  often (B1 / B4 territory).
- **Low `count` + high `maxMs`** → expensive single render. Wrap that
  subtree with `<PerformanceProfiler id="X">` to drill in, then use
  React DevTools Profiler for per-fiber attribution.

`window.__atomicProfiler.reset()` between scenarios for clean numbers.

---

## Roll-out order

| Step | Win | Status |
|------|-----|--------|
| B5 | drop `structuredClone` in `merge` no-Loro path | ✅ `e89c9da3` |
| B6 | `Promise.all` `getMemberWithIndex` | ✅ `e89c9da3` |
| B7 | echo-detection on SUB pushes | ✅ `e89c9da3` |
| B2 | Set-indexed members + early-bail in `applyResourceChange` | ⏳ next |
| B8 | memoise `Resource.title` (or fold into B1) | ⏳ next |
| B1 | replace `proxyResource` with `useSyncExternalStore` | ⏳ biggest |
| B3 | incremental `rebuildCacheFromLoro` via Loro container events | ⏳ |
| B4 | folds into B1 | ⏳ |

Measure before/after each step with the profiler. The first three
should already produce a visible improvement on commit-burst flows
(typing into a chatroom, fast row entry, etc.) and on cold drive-open
with deep folder trees.

---

## Out of scope / not bottlenecks

- **Loro WASM init cost** — happens once per session, irrelevant after.
- **OPFS round-trips** — fire-and-forget from the hot path; the
  serialised worker queue means ordering is guaranteed without
  awaiting.
- **WS frame decoding** — binary protocol is much faster than the old
  JSON; profiler shows it's a small fraction of per-update time.
- **Tantivy / search index** — not on the data-browser hot path at all
  (server-side concern; only visible on `/search`).

If the profiler ever shows otherwise, this section should be moved up.
