# Sign at sync boundary, not at save boundary

> **Status:** Proposal (2026-05-29). Browser-side simplification. Supersedes
> [`unified-data-layer.md`](./unified-data-layer.md) § S4a's per-step plan with
> a smaller, less invasive sequence.
>
> **Depends on:**
> [`commit-retention-and-state-certificates.md`](./commit-retention-and-state-certificates.md)
> Phase 1 (split `validate_loro_causality` into idempotent-replay vs
> LWW-loss) — without it, drain replays of an already-applied commit are
> wrongly rejected and the outbox strands.

## Thesis

A `Commit` may carry arbitrarily many local edits.
[`commit-retention-and-state-certificates.md`](./commit-retention-and-state-certificates.md)
line 307–309 already specifies this:

> Commit granularity is free to vary — one property edit, a save boundary, a
> batch of local edits, a sync boundary, a periodic checkpoint, a destroy.
> **One commit is not assumed to equal one UI action or one Loro op.**

The browser today violates that explicitly. Every debounced `useValue`
save (default 100 ms) signs **one Commit per debounced keystroke**. 26
characters of typing produce 26 signed commits, 26 POSTs, 26 echoes back
through `applyIncoming`, 26 outbox writes, 26 React renders for the same
property.

Move the sign boundary from `Resource.save()` to the outbox drain. Most of
the S4a deletion target list falls away as a side effect.

## What changes

### Today

```
keystroke → useValue debounce (~100 ms)
         → resource.save()
            → signChanges  (sign Commit N, builds previousCommit chain)
            → push to _pendingCommits
            → upsertCommit into outbox  (Phase 1 attempt: per-keystroke)
         → pushCommits
            → _drainPendingCommits
               → POST commit N
               → ack from outbox
               → setLastCommitValue
               → applyToStore('local-acked')
               → maybe push blobs
               → maybe subscribe / save batched children
```

26 sign + POST + echo round-trips for "abcdefghijklmnopqrstuvwxyz".

### Proposed

```
keystroke → loroSetProperty (already does this; no save() call)
         → mark subject dirty in store.outbox  (one Set add)

[separately, on debounce / blur / sync timer / explicit save / reconnect]
drainPass()
   for each subject in store.outbox:
      → export Loro delta from resource._loroVersionAtLastSave
      → if no new ops: clear dirty bit, continue
      → sign ONE Commit with the batched loroUpdate
      → POST
      → on success: advance resource._loroVersionAtLastSave; clear dirty bit
      → on failure: leave dirty bit; retry next drain
```

26 keystrokes → 1 sign + 1 POST + 1 echo.

## What dies

From [`unified-data-layer.md` § S4a's deletion target](./unified-data-layer.md#s4a-resource-save-decomposition)
(lines 334-338) — all of it disappears under this plan:

- `Resource._pendingCommits` — outbox holds the only dirty signal; no list of
  signed commits accumulates on the resource.
- `Resource.setPendingCommits`, `hasPendingCommits` — no commits to set or
  query.
- `Resource._lastLocalSignature` — no previousCommit chain across multiple
  signed-but-unposted commits, because there's never more than one
  signed-but-unposted commit per resource.
- `Resource.pushCommits` — `Store.syncDirtyResources()` drains the outbox
  directly.
- `Resource._drainPendingCommits` — gone; its post-ack work moves into the
  outbox drain callback.
- `Resource.saveOffline` — outbox dirty set is already durable (one
  localStorage write per drain, not per keystroke); offline = "didn't drain
  yet."
- `Resource.applyPendingCommitsLocally` — there's no list of signed commits
  to apply locally; the Loro doc is the local state, and it's already
  persisted to OPFS by existing paths.
- `CommitBuilder` (browser side) — shrinks to a one-shot helper invoked by
  the drain; the mutable-builder-on-Resource pattern goes away.

The outbox shape simplifies:

```ts
// today
interface OutboxEntry {
  subject: string;
  commits: Commit[];        // ordered, includes signature chain
  enqueuedAt: number;
  lastAttemptAt?: number;
  lastAttemptError?: string;
}

// proposed
interface OutboxEntry {
  subject: string;
  dirtyAt: number;          // when first marked dirty since last drain
  lastAttemptAt?: number;
  lastAttemptError?: string;
}
```

No commits stored in the client. The Loro delta gets exported fresh at drain
time, so what's signed is exactly current state minus
`_loroVersionAtLastSave` — no stale-batch problem and no risk of signing
against a baseline that subsequent retries already covered.

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
doesn't *have to* change for sign-at-drain to ship. But moving every
property edit through one canonical signed path makes a handful of
existing frames redundant or strictly informational. Each is independent;
ship them when convenient.

### Required to land cleanly alongside sign-at-drain

None. The plan ships with the protocol unchanged.

### Enabled, ship when ready

| Surface | Status today | After |
| --- | --- | --- |
| `UPDATE (0x11)` `HAS_COMMIT_ID` flag (0x02) | Set on subscription pushes; absent on GET responses | Always set — every server-known state was produced by a Commit, so the commit id is always known. Drops the conditional length-prefix branch in the parser. |
| `UPDATE (0x11)` `PUSH` flag (0x04) | Distinguishes subscription broadcast from GET response | Redundant with `request_id` matching (`request_id == 0` ⇒ unsolicited). Drop. |
| `SYNC_OK (0x31)` | "Drives match, nothing to do" | Collapse into `SYNC_DIFF (0x32)` with empty `pull/push/remove`. Already valid; just stop emitting `SYNC_OK`. |
| `0x36` reserved slot | Held since QUERY_UPDATE retirement | Reclaim. |
| `SUBSCRIBE` / `SUBSCRIBE_QUERY` text frames | Two text-frame registrars + `SUB (0x20)` binary | Fold into one binary `SUBSCRIBE (0x20)` with a `{scope: drive|subject|filter, target}` body, per [`unify-subscription-primitives.md`](./unify-subscription-primitives.md). |
| `COMMIT_OK (0x14)` body | Full server commit JSON | Shrink to `[request_id] [commit_id_string]`. Caller only needs the id to populate `lastCommit`; the rest of the commit object is redundant with what the client signed. |

### Frame-count math (honest)

Today's surface in `docs/src/websockets.md`: 14 binary frames in active
use + 4 legacy text frames (`SUBSCRIBE`, `SUBSCRIBE_QUERY`,
`LORO_SYNC_SUBSCRIBE`/`UNSUBSCRIBE`, `LORO_SYNC_UPDATE`,
`LORO_EPHEMERAL_UPDATE`) + 3 `UPDATE` flag bits.

After this plan + the cleanups above:

| Surface | Today | After |
| --- | --- | --- |
| Binary frames | 14 | 13 (–`SYNC_OK`) |
| Text frames | 5 | 2 (`LORO_SYNC_UPDATE` and `LORO_EPHEMERAL_UPDATE` stay — see non-goal below; the SUBSCRIBE text frames move to binary unified `SUBSCRIBE`) |
| `UPDATE` flags | 3 | 1 (just `SNAPSHOT`) |

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
2. **Browser: dirty bit in outbox.** Add `Outbox.markDirty(subject)`
   alongside the existing `upsertCommit`. `Resource.save()` keeps signing
   for now but also calls `markDirty`. Drain prefers dirty-set entries when
   the legacy `commits[]` list is empty.
3. **Browser: defer signing.** `Resource.save()` stops signing
   immediately. Instead it calls `markDirty` and schedules a drain. Drain
   exports the current Loro delta, signs once, POSTs, advances
   `_loroVersionAtLastSave` on ack. Genesis-create path retains a sync sign.
4. **Browser: delete the legacy list-of-commits path.** Remove
   `_pendingCommits`, `_lastLocalSignature`, `pushCommits`,
   `_drainPendingCommits`, `saveOffline`, `applyPendingCommitsLocally`,
   `setPendingCommits`, `hasPendingCommits`. Outbox `OutboxEntry` shrinks to
   `{subject, dirtyAt, lastAttemptAt?, lastAttemptError?}`. `CommitBuilder`
   shrinks to a one-shot helper.
5. **Browser: drain cadence.** Trigger drains on: (a) the post-save
   debounce window expires (today's 100 ms), (b) blur on the focused
   editable, (c) periodic timer when there's pending dirty state, (d) WS
   reconnect, (e) explicit `Store.save()` from page-unload handlers. The
   drain is idempotent; concurrent triggers share the in-flight promise.

After step 5, the per-keystroke localStorage write that broke the earlier
S4a Phase 1 attempt is gone (the dirty set persists once per drain, not per
sign), and `LocalOutbox.persist` no longer needs microtask debouncing for
correctness — though the current debounced implementation stays as a small
perf win.

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
  doc.subscribePreCommit((e) => {
    const json = doc.exportJsonInIdSpan(e.changeMeta);
    e.modifier.setMessage(JSON.stringify({
      agent: store.getAgent().subject,
      sig:   signAgentKey(canonicalize(json)),  // Ed25519 over canonical change bytes
    }));
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

1. **Drain cadence on the wire.** Should drains be unconditional ("send
   what's dirty whenever") or VV-negotiated ("server tells client what it's
   missing")? `unified-sync.md`'s `DriveSyncState` exchange is the second
   model; this plan currently assumes the first.
2. **Drain partial failures.** If a drain has 10 dirty subjects and POST 5
   succeeds before POST 6 fails, do we retain dirty for {6..10} only or
   re-drain all 10? Re-drain all 10 is safe under idempotency Phase 1.
3. **Genesis flow under high-audit profile.** A new resource's first
   `Change` is the one that derives the DID. Its `message` must be settled
   before the signature is computed. Doable via `subscribePreCommit` but
   needs care (the message must not include the resulting commit signature,
   which is circular).
4. **`writeDatatypeTags` system commits.** Today these run inside
   `signChanges` and mutate Loro. Under drain-time signing they happen
   during the drain export. Either pre-export (stamp before exporting the
   delta) or accept that they ride on the next drain.
5. **`logPendingCommit` for the Sync page UI.** Today the UI shows
   "pending → sent → failed" transitions per commit. Under drain-time
   signing there's no "pending" state for ~99% of typing — the commit
   doesn't exist until the drain. UI surfaces `outbox` dirty set + drain
   in-flight state instead.

## Related plans

| Doc | Relationship |
| --- | --- |
| [`commit-retention-and-state-certificates.md`](./commit-retention-and-state-certificates.md) | Phase 1 (idempotency) is the prereq. Defines that batched Commits are allowed (line 307-309). High-audit profile is an extension of that doc's `retention=full` Loro-aware variant. |
| [`unified-data-layer.md`](./unified-data-layer.md) | Supersedes § S4a's step-by-step plan with this smaller sequence. § S4 (LocalOutbox as the durable queue) stays the right outbox abstraction, just with a simpler entry shape. |
| [`unified-sync.md`](./unified-sync.md) | `DriveSyncState` VV exchange complements drain-time batching: it's the "what's new from peer to peer" side. |
| [`authorization-sync.md`](./authorization-sync.md) | High-audit profile's per-change signatures interlock with cross-agent grant-chain verification. Low-bw profile defers grant-chain checks to the batched Commit boundary. |
| [`sync.md`](./sync.md) | `COMMIT` frame is unchanged; this plan changes only *when* one is built, not the wire format. |
