# Automatic native Iroh receipts

Worktree: `/Users/michieldejong/.codex/worktrees/atomic-peer-receipts/atomic-server` (reused clean task-owned checkout).
Branch: `codex/atomic-iroh-receipts-2538`.
Base: #2589, `1f5ffa58407ba8bd0edb27957c5423a931c2690f`.
Separate from TablePage #2535/#2536 and full-drive/blob confirmation #2564.

## Contract and ownership

Native peers negotiate an optional Iroh capability and automatically request
version-specific resource receipts after bulk reconciliation and during live sync.
The shared browser/native producer requires authenticated drive/read access,
actual state coverage and persistent flush. Observations are correlated to the
connection, identity epochs, source storage and exact requested target. They do
not establish physical independence, retention, blob/key completeness or backup
recovery. Legacy peers retain ordinary sync. Per-store subscriptions expose
bounded, ephemeral evidence; there is no receipt ledger.

- durability_design: native requester/scheduler and peer transport integration.
- local_persistence_fix: shared producer, wire types, browser compatibility.
- durability_review: real cross-process Iroh acceptance, independent review.
- coordinator: per-Db subscription/agent epoch, docs, validation, PR and CI.

- [x] Inspect Iroh authentication, bulk/live paths and #2589 producer.
- [x] Extract common persistence proof without changing browser guarantees.
- [x] Add negotiated native production and generation-fenced automatic requests.
- [x] Expose per-store receipts and document the developer contract.
- [x] Verify adversarial cases and real native bulk/live/reopen behavior.
- [x] Complete required local checks and independent review.
- [ ] Publish stacked PR and follow exact-commit CI.
- [ ] Remove this plan only once required CI passes.

Independent review found and resolved the accept-side auth-back prerequisite;
receipt production requires successful mutual authentication. Review is complete.
The wider sync selection passes 265 tests with one existing ignored wire-vector
printer. After reproducing and fixing three target-lookup/correlation failures,
all 25 focused receipt tests pass. Final cross-process bulk/live/kill-and-reopen
acceptance passes (its child entry point is intentionally ignored by the parent
test runner). Rebuilt WASM and real Chromium receipt/handoff/reopen checks pass.
Rust formatting, independent review and required staged-snapshot workspace
Clippy pass. Exact-commit CI remains a gate; retain this plan until it passes.

Cross-process diagnostics established that independently encoded Loro vectors
can differ bytewise while naming identical counters. The acceptance test compares
full decoded-vector equality; exact request/response string correlation remains
a separate wire invariant. Native targets are observed stored versions, so no
receipt is promised for an intermediate edit that coalesces before capture.
