# Version-specific save receipts (#2538)

- Worktree: `/Users/michieldejong/.codex/worktrees/atomic-save-receipts/atomic-server`
- Branch: `codex/atomic-save-receipts-2538`
- Deliberate base: `2341c40a37d8e4ef9677815a3c753d541b0676ed`, PR #2567
  (`codex/atomic-local-durability-2538`). Required local persistence and retry
  preservation are prerequisites; this PR targets that branch until it lands.
- Latest inspected develop: `ee1e896d6bb1b3aa05792e657b0b95d6067e188b`.
- Align with receipt-only contract from closed, unmerged #2244 at
  `badccc6691fcd8569b26c92906febcbd66eaf7f3`; do not import its routing/Vault stack.
- #2568 independently changes the unsaved-parent status to `queued`. Until then
  its legacy status remains, with no receipt evidence. No TablePage (#2537) edits.
- Implementation agent owns `browser/lib/src/resource.ts`, `store.ts`, receipt
  tests and necessary narrowly related library tests. Coordinator owns public
  docs, architecture notes, coverage, build/integration and publication.

## Contract

Add `Resource.saveWithReceipt(opts?: { background?: boolean })` alongside
compatible `save(opts)`. Keep #2244's `SaveReceipt`, `LocalSaveReceipt` and
`ServerSaveReceipt` shapes: status/subject, optional local version, optional
server endpoint/commit/version. Missing fields assert nothing. No-op and parent
batching produce no fresh evidence. Receipts and nested evidence are immutable.

Capture the Loro version alongside the exact snapshot before the worker write;
report local evidence only after that write/flush completes. Fence local and
server completion against identity replacement, including A→B→A. Preserve
serialization, explicit-save pacing, optional-online-mirror timeout behavior and
the internal persistence boolean's outbox-written meaning.

Server evidence names the actual captured destination and accepted commit version,
excluding later edits. Custom host commit transports do not prove acceptance by
the configured server and must not yield server evidence. Receipt bookkeeping
failure cannot retry accepted genesis or updates. Server acceptance does not
claim fsync, Vault backup or independent replica coverage. Avoid importing new
per-drive routing architecture or inventing another queue.

## Acceptance and progress

- [x] Inspect prerequisites and delegate bounded architecture review.
- [x] Reproduce missing API with four focused failures before implementation.
- [x] Implement receipts, identity fencing and accepted-commit bookkeeping.
- [x] Test local/server capture with concurrent later edits; no-op and batching;
  missing/failed/late local mirror; identity/database replacement; custom transport;
  concurrent saves; no duplicate delivery after receipt bookkeeping failures.
- [x] Document use and limits, update architecture and testing coverage.
- [x] Independent review; 1824 library tests passed (one existing skip),
  six real WASM memory integrations passed, typecheck/lint/format passed.
- [x] Final workspace build including this worktree's WASM and six real memory
  integration tests passed. Commit hooks run at publication.
- [ ] Publish separate stacked PR and follow exact-head CI.
- [ ] Remove completed task plan after required CI passes.

Tests at a stubbed worker/transport boundary establish receipt attribution and
control flow, not a new crash-survival claim. Existing flush implementation stays.
The real WASM integration verifies memory writes do not claim local durability.
Identity checks reject stale completion; they do not undo writes already begun.
Review found and fixed a background acknowledgement entering a subscriber-started
no-op receipt and a cancellation check swallowed by the hydration fallback.
