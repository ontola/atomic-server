# Devonian reconnect fix

Task: 01a09fc2-5986-7fd3-bafd-90db86a91ded
Worktree: /private/tmp/atomic-server-devonian-reconnect
Branch: codex/devonian-reconnect
Base/dependency: feat/plugin-model-improvements at 2ccff09761439e4ccb90e5e290e55ef862d9a0d6 (user specified).

- [x] Inspect flow and plan: concurrent route resumes can consume the same one-time verifier.
- [x] Reproduce with regression test before fix.
- [x] Serialize callback handling without weakening one-time redemption.
- [x] Update docs and coverage.
- [x] Targeted tests and typecheck attempted. Regression: original rejects with Reconnect your account; fixed 5/5 pass. LocalThought suite 61/61 pass. Full typecheck has pre-existing useFile.test.tsx TS2352; shared service-ui dependency resolved locally. No E2E/live OAuth run of patched build.
- [ ] PR and CI.

Acceptance: concurrent/remounted resumes redeem once and recover the tracker; invalid ownership/state and uncertain redemption continue to fail closed. No provider writes during reconnect verification.
Ownership: Terra implementation/test files; coordinator plan, README and TESTING_COVERAGE.md.

Validation uses installed tools directly: pnpm version-manager signature verification cannot reach the registry in the sandbox; verification is not disabled. Astra reviewed locking and unchanged credential safety.
