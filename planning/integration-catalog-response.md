# Plugin catalog response compatibility

- Task: Codex chat `why`, integrations page catalog crash (2026-10-30).
- Worktree: `/Users/michieldejong/.codex/worktrees/integration-catalog-response/atomic-server`
- Branch: `codex/integration-catalog-response`
- Base: fetched `origin/develop`, `54dc025958dd370c1730dc240854d9614ecf1b60`.
- Ownership: coordinator owns this plan, documentation, validation and publication; bounded design agent is read-only; catalog_fix owns `helpers/pluginListings.ts`, its Vitest tests and `IntegrationStore.tsx`; catalog_browser_test owns `integration-store-install.spec.ts`.
- Dependency: none expected; local node returns a catalog envelope while develop still returns a bare array.

Acceptance: Apps (including legacy integrations links) accepts the observed `{ entries, hostFeatures }` response and legacy arrays; malformed catalog data stays within the catalog error handling instead of crashing rendering. Search and release review keep working. No preference or backend API change.

- [x] Design contract: normalize legacy arrays and envelopes before state; validate render-critical fields and reuse the catalog alert
- [x] Failing regression reproduction: envelope `.filter` failure reproduced before implementing parser
- [x] Implement response normalization and regression coverage
- [x] Update public docs and testing coverage
- [ ] Validation: 68 targeted Vitest tests pass; focused lint/format pass; compiler findings match unchanged baseline. Typecheck and browser build/verification in progress.
- [ ] Publication: read-only review has no actionable findings; commit/push/PR pending
- [ ] Dispatch and follow exact-commit CI
- [ ] Remove completed plan after green CI, push cleanup, verify final CI
