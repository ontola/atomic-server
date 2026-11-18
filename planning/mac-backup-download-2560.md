# Mac backup download (#2560)

Task: issue #2560, chat 01a1e494-9172-73a1-a076-e18d624eabc8.
Worktree: `/Users/michieldejong/.codex/worktrees/mac-backup-download/atomic-server`.
Branch: `codex/mac-backup-download-2560`.
Base: `origin/develop` at `f445d2909c50506c74c798cd8d891e99e8962780`.

- [x] Design: omit the save picker's extension filter, whose hyphen violates
  File System Access suffix rules; preserve the suggested `.atomic-vault`
  filename, file format, streaming writer and restore compatibility.
- [x] Regression and implementation (coding agent owns `vaultFile.ts` and
  `vaultFile.test.ts`). Reproduce invalid suffix rejection before fixing;
  validate written bytes, cancellation and unexpected picker errors.
- [x] Documentation and coverage (coordinator owns docs and coverage).
- [x] Validation and review.
- [ ] PR to develop.
- [ ] CI on the exact pushed commit; remove this completed plan afterward.

Acceptance: saving passes picker option validation, retains the filename and
produces a parseable file containing the same sealed bytes. Cancellation does
not save, errors remain visible. No format migration or native API changes.
No unresolved design dependencies. Native macOS dialog acceptance remains
separate from unit tests with a spec-validating picker stub.

Validation so far: the regression failed before the fix with the reported
invalid extension error; all 20 backup file and Vault panel tests pass after
the fix. App TypeScript check passes. Focused formatting/lint passes.
Full workspace build and Rust formatting check pass. Independent review found
no actionable issues. Vite extraction obsoleted only the removed picker label
in all six catalogs; every diff was reviewed and the Vite process stopped.
