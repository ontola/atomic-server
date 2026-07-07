# Unified sync — one API, WS or Iroh

> **Status:** Active plan. Rewritten 2026-07-02 after a full audit of
> `lib/src/sync/*`, `browser/lib/src/websockets.ts`, and
> `browser/lib/src/local-outbox.ts`. Supersedes the 2026-05 revision; builds on
> completed WS `COMMIT` work in [`sync.md`](./sync.md), sign-at-drain in
> [`sign-at-drain.md`](./sign-at-drain.md), and the runtime boundary in
> [`atomic-lib-runtime.md`](./atomic-lib-runtime.md).
>
> **Second audit pass, same day (2026-07-02):** a deeper sweep across
> `server/src/handlers/web_sockets.rs`, `lib/src/client/ws.rs`, and
> `flutter/.../ws_sync.rs` for dead code, diverging concepts, and security
> gaps. Added findings **F8–F11** (two critical, both on paths F1–F6 didn't
> cover) and the [dead code & drift inventory](#dead-code--drift-inventory-2026-07-02-second-pass).
> **F8 and F9 are the new top priorities** — both are unauthenticated
> read/write paths, worse than anything in the first audit.
>
> **Third pass, same day:** the
> [consolidation inventory](#consolidation-inventory-2026-07-02-third-pass).
> Root cause of the code growth: `engine::handle_frame` only owns half the
> frame tags, so the server WS handler and the engine grow parallel copies
> that drift (one drift bug found: `internal:/` resolution exists only in the
> server's GET arm).

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
admission drive resolved from local state, not payload (`989a8751`), scoped to existing
resources (Open Question 5 covers new-subject bootstrap); F3 — live-mode fallback
dispatch uses the session agent, not a fresh Public (`34fd15c2`), plus a follow-up
clearing the per-connection `drive_cache` when a late AUTH changes identity; F1 interim —
`computeDriveSyncState` excludes outbox-pending subjects from the VV state sent to the
server, closing the browser side of the unsigned-write race without a wire change; F4 —
`BLOB_RESPONSE` (the sync-protocol write path) now gated on admission via a
pending-request map keyed off the `BLOB_REQUEST`s the server itself issued (unsolicited
or un-admitted responses rejected); quota accounting turned out to already be correct
(`per_drive_usage` recomputes from stored blobs rather than counting writes); the
browser's *primary* blob-write path, HTTP `PUT /blob/{hash}`, was originally left open
as a follow-up and is now also gated (2026-07-02, F4 follow-up section below); F5 — `ERROR` frame and
HTTP `/commit` body now carry a structured `code`, outbox switches on it with
message-string matching as the fallback for unrecognized codes (including a garbled
code misread from a pre-F5 server's frame under the new byte layout — the fallback path
had its own bug, since fixed). F2/F3 verified with regression tests proven against a
reverted build, full lib suite (229/229), and the full portal e2e suite (8/8) against a
rebuilt managed node. F1 interim/F3-follow-up/F4/F5 verified with regression tests
proven against a reverted build and the full lib suite (235/235) plus browser lib suite
(122+/122+); not yet re-run against the portal e2e suite.
**Also fixed 2026-07-02 (not part of the original audit):** F7 — two browser
local-cache durability bugs (OPFS flush timing, WS-reconnect replace clobbering a
durable pending edit) found chasing a flaky offline-persistence e2e test.

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
The full fix needs the wire change described there (F3 in Phase 3). The **interim
mitigation is fixed** (2026-07-02, browser-only, no wire change): `computeDriveSyncState`
now drops any subject with a pending outbox entry (`outbox.hasPending`) from the VV
state sent as `SYNC_VV` — the server never sees it as "ahead" and never asks for a
`SYNC_PUSH`, so the drain (once its backoff clears) remains the only writer. Verified
with a regression test (`store.test.ts`) proven against a reverted build. This closes
the *browser* side of the race; `import_sync_push`'s lack of signature verification on
the server is unchanged and still tracked by the Direction note above.

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
one — then proved the fix.

**Residual, scoped to Open Question 5, not a gap in this fix:** the
`admitted_for_drive` bootstrap carve-out (`Err(_) => true`) is unchanged and is now
safe **for existing resources** — `drive_subject` feeding it can no longer be spoofed
via the payload. For a genuinely **new** subject with no resolvable `PARENT`,
`resolve_update` falls back to the subject itself as `drive_subject` — which the peer
chose — and a nonexistent drive still hits `Err(_) => true` and is admitted under
`OpenPolicy`. Unauthenticated creation of arbitrary "drive-root" resources over Layer 2
remains possible, unchanged by this fix. That's exactly what Open Question 5 already
asks ("what replaces `Err(_) => true` for a drive that doesn't exist locally yet") —
this fix closes the *existing-resource* spoof, not the bootstrap-admission question.

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

### F4 — Blob frames bypass both gates ✅ Sync-protocol write path fixed 2026-07-02; HTTP write path fixed 2026-07-02

`BLOB_REQUEST` serves any blob by 32-byte hash with no `check_read`
(hash-as-capability — **documented as an accepted decision**: a hash is
unguessable capability-equivalent, and read access was never the gap the
audit was worried about). `BLOB_RESPONSE` inserted unconditionally with no
admission/quota check.

**Fixed (sync-protocol write path only — `BLOB_RESPONSE`):** `Db` gained a
small in-memory `pending_blob_requests` map (hash → drive). `import_sync_push`
records an entry there whenever it emits a `BLOB_REQUEST` (only ever done for
a drive that already passed `admit_drive_write` at the top of that function).
The `BLOB_RESPONSE` handler now consumes that entry: no matching entry
(unsolicited push, not just an un-admitted one) is rejected outright; a
matching entry is re-checked against `admit_drive_write` before the bytes are
stored (enrollment/quota can change between the request and the response).
Two regression tests (`blob_response_without_matching_request_is_rejected`,
`blob_response_for_unadmitted_drive_is_rejected`) proved against a reverted
`engine.rs`; the existing `sync_blobs_via_engine` and `iroh_blob_roundtrip`
tests confirm the legitimate round trip is unaffected.

**F4 follow-up fixed (2026-07-02) — the browser's primary blob-write path is
now gated:** `PUT /blob/{hash}` (`server/src/handlers/blob.rs::put_blob`) is
how the browser actually uploads file bytes — the WS
`BLOB_REQUEST`/`BLOB_RESPONSE` pair the fix above gates is the
peer-to-peer/sync-catchup path, not the primary one. `put_blob` used to
verify only that the body's BLAKE3 hash matches the URL (content-addressing
integrity), then store it with zero admission, quota, or auth check —
the hash alone is NOT a write capability, since an attacker choosing their
own bytes can always compute a hash for them.

**Fix:** bytes are only accepted when a resource *already on this server*
references `did:ad:blob:<hash>` via the `BLOB` property (found via
`Storelike::query`, `for_agent: Sudo` — existence only, not a read-rights
check, so private-file uploads aren't blinded by the lookup) and **any** of
those referencing resources' drives passes `admit_drive_write`, resolved the
same way `resolve_destroy_drive` does (`DRIVE_PROP`, falling back to the
resource's own subject). This works because the client's outbox drain always
POSTs the referencing commit before pushing the blob's bytes
(`local-outbox.ts`), so the ordering the gate depends on already holds in the
legitimate flow. The gating logic lives in a standalone
`resolve_blob_write_admission(&Db, hash_hex)` function, pulled out of the
actix handler specifically so it's unit-testable directly against a `Db` —
there's no config-level way to install a non-default `SyncPolicy` on a spun-up
`atomic-server` process, so an HTTP-integration test alone couldn't exercise
the rejection paths.

**Second-review edge case, fixed in the same batch:** the first version
queried with `limit: Some(1)` and checked only that one result's drive —
correct when a hash is referenced from a single drive, but content-addressed
bytes can legitimately be referenced from resources in *different* drives
(the same file uploaded independently into two drives), and a single-result
limit made the verdict depend on which resource the query happened to return
first. Fixed to drop the limit and accept if any referencing resource's drive
is admitted. `referenced_hash_admitted_via_any_matching_drive` uses
hand-picked (not randomly-DID'd) subjects so the unadmitted resource is
deterministically forced first in the property-value index — confirmed via
revert-and-check that this fails 100% of runs against the `limit(1)` version
(a randomized-subject version of the same test only failed ~60% of runs,
which wasn't trustworthy as a regression guard).

Four unit tests total (`unreferenced_hash_is_rejected`,
`referenced_hash_on_admitted_drive_is_allowed`,
`referenced_hash_on_unadmitted_drive_is_rejected`,
`referenced_hash_admitted_via_any_matching_drive`), each verified via
revert-and-check, plus two HTTP-level integration tests
(`server/tests/put_blob.rs`) proving the real endpoint behaves the same way
over the wire (legit commit-then-blob flow succeeds; unreferenced hash gets
401). The separate `/upload` multipart endpoint (`handlers/upload.rs`) was
checked and needed no change — it already requires `check_write` before
inserting bytes, and doesn't call the new gate at all.

**Quota accounting was already correct, no fix needed:** `per_drive_usage`
(the number the managed control-plane reports) recomputes `blob_bytes` by
walking each drive's resources and summing referenced blob sizes at query
time — it isn't a per-write counter, so it was never actually blind to blobs
written via either path. The real gap is purely on the *admission* side: an
unenrolled/over-quota drive's blob bytes get **stored** at all, consuming
disk regardless of what a usage report would eventually show. The fix above
closes that for the sync-protocol path; `put_blob` remains open.

### F5 — Outbox failure classification is coupled to server error strings ✅ Fixed 2026-07-02

`isTerminalCommitErrorMessage` / `isUnrecoverableCommitErrorMessage` pattern-match
exact server message text ("is_genesis: true, but…", "/properties/write right has been
found"). A server wording change silently converts terminal errors into infinite
backoff retries — the exact ingest-flood mode the classifiers exist to prevent. The
`ERROR` frame and HTTP `/commit` error body need a **structured error code**; the
outbox switches on the code, keeps string-matching only as legacy fallback.

**Fixed:** picked "append code before the message" for the wire change (user decision;
the alternatives were a self-describing message prefix or a new frame version — see the
old Open Question 6, now resolved and removed).

- **Wire:** `ERROR` frame is now `[0x03] [request_id: u16] [code: u16] [message: utf8]`
  (was `[request_id][message]`). A shared `sync::protocol::error_code` registry
  (`UNKNOWN`/`GENESIS_COLLISION`/`MISSING_REQUIRED_PROPERTY`/`UNAUTHORIZED_WRITE`) plus
  `classify_commit_error(message) -> code` is the one place both wire paths classify
  from. Backward compat is asymmetric by design (user-approved tradeoff): an old
  client reading a new server's `ERROR` sees 2 extra leading bytes in the message text
  (cosmetic garbling); a new client reading an old server's `ERROR` misreads the
  message's first 2 bytes as `code` — any code it doesn't recognize is treated the same
  as `UNKNOWN`, so this degrades to the pre-F5 string-matching fallback either way.
- **HTTP:** `/commit`'s JSON-AD error body gets a new `errorCode` property
  (`urls::ERROR_CODE`) alongside `description`, set from the same `classify_commit_error`
  in `server/src/errors.rs`'s generic `AtomicServerError::error_response` — harmless
  (`UNKNOWN`) for the many non-commit errors that also flow through that path.
- **Browser:** `AtomicError` gained an optional `code` field, populated from the WS
  `ERROR` frame's decoded code or parsed out of the HTTP JSON-AD body. New
  `isTerminalCommitError(message, code)` / `isUnrecoverableCommitError(message, code)`
  in `local-outbox.ts` check the code first (when recognized) and fall back to the
  original string matchers otherwise — those matchers are unchanged and still exported,
  now positioned as the fallback layer rather than the only layer.
- **Callers updated:** every `encode_error` call site (engine.rs, web_sockets.rs) passes
  an explicit code — `error_code::UNKNOWN` for generic protocol errors (invalid frame,
  not found, etc.), `classify_commit_error(&e.to_string())` at the two commit-application
  error sites (WS `COMMIT` handler, HTTP `/commit`).
- Not yet threaded through: `lib/src/client/ws.rs` (Rust WS client)'s `WsMessage::Error`
  still only carries the message — no current consumer switches on the code, so it's
  deferred to whenever mobile/native outbox parity (Phase 1/2) needs it. It correctly
  skips the new 2-byte `code` field on decode either way.
- Verified: unit tests on both sides (`protocol.rs`'s `classify_commit_error_matches_known_patterns`
  / `error_encoding`; browser `ws-v2.test.ts`, `error.test.ts`, `local-outbox.test.ts`),
  proven against a reverted build for the browser-side code-first classifiers. Full lib
  suite (235/235) and browser lib suite (122/122) green.

### F6 — `apply_commit_json` is a loaded footgun in a shared module

It applies commits with `validate_rights: false`, no timestamp and no previous-commit
validation. Correct for its current callers (a client applying commits from its trusted
hub), but it lives in `ws_apply.rs` next to accept-path code. At minimum: a doc comment
stating it must never run on an accept path; better: move it behind a
`trusted_hub`-named API.

### F7 — Browser local-cache durability gaps (not part of the original audit) ✅ Fixed 2026-07-02

Found chasing a flaky `sync.spec.ts` e2e test ("edits made offline persist across
reload"), not the F1-F6 audit — these are client-side local-cache bugs, not wire-protocol
trust issues, but land in the same "offline edit gets lost" failure mode so they're
recorded here rather than a separate doc.

1. **OPFS writes weren't durable before a fast reload.** `client-db.worker.ts`'s
   `putResourceWithSnapshot` writes to the OPFS-backed redb with `Durability::None` for
   throughput — durable persistence only happened on a periodic 1-second flush tick
   (`FLUSH_INTERVAL_MS`). An offline edit immediately followed by a reload (exactly what
   a user hitting Cmd+R after an offline edit does) could land before that tick fired:
   the save's promise resolved, `pendingDirtyCount` went positive, but the OPFS read on
   reload came back completely empty. **Fixed:** `putResourceWithSnapshot` now calls
   `db.flush()` synchronously right after the write — it's the one write path
   `resource.ts`'s `persistToClientDb` uses specifically because its caller
   (`saveOffline`) needs the write durable the moment its promise resolves, so it no
   longer waits on the periodic tick. Other write ops still rely on the tick (fine —
   they don't carry the same immediate-durability promise).
2. **A WS reconnect could destructively replace local state with a durable pending
   edit.** `Store.applyIncoming`'s `replace` flag (full-snapshot `UPDATE`/`SUB` push →
   wipe-and-reimport instead of merge) gated only on `resource.hasUnsavedChanges()`, an
   in-memory-only signal. On a cold reload the freshly-created Resource object has never
   had `set()` called on it, so `hasUnsavedChanges()` reads `false` even though the
   outbox's durable (localStorage-backed) dirty bit says the subject has a pending
   offline edit — `replace: true` would then call `resetLoroState()` and wipe it.
   **Fixed:** `replace` also checks `!this.outbox.hasPending(subject)`.

Verified both by reverting each fix independently and confirming the e2e test failed
reliably (0/3 runs), then reapplying and getting 5/5. Full `offline-*`/`clientdb-*` e2e
suite (7 tests) and all 108 `browser/lib` unit tests pass with both fixes in.

## Second-pass audit findings (2026-07-02)

Deeper sweep across the server WS handler, the Rust WS client, and the Flutter
sync bridge. F8 and F9 outrank everything in the first audit.

### F8 — `SYNC_DELTAS`: an unauthenticated, unchecked write path that nothing uses

**Not to be confused with the VV negotiation** (`SYNC_VV`/`SYNC` → `SYNC_DIFF` →
`SYNC_PUSH`), which is the intended "I have this state, you have that state, what do
we exchange?" mechanism and **stays**. `SYNC_DELTAS` is its legacy precursor: a
one-way text frame (`SYNC_DELTAS {drive, deltas: {subject: base64}}`) that says
"apply these bytes, no questions asked" — no diff step, no negotiation.

The problem, in the server's WS text handler
(`web_sockets.rs:571` → local wrapper at `:709`):

- The wrapper **discards the session agent** (`_agent: ForAgent`).
- `engine::handle_sync_deltas` (engine.rs:737) performs **no checks at all**: no
  signature, no `check_write`, no `admit_drive_write`, not even the tombstone skip
  that `import_sync_push` has.
- Any WS connection — **no AUTH required** — can write arbitrary Loro state to
  arbitrary subjects.

And it's dead: the browser sends `SYNC_VV` + binary `SYNC_PUSH`; Flutter and the Rust
`WsClient` never emit it (only doc-comment mentions). An open hole guarding a feature
nobody uses. **Fix: delete the text handler and `engine::handle_sync_deltas`.**

**Fixed (2026-07-02).** Deleted the `SYNC_DELTAS` text-frame branch and
`handle_sync_deltas` wrapper from `web_sockets.rs`, and `engine::handle_sync_deltas`
itself. Both crates compile clean; full `atomic_lib` suite green.

### F9 — Inbound Iroh connections become trusted "known peers" the victim auto-dials

Chain, each link verified in code:

1. `AtomicHandler::accept` (peer.rs:264) accepts **any** connection — no pairing or
   allowlist check.
2. `register_live_peer` **persists every peer** via `add_known_peer(&store, &key, "")`
   (peer.rs:570) — including unauthenticated (Public) inbound ones. One empty `SYNC`
   and the attacker is remembered forever.
3. The auto-connect loop (peer.rs:166–235) dials all known peers for the active drive.
4. On that outbound connection the victim is the **initiator**, and the initiator:
   - serves the peer's `SYNC_DIFF.pull` list **straight from `Tree::LoroSnapshots`
     with no `check_read`** (peer.rs:1156–1175, 1206–1225), and
   - imports the peer's `SYNC_PUSH` with **`ForAgent::Sudo`** (peer.rs:1188).

Net: anyone who learns a NodeID (published via pkarr discovery) can get the victim's
node to dial them, **exfiltrate the entire active drive, and push arbitrary state back
as Sudo**. The initiator-side trust model ("I dialed you, so I trust you") is only
sound if `known_peers` means *explicitly paired* — step 2 breaks that invariant.

**Fix (minimal):** never `add_known_peer` on the accept path — only on QR pairing /
explicit user action. **Fix (proper):** also gate initiator-side `pull` serving on the
auth-back identity (`check_read` per subject, same as the acceptor's `handle_sync_vv`
does), and replace the Sudo import with the auth-back agent. This is the concrete
exploit behind the existing "Require `AUTH` before `SYNC`" debt item.

**Fix (minimal) done (2026-07-02).** `register_live_peer` no longer calls
`add_known_peer` at all, and `handle_stream`'s HELLO handler no longer persists the
peer name into known-peers on the accept side (the initiator's own HELLO handler in
`sync_drive_with_peer_using_outcome` still does — that's the legitimate,
user-initiated dial). `e2e_hello_exchanges_device_names` now asserts the *negative*
(accept side must NOT gain a known-peer entry from an unsolicited connection).

**Fix (proper) — still open, now unblocked.** Open Question 2 was decided for
Option B (2026-07-02, see [`serverless-p2p.md`](./serverless-p2p.md)), so this is
scheduled work (its Phase P0), not deferred. Concretely still unfixed today: initiator-side
`pull` serving has no `check_read`, the initiator's `SYNC_PUSH` import still uses
`ForAgent::Sudo`, **and** the initiator's `SYNC_DIFF.remove[]` handling
(`sync_drive_with_peer_using_outcome`, peer.rs) applies `ws_apply::apply_destroy` with
no rights check at all — a peer the victim dialed can still tell the victim to delete
and tombstone subjects the victim *already has*. See F10 below: F10 only closed the
*unknown*-subject phantom-tombstone half of that same `apply_destroy` call; this
known-subject half is F9 proper's scope, and Open Question 4's.

### F10 — DESTROY-spam pre-tombstoning: unauthenticated remote data destruction

When a live peer sends `DESTROY` for a subject that doesn't exist locally,
`resolve_destroy_drive` returns `None` and the destroy is applied **unconditionally**
(peer.rs:683), writing a permanent tombstone. The "harmless no-op" comment
(ws_apply.rs:181) is wrong — a tombstone:

- blocks all future imports of that subject (`import_sync_push` skip, engine.rs:614);
- makes `handle_sync_vv` emit `remove[]` for it (engine.rs:527), telling honest
  clients to **delete their local copies**.

So a Public live peer can spray `DESTROY` frames for subjects the victim hasn't synced
yet, permanently blocking them and propagating deletion to other replicas. **Fix:**
don't record tombstones from unprivileged peers for locally-unknown subjects — drop
the frame, or require the same drive admission as every other write.

**Fixed — unknown-subject case only (2026-07-02).** `apply_destroy_unchecked`
(ws_apply.rs) now only records a tombstone for a subject this node has prior history
with (it existed and was just deleted, or it was already tombstoned); a DESTROY for a
locally-unknown, never-tombstoned subject is now a real no-op. Existence is checked via
a `get_resource` lookup *before* attempting removal, not derived from
`remove_resource(..).is_ok()` — that used to conflate "never existed" with "existed but
the delete transaction failed" (e.g. a transient KV error), which would have skipped
the tombstone for a real resource whose deletion merely failed. Three regression tests
(`sync::ws_apply::destroy_phantom_tombstone_tests`), each verified via the
revert-and-check discipline (fails without the fix, passes with it).

**Not fixed — known-subject case.** This finding's title says "unauthenticated remote
data destruction," and the fix above only addresses the *phantom tombstone* half of
that (an unprivileged peer poisoning a subject name it never had standing over). The
other half is unchanged: on the **initiator** side, `sync_drive_with_peer_using_outcome`
applies `apply_destroy` for every subject in a `SYNC_DIFF.remove[]` list with **zero
rights check**, so a dialed peer can still delete + tombstone a subject the victim
*legitimately has and cares about* — no admission, no `check_read`, nothing. That's the
same initiator-trust hole as F9 proper (this is literally the same `apply_destroy` call
F9's writeup already flagged as needing a gate) and Open Question 4 ("P2P `remove`
policy"). Tracked there, not re-tracked here, to avoid the checklist implying two
separate open items for one hole.

### F11 — Tombstones are write-only; legitimate re-creation splits the layers

`record_tombstone` is called from `remove_resource` (db.rs:2618) and `apply_destroy`,
but **no clear/remove API exists anywhere**. Destroy-then-recreate of the same subject
(idempotent genesis replay, importers) leaves Layer 1 saying "exists" while Layer 2
forever skips its imports and emits `remove` for it — permanent split-brain. **Fix:**
clear the tombstone when a rights-checked commit (re-)creates the subject.

**Fixed (2026-07-02).** Added `tombstones::clear_tombstone`, a `Storelike::clear_tombstone`
default (no-op) method overridden on `Db`, wired into `commit.rs`'s rights-checked
genesis path (`validate_and_build_response`, right after `check_append` succeeds — called
unconditionally there, so any is_new-subject genesis, not just recreations, gets a no-op
clear when nothing was tombstoned). Regression test
(`commit::test::genesis_commit_clears_stale_tombstone_on_own_subject`), verified via
revert-and-check.

### F12 — Browser Loro WASM double-init race corrupts the heap ✅ Fixed 2026-07-07

`LoroLoader.initializeLoro` (browser/lib/src/loro-loader.ts) guarded only on
`_Loro`, which is assigned *after* several awaits — and loro-crdt's own
`__wbg_init` has the same TOCTOU hole (`if (wasm !== undefined)` is only
satisfied once the async fetch+instantiate finishes). `enableLoro()` is called
fire-and-forget at app startup (App.tsx) AND awaited on demand (`signChanges`,
collections, canvas), so overlapping calls in the wasm-download window
instantiated **two** wasm modules; the second silently replaced the
module-global `wasm`. Docs created against the first instance then dereference
— and write through — stale pointers into the second instance's heap.
Symptoms surface long after the race: dlmalloc panics
(`psize >= size + min_overhead`), `indirect call signature mismatch` on
`doc.commit()` (drain/sign path), `index out of bounds` in `CLOSURE_DTORS`,
and crashes in `Loro*Finalization` GC finalizers.

**Fixed (2026-07-07).** Single-flight promise in `LoroLoader.initializeLoro`:
concurrent callers share one in-flight init; a failed load clears the slot so
retry is possible. Regression test in `loro-loader.test.ts` asserts promise
identity for overlapping calls.

## Dead code & drift inventory (2026-07-02 second pass)

### Dead code (delete)

| What | Where | Notes |
| --- | --- | --- |
| `SYNC_DELTAS` path | `web_sockets.rs:571,709`, `engine.rs:737` | See F8 — dead **and** a hole. **Deleted (2026-07-02).** |
| `WSClient.sendBlob` | `websockets.ts:693` | Zero callers; doc comment ("used by uploadFiles") stale since blob delivery moved to HTTP `PUT /blob`. **Deleted (2026-07-02).** |
| `WsClient::get_resource` | `lib/src/client/ws.rs:202` | Dead **and broken**: sent text `"GET "`, which the server no longer handles — always timed out. Flutter hand-rolled a working binary GET (`fetch_resource_state`) right next to it. **Deleted (2026-07-02).** |
| `WsMessage::Resource`/`Commit` + `"RESOURCE "`/`"COMMIT "` text parsing | `lib/src/client/ws.rs:299` (parser), consumed at `flutter/rust/src/api/simple/ws_sync.rs:143`, `server/tests/ws_get_unauthorized_latency.rs:88,135` | **Unreachable, not "used."** A `match` arm referencing `WsMessage::Commit`/`Resource` proves the *variant compiles*, not that it's ever produced — `parse_server_message` only builds these from a text `"COMMIT "`/`"RESOURCE "` prefix, and nothing sends either: the server fans commits out exclusively as binary `UPDATE` (`ws_v2::encode_update`, `web_sockets.rs:343,655`), never as a text `COMMIT` frame. Same trap the original inventory entry fell into. Left in place this pass, not deleted — deletion spans into Flutter (`ws_sync.rs`), out of scope for a Rust-only sweep. |
| `EPHEMERAL (0x40)` tag | `protocol.rs:45`, `ws-v2.ts:37` | Declared both sides, zero encode/decode/dispatch. Flagged in sync.md's 2026-05-28 audit; still there. **Left as-is (2026-07-02):** a genuinely reserved tag for a future binary presence/cursor migration (current presence goes over the text `LORO_EPHEMERAL_UPDATE` frame instead), not obviously erroneous — revisit alongside the frame's actual migration, not as a blind delete. |
| `handle_stream_then_live` | `peer.rs:1358` | Wrapper that only calls `handle_stream`. **Deleted (2026-07-02)** — call site now calls `handle_stream` directly. |
| Test-module duplicate `encode_get` | `protocol.rs` (test mod) | Private copy with stale comment "server doesn't use it yet" — the pub `encode_get` exists and Flutter uses it, and was being shadowed by this duplicate inside the test module. **Deleted (2026-07-02)** — the one test that used it now exercises the real `pub fn encode_get`. |

### Diverging concepts (converge)

- **One bulk-sync op, two wire forms:** browser sends text `SYNC_VV <json>`
  (web_sockets.rs:557); Iroh sends binary `SYNC (0x30)` — same semantics, two
  encoders, two parsers, and the text request gets *binary* response frames. Fold the
  browser onto binary `SYNC` when convenient.
- **Subscription identity is frozen at subscribe time:** `SUBSCRIBE`/`SUBSCRIBE_QUERY`
  store `agent: self.agent.to_string()` in the commit monitor. A connection that
  subscribes before AUTH completes (or upgrades identity later) keeps Public-scoped
  fanout for the socket's lifetime. The browser dodges it by subscribing after
  AUTH_OK; nothing enforces that. Structurally the same stale-identity bug as the
  F3 follow-up's `drive_cache` — fix the same way (refresh or re-register on AUTH).
- **Trusted vs untrusted apply share one module:** `ws_apply.rs` holds both the
  unconditional `apply_state_update`/`apply_destroy` (clients trusting their hub —
  Flutter's path) and the gated `resolve_*`/`persist_*` pair (accept paths), fenced
  only by doc comments. Generalizes F6: split into `trusted_hub` vs `untrusted_peer`
  modules so misuse is a compile-time smell.
- **Initiator/acceptor asymmetry in peer sync:** acceptor's `handle_sync_vv` does
  per-subject `check_read` before pushing; the initiator serving the mirror-image
  `pull` checks nothing (part of F9).
- **`compute_drive_hash` non-`ring` fallback** (engine.rs:296) uses `DefaultHasher`
  while the browser always uses SHA-256 — a non-ring build silently never
  hash-matches, so every reconnect pays the full VV diff. Make it a compile error or
  document ring as required.

### Inconsistencies (fix cheap)

- ~~**Canonical spec is stale:** `docs/src/websockets.md:36` still documents `ERROR` as
  `[request_id][message]`; F5 added `[code: u16]`. protocol.rs's own header rule
  requires doc + TS updates in the same change.~~ **Fixed (2026-07-02):** table row
  updated to `[request_id] [code] [message]`, plus an error-code reference table.
- ~~**Frame-size caps disagree:** server WS 16 MiB, Iroh accept-handshake 10 MB
  (`len > 10_000_000` **breaks the stream**), Iroh live 50 MB, browser unbounded. A
  12 MB blob survives live mode but kills a handshake. Nothing bounds `BLOB_RESPONSE`
  at the protocol level. Pick one cap, share the constant.~~ **Partially fixed
  (2026-07-02):** the three *Iroh* caps (plus a fourth, completely unbounded read —
  the initiator's AUTH-response length prefix, a real DoS gap) are now two shared
  named constants (`IROH_FRAME_MAX_BYTES` = 50MB post-auth, `IROH_PREAUTH_FRAME_MAX_BYTES`
  = 10MB pre-auth — see the Engineering debt entry above for why they're deliberately
  different, not unified to one value). The server WS 16 MiB actix limit and the
  browser's unbounded outbound side are **still untouched** — different transport,
  different fix, left open.
- **`request_id = 0` errors become user-facing toasts:** the browser routes id-less
  `ERROR`s to `store.notifyError` (websockets.ts:750); the engine's new F4 rejections
  ("Unsolicited blob response") and misc protocol errors will surface as UI toasts.
  Not touched this pass.
- ~~**Tombstone keys skip base-domain resolution:** `tombstone_key` uses
  `Subject::from_raw(subject, None)` (tombstones.rs:10) while snapshot keys resolve
  with the store's base domain — a relative-form subject can tombstone under a
  different key than its snapshot. Needs a regression test.~~ **Test added
  (2026-07-02),** not a behavior fix: `sync::tombstones::key_normalization_tests`
  proves `?drive=`-suffixed and trailing-slash variants of the same subject share a
  tombstone key (both already normalize correctly via `pure_id()`, with
  `base_domain: None` — passed). The base-domain-mismatch scenario in this note's
  original wording (relative-form subject vs. absolute, under a real `base_domain`)
  is still unverified; flagging as unresolved rather than claiming more than the new
  tests actually prove.
- ~~**Stale `ERROR` offset in peer.rs's AUTH-response path:** reads the message at
  `auth_buf[3..]`; under the F5 layout it's `[5..]`. Cosmetic (2 garbage bytes).~~
  **Fixed** (landed with F5's second-review fixes, before this Phase 0b batch).
- ~~**`pending_blob_requests` has no TTL** — entries for responses that never arrive
  accumulate for the process lifetime. Tiny values; cap or expire anyway.~~ **Fixed**
  (landed with F5's second-review fixes, before this Phase 0b batch): 5-minute TTL,
  pruned lazily on insert.

## Consolidation inventory (2026-07-02 third pass)

Why the code keeps growing: **`engine::handle_frame` was meant to be *the*
transport-agnostic dispatcher, but it only owns 6 of the ~12 active tags.** The
server WS handler delegates `SYNC`/`SYNC_PUSH`/`BLOB_*` to it but hand-rolls its own
`AUTH`, `GET`, `COMMIT`, `SUB`, `UNSUB` arms — so every frame feature lands in one
copy and not the other, and the code grows in pairs. Item 1 below is the fix that
stops the pattern; the rest are instances of it.

### Duplicated implementations (merge)

1. **Server `GET`/`AUTH` arms duplicate `engine::handle_frame` — with live drift.**
   `web_sockets.rs:268` and `engine.rs:62` both implement GET, but only the server
   copy resolves `internal:/` URLs to the server origin (`web_sockets.rs:324`) — an
   Iroh peer GETting the same resource receives unresolved `internal:/` subjects.
   Same duplication for AUTH (`web_sockets.rs:241` vs `engine.rs:35`). **Fix: engine
   owns both arms; server passes an origin-resolver hook.** This is the
   one-lands-instead-of-two change.
2. **AUTH-frame parsing ×3**: `engine.rs:39`, `web_sockets.rs:251`, `peer.rs:1284`
   (auth-back) — three copies of "parse `AuthValues` → verify → assign". One
   `protocol::handle_auth_frame` helper.
3. **Compact-VV build ×2 (+1 decode)**: `peer.rs:1051–1080` (initiator) and the
   browser's `computeDriveSyncState` both build the peers-array + counters map;
   `handle_sync_vv` decodes it. The Rust build block belongs next to `encode_sync`
   in `protocol.rs`.
4. **Blob-hash extraction ×2 in engine.rs alone** (lines ~500 and ~701:
   `blob_hash_hex` → hex decode → `[u8;32]` → `contains_key(Blobs)`), plus a TS
   sibling in `checkForMissingBlobs`. One helper on `Subject` or in engine.
5. **Six public entry points for one peer-sync function**: `sync_drive_with_peer`,
   `_outcome`, `_if_needed`, `_forced`, `_using`, `_using_outcome`. Real non-test
   callers: three (flutter manual `peer_sync` — which Phase 3 deletes anyway,
   `routes.rs` pairing endpoint, flutter auto-connect ×2). `_using*` are pub but
   test-only. Collapse to one function + options struct.
6. **Three peer-event APIs, all FRB-exported**: `poll_sync_events` (legacy polling),
   `wait_for_sync_event`, `wait_for_peer_count_change`. The `NodeEvent` stream
   (Unified API sketch) replaces all three; drop the polling one first.
7. **ws-v2.ts mirrors server-only frame directions**: `encodeUpdate`,
   `encodeCommitOk`, `encodeSyncOk`, `encodeDestroy`, `encodeUnsub`, `decodeGet`,
   `decodeAuth`, `decodeSub` — zero uses outside ws-v2.ts + tests; the browser never
   sends an `UPDATE` or receives a `GET`. Trim from the bundle or move to a
   test-only module.
8. Micro: the browser `DESTROY` handler inline-decodes the subject
   (`websockets.ts:831`) instead of using the `decodeSubject` helper ws-v2 exports
   for exactly this.

### More dead code (third pass)

| What | Where | Notes |
| --- | --- | --- |
| `WSClient.subscribeResource` / `unsubscribeResource` | `websockets.ts:475–499` | Zero browser callers — the browser is drive-`SUB`-only; per-resource text `SUBSCRIBE` is Flutter-only (one call, `subscribe_canvas`). Corollary: browser **never unsubscribes from anything** (`encodeUnsub` also has zero callers); server-side subscriptions die only with the connection. |
| `AUTHENTICATED` text branches | `websockets.ts:964`, `client/ws.rs:349` | Server never sends that string anymore (zero hits in `server/src`). |
| `WsClient::{subscribe_query, fetch_blob, send_loro_sync_update, send_loro_ephemeral_update}` | `client/ws.rs` | No callers anywhere. With the broken `get_resource` (drift inventory), ~half the Rust WS client's public surface is unused. |
| `LIVE_CONNECTIONS` append-only Vec | `peer.rs:318,1326` | Not dead but a leak: pushed on every outbound sync, never removed (`remove_live_peer` cleans `LIVE_PEERS` only). Pins dead QUIC connections open for process lifetime. Prune alongside `remove_live_peer` or key by peer. |

### Compounding note

Open Question 2 is decided: **Option B** ([`serverless-p2p.md`](./serverless-p2p.md)).
The deletions still happen — B replaces today's handshake/live machinery with
`SyncSession` rather than preserving it (see that doc's deletion table: the six
`peer_sync` variants, the FRB event-API trio, and the handshake/live duality all go).
This inventory plus the drift inventory is ~500+ deletable/mergeable lines — and item 1
(engine owns all tags) is now a **prerequisite** for serverless-p2p's "every peer is a
hub" principle, not just the structural fix for the two-copies growth pattern.

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
  Safe for *existing* resources now; the `Err(_) => true` bootstrap carve-out for a
  genuinely new subject with no resolvable parent is unchanged and still admits an
  unauthenticated drive-root create — that's Open Question 5, not this fix's scope.
- [x] **F3:** thread the session agent into the live-mode unhandled-tag fallback
  (`34fd15c2`) — was a fresh `ForAgent::Public`.
- [x] **F3 follow-up:** clear `drive_cache` when a late AUTH frame changes the
  session's identity mid-connection — the cache's verdicts (e.g. `Public` rejected)
  were computed under the old identity and, uncleared, would keep rejecting a drive
  for the rest of the connection even after the peer proves a stronger identity.
  `invalidate_drive_cache_on_identity_change` (peer.rs), two regression tests.
- [x] **F4 (sync-protocol path only):** `BLOB_RESPONSE` gated on admission via
  a pending-request map; quota accounting already correct (recompute-based
  `per_drive_usage`). Hash-as-capability for `BLOB_REQUEST` documented as
  accepted, not fixed.
- [x] **F4 follow-up:** gate HTTP `PUT /blob/{hash}` (2026-07-02) — bytes
  accepted only when a resource already references `did:ad:blob:<hash>` and
  that resource's drive is admitted. This was the last unauthenticated write
  path in the server. See the F4 write-up above for the fix and its tests.
- [x] **F8 (critical):** delete the `SYNC_DELTAS` handler + `engine::handle_sync_deltas`
  — unauthenticated, unchecked write path with zero senders (2026-07-02).
- [x] **F9 minimal:** stop `add_known_peer` on the accept path (2026-07-02).
- [ ] **F9 proper (still open):** `check_read` on initiator-side `pull` serving; replace
  the initiator's `ForAgent::Sudo` import with the auth-back agent; also covers the
  initiator's ungated `apply_destroy` on `SYNC_DIFF.remove[]` entries (peer.rs, in
  `sync_drive_with_peer_using_outcome`) — a peer the victim dialed can still delete +
  tombstone subjects the victim **already has**, no rights check at all. F10 only closed
  the *unknown*-subject phantom-tombstone case; the known-subject case is this same
  initiator-trust hole and Open Question 4's territory. Now unblocked (Open
  Question 2 → Option B) and scheduled as [`serverless-p2p.md`](./serverless-p2p.md)
  Phase P0, where OQ4 resolves as "destroys travel as signed commits."
- [x] **F10 (partial — see F9 proper above):** no phantom tombstones from unprivileged
  peers for locally-*unknown* subjects (2026-07-02). Does **not** cover a known subject
  destroyed via the initiator's ungated `SYNC_DIFF.remove[]` apply — that's F9 proper.
- [x] **F11:** clear tombstone when a rights-checked commit re-creates the subject
  (2026-07-02).
- [ ] **Require `AUTH` before `SYNC` / `SYNC_PUSH`** on accept paths (fail closed) —
  F9 is the concrete exploit this abstract item was about.
- [ ] **Bind `AUTH.requestedSubject` to `SYNC.drive`** for the session.
- [ ] **Subscription identity refresh:** re-evaluate `SUBSCRIBE`/`SUBSCRIBE_QUERY`
  agent binding when a connection's AUTH lands or changes (see drift inventory).
- [ ] **F6:** fence `apply_commit_json` (trusted-hub-only naming/docs); consider the
  broader `trusted_hub`/`untrusted_peer` module split from the drift inventory.
- [ ] **Outbox:** all destroy paths on mobile → `try_push_commit`.
- [x] **Docs:** update `docs/src/websockets.md` for the F5 `ERROR` layout (2026-07-02)
  — table row now shows `[request_id] [code] [message]`, plus an error-code reference
  table.
- [ ] **Engine owns AUTH/GET:** move the server WS handler's hand-rolled `AUTH`/`GET`
  arms into `engine::handle_frame` (origin-resolver hook for `internal:/`) — stops
  the two-copies growth pattern; already produced one drift bug (see consolidation
  inventory item 1).
- [ ] **`LIVE_CONNECTIONS` leak:** prune on peer removal (consolidation inventory).
- [x] **Unified Iroh frame cap (2026-07-02):** `peer.rs` had three inbound
  length-prefix checks that had drifted apart (50MB / 50MB / 10MB) plus one
  completely unbounded read (the initiator's AUTH-response length prefix —
  a real DoS gap, `vec![0u8; auth_len]` with no cap at all). Consolidated into
  two named constants in `protocol.rs`: `IROH_FRAME_MAX_BYTES` (50MB, for
  frames read once a connection has proven identity) and
  `IROH_PREAUTH_FRAME_MAX_BYTES` (10MB, for frames read before identity is
  proven). First pass naively unified all three to 50MB, which quietly raised
  the unauthenticated accept-path bound 5×; corrected to keep the pre-auth
  path at the original, tighter 10MB instead. Applied per-frame based on the
  connection's own tracked `agent`, not per-loop, at all three sites that
  matter: the accept-side dispatch loop (`handle_stream`) and **also** the
  live-sync read loop (`register_live_peer`) both gate on `matches!(agent,
  ForAgent::Public)` — a connection can reach live mode while still `Public`
  (an unauthenticated peer that completes the handshake transitions into live
  mode with whatever agent it has), so the live loop needed the identical gate,
  not a flat cap; a first pass missed this and left it at a flat 50MB
  regardless of identity, caught on review. The initiator's own post-AUTH
  `SYNC_*` response read (`sync_drive_with_peer_using_outcome`) stays flat at
  `IROH_FRAME_MAX_BYTES` — it only runs after that connection's own AUTH has
  already succeeded, no `Public` case to gate on.
- [x] **F10 existence check (2026-07-02):** `apply_destroy_unchecked` used to derive
  `existed` from `remove_resource(..).is_ok()`, which conflated "never existed" with
  "existed, but the delete transaction failed" (e.g. a transient KV error) — both read
  as `existed == false`, so a real, still-present resource whose deletion merely failed
  could be misclassified as unknown and skip its tombstone. Now checks existence via a
  separate `get_resource` lookup before attempting removal.
- [x] **Dead code (2026-07-02):** `handle_stream_then_live` (pure pass-through
  wrapper, one caller, inlined); the private test-module `encode_get` duplicate in
  `protocol.rs` that shadowed the real `pub fn encode_get` (deleted; the test now
  exercises the real one); `WsClient::get_resource` (dead **and** broken — sent a
  legacy text `"GET "` frame the server hasn't parsed since the binary v2 GET path
  landed; zero callers anywhere in the repo — deleted). The `WsMessage::Resource`/
  `Commit` variants and their text-frame parsing are separately **unreachable** (a
  `match` arm existing in Flutter/a server test proves the variant compiles, not that
  anything produces it — nothing sends text `"COMMIT "`/`"RESOURCE "`, commits fan out
  as binary `UPDATE` only) but left in place: deletion spans into Flutter, out of
  scope for this pass — see the Dead code inventory table. `EPHEMERAL (0x40)` tag
  also left as-is — genuinely reserved for a future binary presence/cursor migration,
  not obviously dead.

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

> ✅ **Decided 2026-07-02: Option B.** Serverless P2P (Android ↔ Android,
> same agent, no hub) is a product requirement. Full plan:
> [`serverless-p2p.md`](./serverless-p2p.md). Consequences for this doc:
> F9-proper is unblocked (no longer gated on this decision); OQ4 resolves as
> "deletes travel as signed destroy commits"; the consolidation inventory's
> "engine owns all tags" item becomes load-bearing ("every peer is a hub");
> and the deletions below still happen — B replaces today's handshake/live
> machinery with `SyncSession`, it does not preserve it.

Historical context (pre-decision): the default recommendation was A for canvas v1.
The second audit raised the stakes — F9 (inbound auto-trust → drive exfiltration +
Sudo write) and F10 (DESTROY-spam tombstoning) are accept-path holes that Option A
would have deleted outright, while Option B requires fixing them properly. F8 and
F9-minimal landed before the decision since they were cheap either way.

## Implementation phases

### Phase 0 — Trust fixes (new; before more surface is built)

- [x] F2: local-state drive resolution (`989a8751`).
- [x] F3: session agent in live-mode fallback dispatch (`34fd15c2`).
- [x] F1 interim: skip VV push for subjects with pending outbox entries
  (`computeDriveSyncState`, browser-only, 2026-07-02).
- [x] F4: blob admission via pending-request map on the sync-protocol path;
  quota accounting was already correct (2026-07-02). HTTP `PUT /blob/{hash}`
  — the browser's primary upload path — gated the same day as its own
  follow-up item; see the F4 write-up above.
- [x] F5: structured error codes on `ERROR` (wire change) and `/commit`
  (`errorCode` JSON-AD field); outbox switches on code, string-matching is
  now the fallback for a `code` outside the known set — including a
  garbled value misread from a pre-F5 server's frame, which the first
  version of this fix got wrong (see F5's writeup above) (2026-07-02).

**Phase 0 complete** as of 2026-07-02 — F1 (interim), F2, F3 (+ follow-up), F4
(both the sync-protocol and HTTP write paths), F5 all fully fixed and tested.
Full audit findings F1-F6 status: F1 has an interim browser-side fix (the full
fix is the state-first wire change in Phase 3); F2, F3, F4, F5 fully fixed; F6
is still open (Phase 0 didn't include it — it's a lower-severity doc/naming
fix, tracked in the Engineering debt checklist above).

### Phase 0b — Second-pass trust fixes (2026-07-02 audit; substantially complete)

Ordered by severity. F8 and F9 outrank everything else in this doc. The former
Option A/B dependency is resolved (Open Question 2 → **Option B**,
[`serverless-p2p.md`](./serverless-p2p.md)): the "proper" F9 fix is now scheduled
work in that plan's Phase P0, not a decision-gated maybe.

- [x] F8: delete `SYNC_DELTAS` (server text handler + engine fn) (2026-07-02).
- [x] F9 minimal: no `add_known_peer` on the accept path (pairing/explicit action
  only) (2026-07-02).
- [ ] F9 proper (still open — **now unblocked**, Open Question 2 decided for
  Option B; scheduled as [`serverless-p2p.md`](./serverless-p2p.md) Phase P0):
  `check_read` on initiator `pull` serving; auth-back agent instead of `Sudo` on
  initiator import; **also** the initiator's ungated `apply_destroy` on
  `SYNC_DIFF.remove[]` for known subjects (see F10 below and Open Question 4 —
  resolved by "deletes travel as signed destroy commits").
- [x] F10: reject phantom tombstones for locally-*unknown* subjects from
  unprivileged peers (2026-07-02). **Does not** cover a known subject destroyed via
  the initiator's ungated remove-apply — that's F9 proper, above.
- [x] F11: tombstone cleared on rights-checked re-create (2026-07-02).
- [x] F4 follow-up: gate HTTP `PUT /blob/{hash}` (2026-07-02, see Engineering debt
  above) — the last unauthenticated write path in the server.
- [x] Cheap inconsistency sweep — **done:** docs `ERROR` layout, unified Iroh frame
  cap (kept pre-auth tighter than post-auth, see Engineering debt), `auth_buf` offset
  (landed earlier with F5's second-review fixes), `pending_blob_requests` TTL (same),
  tombstone key normalization test, dead-code deletions (`SYNC_DELTAS`, `sendBlob`,
  broken `WsClient::get_resource`, `handle_stream_then_live`, duplicate test-module
  `encode_get`). **Still open, not done this pass:** the other "4 more dead
  `WsClient` methods," `subscribeResource`/`unsubscribeResource`,
  `AUTHENTICATED` branches, `LIVE_CONNECTIONS` prune — not investigated; `EPHEMERAL`
  tag investigated and deliberately left (see Dead code inventory).
- [ ] Consolidation item 1 (engine owns `AUTH`/`GET`) — the structural fix; see
  the consolidation inventory. Do this before adding any new frame or frame
  feature, or the copies drift further. Not touched this pass.

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
- [x] Decide Option A vs B for Iroh — **Option B** (2026-07-02,
  [`serverless-p2p.md`](./serverless-p2p.md)); harden per that plan's P0/P1.

### Phase 4 — Tests

- [x] `ws_commit.rs`, `sync`/`query_subscribe` integration, browser vitest suite,
  `push_list_item_save_locally_persists_strokes`.
- [x] Regression: reconnect with backoff-pending outbox entry must NOT VV-push that
  subject unsigned (F1 interim) — `store.test.ts`.
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
| [`serverless-p2p.md`](./serverless-p2p.md) | **Option B execution plan** — same-agent device sync without a hub; owns F9-proper, OQ4/OQ6 resolutions, pairing, and the Iroh `SyncSession` transport. |

## Open questions

1. **Embedded server on mobile** — every install its own server, or shared hosted
   instance? (Affects `serverUrl` default.)
2. **Iroh default** — ✅ **Decided 2026-07-02: Option B** (serverless P2P is a
   product requirement; plan in [`serverless-p2p.md`](./serverless-p2p.md)).
   Unblocks F9-proper; resolves OQ4 below (signed destroy commits) and OQ6
   (same-agent AUTH proof *is* the pairing).
3. **Layer 2 provenance depth** — is `lastCommit`-id-only enough for same-agent
   replicas, or must `SYNC_PUSH` carry verifiable signed envelopes end-to-end
   (overlaps the high-audit profile in [`sign-at-drain.md`](./sign-at-drain.md))?
4. **P2P `remove` policy** — accept peer tombstones for same-agent reconcile, or only
   hub-signed destroys?
5. **Bootstrap admission (F2)** — what replaces `Err(_) => true` for a drive that
   doesn't exist locally yet: first-writer-wins with grace (as `AllowlistPolicy`
   does), explicit enrollment, or reject-until-known? Still open — F2's fix (`989a8751`)
   closed the existing-resource spoof but deliberately left this carve-out unchanged.
6. **What makes a peer "known"? (F9)** — today: any inbound connection. The fix says
   "pairing or explicit user action," but the pairing primitive itself is undefined
   (QR scan is one-directional trust; see [`sync.md`](./sync.md)'s handshake notes and
   the constrained append-only inbox in
   [`authorization-sync.md`](./authorization-sync.md)). Decide what ceremony grants
   known-peer status before rebuilding the accept path around it.
