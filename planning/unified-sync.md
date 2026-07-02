# Unified sync — one API, WS or Iroh

> **Status:** Active plan. Rewritten 2026-07-02 after a full audit of
> `lib/src/sync/*`, `browser/lib/src/websockets.ts`, and
> `browser/lib/src/local-outbox.ts`. Supersedes the 2026-05 revision; builds on
> completed WS `COMMIT` work in [`sync.md`](./sync.md), sign-at-drain in
> [`sign-at-drain.md`](./sign-at-drain.md), and the runtime boundary in
> [`atomic-lib-runtime.md`](./atomic-lib-runtime.md).

## Goal

One **transport-agnostic sync API** in `atomic_lib` that apps use the same way whether
the carrier is **WebSocket** (browser ↔ server, mobile ↔ server) or **Iroh** (optional
device-to-device). Callers subscribe to **node events** (including live queries); they
do not call `peer_sync()` after scanning a QR code.

```text
Flutter / browser UI
        │
        ▼
  AtomicNode / SyncSession          ← single API
  · subscribe(Subscription)
  · mutate → dirty bit → Outbox
  · sync_drive (optional full reconcile)
        │
        ▼
  Local Db (offline-first cache)
        │
   ┌────┴────┐
   ▼         ▼
WsTransport  IrohTransport  ReticulumTransport  ← send/recv same v2 frames
```

Wire format: [`docs/src/websockets.md`](../docs/src/websockets.md) (Atomic peer
protocol). Encoding lives in `lib/src/sync/protocol.rs`; semantics in
`lib/src/sync/engine.rs`. Reticulum transport planning lives in
[`reticulum-sync.md`](./reticulum-sync.md).

## Current state (honest, 2026-07-02)

| Piece | Browser | Flutter native |
| --- | --- | --- |
| Local store | OPFS (`ClientDb`) | redb (`Db` in FRB) |
| Outbox shape | **Dirty-bit + sign-at-drain** (`local-outbox.ts`) — one signed commit per subject per drain pass; genesis envelope + offline `baseVersion` are the only stored artifacts; identity-scoped localStorage | Partial (`try_push_commit` when session open); no durable dirty queue, no backoff/blocked states |
| Persist commits | **WS `COMMIT` preferred**, HTTP `/commit` fallback (`Store.sendCommit`) ✅ | WS `COMMIT` when session open; else local only |
| Live updates | WS `SUB` → `UPDATE`/`DESTROY` (QUERY_UPDATE retired) | WS session + `pollDbEvent` |
| Bulk reconcile | `SYNC_VV` on reconnect, after outbox drain; `SYNC_DIFF.remove` applied ✅ | Iroh `SYNC`/`SYNC_PUSH` (peer.rs) |
| Multi-device | Same account on same server | WS-first; QR + Iroh bulk as fallback |

**Done since the 2026-05 revision:** sign-at-drain (dirty-bit outbox), drain backoff +
terminal/blocking error classification, identity-scoped outbox namespaces, browser
`SYNC_DIFF.remove` handling, Iroh live-loop `UPDATE`/`DESTROY` gated on identity +
admission (`admitted_for_drive`, commits `7ae8bcc1`/`839228f8`/`5c230ae3`), drive-scoped
commit fan-out isolation. **Done since this revision (2026-07-02 audit):** F2 —
admission drive resolved from local state, not payload (`989a8751`); F3 — live-mode
fallback dispatch uses the session agent, not a fresh Public (`34fd15c2`). Both
verified with regression tests proven against a reverted build, full lib suite
(229/229), and the full portal e2e suite (8/8) against a rebuilt managed node.

**Correction to a common assumption:** the outbox does **not** POST over HTTP as its
primary path. `drainOutboxSubject` builds a `/commit` endpoint URL, but that URL is a
routing key — `Store.sendCommit` sends the commit as a WS `COMMIT (0x13)` frame whenever
the socket is open, and only falls back to HTTP when it isn't. What *is* still HTTP-era
is the shape around that call — see [Outbox modernization](#outbox-modernization) below.

## Audit findings (2026-07-02)

These drive the work items in this revision. Ordered by severity.

### F1 — Layer 2 is an unsigned write path that races the outbox

The stated rule ("every persisted mutation signs a commit") holds only when the outbox
drain wins the reconnect race. `WSClient.handleOpen` drains before `SYNC_VV`, but if a
drain entry is inside its backoff window (or blocked), the VV exchange sees the client
ahead and `handleSyncDiff` pushes **raw Loro bytes**; `import_sync_push` persists them
with only a drive-level `check_write` — no signature verification, no commit record, no
`lastCommit` provenance. The same edit reaches the server signed or unsigned depending
on timing. The 2026-05 doc acknowledged this for deletes (`remove[]`); it is equally
true for writes.

**Direction:** Layer 2 must become *state transfer with commit provenance*, not a
parallel authority — see [State-first wire](#state-first-wire-commit-as-provenance-envelope).

### F2 — Admission gating trusts payload-controlled data ✅ Fixed 2026-07-02

`resolve_update` (ws_apply.rs) resolves the target drive from `DRIVE_PROP` on the
**merged** doc — i.e. partly from the incoming delta — falling back to the subject
itself. `admitted_for_drive` (peer.rs) then checks write rights against *that* drive,
and returns `true` when the drive resource doesn't exist locally (bootstrap carve-out,
`Err(_) => true`). Combined: a peer can assert a drive it controls (or a nonexistent
one) inside the delta and pass the gate for a subject it shouldn't touch. This is the
LWW sibling of the `IS_A: [Agent]` spoof closed in `7ae8bcc1`.

**Fixed (`989a8751`):** `resolve_update` now reads `drive_subject` from the *existing*
local resource, captured **before** the incoming delta is merged, for an existing
subject; a genuinely new subject resolves via `PARENT` (mirroring `commit.rs`'s
existing safety net) rather than trusting a directly-asserted `DRIVE_PROP`. Two
regression tests (`resolve_update_drive_spoof_tests`) proved the exploit against a
reverted build — the attacker's spoofed drive subject won over the resource's real
one — then proved the fix. The `admitted_for_drive` bootstrap carve-out itself
(`Err(_) => true`) is unchanged and is now safe, since `drive_subject` feeding it is
no longer attacker-controlled.

### F3 — Iroh live-mode fallback discards the authenticated agent ✅ Fixed 2026-07-02

`register_live_peer`'s read loop gates `UPDATE`/`DESTROY` with the session agent
(fixed), but any *other* tag falls through to `engine::handle_frame` with a fresh
`ForAgent::Public`. A `SYNC_PUSH` arriving in live mode is therefore admission-checked
as Public — which passes for a locally-missing drive under `OpenPolicy` (engine.rs
bootstrap case). Thread the session agent into the fallback dispatch.

**Fixed (`34fd15c2`):** `agent` is now a mutable binding owned by the read-loop task
(shadowing the `register_live_peer` parameter), used by both the `admitted_for_drive`
checks and the fallback dispatch to `engine::handle_frame`. Side benefit: a
late-arriving `AUTH` frame (allowed by the protocol at any point, not just during the
handshake) now actually strengthens the session's identity for the rest of the
connection, rather than being silently discarded by this path.

### F4 — Blob frames bypass both gates

`BLOB_REQUEST` serves any blob by 32-byte hash with no `check_read`
(hash-as-capability — acceptable, but should be a documented decision), and
`BLOB_RESPONSE` inserts unconditionally with no admission/quota check
(engine.rs). On a managed node, blob bytes don't count against the drive quota
the `AllowlistPolicy` enforces. Route blob writes through `admit_drive_write`
and account their size.

### F5 — Outbox failure classification is coupled to server error strings

`isTerminalCommitErrorMessage` / `isUnrecoverableCommitErrorMessage` pattern-match
exact server message text ("is_genesis: true, but…", "/properties/write right has been
found"). A server wording change silently converts terminal errors into infinite
backoff retries — the exact ingest-flood mode the classifiers exist to prevent. The
`ERROR` frame and HTTP `/commit` error body need a **structured error code**; the
outbox switches on the code, keeps string-matching only as legacy fallback.

### F6 — `apply_commit_json` is a loaded footgun in a shared module

It applies commits with `validate_rights: false`, no timestamp and no previous-commit
validation. Correct for its current callers (a client applying commits from its trusted
hub), but it lives in `ws_apply.rs` next to accept-path code. At minimum: a doc comment
stating it must never run on an accept path; better: move it behind a
`trusted_hub`-named API.

## Outbox modernization

The dirty-bit sign-at-drain core is the right design — keep it. What needs work is the
plumbing around it, which still carries HTTP-era shapes:

1. **Endpoint-keyed routing.** `drainOutboxSubject` constructs an HTTP URL per POST just
   so `sendCommit` can look up the matching WS. The drain should target a
   *SyncSession/transport*, not a URL string. This is also what the Rust `AtomicNode`
   API needs, so browser and mobile share one drain implementation.
2. **Sequential single-subject round trips.** The drain awaits one `COMMIT` →
   `COMMIT_OK` per subject, in order. A reconnect with 50 dirty subjects is 50
   sequential RTTs. Fix in two steps:
   - *Pipelining:* `COMMIT` frames already carry `request_id`; send the whole sorted
     batch (respecting the agents → drive → children ordering for genesis chains) and
     match acks out of order.
   - *Optional `COMMIT_BATCH` frame:* one frame carrying N signed commits, one ack with
     per-commit results. Only if pipelining measurably isn't enough.
3. **Fat `COMMIT_OK`.** The full server commit JSON comes back; the client only needs
   the commit id for `lastCommit`. Shrink to `[request_id] [commit_id]`
   (already listed in [`sign-at-drain.md`](./sign-at-drain.md) § protocol cleanups).
4. **Genesis + first-delta = two round trips.** A new resource POSTs its pre-signed
   genesis envelope, then signs and POSTs the accumulated delta separately. Allow the
   drain to send both in one pipelined pair (genesis first; server applies in order).
5. **Commit merging is already in — say so and bound it.** Sign-at-drain batches all
   Loro ops since the last successful drain into ONE commit per subject per pass
   (26 keystrokes ≠ 26 commits). What it does *not* do is merge across failed passes —
   it doesn't need to: a failed POST never advances the save cursor, so the next pass
   re-exports one bigger delta and signs one fresh commit. Document this as the
   contract; the commit *chain* granularity is "one commit per drain pass that reached
   the server", which is the right audit granularity.
6. **Rust/mobile parity.** Port `LocalOutbox` semantics (dirty bit, genesis envelope,
   `baseVersion`, backoff, blocked) into `atomic_lib` as the `AtomicNode` outbox so
   Flutter stops maintaining a partial reimplementation (`try_push_commit`).

## State-first wire: commit as provenance envelope

The instinct "sync should merge commits and just send single update statuses by
default" is where the protocol is already heading — make it explicit:

- **Server → client is state-first today.** Subscribers get one `UPDATE` frame carrying
  the subject's Loro state (snapshot or delta) + `commit_id` — not a commit-by-commit
  replay. Keep that. Finish the flag cleanups that cement it
  ([`sign-at-drain.md`](./sign-at-drain.md)): `HAS_COMMIT_ID` always set, drop `PUSH`
  (redundant with `request_id == 0`), collapse `SYNC_OK` into an empty `SYNC_DIFF`.
- **Client → server: state accumulates locally, ONE signed commit per subject certifies
  it at drain time.** The commit is not the unit of editing; it's the signed envelope
  that authorizes a state transition. This is the sign-at-drain model and the
  `retention` direction in
  [`commit-retention-and-state-certificates.md`](./commit-retention-and-state-certificates.md).
- **Layer 2 carries provenance instead of competing (fixes F1).** `SYNC_PUSH` entries
  gain the subject's `lastCommit` id (and, where available, the signed envelope for
  ops past it). The importer can then either (a) verify and record provenance, or
  (b) for the same-agent-replica case, at minimum refuse entries whose claimed
  provenance doesn't check out. Interim, cheaper step: on reconnect, **block VV push
  for subjects with a pending outbox entry** — the drain is the only writer for dirty
  subjects; VV sync covers only subjects the outbox doesn't know about. That closes
  the unsigned-write race without a wire change.

## Trust and authority

See also [`atomic-lib-runtime.md` § Authorization](./atomic-lib-runtime.md#authorization)
and [`sync.md` § Deletes over bulk sync](./sync.md#deletes-over-bulk-sync).

### Default (canvas v1): hub + signed commits

For **phone + tablet + web** on the **same agent**, the configured server is the source
of truth. Clients are offline-first **replicas**:

- **Trust:** commits applied on the hub (rights-checked) and pushed to subscribers.
- **Do not trust:** Iroh `NodeID` alone, QR scan alone, bulk `SYNC_DIFF` as a second
  authority over deletes, or **any drive/class value carried inside incoming CRDT
  payloads** (F2).

### Two sync layers (do not conflate)

```text
Layer 1 — Commit log (authoritative)
  mutate → dirty bit → outbox drain → sign ONE commit/subject → COMMIT → hub apply + rights
  → other clients: UPDATE / DESTROY

Layer 2 — Bulk reconcile (same-agent catch-up / offline gap)
  SYNC → SYNC_DIFF { pull, push, remove, pullFrom } → SYNC_PUSH
  Loro VV diff + local tombstones — target: provenance-carrying (F1)
```

| Layer | Proves identity | Proves rights | Deletes |
| --- | --- | --- | --- |
| **1 — Live / COMMIT** | WS `AUTH` or HTTP auth | Hub `apply_commit` + hierarchy | Signed destroy commit → `DESTROY` |
| **2 — Bulk** | `AUTH` on stream before `SYNC` (required policy — not yet enforced) | `check_read` on push; `check_write` + admission on import | `remove[]` from peer tombstones — **not** signed on the wire |

**Policy:** authoritative delete = Layer 1 on the hub. Layer 2 `remove` only prevents
resurrection between honest replicas of the same agent.

### Engineering debt (trust-related)

- [x] **Iroh live loop:** gate `UPDATE`/`DESTROY` on identity + admission
  (`admitted_for_drive`, per-connection verdict cache).
- [x] **F2:** resolve admission drive from local state, not payload (`989a8751`).
  The `Err(_) => true` bootstrap carve-out is unchanged but now safe, since it's
  no longer fed an attacker-controlled drive subject.
- [x] **F3:** thread the session agent into the live-mode unhandled-tag fallback
  (`34fd15c2`) — was a fresh `ForAgent::Public`.
- [ ] **F4:** admission + quota accounting for `BLOB_RESPONSE`; document
  hash-as-capability for `BLOB_REQUEST` or add `check_read`.
- [ ] **Require `AUTH` before `SYNC` / `SYNC_PUSH`** on accept paths (fail closed).
- [ ] **Bind `AUTH.requestedSubject` to `SYNC.drive`** for the session.
- [ ] **F6:** fence `apply_commit_json` (trusted-hub-only naming/docs).
- [ ] **Outbox:** all destroy paths on mobile → `try_push_commit`.

## Unified API sketch

Align with [`atomic-lib-runtime.md`](./atomic-lib-runtime.md) (`SyncService`,
`NodeEvent`, `AtomicTransport`):

```rust
pub enum Subscription {
    Drive(Subject),
    Query { property: String, value: String, drive: Subject },
    Resource(Subject),
}

pub enum NodeEvent {
    ResourceChanged { subject: Subject, source: ChangeSource, .. },
    ResourceDestroyed { subject: Subject, source: ChangeSource },
    QueryChanged { filter: QueryFilter, added: Vec<Subject>, removed: Vec<Subject> },
    SyncStateChanged { drive: Subject, state: SyncState },
}

impl AtomicNode {
    pub fn subscribe(&self, sub: Subscription) -> NodeEventStream;
    /// Drains the dirty-subject outbox over the given transport
    /// (pipelined COMMIT frames — see Outbox modernization).
    pub async fn drain_outbox(&self, transport: &mut impl AtomicTransport) -> ..;
    pub async fn run_sync_session(&self, transport: impl AtomicTransport, drive: Subject) -> ..;
}
```

The outbox inside `AtomicNode` is the ported `LocalOutbox` (dirty bit + genesis
envelope + `baseVersion` + backoff/blocked), not a signed-commit queue.

**WS adapter:** `atomic_lib::client::ws::WsClient`. **Iroh adapter:** existing
`peer.rs` live stream — should emit the same `NodeEvent`s after import.
**Flutter bridge (FRB):** `subscribe_events`, `open_sync_session(server_url)`,
`close_sync_session` — not `peer_sync` / `watch_children`.

## Retire manual `peer_sync`

Unchanged direction: QR pair → bulk `sync_drive_with_peer` → hope, plus
`watch_children` polling, get replaced by sign-in with server URL + background WS
session + query subscriptions.

| Option | When |
| --- | --- |
| **A. Remove bulk Iroh sync** | Same-user multi-device always via server; largest deletion (`peer_sync` path). |
| **B. Keep Iroh under `SyncSession`** | "Sync without server"; same API, `IrohTransport` only. |

Default recommendation: **A for canvas v1**; **B later** if serverless P2P becomes a
product requirement. Note: the F1–F3 hardening is only *required* under Option B — under
Option A the Iroh accept path can be deleted instead of fixed. Decide before investing.

## Implementation phases

### Phase 0 — Trust fixes (new; before more surface is built)

- [x] F2: local-state drive resolution (`989a8751`).
- [x] F3: session agent in live-mode fallback dispatch (`34fd15c2`).
- [ ] F1 interim: skip VV push for subjects with pending outbox entries.
- [ ] F5: structured error codes on `ERROR` / `/commit`; outbox switches on code.
- [ ] F4: blob admission + quota accounting.

### Phase 1 — WS session on mobile (primary)

- [x] `serverUrl` for native sign-in; background WS task; `pollDbEvent` bridge;
  `CanvasStore` off `watch_children`; partial outbox (`push_stroke`).
- [ ] Outbox: destroy commits always `try_push_commit` when WS open.
- [ ] Port `LocalOutbox` semantics to `atomic_lib` (`AtomicNode` outbox) — one
  implementation for browser-wasm and Flutter.

### Phase 2 — Outbox/protocol modernization

- [ ] Drain targets a transport, not an endpoint URL.
- [ ] Pipelined `COMMIT` (out-of-order ack matching by `request_id`).
- [ ] Genesis + first delta in one pipelined pair.
- [ ] Shrink `COMMIT_OK` to `[request_id] [commit_id]`.
- [ ] Flag cleanups: `HAS_COMMIT_ID` always, drop `PUSH`, fold `SYNC_OK` into
  empty `SYNC_DIFF` (see [`sign-at-drain.md`](./sign-at-drain.md)).

### Phase 3 — Layer 2 provenance

- [ ] `SYNC_PUSH` entries carry `lastCommit` (+ signed envelope where available).
- [ ] Import verifies/records provenance; policy decision for same-agent replicas.
- [ ] Decide Option A vs B for Iroh; delete or harden accordingly.

### Phase 4 — Tests

- [x] `ws_commit.rs`, `sync`/`query_subscribe` integration, browser vitest suite,
  `push_list_item_save_locally_persists_strokes`.
- [ ] Regression: reconnect with backoff-pending outbox entry must NOT VV-push that
  subject unsigned (F1).
- [ ] Regression: incoming delta asserting a foreign `DRIVE_PROP` is rejected for an
  existing subject (F2).
- [ ] Flutter integration: tablet + phone against test server.

## Related plans

| Doc | Relationship |
| --- | --- |
| [`atomic-lib-runtime.md`](./atomic-lib-runtime.md) | Owns `AtomicNode`, `NodeEvent`, `AtomicTransport`. |
| [`sign-at-drain.md`](./sign-at-drain.md) | Outbox dirty-bit model (shipped); protocol cleanups this doc schedules. |
| [`commit-retention-and-state-certificates.md`](./commit-retention-and-state-certificates.md) | Commit-as-state-certificate; idempotent replay that makes re-drain safe. |
| [`sync.md`](./sync.md) | WS `COMMIT` / echo suppression — done; test coverage gaps. |
| [`unified-data-layer.md`](./unified-data-layer.md) | Browser cache on top of node API. |
| [`virtual-drive.md`](./virtual-drive.md) | VFS subscribes to the same watched-queries cache. |

## Open questions

1. **Embedded server on mobile** — every install its own server, or shared hosted
   instance? (Affects `serverUrl` default.)
2. **Iroh default** — Option A (server-only) or Iroh as silent fallback? Gate the F1–F3
   hardening investment on this.
3. **Layer 2 provenance depth** — is `lastCommit`-id-only enough for same-agent
   replicas, or must `SYNC_PUSH` carry verifiable signed envelopes end-to-end
   (overlaps the high-audit profile in [`sign-at-drain.md`](./sign-at-drain.md))?
4. **P2P `remove` policy** — accept peer tombstones for same-agent reconcile, or only
   hub-signed destroys?
5. **Bootstrap admission (F2)** — what replaces `Err(_) => true` for a drive that
   doesn't exist locally yet: first-writer-wins with grace (as `AllowlistPolicy`
   does), explicit enrollment, or reject-until-known?
6. **Structured error codes (F5)** — enum on the `ERROR` frame payload + JSON field on
   HTTP, or a shared registry in `protocol.rs`?
