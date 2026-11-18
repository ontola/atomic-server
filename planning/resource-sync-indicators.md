# Resource sync: remaining destinations

Resource-row indicators, the “Copies & sync” panel, browser server-confirmation
recovery and per-resource Cloud Vault confirmations are implemented in draft
PR #2576. WebRTC peer confirmation is implemented and locally validated. This plan remains open for
attachment confirmation, native per-resource peer evidence and multiple-server
configuration. Exact-commit CI is tracked on the PR.

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
- [ ] Extend per-resource evidence to native Iroh and native requester/UI paths;
  native WebRTC responders already use the shared receipt handler.
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

## Validation baseline, 2026-11-18

- Targeted Rust storage/export, library adapter/handoff/parser tests pass,
  including generation rotation/replay, durable reopen, scope isolation and the
  exact exported version versus unchanged/later edits.
- Vault ledger/automatic/manual/native regressions: 66 passing; backup
  orchestration: 73 passing; ResourceSync UI: 20 passing.
- Full frontend typecheck, matching lib/WASM/UI/native builds and all six
  translation catalogs pass. Five new messages are translated. Component compiler
  checks pass; the manual Vault hook's existing suppression diagnostic was
  independently reproduced against HEAD before these changes.
- Four distinct native Chromium tests pass across the integrated run and
  targeted rerun, one worker and zero retries. The new two-test Vault spec uses
  real WASM encryption and durable storage with a test-owned HTTP service: it
  checks successful backup, same-account reload without a new upload, account
  isolation, edits during upload and failed upload. It does not claim live S3 or
  control-plane validation. Desktop/mobile/footer/pending screenshots were
  reviewed and shared in chat. Test diagnostics remain strict; no ResizeObserver
  errors are suppressed.
- Previous server phase: 134 library regressions, 40 adapter/storage regressions,
  seven Rust receipt tests and seven distinct native browser checks passed. The
  first-phase full frontend baseline was 2,614 Vitest and two MCP integration
  tests under TZ=UTC. The unchanged date-formula test depends on DST; no unrelated
  formula code was changed. Exact-head CI results belong on PR #2576.

## Peer confirmation phase (in progress, 2026-11-18)

Authorized in the same chat, based on unmerged Vault commit
`4f1adad7d119a2c888989e1d839a477de7ba87f7`. Reuse this owned worktree/branch.
The original checkout still has only the four baseline untracked entries.

- [x] Review existing `browser-storage-receipts-v1` work on
  `codex/atomic-peer-receipts-2538` and reuse its protocol where applicable.
- [x] Add authenticated, exact-version resource peer evidence after the
  receiver's storage barrier; connection counts and generic sync completion
  must never create confirmations.
- [x] Scope evidence to peer identity and live connection generation. A closed
  or replaced browser tab cannot count as a currently available copy. Shared
  local storage must not be counted again merely because another tab is open.
- [x] Present distinct browser copies, current/pending/unavailable state and
  confirmation time, with a distinct peer icon and clear browser availability.
- [x] Verify initial reconciliation, newer edits, departure, reload, legacy
  peers and failed/malformed acknowledgements at appropriate layers.
- [x] Run actual browser peer acceptance, capture desktop/mobile UI, settle
  translations, update docs/coverage, and independently review integration.
- [ ] Commit/push this phase to the existing PR and follow exact-head CI.

Ownership for this phase: coordinator owns UI/docs/catalogs/plan/PR/CI;
`sync_architecture` owns the bounded design and then JS evidence/transport;
`sync_ui` owns Rust/WASM/backend adapter bridges; `sync_ui_tests` owns UI and
browser acceptance tests. No other task's worktree will be modified.

The backend protocol, scoped backing-store identity and bounded request design
are adapted from `788bc98682b6aae91995e578afa968d716745ce7` on
`codex/atomic-peer-receipts-2538`. This phase integrates that contract directly
with resource status and does not import the separate SaveReceipt/evidence-policy
API stack. Shared wire definitions are intentionally identical. Native Iroh's
full-drive/blob confirmation work (`1021eba25`, different protocol frames) is
not sufficient evidence for an individual resource and remains a separate
dependency. Browser proof is session-only: reloading requires fresh evidence.


Peer validation: 23 Rust peer-session tests, 3 backing-store identity tests,
3 flush/concurrency tests, 13 existing server/Vault receipt storage tests and
22 adapter tests pass. Focused final peer JS tests: 42 pass; the earlier combined
server/peer regression run passed 83 tests, with later legacy/live-send race
cases verified in their affected suites. ResourceSync UI tests: 25 pass. Full
frontend/E2E typechecks, library lint, compiler checks, matching builds and all
six translation catalogs (3,088 active messages, zero missing) pass.

Five distinct native Chromium journeys pass across the initial combined run
(existing server/Vault four) and targeted peer rerun (one worker, zero retries).
The peer test checks real WebRTC/WASM receipts, paused receiver/newer edits,
shared-storage tabs, peer departure/reload and absence from server inventory.
Only rendezvous is a test fixture; production signaling, TURN and a live mixed
browser/native journey remain separate acceptance. Initial peer test setup was
corrected to wait for active server sync to finish and set preferences only on
the app origin; strict diagnostics remain enabled. Exact-head CI is tracked on
PR #2576 rather than inferred from these local results.
