# Distinguish an unsaved-parent queue from local persistence (#2538)

- Worktree: `/Users/michieldejong/.codex/worktrees/atomic-queued-save/atomic-server`
- Branch: `codex/atomic-queued-save-2538`
- Base: `f445d2909c50506c74c798cd8d891e99e8962780` (`origin/develop`)
- Parent task: Atomic-side research follow-up #2538, separate from #2537 TablePage.
- Implementation agent owns library changes/tests, website save-result guard/tests
  if needed, and related documentation/coverage. Coordinator owns publication.

## Contract

Extract the narrow `queued` SaveResult distinction proposed in #1531. A child
waiting in memory for its unsaved parent returns `queued`, not `offline`.
Neither persistence nor server acceptance has completed. Preserve subsequent
parent-first batch draining and retry behavior. Audit callers that interpret
`offline` as incomplete saving, including website publication, and include
`queued` in those checks. This does not add a receipt API or server protocol.

The companion `codex/atomic-local-durability-2538` PR strengthens actual offline
and local-only persistence failures independently. #2244 owns broader receipts;
#2166 owns optional server durable acknowledgement. No ELFA/TablePage edits.

- [x] Delegated architecture review and isolated branch from develop.
- [x] Reproduce the wrong result with a focused unit regression.
- [x] Return `queued`, preserve batching, and audit consuming guards.
- [x] Document compatibility and update coverage.
- [x] Run tests, review diff, workspace build and library/app/e2e typechecks.
  Targeted lint/format passed; commit hook runs at publication.
- [ ] Publish PR and follow exact-commit CI.
- [ ] Remove completed plan after green CI.

## Evidence and overlap

The existing parent/child regression in `commit.test.ts` failed with `offline`
instead of `queued` before the fix. It now also verifies no local persistence
call while waiting and no remaining edits after the parent-first batch drains.
The website publication regression separately failed by accepting `queued`.
The only production `offline` save-result guard was `saveWebsiteResource`;
the integration-workspace fixture helper also needs the new result handled.
No rendered error strings changed.

This extracts the result distinction from #1531 (`0ab529606bcc109ac1e5a1e3abb9ad227ff173f5`),
adapted to current develop's explicit/background save handling. It does not
extract that PR's server flush policy or local-storage changes. #2244's receipt
API and #2166's server durability protocol remain separate.

Targeted library validation: commit, save acknowledgement, save-status
coordinator and scheduled-save suites: 47 tests passed. Website rendering and
inline-editing suites: 15 tests passed. Full workspace build and library/app/e2e
typechecks passed. CI remains to be recorded.
