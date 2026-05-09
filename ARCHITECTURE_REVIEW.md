# Architecture review — `@tomic/lib` + OPFS integration

A few weaknesses surface as soon as you trace one end-to-end flow
(say, "remote client edits a chatroom message"). The pattern is
consistent: **a single logical change passes through three or four
independent state-mutation paths, each with its own ordering,
subject normalisation, persistence, and notification semantics.**
That's where the flakes live.

This document inventories the pain points, ranks them by impact,
and sketches what a more-coherent design would look like. It is
deliberately not a refactor plan — the user will decide which
items to act on.

---

## 1. There is no single "ingress" to the store

A resource update can enter the store via at least nine
distinguishable paths:

| Source | Entry point | Persistence | Notify? |
|---|---|---|---|
| WS `UPDATE` (response to pending GET) | `websockets.ts:495–506` | via `addResources` (JSON-AD) + `persistToClientDb` (snapshot) | yes |
| WS `UPDATE` (subscription push) | `websockets.ts:526–554` | same as above, but with echo-detection skip | conditional |
| WS `SYNC_PUSH` (drive sync delta) | `websockets.ts:594–617` | same | yes |
| WS `QUERY_UPDATE` | `websockets.ts:621+` | ad-hoc | conditional |
| Local commit (`pushCommits`) | `resource.ts:1510, 1540` | `addResources` × 2 (pre + post POST) | yes × 2 |
| Offline commit replay | `resource.ts:1815` (`applyPendingCommitsLocally`) | `clientDb.putResource` + `clientDb.putLoroSnapshot` directly, plus `addResources` | yes |
| HTTP fetch (`fetchResourceFromServer`) | `client.ts:fetchResourceHTTP` → `addResources` | JSON-AD via `addResource` | yes |
| Drive sync VV state | computed/sent from `store.ts:590` | reads many resources, writes via incoming SYNC_PUSH | n/a |
| Direct `addResource` from third-party callers | various | JSON-AD | yes |

Every onramp does *almost* the same thing: hydrate the resource,
maybe set `loading=false`, maybe set `source`/`sourceTimestamp`,
maybe pass `skipCommitCompare`, maybe call `persistToClientDb`,
maybe fire `notify`. But each does it differently.

**Symptoms this produces**

- The genesis double-POST race we fixed (`5c168355`) — two paths
  through `pushCommits` both calling `postCommit` because no single
  in-flight guard existed.
- The collection-init drop we fixed (`73fecf18`) — the WS-GET-
  blocked-on-auth path interacts with the in-memory event path on
  `applyResourceChange`.
- Echo detection in WS UPDATE (`isEcho` at `websockets.ts:548`) is
  hand-rolled per-call-site because the central path doesn't know
  whether the same commit was already applied.

**What "one ingress" would look like**

A single `Store.applyIncomingResourceChange(resource, source, opts)`
that:
1. Normalises the subject (handles `_new:` → `did:ad:`).
2. Performs commit-id deduping (one place, not at each call site).
3. Persists JSON-AD + Loro snapshot atomically (or in a known
   order with one error path).
4. Fires exactly one notification with a well-defined `source`
   tag (`local-commit`, `ws-push`, `ws-pending-get`, `http-fetch`,
   `offline-replay`, …).

The current `addResource` is *trying* to be that, but every WS
handler ALSO does setup before/after the call, so it's not the
real chokepoint.

---

## 2. OPFS is written from three different layers

Three layers all reach into `clientDb.put*` directly:

```
Store.addResource           → clientDb.putResource(jsonAd)         // store.ts:930
Store.uploadFiles           → clientDb.putBlob(hash, data)         // store.ts:2727
Resource.applyPendingCommitsLocally → both putResource AND putLoroSnapshot  // resource.ts:1830, 1845
WSClient.persistToClientDb  → clientDb.putLoroSnapshot(snapshot)   // websockets.ts:859
WSClient.handleBlobResponse → clientDb.putBlob(...)                // websockets.ts:680
```

A single update from the WS triggers BOTH `addResource` →
`putResource(jsonAd)` AND `persistToClientDb` → `putLoroSnapshot`.
These are two separate worker round-trips with no cross-check.
If the JSON-AD lands but the snapshot doesn't (or vice versa),
the next reload sees a half-state. The
`getResourceWithSnapshot` reader gracefully handles `null`
snapshot, but the inverse — snapshot without JSON-AD — has
inconsistent behaviour across read sites.

**One chokepoint** — every "I have a new authoritative version of
this resource" should call exactly one persistence function that
either succeeds (both writes land in OPFS in a defined order,
worker queue guarantees ordering) or marks the resource as
"persistence pending" so the in-memory store knows what's not
durable yet.

A related smell: `applyPendingCommitsLocally` is the only path
that writes BOTH JSON-AD and snapshot from the same call; the
WS path writes them from two different files via two different
methods. The fact that one path got it right and another two
didn't is exactly what "no chokepoint" produces.

---

## 3. Three overlapping notification systems

`useResource` subscribes to **three independent channels** for
the same resource:

```ts
// react/src/hooks.ts:67-78
useEffect(() => {
  setResource(proxyResource(...));
  return store.subscribe(subject, ...);   // Channel A: per-subject
}, ...);

// react/src/hooks.ts:90
return resource.stable.on(ResourceEvents.LocalChange, ...);  // Channel B: per-property

// react/src/hooks.ts:107
return resource.stable.on(ResourceEvents.LoadingChange, ...);  // Channel C: loading
```

Plus, on the store side, **two more event paths**:

- `eventManager.emit(StoreEvents.ResourceUpdated, resource)` — fires
  on every `addResource`, used by `useCollection` for live-membership.
- `eventManager.emit(StoreEvents.ResourceManuallyCreated, resource)`
  — fires only from `notifyResourceManuallyCreated`, used by
  `useChildren` to invalidate.

So one logical "this resource changed":
- Calls 1 per-subject subscriber callback list
- Fires 1 `ResourceUpdated` event
- Fires 0–N `LocalChange` events (per modified property)
- Fires 0–1 `LoadingChange` events
- Maybe fires 1 `ResourceManuallyCreated`

`useResource` re-renders if ANY of A/B/C fires, allocating a new
`proxyResource()` each time so React's `Object.is` reports change.
For a bursty WS UPDATE flow, the same logical change can re-render
the same component three times.

PERFORMANCE_PLAN.md flags this as B1. The fix it proposes is
`useSyncExternalStore` — that collapses A/B/C into one external
subscription with explicit `getSnapshot`, which is the right
shape. Deferred because `useValue`/`useTitle` are coupled to
the proxy-identity-changes contract.

---

## 4. `proxyResource()` defeats referential equality on purpose

```ts
// resource.ts:2086-ish
export function proxyResource(r: Resource): Resource {
  return new Proxy(r.__internalObject, {});  // empty handler
}
```

The Proxy is empty — it does not intercept anything. Its only
role is to be a *different object reference* than the previous
proxy, so `useState`'s `Object.is` check decides to re-render.

Every `useResource` consumer sees identity changes per notify,
which means:

- `React.memo(MyRow, (a, b) => a.resource === b.resource)` is
  always false — every parent re-render bubbles down through
  every memoised child.
- `useEffect(..., [resource])` re-fires on every notify.
- Allocations: M components × N updates per second of allocations
  for nothing.

This is the single biggest correctness/perf trap in the
subscription model.

---

## 5. Pending commits live in three places

For an offline edit that hasn't been pushed:

1. `Resource._pendingCommits: Commit[]` — in-memory queue, drained
   by `pushCommits`.
2. `localStorage['atomic.offline.<subject>']` — persisted JSON of
   the same array, rehydrated on reload.
3. `Store.dirtyForSync: Set<string>` — subjects awaiting drain on
   reconnect.
4. (Bonus) `Store._lastLocalSignature` is also stateful, but only
   in-memory, so after reload the chaining identity is partially
   forgotten — see comment in `signChanges`:1395 ("If `_lastLocalSignature`
   is set, build the previous-commit URL from it; otherwise read
   the resource's `lastCommit`").

Three sources of truth that the code must keep in sync. The
recently-fixed-pre-this-session "syncDirtyResources fires twice on
WS reconnect flap" was an artefact of this complexity — the
multiple state stores meant the second `syncDirtyResources` call
saw a queue that the first hadn't drained yet, and `pushCommits`
had no re-entrance guard because none of the three stores was
authoritative for "is this resource currently being pushed?".

The cleaner design is one queue, persisted as one record with
one schema — say `Store.outbox: OutboxEntry[]` with `{subject,
commits, lastAttemptAt, lastAttemptError}` — read/written from
one place, with reconciliation on rehydrate.

---

## 6. ClientDb leadership election as flake source

The current design coordinates OPFS access between tabs via
`navigator.locks` + `BroadcastChannel` + a 5-second
`leader-ping`/`leader-announce` handshake. The 9 dagger-CI flakes
we just identified all stem from the second context's handshake
exceeding the timeout. We bumped to 30s in `74f0834b`, which
should clear them.

But the underlying design has more weaknesses:

- **Failure mode is silent**: a tab in `'failed'` state keeps
  running and just throws `ClientDb unavailable` from every RPC.
  Many call sites swallow that error (`.catch(() => undefined)`),
  producing observe-stale-data behaviour with no UI signal.
- **No fallback** to per-tab DB: a follower's only path to OPFS is
  via the leader's worker. If the leader stalls (or its worker
  errors), every follower hangs.
- **`BroadcastChannel` carries every RPC**, so under contention the
  whole multi-tab cohort is bottlenecked through one channel.
- **The lock's lifetime is "forever, until the tab unloads"** —
  there's no way to gracefully hand off. A long-running leader tab
  that becomes unresponsive (e.g. heavy GC pause) blocks all
  followers.

Alternative shapes:

- **Single SharedWorker**: one shared global worker per origin owns
  the WASM DB, all tabs talk to it via `postMessage`. No leader
  election needed. Browser-managed lifecycle. Currently the worker
  is a `Worker`, not `SharedWorker`.
- **Per-tab DB with reconciliation**: each tab has its own WASM
  instance reading the same OPFS via sandboxed file system. Loro
  CRDT semantics already handle multi-writer reconciliation.
  Coordination only needed for "who runs the search index", which
  could be a single elected indexer.

---

## 7. Drive sync runs as a parallel state machine

`syncDirtyResources` (HTTP /commit drain) and `startVVSync` (WS
SYNC_VV) are two separate sync mechanisms that:

- Share no transactional boundary
- Run sequentially in `handleOpen` but only by convention
- Each can fail without aborting the other
- Have separate completion signals
  (`pendingDirtyCount`, `lastDriveSync`)

For a clean reconnect this is fine. For a flap (close → reopen
during dirty drain) the system can run `syncDirtyResources` twice
in parallel — which is what we just fixed in `5c168355`.

Either:
- Both should be merged into one outgoing flow (resource VV +
  pending commits sent in one SYNC_VV-equivalent message).
- Or the dirty drain should be subordinate to the drive-sync
  state machine, not parallel.

---

## 8. `Store` is a god object

`browser/lib/src/store.ts` is 3000+ lines with responsibilities
that fan out across:

- Agent management
- Drive management
- Resource cache
- Per-subject subscription
- Event manager (top-level events)
- OPFS coordination (clientDb attached here)
- Local search index
- WS client management
- Dirty queue
- Commit log
- Batch resource saving (parent-not-yet-created handling)
- Server URL/network detection
- Subject normalisation / aliases
- Recently-created flag for navigate-vs-emit race
- `notifyResourceManuallyCreated` flag plumbing

Each of these is a coherent concern. They share the `resources`
map and `eventManager`, but otherwise interact loosely. Splitting
them into composable parts (`AgentSession`, `ResourceCache`,
`OutboxQueue`, `DriveSync`, `LocalIndex`) would make ownership
clearer and let each piece grow its own test surface.

The downside of splitting: the existing surface area is the
**public API** of `@tomic/lib` — many fields and methods are
called from `data-browser`. So a refactor is also a major-version
bump. That's a real cost.

---

## 9. Subject normalisation is forked

`normalizeSubject` exists in `Store`. But subject changes also happen:
- During genesis commit signing (`resource.ts:1457-1471` — silently
  moves the resource in `store.resources` map).
- Via `aliases` map (one direction).
- In commit serialisation (`commit.ts:248-251` — `_new:` placeholder
  swapped to `did:ad:<sig>`).
- In path-tied HTTP subjects (`store.ts:1162` — `createHTTPSubject`).

Each one knows about a different subset of the rules. Adding a
new subject form (e.g. a future `did:atomic:` scheme) would mean
finding and updating all four.

A single `Subject` type with a normalisation method, used at every
boundary, would make this enforceable.

---

## 10. Smaller smells worth noting

- **`useCollection` constructor vs. `refresh()` divergence** — the
  one we just unified in `73fecf18`. The pattern of "constructor
  calls a fast path, the public API has the safe loop" is fragile.
- **Echo detection lives in two places** — `addResource` does
  commit-id compare (skipped via `skipCommitCompare`), and the WS
  UPDATE handler also does temporal commit-id compare via
  `prevCommit !== newCommit`. They overlap but aren't identical.
- **`Store.fetchResourceFromServer` and `WSClient.fetch`** —
  there are two GET paths (HTTP vs WS) chosen by feature flag.
  Each has its own error/timeout handling. Many callers fall
  through: WS first → HTTP fallback. The code repeats this
  per-call-site rather than centralising.
- **Loading state has three booleans** — `resource.loading`,
  `resource.new`, plus the `_loroSnapshotBytes` deferred-hydrate
  flag. Their interactions are documented in long inline comments
  but not in the type.

---

## Suggested ranking

If only a few items get attention, this order maximises ROI:

1. **One ingress chokepoint for incoming resource changes.** Folds
   in #1, simplifies #2, makes #7 (drive sync) and the genesis-
   double-POST class of bug structurally impossible. Big change,
   biggest payoff.
2. **`useSyncExternalStore` migration** (PERFORMANCE_PLAN B1).
   Folds in #3 and #4. Touches every hook in `@tomic/react` but
   is mechanical.
3. **Outbox as one persisted queue.** Folds in #5. Clean refactor,
   limited blast radius.
4. **SharedWorker for OPFS.** Folds in #6. Much simpler than the
   leader-election dance.
5. **Split `Store` into composable pieces.** #8. Major-version
   bump; do alongside the ingress refactor.
6. The rest are improvements, not architectural fixes.

---

## What this session's fixes already did

- `5c168355` — pushCommits re-entrance guard. Patches the immediate
  symptom of #1 (multiple ingress paths, no shared lock).
- `73fecf18` — Collection constructor unified with `refresh()`.
  Patches the symptom of #1 (event path drops members during
  initial fetch race).
- `74f0834b` — leadership-election timeout 5s → 30s. Patches the
  symptom of #6 (silent failure of follower contexts in dagger).

Each of these was a localised fix that also nudged toward "fewer
parallel paths". The architectural items above are the structural
versions of the same insights.
