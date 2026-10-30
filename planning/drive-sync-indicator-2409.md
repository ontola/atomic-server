# Selected-drive sync indicator (#2409)

Status: design and reproduction.

- Task: Codex chat `drive-my-chrome-to-find-out`.
- Worktree: `/Users/michieldejong/.codex/worktrees/drive-sync-indicator-2409/atomic-server`.
- Branch: `codex/drive-sync-indicator-2409`.
- Base: fetched `origin/develop`, `54dc025958dd370c1730dc240854d9614ecf1b60`.
- Ownership: coordinator owns this plan and documentation; bounded Astra design
  pass is read-only; implementation/test ownership will be assigned after design.
- Original checkout has four pre-existing untracked paths; its status and HEAD
  were saved outside the repository before setup. Preserve all original work.

## Acceptance

- A local-only selected drive cannot look protected because an unrelated saved
  server happens to be connected. The sidebar and Sync page must agree.
- A sync result for another drive/server cannot establish a remote copy here.
- Preserve truthful syncing, queued, blocked, and disconnected states for drives
  actually using the server. Account for existing browser peer/Vault evidence
  without treating a transport connection or enabled service as proof of backup.
- Drive and identity switches must not retain the previous drive's status.
- Reproduce at the cheapest meaningful test layer before fixing; capture the
  actual changed UI with synthetic data and record validation limitations.

## Work

- [x] Astra architecture review and implementation contract.
- [x] Regression reproduces current misleading connected status.
- [x] Implement selected-drive indicator and necessary activity wording.
- [x] Update public docs, shared UX reference and TESTING_COVERAGE.md.
- [ ] Targeted tests, typecheck, compiler/lint checks, translations and UI screenshot.
- [ ] Review task-owned diff, commit, push, open PR against develop.
- [ ] Follow exact-commit CI; remove completed plan and verify final commit.

## Decisions and boundaries

- The skill requests unavailable `gpt-5.6-terra`; the available
  `gpt-6.1-terra` substitution was disclosed before dispatch. The skill does
  not require approval for this routine choice.
- Terra implementation owns Sidebar presentation and narrow Store receipt/event
  fixes plus component/library tests. A separate Terra owns only
  `browser/e2e/tests/sidebar-drive-sync.spec.ts`. Coordinator owns docs and builds.
- Preserve the raw global connection status. Derive selected-drive presentation
  using live-sync eligibility and confirmed sync evidence for the current server.
- The red local-only label describes server sync, not backup protection: Vault
  enrollment and peer connectivity do not establish a completed durable backup.
- Global pending/sync counters remain global; this is not a per-drive progress
  accounting redesign.
- Existing Flutter device settings has no browser sidebar replica or commit
  activity log; no unrelated Flutter change is needed.
- User subsequently requested model-agnostic skill guidance; the local skill and
  its UI metadata now request state-of-the-art available models without names.
- Architecture review found late responses could revive a local-only receipt.
  The shared Store completion boundary now rejects that evidence, with a failing
  then passing late-ack regression; deferred socket work also checks its context.
- Focused component/helper tests: 20 passed. Library checks include Store,
  local-only persistence, commit summaries, routing and socket responses: final
  rerun passed 121 tests. Browser verification is still pending.
- User chose a focused indicator PR with separate account-isolation cleanup.
  Follow-up #2411 owns agent/drive routing preferences, conservative legacy
  migration, and retained-cache protection across A → sign-out → B transitions.
  This PR does not claim to isolate those preferences or all progress counters.
