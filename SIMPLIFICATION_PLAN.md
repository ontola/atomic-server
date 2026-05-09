# Simplification plan

A concrete, ordered list of steps to converge `@tomic/lib` on the
unified data layer described in `UNIFIED_DATA_LAYER.md`. Each step
is independently shippable, has its own test surface, and can be
reverted without unwinding later steps. Order is chosen so the
biggest payoff lands first while the riskiest changes (public-
API-breaking) come after the prep work that makes them safe.

Naming convention: each step is **Step N**, with a one-line
"definition of done". Effort estimates are person-days assuming
familiarity with the codebase.

---

## Phase 0 — preconditions (already done this session)

✅ Always-on perf trace (`browser/lib/src/perf-trace.ts`) — gives
us a measurement baseline so each step can be checked for
regressions.

✅ E2E CPU throttle (`ATOMIC_TEST_CPU_THROTTLE` env var) —
reproduces the dagger-only flakes in 15s locally instead of 1h.

✅ `pushCommits` re-entrance guard (5c168355) — eliminates the
genesis double-POST as a noise source so we can measure structural
changes without it confounding results.

✅ Collection-init unified with `refresh()` (73fecf18) — same
reasoning, removes the dominant flake class from the baseline.

✅ Leader-election timeout 5s → 30s (74f0834b) — reduces multi-
context flake noise to background level for the SharedWorker
migration later.

These three fixes give us a **clean signal**: the next CI run
will show what's left as actual structural problems vs. fix-able
acute bugs.

---

## Phase 1 — `OpfsPersistor` (S2)

**Goal**: every OPFS write goes through one function that writes
JSON-AD + Loro snapshot in one worker round-trip.

**Definition of done**: zero direct calls to `clientDb.putResource`
/ `clientDb.putLoroSnapshot` / `clientDb.removeResource` outside
of `OpfsPersistor`.

### Step 1.1 — extend the worker protocol *(0.5 day)*

`browser/lib/src/client-db.worker.ts`: add a single message type
that takes `{ subject, jsonAd, loroSnapshot }` and writes both in
the same handler. Keep the existing `putResource` and
`putLoroSnapshot` for now.

```ts
case 'putResourceWithSnapshot': {
  await ensureInit();
  await db!.putResource(msg.jsonAd);
  await db!.putLoroSnapshot(msg.subject, msg.snapshot);
  return;
}
```

The worker's serialised queue makes this atomic from the caller's
perspective — no other message can interleave.

### Step 1.2 — introduce `OpfsPersistor` *(0.5 day)*

New file `browser/lib/src/opfs-persistor.ts`. Owns one
`ClientDbWorker` reference. Public API: `putResource`,
`putBlob`, `removeResource`, `getResourceWithSnapshot`,
`waitForReady`, `isReady`. Each method is a thin wrapper that
serialises the args and routes via the worker protocol.

Internal-only: any read fallback (e.g. retry-on-timeout) lives
here.

### Step 1.3 — migrate the four write call sites *(1 day)*

Find/replace pattern:

| Current | New |
|---|---|
| `clientDb.putResource(jsonAd)` (`store.ts:930`) | `persistor.putResource({subject, jsonAd, snapshot})` |
| `clientDb.putLoroSnapshot(subject, snap)` (`websockets.ts:859`) | merged into the `addResource` call so JSON-AD + snapshot go together |
| `clientDb.putResource(JSON.stringify(obj))` (`resource.ts:1845`) + `clientDb.putLoroSnapshot(...)` (`resource.ts:1830`) | one `persistor.putResource(...)` |
| `clientDb.removeResource(...)` (`store.ts:2026`) | `persistor.removeResource(...)` |

After the migration the only file importing `ClientDbWorker` is
`opfs-persistor.ts`.

### Step 1.4 — delete the old worker messages *(0.5 day)*

Once no caller uses `putResource`/`putLoroSnapshot` directly,
delete those cases from `client-db.worker.ts`. Mark the
`ClientDbWorker` type's individual put-methods as deprecated and
remove the public exports.

**Cumulative effort**: ~2.5 days. Risk: low (mechanical refactor,
existing tests cover the paths). **Stops** persistence-half-state
bugs at their source.

---

## Phase 2 — `LocalOutbox` (S4)

**Goal**: pending writes (signed-but-not-pushed commits + queued
blobs) live in one durable queue with one schema.

**Definition of done**: `Store.dirtyForSync`,
`localStorage['atomic.offline.*']`, and `_lastLocalSignature` are
all gone; `LocalOutbox` is the only source of "what hasn't
synced".

### Step 2.1 — define `OutboxEntry` and write the persistence shape *(0.5 day)*

```ts
interface OutboxEntry {
  subject: string;          // post-signing did:ad: form
  commits: SerialisedCommit[];
  blobs?: { hash: string; bytesRef: string }[];  // bytes in OPFS
  enqueuedAt: number;
  lastAttemptAt?: number;
  lastAttemptError?: string;
  lastLocalSignature?: string; // for chaining offline edits
}
```

Persistence: one `OPFS://atomic-outbox.json` file (preferred over
localStorage — survives quotas, works in incognito's own way,
co-located with the rest of the app's state).

### Step 2.2 — implement `LocalOutbox` *(1 day)*

```ts
class LocalOutbox {
  enqueue(entry: OutboxEntry): Promise<void>;  // append + persist
  upsertCommit(subject: string, commit: SerialisedCommit, sig?: string): Promise<void>;
  // Drains. Idempotent — concurrent calls join the in-flight promise.
  drain(commitPoster: CommitPoster): Promise<DrainResult>;
  pending(): readonly OutboxEntry[];
  clear(subject: string, upToCommitId: string): Promise<void>;
}
```

The `upsertCommit` method is what `Resource.signChanges` calls
instead of pushing onto `_pendingCommits` and writing
localStorage separately.

### Step 2.3 — wire signing into the outbox *(1 day)*

In `Resource.signChanges`:

```ts
// before:
this._lastLocalSignature = commit.signature;
this._pendingCommits.push(commit);
// localStorage write happens later in applyPendingCommitsLocally

// after:
await this.store.outbox.upsertCommit(this.subject, commit, commit.signature);
// _pendingCommits stays in-memory only, cleared after successful drain
```

`applyPendingCommitsLocally` becomes mostly empty — the outbox
already persists. Only the in-memory store hydration remains.

### Step 2.4 — wire reconnect drain through the outbox *(0.5 day)*

`syncDirtyResources` becomes:

```ts
async syncDirtyResources(): Promise<void> {
  return this.outbox.drain(this);  // `this` provides postCommit
}
```

The pre-existing in-flight guard moves into the outbox. The
"sort by depth" ordering moves with it.

### Step 2.5 — delete the parallel state stores *(0.5 day)*

Remove `Store.dirtyForSync`, `Store._lastLocalSignature` rehydrate
logic, `localStorage['atomic.offline.<subject>']` keys (one-shot
migration: read once into outbox, then never again),
`hydrateCommitLogFromOffline`. The dirty-sync status display
reads `outbox.pending().length` instead.

**Cumulative effort**: ~3.5 days. Risk: medium — touches the
offline-create flow which is the most-tested path. Mitigation:
Phase 1's `OpfsPersistor` and the existing offline-roundtrip
integration test give clear signals.

---

## Phase 3 — `applyIncoming` chokepoint (S1)

**Goal**: every WS frame, HTTP response, local commit, and
offline replay funnels through one function with one ordering
contract.

**Definition of done**: `addResource`, `addResources`, and
`hydrateResourceFromJsonAd` are all internal helpers of
`ResourceCache`; the rest of the codebase calls
`applyIncoming(...)`.

### Step 3.1 — design the `IncomingChange` type *(0.5 day)*

```ts
interface IncomingChange {
  subject: string;
  loroBytes?: Uint8Array;
  jsonAd?: string;
  commitId?: string;
  source: ChangeSource;
  receivedAt: number;
  // Optional flags for the rare cases that need them.
  // Deliberately small set; extend only when a real call-site
  // requires it.
  forceNotify?: boolean;
}

type ChangeSource =
  | 'ws-pending-get'
  | 'ws-sub-push'
  | 'ws-sync-push'
  | 'ws-query-update'
  | 'http-fetch'
  | 'local-pre-push'
  | 'local-acked'
  | 'offline-replay';
```

### Step 3.2 — implement `ResourceCache.applyIncoming` *(1 day)*

The single ingress:

```ts
async applyIncoming(change: IncomingChange): Promise<void> {
  const subject = this.normalize(change.subject);

  // 1. Dedup by commitId. Skips both echo pushes AND late-
  //    arriving redundant copies (e.g. SYNC_PUSH for a resource
  //    we just acked locally).
  const existing = this.resources.get(subject);
  if (
    existing &&
    change.commitId &&
    existing.get(LAST_COMMIT) === change.commitId &&
    !change.forceNotify
  ) {
    return;  // idempotent no-op
  }

  // 2. Hydrate in-memory.
  const r = existing ?? new Resource(subject);
  if (change.loroBytes) r.importLoroUpdate(change.loroBytes);
  else if (change.jsonAd) r.applyJsonAd(change.jsonAd);
  if (change.commitId) r.setLastCommitValue(change.commitId);
  r.source = change.source;
  r.sourceTimestamp = change.receivedAt;
  r.loading = false;
  this.resources.set(subject, r);

  // 3. Persist atomically (Phase 1's chokepoint).
  await this.persistor.putResource({
    subject, jsonAd: r.toJsonAd(), snapshot: r.exportLoroSnapshot()
  });

  // 4. One notification.
  this.notifyOne(subject, r, change.source);
}
```

### Step 3.3 — migrate WS handlers one Tag at a time *(2 days)*

Order: `Tag.UPDATE` (pending-GET branch first, then sub-push) →
`Tag.SYNC_PUSH` → `Tag.QUERY_UPDATE`. Each conversion deletes
that branch's bespoke `addResources` + `persistToClientDb` + echo
detection.

After each conversion, the relevant integration test
(`upload-roundtrip`, `upload-offline-reconnect`) and a focused
e2e test (`perf-budgets`, `perf-sidebar-reload`) must pass.

### Step 3.4 — migrate the local-commit path *(0.5 day)*

`Resource.pushCommits`'s pre-POST and post-POST `addResources`
calls become `applyIncoming({source: 'local-pre-push'})` and
`applyIncoming({source: 'local-acked', commitId})`.

### Step 3.5 — migrate HTTP fetch *(0.5 day)*

`Store.fetchResourceFromServer` and `Client.fetchResourceHTTP`
funnel through `applyIncoming({source: 'http-fetch'})` instead
of `addResources`.

### Step 3.6 — delete the old `addResource` *(0.5 day)*

After all migrations, the public `addResource`/`addResources`
become deprecated wrappers that internally call `applyIncoming`
with a default source. Remove from the public export. Done.

**Cumulative effort**: ~5 days. Risk: high — this is the
structural change. Mitigation: each Tag migration is reversible
and independently testable; perf-trace + perf-budgets gives
quantitative regression checks.

---

## Phase 4 — `DriveSync` orchestrator (S6)

**Goal**: reconnect runs through one state machine; dirty drain
and VV sync are sub-steps, not parallel ops.

**Definition of done**: `Store.driveSyncInProgress` and
`Store.dirtySyncInProgress` are gone; one `driveSync.state`
enum exposes status.

### Step 4.1 — define the state machine *(0.5 day)*

```ts
type DriveSyncState =
  | { kind: 'disconnected' }
  | { kind: 'authenticating'; since: number }
  | { kind: 'draining-outbox'; remaining: number }
  | { kind: 'sending-vv' }
  | { kind: 'applying-diff'; pending: number }
  | { kind: 'connected'; lastSyncAt: number };

class DriveSync {
  state: DriveSyncState;
  // Re-entrance: returns existing connect-promise if mid-flight.
  connect(): Promise<void>;
  disconnect(): void;
  // Internal — driven by WS event loop.
  onAuthOk(): void;
  onSyncOk(): void;
  onSyncDiff(diff: SyncDiff): void;
}
```

### Step 4.2 — replace `WSClient.handleOpen` with a state-machine call *(1 day)*

```ts
private handleOpen() {
  this.driveSync.connect();  // owns auth + outbox.drain + vv-sync
}
```

### Step 4.3 — delete `syncDirtyResources` and `startVVSync` as public methods *(0.5 day)*

They become internal methods of `DriveSync`. The status display
reads `state.kind` instead of two booleans.

**Cumulative effort**: ~2 days. Risk: low (Phase 2 + Phase 3
already removed the data-layer races). Mostly cosmetic
restructuring with one observable benefit: the
"reconnect-flap fires drain twice" class of bug is structurally
impossible.

---

## Phase 5 — `useSyncExternalStore` hooks (S3)

**Goal**: one subscription per `useResource` call; identity
stable until the resource genuinely changes.

**Definition of done**: `proxyResource` is deleted; `data-browser`'s
hot paths use the new hooks; `React.memo` works as expected.

### Step 5.1 — implement `useResourceV2` behind a flag *(1 day)*

```ts
// react/src/useResourceV2.ts
export function useResourceV2<T>(subject: string): Resource<T> {
  const store = useStore();
  return useSyncExternalStore(
    cb => store.subscribe(subject, cb),
    () => store.getSnapshot(subject),
  );
}
```

`store.getSnapshot(subject)` returns the same `Resource`
instance until something *actually* changes (commit applied,
property set). The cache mutates a wrapper instance index when
state changes, similar to React's reducer pattern.

Behind a `ATOMIC_USE_RESOURCE_V2` env flag so apps can opt in
incrementally.

### Step 5.2 — port hot paths in data-browser *(2 days)*

In order of cumulative re-render volume:
1. `SidebarTree` + `ResourceSideBar` (Sidebar's
   per-row useResource calls — tens of subscribers).
2. `TableEditor.Cell` (one per cell, hundreds for a wide
   table).
3. `EditableTitle` (one per page).
4. Everything else.

For each, run `perf-budgets.spec.ts` before/after and compare
the `store.ResourceUpdated` event count and total render time.

### Step 5.3 — port `useValue` / `useTitle` to per-property *(1 day)*

```ts
useValue(subject, prop)   // subscribes only when prop changes
useTitle(subject)         // subscribes to (name|shortname|filename)
```

The cache exposes a per-property `getSnapshot(subject, prop)`.

### Step 5.4 — delete `proxyResource` *(0.5 day)*

When no caller depends on per-notify identity changes, delete
the function and its three call sites in `useResource`.

**Cumulative effort**: ~4.5 days. Risk: high in scope (touches
every component that reads a Resource), low in any individual
component (mechanical pattern). Mitigation: feature flag,
hot-path-first ordering, perf trace gates.

---

## Phase 6 — `SharedWorker` for OPFS (S5)

**Goal**: replace the leader-election dance with the browser's
built-in `SharedWorker` lifecycle.

**Definition of done**: `client-db.ts`'s `Role`,
`LEADERSHIP_TIMEOUT_MS`, `becomeLeader`, `handleBroadcast`,
`leadershipGained`, `leaderObserved` are all deleted.

### Step 6.1 — convert `client-db.worker.ts` to a SharedWorker *(1 day)*

Add `self.onconnect = (ev) => bindPort(ev.ports[0])`. Each
connecting tab gets its own `MessagePort`; the worker's internal
queue serialises across all of them.

### Step 6.2 — replace `ClientDbWorker` boot path *(0.5 day)*

```ts
const sw = new SharedWorker(workerUrl, { type: 'module' });
const port = sw.port;
port.start();
// All RPCs use `port.postMessage` + `port.onmessage`.
```

### Step 6.3 — delete the leader-election state *(0.5 day)*

Remove `Role`, `LEADER_LOCK`, `BroadcastChannel` setup,
`leadershipGained` / `leaderObserved` promises,
`handleBroadcast` switch, `LEADERSHIP_TIMEOUT_MS`.

### Step 6.4 — Safari + extension fallback *(0.5 day)*

If `typeof SharedWorker === 'undefined'` (some extension
contexts, certain iframes), fall back to a plain `Worker`
plus an OPFS `requestAccessHandle` lock. No leader election —
just one Worker per tab, OPFS handles contention.

**Cumulative effort**: ~2.5 days. Risk: medium — touches the
boot path that every test exercises. Mitigation: cross-browser
smoke test in the e2e suite.

---

## Cumulative timeline

| Phase | Effort | Cumulative |
|---|---|---|
| 1. OpfsPersistor | 2.5 d | 2.5 d |
| 2. LocalOutbox | 3.5 d | 6 d |
| 3. applyIncoming | 5 d | 11 d |
| 4. DriveSync | 2 d | 13 d |
| 5. useSyncExternalStore | 4.5 d | 17.5 d |
| 6. SharedWorker | 2.5 d | 20 d |

**~4 weeks of focused work** to reach the unified data layer.
Phases 1–3 (~11 days) deliver the structural fixes; phases 4–6
are quality-of-life on top.

---

## What gates each phase

Each phase commits behind a green run of:

1. `pnpm test` (lib unit tests)
2. `pnpm test:integration` (offline + upload roundtrip)
3. `cd browser/e2e && pnpm test-e2e perf-budgets.spec.ts perf-sidebar-reload.spec.ts` (perf probes)
4. `ATOMIC_TEST_CPU_THROTTLE=6 pnpm test-e2e <flake-set>` (throttled flaky tests must not regress)
5. Dagger CI (the full e2e under real container conditions)

If any phase regresses #4 or #5 from the post-Phase-0 baseline,
revert and revisit. The perf trace gives quantitative numbers
for #3 — the rule of thumb is "no individual span gets slower
by more than 20% without a justifying simplification".

---

## What deliberately is NOT in this plan

- **Splitting `Store` into composable parts.** That's a major-
  version bump and changes the public API of `@tomic/lib`. The
  plan above leaves `Store` as the public face; internally it
  delegates to `ResourceCache`, `LocalOutbox`, `DriveSync`,
  `OpfsPersistor`. Users see the same surface.
- **Switching from sled to a different backend.** Out of scope
  for the data layer.
- **Server-side TOCTOU fix in `commit.rs`.** Mentioned in
  earlier perf-plan; not data-layer architecture.
- **The B1/B3 deferred items in PERFORMANCE_PLAN.md.** They
  largely fold into Phase 5 once `useSyncExternalStore` lands.

---

## Quickest wins if budget is tight

If you can only do **one** thing: **Phase 1 (OpfsPersistor)**.
Smallest blast radius, fixes the JSON-AD/snapshot split-write,
mostly mechanical. ~2.5 days.

If you can do **three**: 1, 2, 3 — that closes the structural
flake source. ~11 days.

If you can do **everything**: 4 weeks for a much smaller, much
more debuggable data layer.
