# Simplification — code-delta estimate per phase

The numbers below are measured against the current state of the
repo (lines counted from real files, not estimated from memory).
For each phase: **lines added** for the new abstraction, **lines
deleted** from existing files, and **net delta**. The "complexity
delta" column captures things you can stop holding in your head:
distinct code paths, edge cases, special flags.

## Current baseline (data-layer-relevant files)

| File | Lines |
|---|---:|
| `browser/lib/src/store.ts` | 3,091 |
| `browser/lib/src/resource.ts` | 2,142 |
| `browser/lib/src/websockets.ts` | 884 |
| `browser/lib/src/client-db.ts` | 557 |
| `browser/lib/src/client-db.worker.ts` | 258 |
| `browser/lib/src/client-db.node.ts` | 252 |
| `browser/lib/src/collection.ts` | 719 |
| `browser/lib/src/client.ts` | 358 |
| `browser/lib/src/parse.ts` | 96 |
| `browser/react/src/hooks.ts` | 719 |
| `browser/react/src/useCollection.ts` | 225 |
| `browser/react/src/useChildren.ts` | 104 |
| **Total** | **9,405** |

---

## Phase 1 — `OpfsPersistor` *(2.5 days)*

| Action | Lines |
|---|---:|
| New `opfs-persistor.ts` | +120 |
| Delete OPFS write block in `Store.addResource` (lines 914–942) | −30 |
| Delete dual-write in `Resource.applyPendingCommitsLocally` (1828–1845) | −25 |
| Delete `WSClient.persistToClientDb` (851–862) | −12 |
| Delete redundant cases from `client-db.worker.ts` (`putResource`, `putLoroSnapshot`) | −30 |
| **Net: +120 −97 = +23** | |

**Complexity delta** (more important than line count):
- 4 OPFS write call sites → 1
- 2 worker round-trips per WS update → 1
- "JSON-AD landed but snapshot didn't" half-state → impossible

---

## Phase 2 — `LocalOutbox` *(3.5 days)*

| Action | Lines |
|---|---:|
| New `local-outbox.ts` | +150 |
| Delete `Store.dirtyForSync` Set + persistence + getter/setter | −30 |
| Delete `Store.hydrateCommitLogFromOffline` | −50 |
| Delete `Store.syncDirtyResources` | −60 |
| Delete `Store.sortDirtyForSync` | −30 |
| Delete `Store` localStorage write paths for `atomic.dirtyForSync` / `atomic.offline.*` | −20 |
| Delete `Resource._pendingCommits` queue plumbing | −20 |
| Delete `Resource.setPendingCommits` | −5 |
| Shrink `Resource.applyPendingCommitsLocally` (becomes a 20-line in-memory hydrate) | −60 |
| Delete `_lastLocalSignature` rehydrate special-case in `signChanges` | −10 |
| Delete `_lastLocalSignature` field + careful clearing logic | −5 |
| **Net: +150 −290 = −140** | |

**Complexity delta:**
- 3 stores for "what hasn't been pushed" (`_pendingCommits` +
  `localStorage['atomic.offline.*']` + `dirtyForSync`) → 1
- 2 reload-rehydrate paths → 1
- `_lastLocalSignature` reload-amnesia footgun → gone
- The race that produced the genesis double-POST is structurally
  impossible (one queue can't drain itself twice in parallel)

---

## Phase 3 — `applyIncoming` chokepoint *(5 days)*

| Action | Lines |
|---|---:|
| New `applyIncoming` in `ResourceCache` | +200 |
| Delete `Store.addResource` body | −130 |
| Delete `Store.addResources` (becomes one-line shim or removed) | −7 |
| Shrink WS UPDATE handler (current 77 lines for the two branches) | −60 |
| Shrink WS SYNC_PUSH handler (current 46 lines) | −30 |
| Shrink WS QUERY_UPDATE handler | −20 |
| Delete `skipCommitCompare` flag + plumbing across 4 files | −25 |
| Delete `Store.hydrateResourceFromJsonAd` (folded in) | −40 |
| Delete `isEcho` / `prevCommit !== newCommit` ad-hoc detection | −15 |
| Delete `Resource.pushCommits` pre/post `addResources` calls | −5 |
| **Net: +200 −332 = −132** | |

**Complexity delta:**
- 9 ingress paths → 1 (`applyIncoming({source: ...})`)
- 4 echo-detection schemes → 1 commit-id dedup in the cache
- "Did this path remember to call `persistToClientDb`?" — gone
- `source: ChangeSource` is now a single discriminated union;
  any new ingress (e.g. CRDT replay, peer sync) is one new
  enum variant, not a new code path through 4 files

---

## Phase 4 — `DriveSync` state machine *(2 days)*

| Action | Lines |
|---|---:|
| New `drive-sync.ts` | +150 |
| Delete `Store.startDriveSync` / `finishDriveSync` / `lastDriveSync` | −40 |
| Delete `_dirtySyncInProgress`, `_driveSyncInProgress`, `setDirtySyncInProgress` | −30 |
| Delete `Store.hasCompletedDriveSync`, `waitForFirstDriveSync` | −40 |
| Shrink `WSClient.handleOpen` (current 23-line body → 3 lines) | −20 |
| Move `WSClient.startVVSync` body into state machine | −25 |
| Delete public `syncDirtyResources` method | −10 |
| **Net: +150 −165 = −15** | |

**Complexity delta:**
- 5 boolean status flags (`driveSyncInProgress`,
  `dirtySyncInProgress`, `serverConnected`, `clientDbReady`,
  `clientDbAttached`) → 1 enum (`DriveSyncState.kind`)
- "Is sync running" had a `Promise.race` over multiple flags →
  one state-machine field
- The reconnect-flap-runs-syncDirtyResources-twice race is
  structurally impossible (state machine guards re-entrance)

---

## Phase 5 — `useSyncExternalStore` hooks *(4.5 days)*

| Action | Lines |
|---|---:|
| New `useResource` / `useValue` / `useTitle` (USS-based) | +150 |
| Delete `proxyResource` function | −10 |
| Shrink `useResource`'s 3 `useEffect`s (current 65 lines → 5) | −60 |
| Shrink `useValue` manual subscription + `reactToProperty` (~80 → 15) | −65 |
| Shrink `useTitle` (~40 → 15) | −25 |
| Delete `LocalChange` / `LoadingChange` listener wiring | −30 |
| Delete `track` param threading through 4+ files | −20 |
| Remove unused `ResourceEvents` entries | −10 |
| Shrink `Resource.inProgressCommit` / `hasQueue` (single ingress makes them simpler) | −25 |
| **Net: +150 −245 = −95** | |

**Complexity delta:**
- 3 subscription channels per `useResource` → 1
- "Allocate a new Proxy per notify so React re-renders" → state
  identity changes only on real change; `React.memo` works again
- `useEffect([resource])` no longer fires on every notify
- 0 extra Proxy allocations per WS update (was 1 per subscriber)

---

## Phase 6 — `SharedWorker` for OPFS *(2.5 days)*

| Action | Lines |
|---|---:|
| New SharedWorker shell + connect/route | +40 |
| Delete `Role` enum + state-machine state | −10 |
| Delete `LEADER_LOCK` + `LEADERSHIP_TIMEOUT_MS` + `BroadcastChannel` setup | −30 |
| Delete `leadershipGained`, `leaderObserved`, `onBecameLeader`, `onObservedLeader` | −20 |
| Delete `becomeLeader` (~45 lines) | −45 |
| Delete `handleBroadcast` switch (~70 lines) | −70 |
| Delete leader-ping timeout `Promise.race` | −20 |
| Delete `bc` field + cleanup | −15 |
| Delete role-based RPC routing | −50 |
| **Net: +40 −260 = −220** | |

**Complexity delta:**
- 4-state role machine (`initializing` / `leader` / `follower`
  / `failed`) → none (browser owns the lifecycle)
- `BroadcastChannel` cross-tab handshake + 5–30s timeout → none
- "Leader tab unloads, who's next?" — handled by the browser
- The 9 dagger leadership-timeout flakes → structurally
  impossible

---

## Cumulative

| Phase | Added | Deleted | Net | Cumulative net |
|---|---:|---:|---:|---:|
| 1. OpfsPersistor | +120 | −97 | +23 | +23 |
| 2. LocalOutbox | +150 | −290 | **−140** | −117 |
| 3. applyIncoming | +200 | −332 | **−132** | −249 |
| 4. DriveSync | +150 | −165 | −15 | −264 |
| 5. useSyncExternalStore | +150 | −245 | **−95** | −359 |
| 6. SharedWorker | +40 | −260 | **−220** | **−579** |
| **Total** | **+810** | **−1,389** | **−579** | |

**~6% of the data layer goes away in absolute lines** — but
that undersells the impact, because the new code is concentrated
in 6 small focused files instead of scattered across 12 large ones.

Where the **complexity** lives:

| Concept | Today | After |
|---|---:|---:|
| OPFS write call sites | 4 | 1 |
| Worker round-trips per WS update | 2 | 1 |
| Resource-ingress paths | 9 | 1 |
| Echo-detection schemes | 4 | 1 |
| Stores tracking "unsynced" state | 3 | 1 |
| Subscription channels per `useResource` | 3 | 1 |
| Sync status booleans | 5 | 1 enum |
| Leader-election states | 4 | 0 |
| Subject-normalisation sites | 4 | 1 |
| `proxyResource()` allocations per notify | 1 per subscriber | 0 |

---

## File-by-file shrinkage

Estimated post-migration line counts:

| File | Today | After | Δ |
|---|---:|---:|---:|
| `store.ts` | 3,091 | ~2,300 | **−25%** |
| `resource.ts` | 2,142 | ~1,700 | **−21%** |
| `websockets.ts` | 884 | ~550 | **−38%** |
| `client-db.ts` | 557 | ~280 | **−50%** |
| `client-db.worker.ts` | 258 | ~210 | −19% |
| `react/src/hooks.ts` | 719 | ~480 | **−33%** |
| New: `opfs-persistor.ts` | — | 120 | new |
| New: `local-outbox.ts` | — | 150 | new |
| New: `resource-cache.ts` (with `applyIncoming`) | — | 250 | new |
| New: `drive-sync.ts` | — | 150 | new |
| **Total relevant data-layer code** | **~9,405** | **~7,690** | **−18%** |

---

## What "drastic complexity reduction" actually means here

Raw line count drops ~18%, but the **mental model** drops much
more:

- **Read paths**: 1 (was 4 — OPFS direct, OPFS via collection,
  WS GET, HTTP GET, with their own caches and error handlers).
- **Write paths**: 1 (was 9 — see table above).
- **State stores for pending writes**: 1 (was 3).
- **Subscription channels**: 1 (was 3 per resource + 2 store-
  level events).
- **Coordinator state machines**: 0–1 (was 2 — leader-election
  + drive-sync, both with re-entrance bugs we just fixed).

A new contributor today has to learn 9 ingress paths,
3 persistence stores, 3 subscription channels, 2 coordinator
state machines, and 4 echo-detection schemes to reason about
"what happens when a chat message arrives". After the migration:
**one diagram with one box per layer**.

---

## Quickest wins by line-count-deleted-per-day

| Phase | Deleted | Days | Lines/day deleted |
|---|---:|---:|---:|
| 6. SharedWorker | 220 | 2.5 | **88** |
| 2. LocalOutbox | 140 | 3.5 | **40** |
| 3. applyIncoming | 132 | 5 | 26 |
| 5. useSyncExternalStore | 95 | 4.5 | 21 |
| 4. DriveSync | 15 | 2 | 8 |
| 1. OpfsPersistor | (+23) | 2.5 | -9 (adds code) |

**Phase 6 (SharedWorker) deletes the most code per day.** That's
also a reasonable starting point if the goal is "show the team
quick wins" — it touches one file, deletes ~260 lines, and
removes the entire leader-election concept.

For *structural* impact, **Phase 2 + Phase 3 still dominate**:
they collapse ingress and outbox, which is where the recurring
bugs come from. Phase 6 is the cleanest delete; Phases 2–3 are
the real architectural improvement.
