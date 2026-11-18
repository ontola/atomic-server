# Resource sync: remaining destinations

Resource-row indicators, the “Copies & sync” panel, browser server-confirmation
recovery and per-resource Cloud Vault confirmations are implemented in draft
PR #2576. WebRTC and native Iroh peer confirmations are implemented and locally
validated, including the embedded native renderer. This plan remains open for
attachment confirmation, native WebRTC and legacy Tauri integration, and
multiple-server configuration. Exact-commit CI is tracked on the PR.

## Ownership and dependency

- Worktree: `/Users/michieldejong/.codex/worktrees/atomic-resource-sync/atomic-server`
- Branch: `codex/atomic-resource-sync`
- Original base: `origin/develop`, `f445d2909c50506c74c798cd8d891e99e8962780`
- Vault work builds on unmerged reload-recovery commit
  `41dbfdb41feb608c6745eb952df7886810d11822` in the same PR.
- Design follows the concept reviewed with Michiel in chat
  `01a1e484-5764-75e0-8345-7269b13e7717`.
- Coordinator owns UI/integration/docs/catalogs/PR/CI; `sync_architecture` owns
  app-level proof and backup orchestration; `sync_ui` owns Rust/WASM/library
  storage and independent review; `sync_ui_tests` owns UI/backup/browser tests.
- The original checkout's pre-existing untracked files remain outside this task.

## Existing contracts to preserve

Local/server evidence comes from actual durable snapshot bytes, acknowledged
commits and exact updates from the current authenticated primary server. It is
version scoped and survives browser reloads. Idle queues, connection status,
`ResourceSaved` and generic peer traffic cannot establish a server receipt.
Newer edits remain pending. Own-echo server metadata must also be persisted
without re-notifying active editors. Old/native adapters without the evidence
capability cannot invent recovered proof.

Vault export supplies a **local-only** resource-version manifest derived from
actual update entries in the sealed object. Unchanged lane cursors, no-op passes,
workspace backup times, occupied-object collisions and another account's backup
cannot mint new proof. PUT and confirm-upload must succeed; checkpoints must
also publish successfully. The manifest never enters plaintext cloud requests.

Private Vault receipts are scoped to managedAccount (the internal account key),
agent, portalUrl (including its meaningful API path), drive, drivePseudonym and
keyEpoch. The ledger lives in the app layer, keeping managed-account semantics
out of Store. Rows batch local reads and do not request account/enrollment data.
Automatic/manual backup establishes scope only after verifying the current
account and enrollment; a no-op pass can then recover existing durable proof.
A fresh fully offline reload cannot establish that account and stays unknown.
An already verified session retains proof while offline; explicit account,
provider, database and lifecycle changes invalidate its context.

`getResourceVaultGeneration`, `getResourceVaultEvidence`,
`putResourceVaultReceipts` and `clearResourceVaultReceipts` use the existing
private encrypted receipt tree. Resource removal clears its receipts. Explicit
Vault disable rotates a durable scope generation; every export captures it
before encryption and every write must match it. This rejects delayed writes
from other tabs and worker-handoff retries after disable. A replayed clear may
conservatively invalidate a newer capture, but can never accept an older one.
Corrupt generations fail closed rather than resetting the fence.

Async setup, receipt reads and callbacks are fenced by scope/resource tokens.
Restored proof requires a valid durable snapshot. Receipt persistence joins
normal reload readiness; diagnostic storage failures withhold proof without
failing an otherwise successful backup. Clearing proof before a UI context was
mounted uses the explicitly verified scope. Existing latest-checkpoint and
coverage protections make normal Vault compaction safe without blanket erasure.

The panel presents independent local/server/Vault states. A confirmed server
retains the primary icon; Vault can be primary when the server copy is unknown
or unconfigured. Unsaved edits and server failures/pending work remain visible.
Shapes and labels accompany colour. File contents are not confirmed by resource
metadata receipts. Browser peer evidence is now a separate session-scoped ledger
based on authenticated stored-version acknowledgements, described below.

## Remaining work

- [ ] Confirm attachment bytes separately from resource data, for each supported
  destination, before claiming a complete file copy.
- [x] Add typed WebRTC per-peer receipts after verified persistent storage.
  Expose resource copy counts independently of connection counts, including
  peer departure, browser-tab lifetimes and identity changes.
- [x] Extend per-resource evidence to native Iroh and its embedded renderer.
- [ ] Extend native WebRTC requester/UI evidence and the legacy Tauri local-HTTP
  renderer; native WebRTC responders already use the shared receipt handler.
- [ ] Extend configuration when multiple active servers are supported, then
  derive the primary indicator from the user's intended destinations.
- [x] Validate real peer-only journeys before enabling success icons. Browser
  tabs must not be presented as durable remote backups.
- [ ] Run the Vault acceptance journey against an explicitly provisioned real
  control plane and S3; the local HTTP boundary fixture is not that validation.
- [ ] Update public docs, coverage and browser acceptance alongside each new
  evidence source; follow exact-head CI before removing this remaining plan.

See `unified-sync.md`, `atomic-lib-runtime.md` and `sync-onboarding-ux.md` for
transport/runtime boundaries. The mockup's multiple authoritative destinations
remain a target rather than a capability inferred from several rendered rows.

## Browser peer contract

WebRTC confirmation is implemented on this branch at
`3faa50118e4c0393961faccfc4d999b3292dc9d9`, building on Vault commit
`4f1adad7d119a2c888989e1d839a477de7ba87f7`. The protocol, scoped storage
identity and bounded requester adapt `788bc98682b6aae91995e578afa968d716745ce7`
without importing the separate SaveReceipt/evidence-policy API stack.

Proof belongs to an authenticated live session and exact stored version. Shared
storage counts once; newer edits, removal, disconnect and account/database
changes invalidate coverage as appropriate. Browser-owned connections require
fresh proof after reload. The real WebRTC acceptance covers these cases with
strict diagnostics. Production signaling/TURN and mixed browser/native WebRTC
remain separate release checks. Native full-drive/blob confirmation work uses
different frames and does not establish individual resource evidence.

Current local validation and exact-head CI results are recorded on PR #2576;
coverage and unverified boundaries are maintained in `TESTING_COVERAGE.md`.

## Native Iroh resource confirmations

This phase builds on this PR's WebRTC commit
`3faa50118e4c0393961faccfc4d999b3292dc9d9`. It selectively adapts the native
receipt producer/requester from `166e64fc63734726a8ef35a729e5f66c0033eeeb`
(`codex/atomic-iroh-receipts-2538`), without importing that branch's separate
save-policy API stack. The optional `iroh-storage-receipts-v1` capability uses
the same resource receipt frames; full-drive/blob confirmations remain separate.

Ownership for this phase:
- `sync_ui`: Rust shared producer, native transport/requester, per-Db live
  evidence, EmbedHost bridge and unit regressions.
- `sync_architecture`: architecture, NativeClientDb/Store polling and tracker
  integration, independent review.
- `sync_ui_tests`: native two-process acceptance and renderer integration tests.
- Coordinator: integration, documentation, validation, PR and CI.

Acceptance and design:
- [x] Review native authentication, stored-state proof and renderer ownership.
- [x] Negotiate exact-version receipts only on mutually authenticated native
  links; retain normal sync with older or unsupported peers.
- [x] Maintain bounded live evidence owned by the native database, fenced by
  local agent/storage identity and connection generation. Closing a session
  removes its evidence; opening a renderer can read existing live evidence.
- [x] Expose authorized resource evidence through the existing host bridge.
  Poll only mounted resource subscribers, batch requests, reject stale replies
  and clear unavailable evidence. The renderer opens no transport.
- [x] Reuse current peer presentation and storage-identity deduplication. Newer
  local edits remain pending until their exact version is confirmed.
- [x] Invalidate native receipt targets and retained evidence across deletion
  and identical-version recreation, including changes through shared-store facades.
- [x] Validate native bulk/live/reopen and departure across real processes,
  plus renderer identity changes, malformed evidence and old-host fallback.
- [x] Update public protocol/product docs and coverage; run required checks.
- [x] Prepare this phase for the existing PR #2576.
- [ ] Follow exact-head CI; runner availability can block the main pipeline.

Evidence is session-local and metadata-only. Distinct storage identities do not
establish independent physical devices, retention, attachment coverage or a
recoverable backup. Native WebRTC requester integration is separate from this
Iroh phase; its shared responder remains supported.
