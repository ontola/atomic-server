# Drive-scoped commit fan-out: tenant isolation + the chatroom regression

> **Status:** Shipped & verified (uncommitted on `did-rebased2`) — drive-scoped
> fan-out + a server-side drive safety net close both the leak and the chatroom
> regression. Full genesis-cert wiring (Part B) deferred. Builds on
> [`sync.md`](./sync.md) (the WS `UPDATE`/`DESTROY` fan-out channel) and
> [`genesis-self-verifying.md`](./genesis-self-verifying.md) (the immutable
> `drive` field this fan-out routes by). Full genesis-cert wiring is deferred to
> that doc's steps 2–4.

## Context

`commit_monitor`'s drive-wide WS fan-out broadcast every `did:ad:` commit to **all**
drive subscribers (DID subjects can't be prefix-matched to a drive URL, so the old code
gave up and sent to everyone). Two consequences:

1. **Cross-tenant leak (security):** agent A received agent B's commits.
2. **The e2e 401 flake (same root cause):** worker A's store ingested worker B's
   resources (foreign-drive); the rights check on that polluted state threw 401
   cascades. The flake was always "A's store ingests B's resources" — i.e. the leak.

Verified by a full 2-worker shared-server e2e run on the fix: **0 × 401** (was the
flake's signature). So the drive-scoped fan-out closes the leak *and* the flake at the
root — the per-worker e2e server harness becomes unnecessary (see §Per-worker harness).

## The fix (shipped, server-side)

Scope the fan-out to the resource's **owning drive**:
- `lib/src/subject.rs` — `Subject::is_within_drive(&self, drive)`: identity match
  (normalized `pure_id`, ignoring query hints / trailing slash); for URL subjects also a
  path-segment-boundary containment (so `…/d2` is not within `…/d` — what a bare
  `starts_with` got wrong); DID subjects match by identity only. (+ unit test.)
- `lib/src/resources.rs` — `Resource::get_drive()`: reads the genesis-stamped `drive`
  propval as a `Subject` (a direct pointer to the drive root; works for DID subjects).
- `server/src/commit_monitor.rs` — fan-out computes the resource's owner
  (`resource_new.get_drive()` for DID resources, else the subject itself) and delivers
  only to subscribers where `owner.is_within_drive(subscribed_drive)`. A DID resource
  with no drive reaches no drive subscriber rather than fanning out blindly.
- Tests: `server/tests/ws_commit_isolation.rs` (new — two agents, two private drives,
  asserts A never sees B's commit) + `server/tests/ws_drive_membership.rs` (updated to
  the production `create_did` path so the new resource carries its `drive`).

All green: `ws_commit_isolation`, `ws_drive_membership`, `subject::tests::test_is_within_drive`.

## The regression it exposed: cross-agent realtime (chatroom)

Drive-scoped fan-out needs a commit's resource to carry the **correct** drive. The
`chatroom` e2e (a *guest* invited to a drive they don't own replies in it) regressed:
the guest's reply reaches the server with **`drive=None`** (proven via a server-side
filesystem trace), so it's routed to no one and the owner never sees it. The old blind
fan-out hid this by broadcasting to everyone.

Chatroom messages are a live query (`useCollection({property: parent, value: chatroom})`,
`ChatRoomPage.tsx`); since `QUERY_UPDATE` was retired (`sync.md`), new members arrive via
the **drive-wide `UPDATE`** channel — so delivery hinges on the reply's drive being right.

**Root cause is client-side, not the DID mechanism.** `set(DRIVE_PROP,…)` writes `drive`
into the Loro doc at genesis, and `rebuildCacheFromLoro` (`resource.ts:624`) restores it
from the Loro map — *if it's there*. The guest's chatroom isn't reliably carrying `drive`
at reply-stamp time. Candidate mechanisms (to confirm during impl, §A2):
- (i) the guest's chatroom Loro doc lacks the genesis `drive` (delta-only / replaced doc);
- (ii) `drive` present then dropped by `rebuildCacheFromLoro` (it preserves only
  `lastCommit`/`createdAt`);
- (iii) chatroom not yet hydrated at reply time (invite-accept navigates before
  `fetchResourceFromServer` resolves — `InvitePage.tsx`).

Dead ends already ruled out: a broad `await store.getResource(parent)` in the genesis
hot path stalls bulk creation (breaks dev-drive setup); server-side drive resolution
conflicts with the signed-genesis-cert direction; the server does *not* strip `drive`
when serving.

## Part A — close the regression (LANDED)

**What actually fixed it: a server-side drive safety net.** The client-side path proved
un-instrumentable in this environment — the guest's reply is created via
`store.newResource` → sign-at-drain (`exportLoroDeltaForDrain` → `builder.sign`), not the
`resource.signChanges` chokepoint, and across the vite-dep-cache / web-worker / console
boundaries the reply consistently reached the server with `drive=None` regardless of the
client edits. Three independent client probes all came back null.

So the drive is now resolved **authoritatively on the server** at commit apply, where the
parent (and its drive) always exist:

- **`lib/src/commit.rs`** (`validate_and_build_response`, inside the new-DID-resource
  block beside the WRITE-grant): if a new DID resource has no `drive`, resolve it from the
  parent — `parent.get(DRIVE_PROP)`, or the parent subject itself when the parent is a
  drive root — and `set_unsafe` it on `resource_new`. This mirrors `create_did`'s stamp
  but runs server-side, so the fan-out (which reads `resource_new.get_drive()`) routes
  correctly no matter how the client created the resource. Idempotent — skipped when the
  client already stamped a drive. Verified: guest reply now arrives `drive=Some(owner)`.

Client-side improvements kept (belt-and-suspenders, correct regardless):
- `rebuildCacheFromLoro` (`resource.ts:636`) now preserves `drive` + `parent` (genesis-
  immutable) across a Loro delta rebuild.
- `signChanges` drive resolution is parent-first (the parent's drive is authoritative;
  the active drive is only a fallback), sync, no hot-path awaits.

> When the full genesis-cert wiring lands (Part B), `drive` becomes part of the *signed*
> identity and the client must stamp it correctly — at which point the server safety net
> becomes a redundant guard (or a verification check), not the primary mechanism.

**A4. Verified (clean):** `subject::tests::test_is_within_drive` ✓; full 2-worker
shared-server e2e — **0 × 401**, chatroom ✓, ontology ✓, 60 passed / 1 failed (the
pre-existing `search › text search` flake, passes in isolation) / 6 skipped; Rust
`ws_commit_isolation` + `ws_drive_membership` ✓.

**A5. Per-worker harness decision.** The 401 flake is fixed at the root, so the
uncommitted per-worker e2e server harness (`browser/e2e/global-setup.ts`,
`global-teardown.ts`, `playwright.config.ts` globalSetup, `test-utils.ts` per-worker
serverUrl) is redundant and adds 2× fastembed CPU contention — recommend reverting once
A4 is green (confirm with user).

## Part B — full genesis-cert wiring (deferred)

Lives in [`genesis-self-verifying.md`](./genesis-self-verifying.md) §"Code impact /
implementation order" (tasks #4–6). It makes `drive`/`parent`/`createdAt`/`createdBy`
ride inline on the signed cert (race-free, offline-verifiable) — a breaking DID-derivation
change. Touch-point map for that effort: sign `GenesisCert` instead of the commit in
`lib/src/commit.rs::create_did` (~L279) + TS `signChanges`/`CommitBuilder.signAt` (wasm
delegates); persist + reject-overwrite the `genesis` propval at the existing
`createdAt`/`createdBy` chokepoint (`commit.rs:~512`); materialize from the cert in
`resources.rs::materialize_genesis_metadata` (~L128). Reuse the existing
`GenesisCert`/`encodeGenesisCert` APIs already built in `genesis.rs`/`genesis.ts`.
Not in this change.

## Verification (commands)

```
ATOMICSERVER_SKIP_JS_BUILD=true cargo test -p atomic-server \
  --test ws_commit_isolation --test ws_drive_membership
cargo test -p atomic_lib --lib subject::tests::test_is_within_drive
cd browser/lib && pnpm exec vitest run src/resource.test.ts
# e2e clean: atomic-server :9883 + vite :5173, rm -rf data-browser/node_modules/.vite
cd browser/e2e && ATOMIC_NO_PER_WORKER_SERVER=true SERVER_URL=http://localhost:9883 \
  FRONTEND_URL=http://localhost:5173 pnpm exec playwright test --project=chromium
# expect: chatroom green; 0 occurrences of "401"; search/ontology are pre-existing flakes
```

## Cross-references
- [`sync.md`](./sync.md) — WS `UPDATE`/`DESTROY` fan-out channel + test-coverage table
  (add `ws_commit_isolation`).
- [`genesis-self-verifying.md`](./genesis-self-verifying.md) — the `drive` field, its
  materialization, and the deferred full cert wiring.
