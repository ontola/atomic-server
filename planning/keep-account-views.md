# Keep account folders and resource views

Task: Codex chat 01a18d0a-e9aa-76e1-be4b-66badd3431c3.
Host worktree: /Users/michieldejong/.codex/worktrees/keep-resource-views/atomic-server, codex/keep-resource-views.
Plugin worktree: /Users/michieldejong/.codex/worktrees/keep-account-views/atomic-plugins, codex/keep-account-views.
Host base deliberately uses origin/claude/atomic-plugins-pin-candidate25 (6614fd0ed): the deployed plugin contract, including row grants and app-key recovery, is not fully on develop. Host PR targets that dependency branch; no develop/candidate merge.
Plugin base origin/main 06be31ac.

## Acceptance
- [x] One visible Google Keep <account> folder, one stable existing resource per note.
- [x] Account folder opens to cards and each note opens directly to a single checklist/text note.
- [x] Completed checklist items start collapsed with actual count; retain blank and nested items.
- [x] View installation is managed in Integrations and absent from ordinary drive contents; no unnecessary new Items table.
- [x] Existing sync identities, rights, baselines and note resources survive migration; repeat migration creates no duplicates.
- [x] Resource view context does not confer broader row access.

## Work
- [x] Inspect existing installation, plugin and host contracts.
- [x] Architecture/design pass (keep_architecture subagent).
- [x] Host implementation and regression tests (delegated ownership to be recorded).
- [x] Sync migration and view implementation/regression tests.
- [x] Documentation and release bundles/catalog versions.
- [x] Targeted tests and browser verification/screenshots (synthetic data only).
- [ ] Reviewed PRs, exact-head CI, and live account migration after implementation can be reviewed.

Validation so far: host37 library +77 frontend tests and library typecheck; plugins73 sync +30 view unit tests, both typechecks, synthetic desktop/mobile browser tests; published bundles regenerated as Google Keep0.2.0 and Keep View0.3.0. Root owns remaining host E2E and CI.

## Release follow-through — 2026-11-02

User explicitly requested review, CI, deployment and live installation upgrade.
PR2421 host head e3232a5b5 and PR719 plugin head1ef1e8e7 are pushed, clean and open.
Both Keep CI lanes passed; overall gates failed and must be resolved before release.

- [ ] Triage host run41084341724 (E2E shard1 and downstream dependency alignment).
- [ ] Preserve pending in-frame permission requests when grant acknowledgement refreshes guests (timesheets/money regressions).
- [ ] Restore calendar validator export lost between old and new plugin host pins.
- [ ] Repair dataset grant-target registry on retry after partial migration.
- [ ] Align plugin E2E expectations with pinned host connection dialog and current explicit sync setup.
- [ ] Independent review, native regression checks, push fixes and observe exact-head green gates.
- [ ] Release catalog via green atomic-plugins main; host release follows maintainer workflow.
- [ ] Upgrade live apps only after the host/frontend supports the new contract; verify existing note IDs and collapsed485 items.

Ownership: keep_architecture — host grant lifecycle, validator export and host CI triage;
keep_sync_folder — catalog migration retry safety/test and live upgrade runbook;
keep_view — money/issue-tracker E2E compatibility; root — pets E2E, plan, integration/release.
Native evidence before follow-through: five Keep view tests and one full mock Keep sync scenario passed against e3232a5b5;73 sync+31 view unit tests,37 lib+95 frontend focused tests and typechecks passed. Screenshots/logs retained outside repository.
Live resources are still legacy (sync0.1.0); no live installation/data edits yet. Opening sync auto-starts provider reconciliation with its saved writeback setting, so upgrade verification must inspect settings and avoid accidental sync starts.
