# Browser/table review batch and CI infrastructure repair

Status: published as draft [PR #2601](https://github.com/ontola/atomic-server/pull/2601); awaiting trekmeester review, integration against current develop and full CI.

- Task: `01a1ef40-c012-7c33-8df9-342e05408dd9`.
- Worktree: `/Users/michieldejong/.codex/worktrees/browser-table-ci-batch/atomic-server`.
- Branch: `codex/browser-table-ci-batch`.
- Base: `a450e20fc0d949958ec8187724dfa6c9423a8f66` (`origin/develop`).
- Coordinator owns integration, batch inventory, documentation and publication.
- CI implementation agent will own workflow changes and their regression checks.
- Architecture agent audits source dependencies and reviews integration decisions.

## Acceptance

- [x] Account for the exact 51 PRs identified by the component audit, including 24 drafts, without importing superseded ancestors.
- [x] Reuse the clean extraction and compiler-test repair in #2597; record necessary dependencies outside the 51-PR cohort.
- [x] Integrate compatible changes with focused regression checks; document any genuinely unresolved contract rather than silently choosing behavior.
- [x] Reconcile numeric constraints: Michiel selected decimal minimum/maximum bounds for integer-valued columns, as JSON Schema allows.
- [x] Repair CI environment handling and offer explicit hosted validation that preserves downstream SaaS, full tests and required checks.
- [x] Validate workflow behavior, focused component tests, type checking, lint and required hooks.
- [x] Open one reviewable batch PR with source inventory and exact validation evidence (#2601).
- [x] Publish the batch and local validation for trekmeester; no worker dispatch.
- [ ] Trekmeester reviews the 24 draft sources, resolves integration conflicts and runs full CI on the final merge candidate.

## Infrastructure evidence

The 5–17 November audit found 40 infrastructure/CI-environment failures among
57 failed Main runs: 22 missing Docker executable, six Docker-engine checks,
seven disconnected/stopped runners, four missing Dagger cache snapshots and
one failure to acquire a runner. Cancellations included execution and queue
timeouts as well as superseded/manual runs.

No SSH connection to Mancave is configured in this environment, and the current
GitHub account lacks organization runner administration access. Host repair
access has been requested. A per-run hosted lane must not silently omit the
private downstream compatibility gate, unlike the existing #2585 proposal.

## Current validation split

The clean extraction vehicle #2597 remains independently reviewable. On
2026-11-19, the reviewed CI-only repair was copied there and pushed as
`a58544dcd632e168ead117d5d7dcadca04482b1e`. Full hosted Main and downstream run
[44468315024](https://github.com/ontola/atomic-server/actions/runs/44468315024)
completed with downstream SaaS success and Main failure. Docker/Dagger startup
succeeded; Main stopped at the unchanged Flutter bridge test
`the_agent_profile_is_saved_and_read_back`, asserting that the agent update
was still pending in the outbox. This is not an infrastructure failure; the
full batch still requires trekmeester validation. The earlier run
44342245250 passed downstream but lost contact with Mancave during Main.
This batch retains the same CI repair and adds the remaining compatible PR
changes; green checks on #2597 will not substitute for this batch's own CI.

The source inventory records all 51 original PRs and six supporting source
vehicles/dependencies. Ten source PRs are already represented by the clean
foundation. The remaining deltas are applied without importing the legacy
ancestors; final source accounting follows tests and review. No original PR
has been closed. Closing superseded reviews is contingent on accepting a
replacement vehicle, not on merely applying its patch.

## Validation findings

- All own-source deltas are applied. Canonical UI primitives replace legacy
  duplicate popovers/dialogs; backend permissions and scoped writes remain in
  adapters. The 51-PR cohort includes 24 drafts, which still require content
  review even after tests pass.
- Host test setup must pass the explicit existing-property lifecycle flag.
  The observed integer-type regression was a stale test fixture, not production
  initialization; the updated focused tests pass.
- The date-formula test mixes a fixed July timestamp with the real November
  timezone offset. The same failure reproduces using the original base module
  and test. Stabilize the fixture clock and verify DST zones without changing
  formula/query semantics.
- Production E2E initially passed 25/27 tests. One failure was a missing local
  form-app build; the other exposed a pre-existing cold-WASM readiness bug in
  React-compiled derived cells. The compiler-executed regression fails before the readiness fix and passes
  afterward. Rebuilding the production frontend and native server (including
  form-app) yields 10/10 passing affected E2E tests with two workers and no retries.
- A bounded review found no new numeric-policy, row-selection-scope or shared
  UI-identity regression. The pre-existing inactive-tab context-rename behavior
  remains outside this batch's fixes.

## CI ownership correction (user approved 2026-11-19)

Only trekmeester schedules shared CI, on either runner. Other agents need an
explicit user exception, and then must use hosted runners. The existing clean
extraction run 44468315024 is explicitly authorized and may finish; this broader
batch is handed to trekmeester for CI. Local checks continue. AGENTS.md,
AGENT_WORKFLOW.md, CONTRIBUTING.md and the local feature instructions now state
this distinction. Manual non-trekmeester refs are forced hosted by workflow
routing; the reserved trekmeester/* branch convention identifies batch runs.

## Local checks completed

- Shared table package: 230 tests in 45 files; build/declarations, typecheck and
  lint pass. Both canonical dialog lifecycles pass all 13 focused tests.
- Atomic browser adapters, table host, formula/dashboard and compiler checks:
  619 tests in 59 files pass after the integration fixes; app typecheck passes.
- The date-formula fixture also passes all 27 tests in Amsterdam, New York and
  UTC after setting its Date clock consistently.
- External packed table/UI consumer installs, renders and checks declarations;
  canonical CSSVar identity remains shared across package boundaries.
- Full browser workspace lint and rustfmt pass. Local WASM, production frontend
  and matching native debug server build successfully. The initial production
  E2E run passed 25/27; after the fixes, all ten affected tests pass. Desktop
  screenshots and a 390×844 mobile quick-add/action-dialog check pass. The
  mobile harness first left the navigation overlay open after resizing; closing
  it through the normal sidebar button fixed the harness. No product workaround.
- Vite extraction visited all 1,404 app source modules. Its temporary middleware
  process reported an unsettled close promise after extraction and exited; no
  writer remains. Catalog checks subsequently pass for all six locales (3,073
  active strings, zero missing entries or issues). Eight erased translations
  restored from the base; 34 new messages translated into five languages.
- CI infrastructure: 17 tests, including 19 actual Main routing-shell cases
  and 15 image-publisher runner-expression cases, pass;
  independent reviews pass. No new shared batch CI is dispatched by this worker.

- Normal commit hooks passed the complete staged browser lint/format snapshot
  and workspace Clippy with warnings denied. The original checkout's four
  untracked paths are unchanged.
- The manual develop-image publisher also forces non-trekmeester dispatch refs
  onto hosted runners before global overrides. Independent workflow audit found
  no additional manual self-hosted entry point. No publishing was performed.
- Remaining shared-CI blocker: the unchanged Flutter bridge test shares a store
  with a live-peer test; a profile push can drain its outbox before the assertion.
  The specific interleaving is not reproduced. Do not remove the assertion or
  claim the full batch green; trekmeester owns final integration and validation.
