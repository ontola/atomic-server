# Plugin catalog response compatibility

- Task: Codex chat `why`, integrations page catalog crash (2026-10-30).
- Worktree: `/Users/michieldejong/.codex/worktrees/integration-catalog-response/atomic-server`
- Branch: `codex/integration-catalog-response`
- Base: fetched `origin/develop`, `54dc025958dd370c1730dc240854d9614ecf1b60`.
- Ownership: coordinator owns this plan, documentation, validation and publication; bounded design agent is read-only; catalog_fix owns `helpers/pluginListings.ts`, its Vitest tests and `IntegrationStore.tsx`; catalog_browser_test owns `integration-store-install.spec.ts`.
- Dependency: none expected; local node returns a catalog envelope while develop still returns a bare array.

Acceptance: Apps (including legacy integrations links) accepts the observed `{ entries, hostFeatures }` response and legacy arrays; invalid top-level catalog data stays within the catalog error handling instead of crashing rendering. Preserve the upstream parser's row normalization. Search and release review keep working. No preference or backend API change.

- [x] Design contract: normalize legacy arrays and envelopes before state; preserve upstream listing normalization and reuse the catalog alert for invalid top-level responses
- [x] Failing regression reproduction: envelope `.filter` failure reproduced before implementing parser
- [x] Implement response normalization and regression coverage
- [x] Update public docs and testing coverage
- [x] Validation: 68 targeted Vitest tests; typecheck; full pre-commit lint/format; rustfmt; full production frontend build. Compiler findings match unchanged baseline. Three Chromium regressions pass with one worker, no retries/skips, on the matching native `light,wasm-plugins` dev build. Actual screens captured outside the repository.
- [x] Publication: reviewed, committed and pushed; PR #2419 targets develop.
- [ ] CI follow-up (2026-11-02): Main run 41078873167 failed one date-cell unit test; downstream passed. Reproduced the same failure with a deferred metadata fetch. Hydrate column and createdAt metadata in its fixture and guard against HTTP requests; targeted 15 tests pass.
- [x] Resolve concrete add/add conflicts with upstream #2408, preserving its parseListings API and normalization while extending it to envelopes.
- [x] Full app tests in CI timezone (UTC): 331 files / 2474 Vitest tests plus 2 MCP script tests pass. Typecheck and rustfmt pass; review found no issues.
- [ ] Commit/push the CI fixture repair and conflict resolution, then follow Main on that exact commit.
- [ ] After green CI, remove this plan, push cleanup and verify CI on the final commit.

Local setup notes: the launcher repeat-WASM build failed parsing a generated package after the standalone matching WASM build succeeded; full frontend build passed reusing that generated WASM. `light` alone hits existing unguarded plugin imports; the native `light,wasm-plugins` build, with required plugin runtime, passed. Neither setup issue requires a source change for this fix. Original checkout status matches its saved baseline.
