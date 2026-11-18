# Extraction batch CI repair

- Task: `01a1ef40-c012-7c33-8df9-342e05408dd9`.
- Worktree: `/Users/michieldejong/.codex/worktrees/extraction-ci-repair/atomic-server`.
- Branch: `codex/extraction-ci-repair`.
- Base: `bd4fa0ed54c466e392b1d42e42480adba132b19d`, the existing combined clean extraction validation batch; its unmerged extraction dependencies are intentional.
- Ownership: coding agent owns the styled-components compiler test; coordinator owns this plan, coverage documentation, integration and CI.

## Acceptance

- [x] Diagnose Main run 44270480118: the compiler regression reads the obsolete host Button re-export instead of the extracted implementation; 2585 app tests passed, one failed.
- [x] Design: exercise canonical shared Button source through both existing compiler passes, retaining all assertions. Vite already aliases the shared UI source, so no runtime change is needed.
- [x] Reproduce the failing focused test and implement the correction (11 compiler tests pass).
- [x] Update the coverage map and inspect the complete repair diff.
- [ ] Run focused checks, required typecheck and normal commit hooks.
- [ ] Publish a reviewable combined batch with explicit source-PR inventory and remaining limitations.
- [ ] Pass full Main and downstream CI on the final published commit.
- [x] Audit superseded PRs: #2535/#2536 and the eight move PRs can close after batch acceptance, preserving branches. Superseded mixed originals are already closed. Keep #2497 (not included) and #2377 (unique app ports).

Do not merge: trekmeester owns merge review. Preserve legacy improvement bases and all unfinished extraction plans. Do not treat this bounded batch as complete TablePage or ELFA migration.
