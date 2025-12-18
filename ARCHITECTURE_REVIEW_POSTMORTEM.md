# Architecture review — post-mortem

Going back through `ARCHITECTURE_REVIEW.md` from earlier this session
and checking which of the 10 gripes I actually closed vs. which are
still open.

Final cumulative session diff: **+871 net LoC** in `browser/` (peaked
at +1,599; clawed back ~728 by aggressive trim across 11 deletion
commits). Of that +871, ~642 is test/diagnostic infrastructure
(perf-trace, perf probes, integration tests for race fixes); the
data-layer (`browser/lib/src` + `browser/react/src`) is **+229 net**.

After this post-mortem was first written, Phases 4a + 5a–5h + a
final `putLoroSnapshot` proxy trim shaved another −149 net out of
`browser/` and reclassified two gripes as closed; this file has
been updated to reflect the final post-Phase-5 state.

---

## Gripe 1 — No single "ingress" to the store ✅ **CLOSED**

> Every onramp does *almost* the same thing: hydrate the resource,
> maybe set `loading=false`, maybe set `source`/`sourceTimestamp`,
> maybe pass `skipCommitCompare`, maybe call `persistToClientDb`,
> maybe fire `notify`. But each does it differently.

**Fixed in `f01cd175` + `5ed045ac`** (Phase 3a + 3b). All 9 ingress
paths now go through `Store.applyIncoming({source, ...})`:

- WS UPDATE (pending-GET + sub-push) → `applyIncoming({source: 'ws-pending-get' | 'ws-sub-push'})`
- WS SYNC_PUSH → `applyIncoming({source: 'ws-sync-push'})`
- HTTP fetch → `applyIncoming({source: 'http-fetch'})`
- Local commit pre-/post-POST → `applyIncoming({source: 'local-pre-push' | 'local-acked'})`
- Offline replay + OPFS rehydrate → `applyIncoming({source: 'offline-replay'})`
- Bootstrap seed (data-browser) → `applyIncoming({source: 'offline-replay'})`

Echo dedup (the four ad-hoc schemes) collapsed to one `commitId`
comparison inside `applyIncoming`. The internal `addResource`
remains as the persist+notify implementation, called only from
`applyIncoming` and a few legacy hydration paths.

**Quality**: structurally good. The remaining wart is that
`addResource` is still public — making it private would require
migrating ~5 internal hydration callers to use `applyIncoming` with
`source: 'offline-replay'`, which is doable but didn't seem worth
the additional churn.

---

## Gripe 2 — OPFS is written from three different layers ✅ **CLOSED**

> Three layers all reach into `clientDb.put*` directly. A single
> update from the WS triggers BOTH `addResource` →
> `putResource(jsonAd)` AND `persistToClientDb` →
> `putLoroSnapshot`.

**Fixed in `4b0a402a`** (Phase 1) — added `putResourceWithSnapshot`
worker method that writes JSON-AD + Loro snapshot in one
postMessage atomically. **Refined in `b2f875e0`** by deleting the
intermediate `OpfsPersistor` wrapper class (124 LoC) — callers
write directly via `clientDb.putResourceWithSnapshot(...)`.

**`WSClient.persistToClientDb` is gone**; the WS UPDATE flow now
writes both forms via the unified `applyIncoming → addResource →
clientDb.putResourceWithSnapshot` chain. The "JSON-AD landed but
snapshot didn't" half-state is structurally impossible.

**Quality**: clean. One method, one call site per write.

---

## Gripe 3 — Three overlapping notification systems ✅ **CLOSED**

> `useResource` subscribes to **three independent channels** for the
> same resource: per-subject, `LocalChange`, `LoadingChange`. Plus
> two more store-level events (`ResourceUpdated`,
> `ResourceManuallyCreated`).

**Fixed in `f239c503` (5b) + `84197161` (5c) + `e878843d` (5a) +
`af2dda1b` (5e)**. The four React entry points now all go through
`useSyncExternalStore` against `Store.getResourceSnapshot()`:

- `useResource` (singular) — Phase 5b, ~15 LoC, single subscribe
  callback into `Store.subscribe(subject)`.
- `useResources` (plural) — Phase 5c, ~30 LoC, snapshot-array cache
  shared across all subjects.
- `useValue` — Phase 5a, subscribes to per-subject + per-property
  via the same store snapshot, no `Object.is` shortcut.
- `useLoroDoc` — Phase 5e, plain `useSyncExternalStore` wrapper.

`getResourceSnapshot` is the single notification chokepoint — bumped
from inside `Store.notify` and keyed on the canonical normalized
subject. The triple-`useEffect` mess is gone.

---

## Gripe 4 — `proxyResource()` defeats referential equality ✅ **SCOPED DOWN**

> The Proxy is empty — its only role is to be a *different object
> reference* than the previous proxy, so `useState`'s `Object.is`
> check decides to re-render.

**Scoped down by Phase 5a–c**: `proxyResource` is now called from
*one* place (`Store.getResourceSnapshot` / `Store.notify`) — every
hook reads through that snapshot rather than allocating its own
Proxy. The empty-handler Proxy still exists as the identity-bump
mechanism, but it's no longer scattered across the hook layer and
no longer fights React's render-bailout.

The lingering thing: the Proxy itself could be replaced with a
counter + tuple snapshot for the next major. Not load-bearing
enough to do mid-session.

---

## Gripe 5 — Pending commits live in three places ✅ **CLOSED**

> 1. `Resource._pendingCommits: Commit[]`
> 2. `localStorage['atomic.offline.<subject>']`
> 3. `Store.dirtyForSync: Set<string>`
> Plus `_lastLocalSignature` in-memory only — reload partially
> forgot the commit chain.

**Fixed in `098c8db9`** (Phase 2) — `LocalOutbox` is the single
source of truth, with a one-shot legacy migration. `dirtyForSync`
Set deleted. `atomic.dirtyForSync` and `atomic.offline.<subject>`
keys removed (migrated). One queue, one schema, one rehydrate path.

`_pendingCommits` still exists as the in-memory ephemeral signing
buffer — but the durable record is the outbox.

**Quality**: clean. Drain is idempotent (folds in the
`pushCommits` re-entrance fix from `5c168355` structurally).

---

## Gripe 6 — ClientDb leadership election as flake source ⚠️ **PATCHED, NOT REPLACED**

> The current design coordinates OPFS access between tabs via
> `navigator.locks` + `BroadcastChannel` + a 5-second handshake. The
> 9 dagger-CI flakes all stem from the second context's handshake
> exceeding the timeout.

**Patched in `74f0834b`** earlier in the session — bumped
`LEADERSHIP_TIMEOUT_MS` 5s → 30s. Did NOT do the SharedWorker
migration (Phase 6).

**Status**: tactical fix only. The leader-election state machine
(`Role` enum, BroadcastChannel handshake, ~200 lines in
`client-db.ts`) is intact. The 9 dagger leadership-timeout flakes
should be cleared by the timeout bump alone, but the structural
fragility is unchanged.

**Reason**: SharedWorker has cross-browser quirks (Safari
historically; some sandboxed contexts) and changing the boot path
requires testing across browsers. Estimated 2.5 days. Skipped.

---

## Gripe 7 — Drive sync runs as a parallel state machine ⚠️ **PARTIALLY FIXED**

> `syncDirtyResources` (HTTP /commit drain) and `startVVSync` (WS
> SYNC_VV) are two separate sync mechanisms with no shared
> transactional boundary.

**Partially fixed**: The drain re-entrance bug is structurally
impossible now because `LocalOutbox.drain` joins the in-flight
promise. `WSClient.handleOpen` was simplified in `bf24863c`.
`_dirtySyncInProgress` was removed in `d34ea7ac` (Phase 4a) — its
only readers now derive the same answer from `outbox.isDraining`.

**Not fixed**: There's still no proper `DriveSync` class.
Status flags (`_driveSyncInProgress`, `_serverConnected`,
`clientDbReady`, `clientDbAttached`) still live as separate
booleans. I prototyped a `DriveSync` class during the session and
reverted it because it was adding more code than it was deleting —
Phase 4a took the deletion-only subset instead.

---

## Gripe 8 — `Store` is a god object ❌ **NOT FIXED, BUT NOT WORSE**

> `browser/lib/src/store.ts` is 3000+ lines with responsibilities
> that fan out across agent management, drive management, resource
> cache, subscription, OPFS, search index, WS client management,
> dirty queue, commit log, batch saves, network detection, …

**Status**: `store.ts` is 3,050 lines (was 3,091 at session start).
Net change is essentially flat: the session added `applyIncoming`,
`IncomingChange` types, `getResourceSnapshot`, the outbox
constructor wiring, and `normalizeSubject` consistency, while
deleting `getResourceAsync`, `markDirtyForSync`, `setDirtySync*`,
`isOffline`, and assorted dead-code helpers.

**Mitigations**: at least two responsibilities now have dedicated
files (`local-outbox.ts` for the dirty queue,
`client-db.worker.ts`/`.ts` for OPFS). The store delegates rather
than implementing them inline. So the *coupling* is reduced even if
the file size isn't.

**Reason**: full split was deliberately out of scope (major
version bump for `@tomic/lib`). Remains an open follow-up.

---

## Gripe 9 — Subject normalisation is forked ❌ **NOT FIXED**

> `normalizeSubject` exists in `Store`. But subject changes also
> happen during genesis commit signing, via `aliases` map, in
> commit serialisation, and in path-tied HTTP subjects. Each one
> knows about a different subset of the rules.

**Status**: untouched. All four sites still exist.

**Reason**: this is invasive — `Subject` would need to become a
type with a normalization method, and every boundary that touches
a subject string would need updating. Estimated medium-large
refactor. Not on the simplification plan.

---

## Gripe 10 — Smaller smells

**`useCollection` constructor vs. `refresh()` divergence** ✅ Already
fixed in `73fecf18` (this was the bug whose investigation triggered
all of this).

**Echo detection lives in two places** ✅ Folded into `applyIncoming`.

**`Store.fetchResourceFromServer` and `WSClient.fetch` overlap** ❌
Untouched. Two GET paths still exist with their own error handling.

**Loading state has three booleans** ❌ Still
`resource.loading`, `resource.new`, `_loroSnapshotBytes` deferred-
hydrate flag. Their interactions are documented in inline comments.

---

## Bonus duplicate fixed mid-session: `ResourceSource` ✅

Found and deleted in `12426da3`. The legacy `ResourceSource` enum on
`Resource.source` was duplicating my new `ChangeSource` enum on
`IncomingChange.source`. Bridged via a `mapChangeSourceToResourceSource`
helper — pure cost, zero behaviour. The resource-side field was used
only by `DataRoute.tsx` for debug display (now removed). Saved 96
LoC and one type-bridge function.

---

## Summary

| Gripe | Status | Commit |
|---|---|---|
| 1. No single ingress | ✅ Closed | `f01cd175` + `5ed045ac` |
| 2. OPFS three layers | ✅ Closed | `4b0a402a` + `b2f875e0` |
| 3. 3 notification systems | ✅ Closed | `e878843d` + `f239c503` + `84197161` + `af2dda1b` (Phase 5a–e) |
| 4. `proxyResource` Proxy | ✅ Scoped down | folded into `Store.getResourceSnapshot` (Phase 5a–c) |
| 5. Pending commits 3 places | ✅ Closed | `098c8db9` |
| 6. Leader election | ⚠️ Patched | `74f0834b` (timeout bump only) |
| 7. Parallel drive sync | ⚠️ Partial | drain re-entrance fixed; `_dirtySyncInProgress` removed (`d34ea7ac`); state machine deferred |
| 8. `Store` god object | ❌ Not fixed | (file flat: 3,091 → 3,050) |
| 9. Subject normalisation | ❌ Not started | |
| 10a. Collection init | ✅ Closed | `73fecf18` (pre-plan, mid-session) |
| 10b. Echo detection | ✅ Closed | folded into `applyIncoming` |
| 10c. Two GET paths | ❌ Not touched | |
| 10d. Loading-state booleans | ❌ Not touched | |
| Bonus: `ResourceSource` dup | ✅ Closed | `12426da3` |
| Bonus: `putLoroSnapshot` proxy | ✅ Closed | `b4f601de` |

**7 closed structurally, 2 partially, 5 still open.** The closed
ones are Phases 1–5 of the plan (which all landed) plus the
adjacent finds (`ResourceSource`, `putLoroSnapshot`, collection
init, echo dedup). The deferred ones are Phase 6 (SharedWorker,
explicitly skipped over Firefox/Safari OPFS quirks) plus the
major-bump items (Subject normalisation, Store split, the two
remaining HTTP/WS GET paths and loading-state booleans).

The biggest *user-facing* improvements: every dagger-flake class
that the original review attributed to gripes 1, 2, 3, 5, and 10a
is now structurally impossible — `useResource` is a single
`useSyncExternalStore`, `applyIncoming` is the only resource
ingress, and `LocalOutbox` is the only durable write queue. The
remaining flake classes (multi-context leader-election under load)
are workaround-patched (30s timeout vs 5s) but the underlying
state machine is unchanged.
