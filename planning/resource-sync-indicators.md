# Resource sync: remaining destinations

Resource-row indicators, the “Copies & sync” panel, browser server-confirmation
recovery and per-resource Cloud Vault confirmations are implemented in draft
PR #2576. WebRTC and native Iroh peer confirmations are implemented and locally
validated, including the embedded native renderer. Separate attachment-byte
confirmation is implemented and locally validated in the real app. This plan remains
open for legacy Tauri integration, production infrastructure validation and
multiple-server configuration. Native WebRTC requester and embedded evidence are
implemented and locally validated for resource details and attachment contents. Exact-commit CI is tracked on the PR.

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

`getResourceReceipts` and `putResourceReceipts` (one pair for the server and
Vault destinations, addressed by a `{server}` or `{vault}` scope) plus
`getResourceVaultGeneration` and `clearResourceVaultReceipts` use the existing
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

- [x] Confirm attachment bytes separately from resource data, for each supported
  destination, before claiming a complete file copy.
- [x] Add typed WebRTC per-peer receipts after verified persistent storage.
  Expose resource copy counts independently of connection counts, including
  peer departure, browser-tab lifetimes and identity changes.
- [x] Extend per-resource evidence to native Iroh and its embedded renderer.
- [x] Extend native WebRTC requester/UI evidence for resource details and bytes.
- [ ] Extend the legacy Tauri local-HTTP renderer.
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


## Attachment confirmations

Builds on native Iroh head `7968972a6b1e6762feedcb698dd47c414603978f` in the
same owned worktree/branch. The original checkout remains at its recorded dirty
baseline. Reuse the committed encrypted Vault file pipeline from
`bf2c4125161d0144b1b31bd5b2d58444a5a89dfc` (#2495), preserving this branch's
resource receipts; do not merge unrelated develop changes. File/chunk validation
may adapt `1021eba25` without importing drive-level confirmation semantics.

- [x] Audit byte identity, durability, transfers and existing dependencies.
- [x] Integrate encrypted Vault file backup dependency and settle conflicts.
- [x] Define bounded exact attachment descriptors and shared byte verification.
- [x] Add local/server/peer byte evidence with authorization and lifecycle fences.
- [x] Record scoped Vault proof only after all required encrypted chunks confirm.
- [x] Present resource details and contents separately; complete destination
  confirmations require both. Unsupported or missing contents remain unknown.
- [x] Validate corruption, partial/missing bytes, hash replacement, reload,
  deletion/GC, late replies and scope changes at unit/integration/UI layers.
- [x] Update protocol/product docs, coverage and actual desktop/mobile screenshots.
- [x] Run required lint/format, type, compiler and Rust checks.
- [x] Publish attachment implementation to PR #2576.
- [ ] Follow exact-head CI; the shared Mancave runner remains queued.

Content identity is independent of the metadata version: renames must not erase
valid byte proof, while changed blob/chunk references immediately lose coverage.
Use explicit supported File representations (BLAKE3 blob, ordered chunks and
legacy hash-backed files); do not imply coverage of arbitrary external document
URLs. File existence, lengths, drive sync timestamps and metadata receipts alone
are insufficient. Large-file verification must be bounded and avoid blocking
transport keepalives. Shared storage identities must not inflate copy counts.

Coordinator owns dependency integration, UI, catalogs, docs and publishing.
`sync_ui` owns Rust storage/protocol/host/WASM implementation;
`sync_architecture` owns library/Store/Vault orchestration and independent review;
`sync_ui_tests` owns independent regression and end-to-end acceptance.

Attachment proof limits and lifecycle decisions: local byte verification admits
64 MiB per stored blob/chunk, 512 MiB per batch, two active batches and a bounded
cache under blob/backend generations. Current metadata and ACL are checked for
every request. Peer byte receipts refresh every 10 seconds and expire after 30
seconds without new proof; remote byte loss cannot retain a permanent checkmark.
S3 can provide HTTP evidence using complete-object/version checks plus verified
reads, but external blob backends do not emit peer byte receipts under their
metadata KV identity. Vault captures persisted drive manifests rather than only
loaded UI resources, assembles supported split files and verifies reused sealed
chunks before writing private scoped proof.

The browser cache has no Rust default signing agent. Its local byte checks and
Vault inventory use the existing trusted local resource/blob access boundary;
remote HTTP and peer checks still require their authenticated agent. Regression
coverage verifies both private-cache confirmation and anonymous remote denial.

The details panel loads on demand and opens only once its module is ready,
keeping the embedded initial payload within the unchanged 1000 kB gzip budget
(999.1 kB locally). The final mobile local/server journey passed twice with
strict browser diagnostics and zero retries; the matching native Iroh renderer
journey also passed. Repeated browser fixtures use unique contents because the
server correctly reuses identical content-addressed blobs across test drives.


## Native WebRTC confirmations (active phase)

Continues on owned branch `codex/atomic-resource-sync` from
`14bd4ace5bab20ba5992a7444500aab4b6d22845`, without merging unrelated develop
changes. Original checkout status is recorded outside the repository at
`/tmp/atomic-resource-sync-native-webrtc-original-status.txt`.

- [x] Review shared receipt session, native WebRTC lifecycle and renderer bridge.
- [x] Negotiate resource and attachment evidence only after mutual authentication.
- [x] Request exact stored versions and content manifests using bounded queues.
- [x] Share the native live evidence ledger while fencing transport/session,
  agent/storage identity, resource removal and late responses.
- [x] Expose native WebRTC evidence through the existing copies panel; retain
  shared-storage deduplication across transports and metadata/bytes matching.
- [x] Test unsupported peers, disconnect/close/reload, edits and attachment
  replacement at Rust and library layers.
- [x] Validate actual browser/native WebRTC resource and attachment confirmation
  through the renderer, with strict diagnostics and zero retries.
- [x] Update public docs and coverage; run focused checks and matching builds.
- [ ] Publish to PR #2576 with required hooks and follow exact-head CI.

Ownership: `sync_ui` owns Rust session/transport implementation and unit tests;
`sync_architecture` owns architecture review and browser-library bridge parsing;
`sync_ui_tests` owns independent acceptance fixtures/tests; coordinator owns
integration, plan/docs/coverage, builds, review and publishing. Only coordinator
runs frontend builds/catalog extraction. Tests must distinguish a native Rust
protocol host using a test data-channel carrier from packaged Flutter and real
physical-device/TURN acceptance.


Approved integration contract: retain the native receipt queue/verifier and add
transport-specific session liveness plus output framing. A unique per-link
WebRTC token replaces Iroh's live-peer registry for that session; only mutually
authenticated links with advertised browser-storage/attachment capabilities can
start requesting proof. Raw frames leave through the existing live-frame API,
so Flutter bridge bindings need no new method. Embedded evidence uses a separate
`webrtc:` connection namespace while preserving storage-identity deduplication.
The current native package enables `iroh`; builds without that feature retain
existing WebRTC responder behavior and must continue compiling. This phase does
not broaden that build-feature contract or add a second WebRTC transport stack.


Validation review found that a native WebRTC handshake during a local write batch
could leave optional requester setup permanently unavailable. Setup now marks
success only after acquiring durable identity and retries on periodic reconcile;
unsupported capabilities remain a cheap no-op. A regression covers the blocked
handshake, committed batch, single requester recovery and close.


Final local validation: 32 Rust WebRTC/shared-receipt cases and 52 focused library
cases passed; native db-only compilation, frontend/library/E2E types and rustfmt
passed. Matching WASM/library/embed/web/server builds passed, with 999.1 kB gzip
initial embed payload within the unchanged 1000 kB limit. The actual mixed
browser/native WebRTC journey passed 1/1 (73.622s), and the Iroh renderer
regression passed 1/1 (75.543s), both with strict diagnostics and zero retries.
The Iroh fixture initially timed out before emitting any Rust output; direct
executable startup then succeeded and the unchanged-timeout rerun passed.
Phase7 screenshots are shared outside the repository. Packaged Flutter/device
transport and production TURN remain separate acceptance boundaries.
