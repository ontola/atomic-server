# Resource sync: remaining destinations

The resource-row indicator, “Copies & sync” panel and browser confirmation
recovery are implemented in draft PR #2576. This plan remains open for the
unfinished Vault, peer and multiple-server dependencies below; completed
implementation checklists have been removed. Exact-commit CI is tracked on the PR.

## Ownership and dependency

- Worktree: `/Users/michieldejong/.codex/worktrees/atomic-resource-sync/atomic-server`
- Branch: `codex/atomic-resource-sync`
- Original base: `origin/develop`, `f445d2909c50506c74c798cd8d891e99e8962780`
- Reload recovery builds on unmerged first-phase commit
  `34ef7e44b5e278f9140797e868436dc9777e5a76` in the same PR.
- Design follows the resource-list concept reviewed with Michiel in chat
  `01a1e484-5764-75e0-8345-7269b13e7717`.
- Coordinator owns integration/docs/catalogs/PR/CI; `sync_architecture` owns
  Store/tracker evidence; `sync_ui` owns database/WASM/worker persistence;
  `sync_ui_tests` owns browser regressions and independent review.
- The original checkout's pre-existing untracked files remain outside this task.

## Existing contract to preserve

`Store.getResourceSyncStatus(resource)` returns a stable immutable snapshot;
`subscribeResourceSyncStatus(resource, callback)` updates consumers. Local
states are confirmed, pending, unknown, unavailable and error. Server states
are confirmed, pending, unknown and not-configured, with the destination URL.
`useSaveState` independently supplies queued/error/dirty save status.

Confirmation covers only observed Loro versions: durable local writes or stored
snapshot bytes, acknowledged server commits and exact updates from the current
authenticated primary server. Idle queues, `ResourceSaved`, drive backup times
and peer presence are insufficient. Server metadata imported through an own-echo
must also be saved locally, without re-notifying active editors. Attachment bytes
are excluded from resource-metadata receipts.

Browser adapters expose optional `getResourceSyncEvidence(subjects, scope?)`
and `putResourceSyncReceipts(scope, receipts)`. The private `sync_receipts_v1`
database tree scopes server proof by canonical account, destination origin and
resource. Reads return actual stored snapshot bytes after a durability barrier.
Restored local proof does not invent the original save time. Recovered server
proof preserves the acknowledged vector and confirmation time; newer offline
edits stay pending. Older/native adapters without this capability retain live
session evidence only.

Receipt merges and deletion cleanup are atomic across database clones and tabs.
Receipts never enter resource queries, replication, outbox rows or Vault exports.
Scope/generation fences reject delayed recovery after account, database,
destination or transport changes. Cache eviction retains disk proof. Normal
pending-sync accounting includes receipt persistence; a diagnostic write failure
never fails an otherwise accepted resource save.

Buttons remain accessible and do not navigate their resource row. Existing
popover primitives handle dismissal and focus return; shapes/text accompany
colour. Vault and peer details currently provide workspace context only.

## Remaining work

- [ ] Add resource/version coverage to confirmed Cloud Vault exports; distinguish
  resource data from attachment bytes and backups by another account.
- [ ] Add typed per-peer receipts after applied/persisted reconciliation and live
  updates. Expose confirmed peer counts independently of connection counts,
  including peer departure, browser-tab lifetimes and identity changes.
- [ ] Extend configuration when the runtime supports multiple active servers,
  then derive the primary indicator from the user's intended destinations.
- [ ] Validate real Vault and peer-only journeys before enabling success icons.
  Browser-peer copies must not be described as durable remote backups.
- [ ] Update public docs, coverage and browser acceptance alongside each new
  evidence source; follow exact-head CI before removing this remaining plan.

See `unified-sync.md`, `atomic-lib-runtime.md` and `sync-onboarding-ux.md` for
transport/runtime boundaries. Multiple authoritative destinations in the mockup
remain a target; they are not supported merely by rendering several rows.

## Validation baseline, 2026-11-18

- Store/tracker/transport/save: 134 tests passing, including reentrant
  subscriptions during account/server switches and stale asynchronous reads.
- Storage/worker/Node/handoff: 40 tests passing across five suites. Rust receipt
  storage: seven passing; `db-sled` check passes.
- Focused ResourceSync/ResourceRow/catalog UI: 29 passing. Library and frontend
  typechecks, component compiler check, and matching lib/WASM/UI/native builds pass.
- Seven distinct native Chromium tests pass across the integrated run and
  targeted rerun, one worker and zero retries. The reload test disables all
  browser networking, restores both confirmations, preserves the server timestamp,
  then reloads a newer offline edit and proves it remains pending. Its initial
  failure was only on expected disconnected-network diagnostics; bounded,
  test-specific expectations keep unrelated diagnostics strict.
- Desktop/mobile and both offline-reload screenshots were reviewed and shared in
  chat. The previous CI own-echo persistence failure and ambiguous profile Save
  locator are corrected and covered by this browser set.
- First-phase full frontend baseline: 2,614 Vitest and two MCP integration tests
  passed under TZ=UTC. An unchanged date-formula test depends on the current DST
  offset; no unrelated formula code was changed. The shared Popover has a
  pre-existing compiler warning. Exact-head CI results belong on PR #2576.
