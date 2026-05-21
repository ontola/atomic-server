# Unified data layer — proposal

> Scope note: this proposal focuses on the browser/JS data layer and the OPFS
> flakes that exposed it. The broader runtime direction is in
> [`atomic-lib-runtime.md`](./atomic-lib-runtime.md) (`AtomicNode` API). Transport
> and multi-device sync (WS / Iroh, Flutter) are in
> [`unified-sync.md`](./unified-sync.md). This document is the browser
> cache/reactivity layer on top of that node surface.

The data-layer flakes we keep landing on (genesis double-POST,
collection drops members during init, leadership-election timeout,
sidebar-not-visible-after-reload) are all symptoms of the same
root shape: **a logical "resource changed" passes through multiple
independent paths**, each writing to overlapping state with no
shared lock or sequencer. This document proposes a unified
data-layer design that collapses those paths into one.

It's a target architecture, not a rewrite plan. The current code
can converge on it incrementally; each section calls out the
mechanical migration step.

---

## The problems, in one paragraph each

**P1 — many ingresses.** A resource update can land via WS UPDATE
(pending-GET response or subscription push), WS SYNC_PUSH, WS
QUERY_UPDATE, local `pushCommits` (pre- and post-POST `addResource`),
offline replay (`applyPendingCommitsLocally`), HTTP `fetchResource`,
or a third party calling `addResources`. Each path sets up
`source`/`sourceTimestamp`/`loading` differently, decides
independently whether to skip the commit-id compare, persists
to OPFS independently, and fires `notify` independently.

**P2 — split persistence.** A WS UPDATE writes JSON-AD via
`Store.addResource` AND writes the Loro snapshot via
`WSClient.persistToClientDb`. Two worker round-trips, two error
paths, no atomic coupling. `Resource.applyPendingCommitsLocally`
is the only path that does both from one place.

**P3 — three subscription channels.** Every `useResource` subscribes
to per-subject callbacks + `ResourceEvents.LocalChange` +
`ResourceEvents.LoadingChange`. Same logical change → up to three
re-renders. `proxyResource()` is an empty Proxy whose only role is
to defeat `Object.is` so React re-renders — which kills
`React.memo`, breaks `useEffect` deps, and reallocates per notify.

**P4 — pending writes in three stores.** `Resource._pendingCommits`,
`localStorage['atomic.offline.<subject>']`, and `Store.dirtyForSync`
must stay in sync manually. `_lastLocalSignature` is in-memory only,
so reload partially forgets the commit chain.

**P5 — leader-election fragility.** Two contexts on one origin
coordinate OPFS via `navigator.locks` + `BroadcastChannel` + a
ping/announce handshake with a 5s timeout. Under dagger CPU
pressure the handshake exceeds the budget and the second context
dies silently (`role = 'failed'`, every RPC throws).

**P6 — drive sync parallel to dirty drain.** On WS reconnect,
`syncDirtyResources` (HTTP /commit drain) and `startVVSync` (WS
SYNC_VV) run in sequence "by convention" but with no transactional
boundary. A reconnect flap can run `syncDirtyResources` twice in
parallel.

---

## The unified design

### Core idea: **one queue in, one queue out, one subscription channel**

```
                ┌──────────────────────────────────────────┐
                │            ResourceCache                 │  in-memory
                │   subject → Resource (one source of truth)│
                └────────────┬─────────────────────────────┘
                             │ snapshot
                             ▼
                ┌──────────────────────────────────────────┐
                │          subscribeStore (USES)            │
                │   useSyncExternalStore-style getSnapshot  │
                └──────────────────────────────────────────┘
       ▲                                                ▲
       │ applyIncoming(...)                             │ enqueueOutbound(...)
       │                                                │
┌──────┴───────┐                              ┌─────────┴───────┐
│  Inbox       │                              │  Outbox         │
│  ────────    │                              │  ────────       │
│  WS UPDATE   │                              │  local commits  │
│  WS SYNC_*   │                              │  blob uploads   │
│  HTTP fetch  │                              │                 │
│  offline-replay (rehydrated from outbox)    │  one persisted  │
└──────────────┘                              │  durable queue  │
       │                                      └────────┬────────┘
       │                                               │
       ▼                                               ▼
┌──────────────────────────────────────────┐    ┌──────────────┐
│         OPFS Persistor (one file)         │    │  ws/http hub │
│  putResource() = jsonAd + snapshot atomic │    └──────────────┘
└──────────────────────────────────────────┘
```

Five components instead of "everything inside `Store`". Each has
one responsibility and a small public surface.

---

### S1: One ingress — `applyIncoming(change, source)`

Replaces P1. Every code path that learns of a new
authoritative-or-local version of a resource calls exactly:

```ts
type ChangeSource =
  | 'ws-pending-get'   // response to our own GET
  | 'ws-sub-push'      // subscription push from someone else
  | 'ws-sync-push'     // drive sync delta
  | 'http-fetch'       // GET via HTTP fallback
  | 'local-pre-push'   // signed locally, not yet on server
  | 'local-acked'      // server confirmed our commit
  | 'offline-replay';  // rehydrated from outbox

interface IncomingChange {
  subject: string;            // already normalised
  loroBytes?: Uint8Array;     // exclusive with jsonAd
  jsonAd?: string;            //   (one wire format per source)
  commitId: string;           // for dedup
  source: ChangeSource;
  receivedAt: number;
}

ResourceCache.applyIncoming(change: IncomingChange): void
```

The cache:
1. Normalises subject (one place).
2. Dedups by `commitId` against the existing resource's
   `lastCommit` — replaces the four ad-hoc echo checks.
3. Imports loro/jsonAd into the in-memory `Resource`.
4. Schedules persistence via the OPFS Persistor (S2).
5. Fires exactly one notification with `change.source` attached
   so listeners can decide whether they care.

**What dies**: `addResource`'s `skipCommitCompare` flag, the
`isEcho` block in `websockets.ts:548`, the
`_lastLocalSignature` rehydrate special-case, the
"persistToClientDb at one specific call site" pattern.

**Migration**: introduce `applyIncoming` alongside `addResource`,
move the WS handlers over one Tag at a time, then `addResource`
becomes a thin shim that calls `applyIncoming({ source:
'http-fetch' })`. Delete when no callers remain.

---

### S2: One persistence chokepoint — `OpfsPersistor`

Replaces P2.

```ts
class OpfsPersistor {
  // The ONLY way to write a resource. Both forms land atomically
  // (worker queues guarantee ordering inside a single
  // `putResource` message; transactions across keys are a future
  // upgrade).
  async putResource(args: {
    subject: string;
    jsonAd: string;          // for index/search
    loroSnapshot: Uint8Array;// for CRDT replay
  }): Promise<void>;

  async putBlob(hash: Uint8Array, data: Uint8Array): Promise<void>;
  async removeResource(subject: string): Promise<void>;
  async getResourceWithSnapshot(subject: string): Promise<...>;
}
```

The current `clientDb.putResource` and `clientDb.putLoroSnapshot`
become private — only `OpfsPersistor` calls them, in the right
order, in the same worker message. No caller of the data layer
ever sees them.

**What dies**: `WSClient.persistToClientDb`, the
`putLoroSnapshot` call inside `applyPendingCommitsLocally`, the
direct `clientDb.putResource` in `addResource`.

**Migration**: change the worker protocol to accept a single
`putResource` with both forms. Update the four call sites that
write OPFS to go through `OpfsPersistor`. Worker keeps its
serialised queue, so atomicity-within-message is automatic.

---

### S3: One subscription model — `useSyncExternalStore`

Replaces P3 + P4 (the `proxyResource` bit).

```ts
// react/src/useResource.ts
export function useResource<T>(subject: string): Resource<T> {
  const store = useStore();
  return useSyncExternalStore(
    store.subscribe.bind(store, subject),  // one subscribe
    () => store.getSnapshot(subject),       // returns the same
                                            //   instance until the
                                            //   resource genuinely
                                            //   changes
  );
}
```

The cache assigns a NEW `Resource` instance only when the
underlying state changes (new commit applied, new property set,
loading flipped). Same instance ⇒ React's identity check decides
not to re-render. `React.memo`, `useEffect([resource])`,
`useMemo([resource])` all work as expected.

`useValue` and `useTitle` move to per-property subscriptions:

```ts
useValue(subject, property)  // subscribes to one (subject,property) key
useTitle(subject)            // subscribes to (name|shortname|filename)
```

So a chatroom that reads 200 messages doesn't re-render when
`message[42].name` changes — only that one row does.

**What dies**: `proxyResource()`, the three-`useEffect` setup in
`useResource`, the per-property `LocalChange` listener that exists
to work around proxy identity. The `track` parameter on
`useResource` becomes obsolete.

**Migration**: implement `useSyncExternalStore`-based hooks
behind a flag (`useResourceV2`), port the data-browser hot paths
first (TableEditor, SidebarTree), measure with the perf trace,
remove the old hooks once parity is reached.

---

### S4: One outbox — `LocalOutbox`

Replaces P4 fully.

```ts
interface OutboxEntry {
  subject: string;
  commits: Commit[];        // ordered, includes signature chain
  blobs?: Array<{           // optional referenced blobs
    hash: Uint8Array;
    bytes: Uint8Array;
  }>;
  enqueuedAt: number;
  lastAttemptAt?: number;
  lastAttemptError?: string;
}

class LocalOutbox {
  enqueue(entry: OutboxEntry): void;
  // Drains the queue against the server. Idempotent — a
  // re-entrance returns the in-flight promise instead of
  // double-draining (S0 bug, fixed in 5c168355).
  drain(): Promise<void>;
  pending(): readonly OutboxEntry[];
}
```

Persistence: one `localStorage['atomic.outbox']` JSON blob (or
one OPFS file once we go multi-tab safely). One source of truth
for "what hasn't been pushed yet".

`_pendingCommits` on the Resource still exists in-memory while a
commit is being signed (signing is sync; outbox is the durable
boundary). After `signChanges`, the commit moves into the outbox
and `_pendingCommits` is cleared. After `drain()` succeeds, the
outbox entry is removed and `applyIncoming({source: 'local-acked'})`
fires for each commit.

**What dies**: `Store.dirtyForSync`, `localStorage['atomic.offline.*']`,
`hydrateCommitLogFromOffline`, the manual `_lastLocalSignature`
rehydration in `signChanges`.

**Migration**: the outbox can wrap the existing dirty queue
without behavioural change initially. Then move signing to
write directly to the outbox instead of `_pendingCommits`. Then
delete the parallel state stores.

---

### S5: SharedWorker for OPFS — `OpfsCoordinator`

Replaces P5.

A single `SharedWorker` per origin owns the WASM DB and OPFS
handle. Every browsing context (tab, iframe, e2e page2) connects
to it via `MessagePort`. The browser handles lifecycle: when the
last connection closes, the worker is reaped.

No leader election. No `BroadcastChannel`. No 5s timeout. No
"the leader tab unloaded, who's next" dance.

```ts
// Inside the SharedWorker
self.onconnect = (event) => {
  const port = event.ports[0];
  port.onmessage = (msg) => routeRpc(msg.data, port);
  // Each port is just another caller; the worker has one DB
  // instance and serialises operations on its internal queue.
};

// In each tab
const port = new SharedWorker('client-db.shared-worker.js').port;
port.postMessage({ id, type: 'putResource', ... });
```

**What dies**: `client-db.ts`'s entire leader-election state
machine (`Role`, `LEADERSHIP_TIMEOUT_MS`, `becomeLeader`,
`handleBroadcast`, `leadershipGained`/`leaderObserved`). About
200 lines.

**Migration cost**: SharedWorker has minor browser differences
from Worker (no `WorkerGlobalScope`, different module loading on
Safari). Fastest path is a 1:1 conversion of the existing
`client-db.worker.ts` + a small `SharedWorker` shell.

**Caveat**: Some sandboxed contexts disallow SharedWorker (some
extensions, certain iframes). Fallback: per-context Worker that
talks directly to OPFS, no leader election needed because OPFS
file locks are per-origin and the WASM DB itself can detect
contention. That's still simpler than the current handshake.

---

### S6: One sync orchestrator — `DriveSync`

Replaces P6.

The drive-sync state machine owns reconnect:

```
States: disconnected → authenticating → draining-outbox →
        sending-vv → applying-diff → connected → (notify subscribers)

On reconnect: enter `authenticating`. On AUTH_OK,
  transition to `draining-outbox` (LocalOutbox.drain()).
  Once empty, transition to `sending-vv`.
  On SYNC_OK or SYNC_DIFF resolution, transition to `connected`.

Re-entrance: if a flap interrupts mid-transition, the new
  `connect` call observes the existing in-flight state and
  joins it (analogous to S4's outbox.drain idempotency).
```

`syncDirtyResources` and `startVVSync` become internal steps of
this state machine, not parallel operations. The dirty-drain
race we fixed in `5c168355` is structurally impossible.

**What dies**: `Store.startDriveSync`, `Store.finishDriveSync`,
`Store.dirtySyncInProgress`, `Store.driveSyncInProgress`, the
`Promise.race` of independent flags inside
`getSyncStatus`. Replaced by one `driveSync.state` enum.

---

## The shape of the new public API

```ts
import { Store, useResource, useChildren, useTitle } from '@tomic/lib';

const store = new Store({ serverUrl, agent });

// Reads
useResource(subject)        // one subscription, one identity per change
useTitle(subject)           // per-(name|shortname|filename) subscription
useChildren(subject)        // collection-style, S1 ingress feeds it
useArray(resource, prop)    // per-(subject,prop) subscription

// Writes
const r = await store.newResource(...)
r.set(prop, value)          // local edit, dirty in-memory only
await r.save()              // signs, enqueues to LocalOutbox, kicks DriveSync

// Status
store.driveSync.state       // one enum, replaces 5 boolean flags
store.outbox.pending()      // canonical "what isn't pushed yet"
```

The **caller-visible** changes are mostly negative-space — the
proxy weirdness and the multiple sync flags go away. The names
mostly stay.

---

## Migration order (smallest-blast-radius first)

1. **`OpfsPersistor`** — low-risk, atomic-write benefit, mostly
   moves existing code behind one function. (S2)
2. **`LocalOutbox`** — wraps existing `_pendingCommits` +
   `dirtyForSync`. Existing tests keep passing. (S4)
3. **`applyIncoming` chokepoint** — move WS handlers over one
   Tag at a time, then HTTP fetch, then local-commit paths.
   Each Tag move is independently testable. (S1)
4. **`DriveSync` state machine** — once `applyIncoming` is the
   only ingress, the orchestrator can be added without
   surprising the rest of the code. (S6)
5. **`useSyncExternalStore` hooks** — biggest perf win, biggest
   surface area on `data-browser`. Do behind a flag. (S3)
6. **SharedWorker** — last, because it touches the worker
   protocol and needs cross-browser smoke tests. (S5)

Each step is independently shippable. Steps 1 and 2 can land in
the next two weeks without breaking any public API. Step 3 is
the structural one — a few weeks of focused work. Steps 5 and 6
are major-version-bump material.

---

## What the four flake fixes from this session preview

Every fix has been a localised version of one of these:

| Commit | Fixes symptom of | Structural version |
|---|---|---|
| `5c168355` (pushCommits guard) | P1 + P4 (no shared lock across ingresses, queue split across stores) | S1 + S4 |
| `73fecf18` (collection.ts refresh-init) | P1 (event path drops members while initial fetch is on a different path) | S1 |
| `74f0834b` (leadership timeout 30s) | P5 (BroadcastChannel handshake fragility) | S5 |
| `cc66e88e` (nextest filter `package()`) | unrelated (test infra) | n/a |

Each was the right tactical fix; none addresses the underlying
architecture. The proposal above closes the structural gap that
keeps producing one of these per week.
