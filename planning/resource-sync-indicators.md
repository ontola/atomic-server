# Per-resource copies and sync

Status: first slice implemented and locally validated, 2026-11-17.
PR/CI completion and the subsequent phases remain open. Design follows the resource-list
concept reviewed with Michiel in chat `01a1e484-5764-75e0-8345-7269b13e7717`.

## Work ownership

- Worktree: `/Users/michieldejong/.codex/worktrees/atomic-resource-sync/atomic-server`
- Branch: `codex/atomic-resource-sync`
- Base: `origin/develop`, `f445d2909c50506c74c798cd8d891e99e8962780`
- Coordinator: integration, public documentation, coverage map, catalogs,
  validation, PR and CI. `sync_architecture`: `browser/lib` evidence and unit
  tests. `sync_ui`: ResourceSync components/hooks, ResourceRow and DriveHome
  interaction guards. `sync_ui_tests`: UI regression tests and the resource-sync
  Playwright specification. Agents do not commit or change branches.
- The original checkout's existing untracked files are outside this task.

## Outcome

Each resource row has a quiet status button. Activating it opens “Copies &
sync”, with the resource's local and remote save state. Destination shapes and
text distinguish servers, vaults and browser peers; colour is supplementary.
Connection and presence are never treated as proof that a resource was saved.

## Steps

- [x] Isolate work and inspect existing resource rows, save-state hooks and
  drive-wide sync/vault/peer status.
- [x] Finalize the evidence contract and acceptance cases.
- [x] Add per-resource local/server confirmation evidence and subscriptions.
- [x] Implement the resource-row indicator and accessible details panel using
  existing Atomic UI primitives.
- [x] Surface vault/peer context without claiming an unconfirmed resource copy.
- [x] Cover offline edits, failed saves/retries, concurrent newer edits, and
  resource/destination/identity changes at the cheapest relevant test layers.
- [x] Verify desktop and mobile interaction in the real app; capture screenshots.
- [x] Update public docs, coverage map and translation catalogs.
- [ ] Review, push, open PR against `develop`, dispatch and follow exact-head CI.

## Acceptance criteria

- An idle save state, connected server, authenticated peer, or drive backup
  timestamp alone never yields a resource-level “up to date” claim.
- A server acknowledgement covers only the state actually sent; newer edits
  remain pending. Going offline preserves a previously confirmed copy while
  making current connectivity explicit.
- Browser persistence is reported independently of server acknowledgement;
  failed/unavailable local storage is not labelled saved locally.
- One resource's pending or failed edits do not mark unrelated resources as
  failed. Changing destination cannot inherit the old destination's receipt.
- Browser-peer copies are not described as durable remote backups.
- Buttons have accessible names; clicking them does not navigate the row.
  Escape/outside dismissal and focus return use the existing overlay primitive.
- The panel fits narrow screens and uses existing theme colours.

## Current evidence and phased delivery

`useSaveState` already exposes per-resource dirty, scheduled, saving, queued,
error and idle states. `StoreSyncStatus`, peer connection strings and vault
metadata are drive-wide and cannot substantiate resource-copy claims.

The first implementation will expose evidence the current save/persistence
paths can actually provide. Unconfirmed destinations remain explicit. Follow-up
work, if needed after the audit, adds per-resource vault manifests and peer
receipts keyed to the exact replicated version, then durable receipt recovery
across reloads. These must not be simulated from timestamps or presence counts.
The full multi-destination appearance in the mockup is a target, not evidence
that the current store supports several authoritative servers simultaneously.

See `unified-sync.md`, `atomic-lib-runtime.md` and `sync-onboarding-ux.md` for
existing transport/runtime boundaries. No protocol or persistence rewrite is
part of the initial UI slice.

## First implementation contract

`Store.getResourceSyncStatus(resource)` returns a stable immutable snapshot;
`subscribeResourceSyncStatus(resource, callback)` updates consumers. `local`
distinguishes confirmed, pending, unknown, unavailable and error. `server`
distinguishes confirmed, pending, unknown and not-configured and carries the
destination URL. Confirmations retain a timestamp and are scoped to the
current identity, database/destination and exact Loro version evidence.
`useSaveState` supplies actionable queued/error/dirty status independently.

Evidence comes from completed local writes, acknowledged server commits and
exact update bytes received from the current authenticated primary server,
never from `ResourceSaved` alone (which also fires for local-only resources),
generic incoming peer data, or an empty outbox. Server replies include metadata
operations not present in the outgoing commit, so their version coverage must
also be recorded; the merged live document must never be used as the receipt. Receipts are session-local in
this slice. File bytes require separate coverage and are not covered by a
resource-metadata receipt. Server/vault classification and context reads belong
in the open panel, not one network request per row.

## Subsequent steps

- [ ] Persist and safely rehydrate version-scoped confirmations across reloads,
  including restored resource state and changes to configured destinations.
- [ ] Add resource/version coverage to confirmed Cloud Vault exports; distinguish
  resource data from attachment bytes and backups by another account.
- [ ] Add typed per-peer resource receipts after applied/persisted reconciliation
  and live updates; expose confirmed peer counts independently of connection
  counts, including peer departure and identity changes.
- [ ] Extend destination configuration when the runtime supports multiple active
  servers, and derive the primary indicator from the user's intended targets.
- [ ] Validate real vault and peer-only journeys before enabling their success
  icons. Keep colour paired with shape and accessible text.

## Validation notes

- Library evidence, WebSocket and adjacent save/outbox/transport tests: 116 passing.
- Final frontend suite under TZ=UTC: 2,614 Vitest tests and 2 MCP integration
  tests passing. All 6 catalogs complete (35 new strings translated into 5
  languages). The unchanged date-formula test fails in Europe/Amsterdam because
  it uses July dates with the current November offset; its 27 tests pass under
  UTC. No unrelated formula code was changed.
- App/library builds, TypeScript checks and new component compiler checks pass.
  The shared Popover retains an existing ref-during-render compiler diagnostic.
- Browser acceptance found server-added metadata operations missing from the
  outgoing receipt. The regression now requires exact authoritative incoming
  bytes to extend coverage, while excluding newer local edits and peer traffic.
  Final Chromium acceptance passes (one test, one worker, zero retries) against
  the matching native dev build. Desktop and mobile screenshots were reviewed;
  keyboard dismissal/focus and mobile footer scrolling pass.
