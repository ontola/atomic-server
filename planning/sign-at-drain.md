# Sign at drain (one commit per save boundary)

> **Status:** Shipped uncommitted (2026-05-29). Real sign-at-drain
> landed in working tree — local Loro ops mark the subject dirty in the
> outbox; the store-level drain exports the accumulated Loro delta,
> signs ONE commit per dirty subject, POSTs. 26 keystrokes ≠ 26 signed
> commits — at most one batched commit per drain pass per subject.
>
> The earlier "option 2" (keep eager sign, async POST) shipped as steps
> 1-3 (commits `a909ad32`..`1e9e2f08`); the working-tree changes
> deliver the original "option 1" — see "Why we returned to option 1"
> below.
>
> Supersedes [`unified-data-layer.md`](./unified-data-layer.md) § S4a's
> per-step plan with a smaller, less invasive sequence.
>
> **Depends on:**
> [`commit-retention-and-state-certificates.md`](./commit-retention-and-state-certificates.md)
> Phase 1 (split `validate_loro_causality` into idempotent-replay vs
> LWW-loss) — without it, drain replays of an already-applied commit are
> wrongly rejected and the outbox strands.

## Thesis

The browser used to make `Resource.save()` synchronously wait for the
server to acknowledge each commit:

```
keystroke → debounce → save() → signChanges → POST → wait for ack → return
                                  ~10 ms        RTT (30–100 ms)
```

That puts a server round-trip in the user-visible path of every typed
character. Two fixes:

1. **Single signed queue.** The outbox owns the signed-but-not-acked
   commits durably across reload, instead of a parallel
   `Resource._pendingCommits` shadow. Per-keystroke localStorage cost is
   amortised by the existing `LocalOutbox.persist` microtask debounce.
2. **Asynchronous POST.** `save()` returns once the commit is signed and
   enqueued in the outbox. The POST happens in the background. Callers
   that need the server acknowledgement (rare — typically the test
   harness or page-unload handlers) await `Store.syncDirtyResources()`
   explicitly.

```
keystroke → debounce → save() → signChanges → enqueue (outbox) → return
                                                 ~10 ms total
                                                 ↓ (background)
                                       drain → POST → ack → applyToStore('local-acked')
```

Per-keystroke `save()` latency drops from `sign + RTT` to `sign`. The
wire format and trust model are unchanged.

## Why we returned to option 1 (real sign-at-drain)

Option 2 (eager sign per `save()`, async POST) shipped in steps 1-3 but
left two structural bugs unfixable inside its model:

1. **Stranded genesis commits on `pendingDirtyCount`.** Callers like
   `store.newResource` sign without an explicit follow-up `save()` —
   the signed commit sat in the outbox forever until some unrelated
   action triggered `syncDirtyResources`. `tables:35` / `table-refresh:23`
   reproduce this — the table-creation flow signs ~6 helper resources
   without follow-up saves, leaving `pendingDirtyCount > 0` forever.
2. **Mid-drain snapshot bug in `_drainPendingCommits`.** Concurrent
   `save()` calls during rapid typing landed their commits in the
   outbox AFTER the in-flight drain captured its snapshot; the second
   commit was acked-by-signature only if it was in the snapshot, so
   commits signed mid-drain stranded forever (`quick edit text typing`
   reproduce).

Both failures share the same shape: the outbox holds a list of
**signed envelopes** rather than a dirty bit, so consistency between
"signed-but-not-posted" and "signed-and-posted" depends on every
caller threading the right `signChanges` / `pushCommits` / `ack` calls.
In option 1, the outbox holds a **dirty bit** (plus an optional
pre-signed genesis envelope for DID derivation), the Loro doc is the
source of truth for what to sign, and the drain re-derives the delta
fresh each pass — no snapshot to strand, no signed envelope to lose.

The original concern that drove option 2 — that drain-time signing
would add RTT to the keystroke path — was misdiagnosed. The actual
fix is that `save()` returns AFTER marking dirty but BEFORE the drain
runs. The dirty bit is set synchronously, so `pendingDirtyCount > 0`
holds immediately and the test's "wait until 0" poll has something to
wait on. The drain itself is fire-and-forget; the user-visible
`save()` latency is `markDirty + scheduleDrain` (~microseconds).

## What changed in code

### Resource

- `_pendingCommits: Commit[]` — **deleted** (was already gone in
  step 1).
- `_lastLocalSignature: string | undefined` — **deleted** (step 1).
- `setPendingCommits` — **deleted** (step 1).
- `hasPendingCommits` — **kept** but delegates to
  `store.outbox.hasPending(subject)` (genesis OR dirty).
- `saveAsGenesis` — **deleted** (step 6, no callers).
- `errorRetries` field + the `previousCommit`-mismatch retry branch in
  `_saveInner` — **deleted** (step 2). Server's idempotent replay
  accept handles stale `previousCommit` transparently.
- `commitBuilder` backup/revert in `_saveInner` — **deleted** (step 2).
- `saveOffline` — under step 4 only materializes the pre-signed
  `signedGenesis` envelope (if present) for the offline audit log; no
  loop over signed commits since none are stored.
- `_drainPendingCommits` — **deleted** (step 4). The per-resource drain
  moved to `Store.drainOutboxSubject`.
- `pushCommits` / `inProgressPush` / `inProgressCommit` / `hasQueue` —
  **deleted** (step 4). Coalescing handled at the outbox level.
- `_saveInner` — **thinned** (step 4). Two branches: (a) caller called
  `markNextCommitAsGenesis()` → sync sign for DID derivation +
  `outbox.setGenesisCommit`; (b) otherwise → `outbox.markDirty`. Both
  fire-and-forget `syncDirtyResources` and return immediately.
- `exportLoroDelta(isFirstCommit)` — promoted to public (was private)
  so the store-level drain can export without going through
  `signChanges`. Internal check guards against the empty-but-non-zero
  delta that Loro's `setRecordTimestamp(true)` emits on every
  `doc.commit()` (compares oplogVersion to the cursor before committing).
- `markLoroSaved()` — **added** public. Advances
  `_loroVersionAtLastSave` to current `oplogVersion`. Called by the
  drain after each successful POST.
- `getLastCommitForChain()` — **added** public. Returns `_lastCommit`
  (set by `setLastCommitValue` on every ack) with cache fallback. Used
  by the drain to chain incremental commits.
- Loro local-updates subscriber — **added** in `getLoroDoc()`. Every
  local op marks the subject dirty via `outbox.markDirty`. Skips
  `did:ad:commit:*` (commit-detail resources, materialized locally only)
  and externally-owned HTTP subjects (`isOwnedSubject` filter).

### Store

- `outbox` constructor callback — fires `emitSyncStatus` AND
  `scheduleOutboxDrain` (macrotask-debounced `setTimeout(0)` auto-drain).
  Microtask debouncing splits one logical save across multiple drain
  passes because `await` yields to the microtask queue.
- `drainOutboxSubject(subject)` — **added** as the per-subject drain.
  Step 1 POSTs `signedGenesis` if present + runs the wasNew pipeline
  (subscribe, `saveBatchForParent`). Step 2 exports the accumulated
  Loro delta, signs ONE commit chained on `getLastCommitForChain()`,
  POSTs, advances `markLoroSaved()`.
- `syncDirtyResources` — drain context updated to pass `drainSubject`
  instead of `postEntry`.
- `postOutboxEntry` — **deleted** (step 4). The new
  `drainOutboxSubject` replaces it.
- `newResource` DID path — signs the genesis sync (subject derive),
  stashes the envelope via `outbox.setGenesisCommit(subject, commit)`,
  marks the subject dirty. The drain POSTs the envelope.
- `isOwnedSubject(subject)` — **added** public. True for DIDs (except
  `did:ad:commit:*`) and HTTP subjects matching `serverUrl`'s origin.
  Filter prevents the Loro subscriber from marking external resources
  dirty (atomicdata.dev classes, etc.), which would produce server
  rejections like "Subject of commit should be sent to other domain."

### LocalOutbox

- `OutboxEntry.commits: Commit[]` — **deleted**. Loro doc is the source
  of truth for what to sign at drain time.
- `OutboxEntry.signedGenesis?: Commit` — **added**. Holds the
  pre-signed genesis envelope for DID-derived subjects so the drain
  POSTs it verbatim (the signature _is_ the subject).
- `upsertCommit` / `setEntry` / `acknowledgeCommits` — **deleted**.
- `markDirty(subject)` / `clearDirty(subject)` — **added**. Idempotent
  markers; `clearDirty` keeps the entry if `signedGenesis` is still
  pending.
- `setGenesisCommit(subject, commit)` / `clearGenesis(subject)` —
  **added**. Genesis lifecycle.
- `doDrain` — drain context calls `drainSubject(subject)` per entry
  instead of `postEntry(entry)`; per-subject success/failure mapping
  unchanged.

### Tests

- `commit.test.ts` — 4 callsites that asserted on `save()`'s return
  value or expected the POST to land synchronously now
  `await store.syncDirtyResources()` after `save()` and read the
  committed signature from `Resource.appliedCommitSignatures`.
- `local-outbox.test.ts` — rewritten for the new shape: `markDirty`,
  `setGenesisCommit` / `clearGenesis`, drain-context `drainSubject`
  instead of `postEntry`.

## What this does NOT change

- The `Commit` wire format. `lib/src/commit.ts`,
  `server/src/handlers/commit.rs`, the `/commit` endpoint, the `COMMIT` WS
  frame — all unchanged.
- The trust model. Agents sign; server verifies. Each batched Commit is
  signed by exactly one agent (the local agent at drain time) and authorizes
  exactly one Loro state transition for one subject. Same as today, just
  with bigger batches.
- The DID genesis path. Resource creation still requires a synchronous sign
  to derive the `did:ad:<sig>` subject. Genesis commits are by definition
  one-edit commits and don't batch — so the genesis path keeps a sync
  sign-then-POST. Everything else drains async.
- `previousCommit`. Still set (server expects it on non-genesis commits);
  the browser reads `resource.get(lastCommit)` at drain time, same as today.
- Loro semantics. `_loroVersionAtLastSave` keeps the same role: the export
  cursor for "what hasn't been signed yet."

## Protocol cleanups this enables

The wire format defined in [`docs/src/websockets.md`](../docs/src/websockets.md)
doesn't _have to_ change for sign-at-drain to ship. But moving every
property edit through one canonical signed path makes a handful of
existing frames redundant or strictly informational. Each is independent;
ship them when convenient.

### Required to land cleanly alongside sign-at-drain

None. The plan ships with the protocol unchanged.

### Enabled, ship when ready

| Surface                                     | Status today                                           | After                                                                                                                                                                            |
| ------------------------------------------- | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `UPDATE (0x11)` `HAS_COMMIT_ID` flag (0x02) | Set on subscription pushes; absent on GET responses    | Always set — every server-known state was produced by a Commit, so the commit id is always known. Drops the conditional length-prefix branch in the parser.                      |
| `UPDATE (0x11)` `PUSH` flag (0x04)          | Distinguishes subscription broadcast from GET response | Redundant with `request_id` matching (`request_id == 0` ⇒ unsolicited). Drop.                                                                                                    |
| `SYNC_OK (0x31)`                            | "Drives match, nothing to do"                          | Collapse into `SYNC_DIFF (0x32)` with empty `pull/push/remove`. Already valid; just stop emitting `SYNC_OK`.                                                                     |
| `0x36` reserved slot                        | Held since QUERY_UPDATE retirement                     | Reclaim.                                                                                                                                                                         |
| `SUBSCRIBE` / `SUBSCRIBE_QUERY` text frames | Two text-frame registrars + `SUB (0x20)` binary        | Fold into one binary `SUBSCRIBE (0x20)` with a `{scope: drive \| subject \| filter, target}` body, per [`unify-subscription-primitives.md`](./unify-subscription-primitives.md). |
| `COMMIT_OK (0x14)` body                     | Full server commit JSON                                | Shrink to `[request_id] [commit_id_string]`. Caller only needs the id to populate `lastCommit`; the rest of the commit object is redundant with what the client signed.          |

### Frame-count math (honest)

Today's surface in `docs/src/websockets.md`: 14 binary frames in active
use + 4 legacy text frames (`SUBSCRIBE`, `SUBSCRIBE_QUERY`,
`LORO_SYNC_SUBSCRIBE`/`UNSUBSCRIBE`, `LORO_SYNC_UPDATE`,
`LORO_EPHEMERAL_UPDATE`) + 3 `UPDATE` flag bits.

After this plan + the cleanups above:

| Surface        | Today | After                                                                                                                                      |
| -------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Binary frames  | 14    | 13 (–`SYNC_OK`)                                                                                                                            |
| Text frames    | 5     | 2 (`LORO_SYNC_UPDATE` and `LORO_EPHEMERAL_UPDATE` stay — see non-goal below; the SUBSCRIBE text frames move to binary unified `SUBSCRIBE`) |
| `UPDATE` flags | 3     | 1 (just `SNAPSHOT`)                                                                                                                        |

Real cleanup, smaller than first glance suggested.

## Non-goals

These look adjacent but are out of scope.

### Replacing `LORO_SYNC_*` for collaborative body editing

`LORO_SYNC_SUBSCRIBE` / `LORO_SYNC_UNSUBSCRIBE` / `LORO_SYNC_UPDATE`
deliver per-Loro-op deltas for **rich-text body editing** (TipTap /
ProseMirror over Loro, in
`browser/data-browser/src/chunks/RTE/useLoroSync.ts`). Each local op is
broadcast immediately on `doc.subscribeLocalUpdates` — no debounce, no
signature, no Commit envelope. That's the speed.

Sign-at-drain does **not** replace this path. Even at a 50 ms drain
window, the round-trip cost (drain wait + sign + POST + server apply +
broadcast + import) lands near 150 ms — borderline for "feels live"
collaborative typing. At more realistic 200 ms drains it crosses
into noticeably laggy.

The honest trust model for `LORO_SYNC_*`: server checks `write` on the
subject at `LORO_SYNC_SUBSCRIBE` time and trusts the subscribed peers
not to lie for the duration of the subscription. Server does not
persist `LORO_SYNC_UPDATE` ops — they live in subscribers' in-memory
docs until a follow-up signed `COMMIT` writes the canonical state.

This survives sign-at-drain unchanged. It is a deliberate latency
choice, not redundant duplication.

Proper resolutions, if the trust window proves too loose, live in a
separate plan: either per-Change signatures (`Change.message` carrying
agent + sig — the high-audit profile below, but applied to every op
during a live session), or session keys negotiated at subscribe time
that authenticate ops within the session. Neither is in scope here.

### Replacing `LORO_EPHEMERAL_UPDATE` for cursors and presence

Cursor positions and presence indicators ride on Loro's
`CursorEphemeralStore` with a 30 s TTL. Per-keystroke delivery is
required (a cursor that lags 200 ms is a worse experience than no
cursor at all), the content is transient, and the trust model is
identical to `LORO_SYNC_*` above. Stays.

### Reworking `BLOB_REQUEST` / `BLOB_RESPONSE`

Content-addressed blob sync is orthogonal to commit signing. Unchanged.

### Removing `previousCommit`

Demoted to optional audit metadata per
[`commit-retention-and-state-certificates.md`](./commit-retention-and-state-certificates.md)
lines 196–200 and 420–429, but the field still rides on every Commit
today and that doesn't change here.

## Migration path

Each step is independently shippable; tests stay green after each.

1. **Server prereq:** ship `commit-retention-and-state-certificates.md`
   Phase 1 (split `validate_loro_causality` so idempotent replays accept).
   ✅ Already shipped. `lib/src/commit.rs` line 520 short-circuits on
   `!imported_new_ops` to accept idempotent replay; `CommitApplied.imported_new_ops`
   (line 711, 726) is computed from oplog VV before/after import; covered by
   `idempotent_commit_replay_is_accepted` (line 1996).
2. **Browser: outbox owns signed-but-not-acked commits.**
   ✅ Shipped (commits `a909ad32`, `f720a3ff`, `d2c815a6`, `da7f31d2`,
   `1f810f1a`, `1e9e2f08` — ~119 lines net deletion across
   `browser/lib/src/{resource,store}.ts`).
   - `_pendingCommits: Commit[]` + `_lastLocalSignature` deleted from
     `Resource`.
   - `signChanges` upserts straight to `store.outbox`.
   - `pushCommits` / `_drainPendingCommits` read commits from
     `outbox.getEntry(subject)` and ack by signature.
   - `saveOffline` merged with `applyPendingCommitsLocally` and shares
     `Store.materializeCommitLocally` for the per-commit synthesis.
   - `postOutboxEntry` delegates to `resource.save()` / `resource.pushCommits()`
     for loaded resources; cold-load reconnects POST directly with sig-ack.
   - Legacy `previousCommit` retry + `commitBuilder` backup/revert +
     `errorRetries` field deleted from `_saveInner` — server's idempotent
     replay accept (Phase 1, above) handles stale `previousCommit`
     transparently.
   - Dead public `Resource.saveAsGenesis` removed.
   - `hydrateResourceFromJson` clobber guard switched from `hasPendingCommits`
     (now outbox-backed and persistent across reload) to
     `hasUnsavedChanges()` (in-memory only) — fixes the offline-reload
     regression that step 1 introduced.
3. **Browser: `save()` returns after enqueue** ✅ _shipped (committed
   `a909ad32`..`1e9e2f08`)_. Eager-sign, async-POST. See option 2 in
   "Why we returned to option 1" — kept for context; step 4 supersedes
   the `_saveInner` contract here.
4. **Browser: real sign-at-drain.** ✅ _shipped (uncommitted)_. Loro
   doc is the source of truth for what to sign. The outbox holds a
   dirty bit + an optional pre-signed genesis envelope. The store-
   level drain (`drainOutboxSubject`) exports the accumulated Loro
   delta, signs ONE commit per dirty subject, POSTs. `pushCommits` /
   `_drainPendingCommits` / `OutboxEntry.commits[]` / `upsertCommit` /
   `acknowledgeCommits` / `inProgressPush` deleted. `_saveInner`
   collapses to: `markDirty` (or sync-sign genesis +
   `setGenesisCommit`) → fire-and-forget `syncDirtyResources` →
   return. See "What changed in code" above for the full diff.
5. **Browser: drain cadence** _(now load-bearing under step 4, partly
   shipped)_. Drains now fire on (a) explicit `save()`, (b) WS
   reconnect via `Store.syncDirtyResources`, (c) any `outbox.markDirty`
   call (`scheduleOutboxDrain` macrotask-debounced). Open follow-ups:
   blur on the focused editable, periodic timer, page-unload flush —
   nice-to-haves; the markDirty trigger covers the typing path.
6. **Browser: collapse the public API surface** _(planned)_. Make
   `save()` await durability, demote `markNextCommitAsGenesis` to
   package-private, keep `_new:` internal-only, and rewrite
   `commit.test.ts` against `newResource` → `set` → `save`. See
   "Step 6" above for the full target API and rationale.

## Step 6: collapse the public API surface

> **Status:** Partially shipped (2026-05-29, uncommitted). Done:
> `save()` now awaits durability and returns `SaveResult`
> (`'persisted' | 'offline' | 'noop'`), `differentAgent` param dropped;
> `signChanges` / `markNextCommitAsGenesis` / the Loro drain helpers
> marked `@internal` (callable across `lib`, excluded from the public
> surface); `commit.test.ts` rewritten against `newResource → set →
> save` with a new `test-store.ts` helper; `_new:` no longer appears in
> any test. **Update (2026-05-29, follow-up commit):**
> `markNextCommitAsGenesis` is now **deleted** — `signChanges` already
> auto-detects genesis for a `_new:`/`did:ad:` subject with no
> previousCommit, so the explicit "mark genesis" step was redundant;
> `newResource` and `uploadFiles` call `signChanges` directly.
> `signChanges` stays `@internal` (only callers are `store.newResource`,
> `store.uploadFiles`, `Resource._saveInner` — all in-package; no
> app/test code calls it, so it's off the public surface. A true
> `#private` isn't possible: `Store` calls it across the class
> boundary).
>
> **Update (2026-05-30) — Step 6 complete.** `#commitBuilder`,
> `#cache`, `#cacheDirty` are now runtime `#private`. `isSaving` was
> already gone. Typed setters ship via `.props` (`doc.props.name = …`,
> typed read+write; the bare `doc.name =` form is intentionally NOT
> offered — shortnames collide with `Resource` methods, and a wrapping
> Proxy would break the React-Compiler proxy-ref memoisation). The
> low-level `CommitBuilder` / `_new:` crypto tests moved out of
> `commit.test.ts` into `sign.test.ts`, so `commit.test.ts` is now a
> pure consumer-API canary (`newResource → set → save`, no scaffolding).

Sign-at-drain left the public API carrying scaffolding that only the
internals should know about. `commit.test.ts` is the canary: it still
reaches for `CommitBuilder`, `markNextCommitAsGenesis()`, raw `_new:`
subjects, and `await store.syncDirtyResources()` after every `save()`.
A consumer of `@tomic/lib` should never type any of those.

### Target API

`Store.newResource<C>(...)` already preserves generics, returning
`Promise<Resource<C>>`. No `Resource.new()` needed — the store is the
entry point.

```ts
// 1. Create. Returns a DID-signed Resource<Document>.
const doc = await store.newResource({
  isA: core.classes.Document,
  propVals: { [core.properties.name]: 'My Doc' },
  parent: driveSubject,
});

// 2. Mutate. Typed setters via the class parameter (optional).
doc.name = 'New name';

// 3. Persist. Resolves once durable. Returns status.
const status = await doc.save(); // 'persisted' | 'offline' | 'noop'
```

No `new Resource('_new:...')`, no `markNextCommitAsGenesis()`,
no `CommitBuilder`, no `syncDirtyResources()`, no `_new:` visible.

### `_new:` is internal, and that's correct — not a smell

`_new:<random>` is the placeholder a resource holds _between_
`getResourceLoading` and the genesis sign. The genesis commit's
signature **is** the subject (`did:ad:<sig>`), so the real subject
cannot exist until we sign. `_new:` bridges that gap. It is
load-bearing, not an anti-pattern.

The fix is not to remove `_new:` — it's to keep it **invisible**:

- `newResource` is the only thing that mints a `_new:` subject, and it
  resolves to the DID before returning — so callers never observe a
  `_new:` subject on a resource handed back to them.
- No public API accepts a caller-supplied `_new:` subject.

### What becomes private / deleted on the public surface

| Symbol                                                                                    | Today                                   | After                                                                          |
| ----------------------------------------------------------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------ |
| `Resource.markNextCommitAsGenesis()`                                                      | public; tests + `newResource` call it   | **Deleted.** Genesis is purely internal — only `store.newResource` decides it. |
| `Resource.signChanges(agent)`                                                             | public                                  | **Deleted from public.** Only `store.newResource` and the drain call it.       |
| `Resource.save(differentAgent?)`                                                          | public; tests pass args                 | **No-arg only.** Always uses store's agent.                                    |
| `CommitBuilder` (direct construction in app/test code)                                    | exported, used in tests                 | Stays exported for drain internals. No test or app code constructs one.        |
| `Store.syncDirtyResources()`                                                              | public; tests `await` it after `save()` | Stays public (WS reconnect). No consumer `await`s it.                          |
| `Resource.getLoroDoc()` / `exportLoroDelta` / `markLoroSavedAt` / `getLastCommitForChain` | public                                  | Keep public but `/** @internal */` JSDoc.                                      |
| `Resource._cache` / `_cacheDirty` / `commitBuilder` (public fields)                       | TS-visible                              | Move to `#private` or WeakMap.                                                 |
| `Resource._saveDepth` / `isSaving`                                                        | public getter + field                   | **Deleted.** No re-entrance needed — `save()` is the sole caller.              |

### `save()` contract change

Today `_saveInner`'s online branch is fire-and-forget:

```ts
this.store.outbox.markDirty(this.subject);
void this.store.syncDirtyResources().catch(() => undefined);
return undefined;
```

Tests must `await store.syncDirtyResources()` separately. Change it to
await the drain and return a status:

```ts
type SaveResult = 'persisted' | 'offline' | 'noop';

async save(): Promise<SaveResult> {
  if (!this.store) throw new Error('No store');
  if (!this.hasUnsavedChanges() && !this.store.outbox.hasPending(this.subject)) {
    return 'noop';
  }

  // Always persist locally first — crash between save() and POST
  // means the local snapshot survives.
  await this.saveOffline();

  this.store.outbox.markDirty(this.subject);

  if (!this.store.serverConnected) {
    return 'offline';
  }

  await this.store.syncDirtyResources();
  return 'persisted';
}
```

| Return        | Meaning                                                            |
| ------------- | ------------------------------------------------------------------ |
| `'persisted'` | Server acked. Resource durable on server.                          |
| `'offline'`   | Server unreachable. Saved to clientDb; drain retries on reconnect. |
| `'noop'`      | No unsaved changes. No commit produced.                            |

**Keystroke-path analysis.** Does `await`ing drain regress typing
latency? No. The sequence:

1. User types character → `useValue` starts 100 ms debounce
2. Character lands in Loro doc → `markDirty` (synchronous, μs)
3. 100 ms passes → `save()` fires → `await syncDirtyResources()`
4. Drain exports Loro delta → signs (~10 ms) → POST (RTT ~50-100 ms)
5. `save()` returns `'persisted'`
6. Debounce restarts on next keystroke — step 4 runs while user is
   thinking or between keystrokes. The 100 ms debounce is the latency
   floor, not the drain.

Under fire-and-forget (today), the drain runs in the background — same
wall-clock time, just no `await`. The `await` only matters for the
explicit save path (blur, Enter, programmatic), where the caller needs
"is it safe to leave?" before proceeding.

### `signChanges(agent)` becomes internal

`signChanges` is public today but only called from two places:

- `Store.newResource` — genesis path
- The drain (`drainOutboxSubject`) — incremental commit path

Both are internal. Make `signChanges` private.

**`uploadFiles` migration.** Currently calls:

```ts
resource.markNextCommitAsGenesis();
await resource.signChanges(this.getAgent()!);
await resource.save();
```

Rewrite as:

```ts
const resource = await store.newResource({
  isA: server.classes.File,
  parent,
  propVals: {
    [server.properties.filename]: name,
    [server.properties.filesize]: blob.size,
    ...
  },
});
await resource.save();
```

Same genesis-sign + POST flow, through the public API.

### Typed proxy setters — delivered via `.props` (2026-05-29)

> **Resolved.** Typed property setters already exist through the `props`
> accessor: `doc.props.name = 'New name'` resolves the shortname to its
> property URL and writes via `set(…, false)`. `QuickAccessKnownPropType`
> is a non-`readonly` mapped type, so this is typed for both read AND
> write — the write-side companion of the existing typed read accessor.
> Locked by a unit test (`supports typed property setters via the props
> proxy` in `commit.test.ts`).
>
> The bare `doc.name = …` form below (props flattened onto the Resource)
> is **intentionally NOT shipped**: a property shortname can collide with
> a `Resource` method/getter (`save`, `subject`, `parent`, `error`,
> `loading`, …), and the only collision-free runtime — wrapping the
> Resource in another Proxy — would break the React-Compiler proxy-ref
> memoisation that `useResource`/`props` depend on (see
> `react-compiler-resource-proxy-pitfall`). `.props` is the safe,
> namespaced home for typed field access. Keeping the original sketch
> below for context.

`doc.name = 'New name'` instead of `await resource.set(core.properties.name, val)`
via `Object.defineProperty` on the Resource:

```ts
private initProxyGetter(prop: string): void {
  Object.defineProperty(this, prop, {
    get: () => this.get(prop),
    set: (val) => { this.set(prop, val); },
    enumerable: true,
  });
}
```

The type mapping comes from a `ClassPropertyMap<C>`:

```ts
type ClassPropertyMap<C extends OptionalClass> = C extends typeof Document
  ? { name: string; description?: string; body?: JSONValue }
  : {};
```

**Optional and additive.** If no mapping exists for a class, consumers
use `resource.get/set` as today. Ship when ready; not blocking Step 6.

### `commit.test.ts` rewrite

The file splits into three groups:

**Group A — pure crypto tests** (lines 15–70, 412–483): Move to
`sign.test.ts`. Test `signAt`, `serializeDeterministically`, genesis
subject derivation, `did:ad:agent` preservation. Import internal
modules directly. Mark as `/** @internal */`.

**Group B — integration tests** (lines 72–410, 521–604): Rewrite using
`store.newResource()` + `save()`. Example:

```ts
it('chains commits on sequential saves', async ({ expect }) => {
  const { store } = await testStore();

  const doc = await store.newResource({
    isA: core.classes.Document,
    propVals: { [core.properties.name]: 'First Save' },
  });
  expect(doc.subject).toMatch(/^did:ad:/);
  await doc.save();

  const firstSubject = doc.subject;
  doc.name = 'Second Save';
  await doc.save();

  expect(doc.subject).toBe(firstSubject);
  expect(postCommitSpy).toHaveBeenCalledTimes(2);
  expect(postCommitSpy.mock.calls[1][0].previousCommit).toBe(
    postCommitSpy.mock.calls[0][0].signature,
  );
});
```

**Group C — offline-persistence regressions** (lines 606–1184): Use
`store.newResource()` but keep spy assertions on outbox/clientDb.
`markNextCommitAsGenesis` and `syncDirtyResources` calls disappear;
assertions against `dbState`, `putSpy`, outbox state stay.

### Migration

| Step | Change                                       | Impact                                                                                 |
| ---- | -------------------------------------------- | -------------------------------------------------------------------------------------- |
| 1    | `save()` awaits drain + returns `SaveResult` | Tests drop `syncDirtyResources`. No known callers pass `differentAgent` outside tests. |
| 2    | `signChanges` → private                      | Only `store.newResource` + drain break. Group A moves to `sign.test.ts`.               |
| 3    | `markNextCommitAsGenesis` → deleted          | Groups B + C stop calling it. `uploadFiles` uses `store.newResource`.                  |
| 4    | Typed proxy setters (optional)               | Additive. `doc.name = 'X'` works; `doc.get('name')` still works.                       |
| 5    | `commit.test.ts` rewrite                     | Group A → new file. Groups B + C → reference implementations.                          |

Steps 1-3 + 5 land in one PR (tests pass at every commit). Step 4 is
independent.

## Profile: high-audit vs low-bandwidth

The protocol stays the same; only what we put **inside** each Commit varies.

### High-audit profile

Targets: federated multi-server deployments, regulated audit, untrusted
relay nodes (browser via untrusted proxy, public mesh networks where
relays may be malicious).

- Each Loro `Change` inside the batched `loroUpdate` carries its agent
  attribution and a signature in `Change.message`.
- The message is set via `LoroDoc.subscribePreCommit`:

  ```ts
  doc.subscribePreCommit(e => {
    const json = doc.exportJsonInIdSpan(e.changeMeta);
    e.modifier.setMessage(
      JSON.stringify({
        agent: store.getAgent().subject,
        sig: signAgentKey(canonicalize(json)), // Ed25519 over canonical change bytes
      }),
    );
  });
  ```

- Verifiers iterate `getChangeAt({peer, counter}).message` on incoming
  Loro updates, recompute the canonical change bytes, verify per change.
- End-to-end verifiable through any relay. Tamper-evident.
- **Cost: ~150 bytes per Loro change.** A 26-char typing burst = ~4 KB on
  top of ~600 B of ops. Acceptable on internet links; prohibitive on LoRa
  or other constrained transports.

### Low-bandwidth profile

Targets: LoRa mesh, satellite, intermittent links, embedded nodes.

- `Change.message` is left empty (or carries only a peer→agent hint, ~20
  bytes — derived from the agent's pubkey hash as a stable peer ID).
- The batched Commit envelope carries the single signature for the whole
  loroUpdate batch — what we have today.
- Relays are **trusted** to forward unmodified. Either the relay is a
  trusted gateway (own infrastructure) or the application accepts the
  threat model.
- Cost per typing burst: ~150 B (single Commit envelope) + ~600 B Loro
  delta ≈ 750 B. Fits in a few LoRa packets.

### Negotiation

Each Atomic node advertises its supported profile(s) in its server info.
The sync protocol picks the strictest profile both sides support. A
profile change for an already-running drive is allowed but rebuilds the
oplog projection (the high-audit profile populates messages going forward;
prior-low-bw changes carry no per-change messages and are attributed at the
batched-Commit boundary only).

The Commit wire format does not change between profiles. Only
`Change.message` content varies.

## Open questions

1. **Drain cadence on the wire** _(unchanged from original)_. Should
   drains be unconditional ("send what's dirty whenever") or
   VV-negotiated ("server tells client what it's missing")?
   `unified-sync.md`'s `DriveSyncState` exchange is the second model;
   this plan currently assumes the first.
2. **Drain partial failures** _(unchanged from original)_. If a drain
   has 10 dirty subjects and POST 5 succeeds before POST 6 fails, do we
   retain dirty for {6..10} only or re-drain all 10? Re-drain all 10 is
   safe under idempotency Phase 1.
3. **Genesis flow under high-audit profile** _(unchanged from original;
   future)_. A new resource's first `Change` is the one that derives the
   DID. Its `message` must be settled before the signature is computed.
   Doable via `subscribePreCommit` but needs care (the message must not
   include the resulting commit signature, which is circular).

Questions 4 and 5 in the original draft (`writeDatatypeTags` placement
under drain-time signing; `logPendingCommit` having no pending state
under drain-time signing) were artefacts of the option 1 (sign-at-drain)
direction. Under option 2 (eager sign, async POST), both are non-issues:
`writeDatatypeTags` still runs inside the eager `signChanges`, and
`logPendingCommit` still fires per commit with "pending → sent → failed"
transitions intact.

## Related plans

| Doc                                                                                          | Relationship                                                                                                                                                                        |
| -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`commit-retention-and-state-certificates.md`](./commit-retention-and-state-certificates.md) | Phase 1 (idempotency) is the prereq. Defines that batched Commits are allowed (line 307-309). High-audit profile is an extension of that doc's `retention=full` Loro-aware variant. |
| [`unified-data-layer.md`](./unified-data-layer.md)                                           | Supersedes § S4a's step-by-step plan with this smaller sequence. § S4 (LocalOutbox as the durable queue) stays the right outbox abstraction, just with a simpler entry shape.       |
| [`unified-sync.md`](./unified-sync.md)                                                       | `DriveSyncState` VV exchange complements drain-time batching: it's the "what's new from peer to peer" side.                                                                         |
| [`authorization-sync.md`](./authorization-sync.md)                                           | High-audit profile's per-change signatures interlock with cross-agent grant-chain verification. Low-bw profile defers grant-chain checks to the batched Commit boundary.            |
| [`sync.md`](./sync.md)                                                                       | `COMMIT` frame is unchanged; this plan changes only _when_ one is built, not the wire format.                                                                                       |
