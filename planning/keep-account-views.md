# Keep account folders and resource views

Task: Codex chat 01a18d0a-e9aa-76e1-be4b-66badd3431c3.
Host worktree: /Users/michieldejong/.codex/worktrees/keep-resource-views/atomic-server, codex/keep-resource-views.
Plugin worktree: /Users/michieldejong/.codex/worktrees/keep-account-views/atomic-plugins, codex/keep-account-views.
Host base deliberately uses origin/claude/atomic-plugins-pin-candidate25 (6614fd0ed): the deployed plugin contract, including row grants and app-key recovery, is not fully on develop. Host PR targets that dependency branch; no develop/candidate merge.
Plugin base origin/main 06be31ac.

## Acceptance
- [ ] One visible Google Keep <account> folder, one stable existing resource per note.
- [ ] Account folder opens to cards and each note opens directly to a single checklist/text note.
- [ ] Completed checklist items start collapsed with actual count; retain blank and nested items.
- [ ] View installation is managed in Integrations and absent from ordinary drive contents; no unnecessary new Items table.
- [ ] Existing sync identities, rights, baselines and note resources survive migration; repeat migration creates no duplicates.
- [ ] Resource view context does not confer broader row access.

## Work
- [x] Inspect existing installation, plugin and host contracts.
- [x] Architecture/design pass (keep_architecture subagent).
- [x] Host implementation and regression tests (delegated ownership to be recorded).
- [x] Sync migration and view implementation/regression tests.
- [x] Documentation and release bundles/catalog versions.
- [ ] Targeted tests and browser verification/screenshots (synthetic data only).
- [ ] Reviewed PRs, exact-head CI, and live account migration after implementation can be reviewed.

Validation so far: host37 library +77 frontend tests and library typecheck; plugins73 sync +30 view unit tests, both typechecks, synthetic desktop/mobile browser tests; published bundles regenerated as Google Keep0.2.0 and Keep View0.3.0. Root owns remaining host E2E and CI.
