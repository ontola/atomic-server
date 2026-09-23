# Light vs heavy E2E, and where unit tests should grow

**Status: partial, scheduling revised 2026-09-23.** Tags, `test-e2e:light`, and
Dagger `--playwright-mode` remain. Automatic PR and feature-branch CI is paused
because Mancave queue time exceeded the test time. Full CI runs on `develop`,
`v*` tags, and explicit dispatches of temporary branches combining PR heads.
Remaining test-layer work: grow `jsTestIntegration`, stop adding heavy-only
variants as Playwright, then drop redundant heavy specs.

Playwright has a **light** suite for local diagnostics and a **full** suite
for integration batches, `develop`, tags, and releases. Lint, Rust, vitest,
JS integration, and Flutter remain in each Main run. The scheduling change
reduces how many Main runs are requested; it does not remove test layers from
a run. Keep cheaper tests for cases that do not require a browser.

Companion: [`TESTING_COVERAGE.md`](../TESTING_COVERAGE.md) — protocol vs glue
vs flow. This plan is about *which flow tests run when*, not about abandoning
the flow layer.

---

## Verdict

The suite is doing two jobs in one job:

1. **Can a person still use the app?** Sign in, make a document, share it,
   edit a table, survive reload. A few dozen browser tests.
2. **Did this operator / template / offline path / regression still work?**
   Combinatorics, serial specs, two-browser sessions, website scaffolding,
   perf probes. Another ~140 tests, most of the wall time.

Both jobs now run for each manually assembled PR batch, on `develop`, and on
`v*` tags. PR updates do not start CI automatically while runner capacity is
limited. The missing piece is not more Playwright: it is using the layers we
already have so job 2 does not have to live in a browser.

---

## Earlier timing baseline (re-measure before tuning)

Playwright is the slow lane. Counts from this tree (2026-08-20):

| Layer | Size | CI job |
|---|---|---|
| Playwright | 68 spec files, ~172 `test()`s, ~13.5k lines | `endToEnd` |
| Browser unit (vitest) | ~100 files (`@tomic/lib` + data-browser helpers) | `jsTest` |
| Browser integration (vitest + real `atomic-server`, no UI) | 5 files under `browser/lib/tests/` | `jsTestIntegration` |
| Rust | ~580 `#[test]` / `#[tokio::test]` | `rustTest` |

There is **no React Testing Library**. UI is only asserted through Playwright.

CI already shards E2E (Mancave: 4 shards × 2 workers, `retries=2`; hosted: 2
shards × 1 worker). `ci()` runs those browsers **in parallel with** clippy,
nextest, Flutter, and two vitest jobs. Dagger comments record the cost: at 3
workers Chromium was killed outright ("Target page, context or browser has
been closed") — starvation, not a race. Retries were dropped to 1 to save
wall time, then raised back to 2 because remaining failures rotated run to
run. The retries are buying headroom the host does not have.

Wall-clock of a Main run is not the same as E2E runtime. Recent Mancave
successes (2026-08-20):

- Docs-only / cache hit: **~2–12 min** end to end.
- Code changes: **~15–45 min** of actual `Main (Mancave) / CI` once the
  runner starts. Queue time on a busy box can add another hour before that.
- Playwright config still talks about a **~50 min e2e budget** as the reason
  retries were cut.

Every test that uses `before` (`test-utils.ts`) pays a full `/app/dev-drive`
bootstrap: WASM ClientDb + OPFS + genesis agent + drive. ~50 specs do this
per test. Setup tax scales with test count, not with assertion count.

Other known drags, already documented in-tree:

- `template.spec.ts` is serial and spawns Next.js / SvelteKit applies.
- `table-refresh.spec.ts` is serial.
- Two-browser specs (`e2e.spec.ts` invite/chatroom, `meetings`, `presence-follow`,
  `second-device-load`, `drive-deeplink`, `vault-backup-restore`, `onboarding`,
  `sync.spec.ts`) hold extra contexts.
- Perf / profile specs (`first-paint-*`, `dev-drive-timing/profile`,
  `opfs-init-perf`, `perf-budgets`, `perf-sidebar-reload`,
  `table-create-perf`) are probes. Several already `test.skip` unless an env
  var is set, but they still occupy the suite.
- Staging deploys from `develop` only after Main is green
  (`deploy_staging.yml`). Production follows a `v*` tag. The full suite is
  load-bearing for those two gates; PRs do not have to share that cost.

`e2e.spec.ts` already says this out loud: *these tests are relatively slow,
try to utilize unit tests to catch bugs earlier.*

---

## The trap

[`TESTING_COVERAGE.md`](../TESTING_COVERAGE.md) exists because **protocol is
well tested and glue/flow is not**, and every production device-sync bug so
far lived in an uncovered glue/flow row. A light suite that is just "delete
half the specs" would recreate that imbalance in the browser.

So:

- Keep **one** Playwright test per user journey that can only fail in the
  UI (click, dialog, drag, two tabs, reload with OPFS).
- Move **combinatorics** (operators, templates, filter keys, row actions,
  pairing envelope validation) down to vitest / Rust, where many already
  live.
- Prefer `jsTestIntegration` (real server, `Store` + `NodeClientDb`, no
  browser) for "does the client actually persist / sync / upload" before
  adding another Playwright file. That job exists and is underused: five
  tests covering upload, genesis, wasm smoke.

Do **not** introduce React Testing Library as the escape hatch. The cost of
a third UI-test stack is higher than tagging Playwright and growing helper /
integration tests.

---

## Current CI scheduling

Main runs all its lint, unit, integration, Rust, Flutter, and **full** Playwright
checks together. Playwright's `@smoke` subset remains available locally but
does not start automatically in GitHub Actions.

| Trigger | Main pipeline |
|---|---|
| PR event or feature-branch push | No automatic repository CI |
| Push to `develop` | Full for the latest tip; a newer push cancels the previous run and only the current successful tip can deploy to staging |
| Push of a `v*` tag | Full, gates release |
| Manual `workflow_dispatch` on a temporary integration branch | Full |

The agent assembles an integration branch from the **exact PR head commits**
selected for a batch, pushes it, and calls
`gh workflow run main.yml --ref <batch-branch>`. The branch's push starts no CI; dispatch starts one full Main
run. Record the batch SHA and run URL, check that the run's `head_sha` equals
that SHA, and inspect every applicable job. Rebuild and rerun the batch when a
PR head changes. Merge only the tested heads together; after merge, `develop`
gets its own full gate before staging. The integration branch never triggers
staging by itself. Do not treat a green run for a previous batch as evidence
for a changed batch.

This intentionally means one premerge batch run and one postmerge `develop`
run. Reusing a premerge result for staging would require proving that the
merged tree is identical and changing the deployment gate; that is outside
this temporary scheduling change.

Develop uses latest-wins concurrency. A new push cancels the prior Main run;
the staging workflow checks the successful run's SHA against the current
develop tip before deploying. This avoids spending Mancave time on a commit
that has already been superseded and avoids deploying a stale success.

`main.yml` keeps the full suite for every dispatched ref, avoiding an
accidental light run that could be mistaken for release evidence. The
`rust-alignment.yml` check runs on `develop` only. These repository workflows
do not control third-party security checks on PRs.

Local commands remain `pnpm test-e2e` for full and `pnpm test-e2e:light` for
the `@smoke` subset. A test can be `@smoke` and still run in full.

---

## What belongs in light (~25–35 tests)

One happy path per product surface a user hits in the first hour. Draft
list — tag these, do not copy them into a new file:

| Journey | Source spec | Keep in light |
|---|---|---|
| Create identity / sign in / sign out | `e2e.spec.ts`, `onboarding.spec.ts` | 1–2 tests |
| Invite + share + second context accepts | `e2e.spec.ts` authorization | 1 (this *is* a flow test; protocol coverage is not a substitute) |
| Chatroom | `e2e.spec.ts` | 1 |
| Folder | `e2e.spec.ts` | 1 |
| Document CRDT (create + websockets) | `documents.spec.ts` | 0 — already marked FLAKY; folder covers create |
| Table create + type a row | `tables.spec.ts` `create and fill` | 1 |
| Search | `search.spec.ts` text search | 1 |
| Offline edit survives reload + reconnect | `sync.spec.ts` | 1 |
| Second device cold-loads a drive | `second-device-load.spec.ts` | 1 |
| Drive deep link adopts the right drive | `drive-deeplink.spec.ts` | 1 |
| Kanban: create board + drag persists | `kanban.spec.ts` | 1 |
| Dashboard: one block with a real total | `dashboard.spec.ts` | 1 |
| Meeting prepare → start | `meetings.spec.ts` | 1 |
| File upload round-trip | `filePicker.spec.ts` or `file-upload-offline` online case | 1 |
| Pairing: paste code success (Tauri-gated form) | `pairing-dialog.spec.ts` | 1 |
| Ontology create/edit | `ontology.spec.ts` | 1 |
| History page | `e2e.spec.ts` | 1 |
| Delete resource | `e2e.spec.ts` | 1 |

That is roughly 20 tests plus a small buffer. Everything else in those files
stays in the repo and runs in heavy.

Rule of thumb for adding a new `@smoke` tag: **would a broken test here
mean we cannot demo the app?** If it is an operator, a template, a
Firefox-only lock, or a perf budget, it is heavy.

---

## What belongs only in heavy

Group by why they are expensive or redundant as a PR gate.

**Combinatorics already unit-tested** — keep one smoke, run the rest in
heavy until (or after) the unit tests are trusted as the regression net:

- Table filters / views, derived columns, aggregates, row actions, quick
  add, templates (`table-*.spec.ts`, `derived-columns`, `aggregates`,
  `quick-add`, `row-actions`) — twins exist:
  `tableFiltering.test.ts`, `derivedColumns.test.ts`,
  `tableAggregates.test.ts`, `rowActions.test.ts`, `quickAdd.test.ts`,
  `tableTemplates.test.ts`.
- Forks (`forks.spec.ts` vs `browser/lib/src/forks.test.ts`).
- Pairing malformed / remembered-peer cards (`pairing.test.ts`,
  `knownPeers.test.ts`).
- Dashboard block math (`dashboardBlocks.test.ts`).
- Meeting lifecycle helpers (`meetingLifecycle.test.ts`).
- Vault helpers (`helpers/managed/*.test.ts`).
- AI compact / tool XML (`chunks/AI/*.test.ts`). The E2E file is fully
  mock-routed; it tests chrome, not a model.

**Multi-session / OPFS / server-only fallbacks** — these *are* flow tests
and should stay Playwright, just not on every PR:

- `offline-*`, `local-db-off-*`, `server-only-fallback`,
  `clientdb-edit-persistence`, `signout-signin-data`,
  `sign-in-without-data`, `client-db-locks` (incl. Firefox project),
  `canvas-*`, `presence-follow`, `vault-backup-restore`.

**Product surfaces that are not the first-hour path:**

- `timer`, `calendar`, `plugin`, `template.spec.ts` (Next/Svelte apply),
  `ai.spec.ts`, `localized-text`, `JSONProp`, `tags`, `discussion`,
  `shortcuts`, `settings`, `default-ontology`, `query-drive-filter`,
  `resource-context-menu`, `rename-regression`, `table-refresh` (serial),
  `sync-devices` (QR copy / form gate — pairing success is the smoke).

**Perf probes** — never a PR gate. Exclude with `@perf` (or keep today's
`test.skip` + env). Run on a schedule or locally with
`ATOMIC_TEST_CPU_THROTTLE`.

---

## Unit / integration gaps to fill *before* shrinking heavy

Do not move a spec to heavy-only and then delete it later unless the row
below exists.

| Gap | Better layer than more E2E |
|---|---|
| Offline create → reconnect → server has the commit | `jsTestIntegration` (extend upload-offline-reconnect pattern) |
| Collection query + AND filters without a grid | already Rust + `multi-property-filter`; UI stays one E2E |
| Kanban group-by precedence (explicit > existing select > auto-create) | data-browser helper unit test; DnD stays E2E |
| Table view config persist (filters/sort/columns) | helper unit + one E2E reload |
| Search overlay parsing (`tag:`, scoped) | small parser unit; overlay E2E stays one test |
| Document CRDT / cursor | keep E2E; no RTL |
| Chatroom invite across contexts | keep E2E; this is the flow |
| `/app/dev-drive` bootstrap timing | perf job, not unit |

`@tomic/lib` is in good shape. data-browser unit tests cluster on **tables
and managed-node helpers**. Thin spots are RTE/documents, search overlay,
ontology editor, plugin loader, settings — those should keep Playwright
until a helper is extracted, not a mock React tree.

Policy for new tests (put this in `TESTING_COVERAGE.md` and
`browser/e2e/README.md` when building):

1. If the logic is a pure function or a Store method, write vitest / Rust
   first.
2. If it is "client talks to a real server, no UI", add
   `*.integration.test.ts`.
3. If it is a user journey, add **one** Playwright test. Tag `@smoke` only
   if a failure means the demo is dead.
4. Extra operators, templates, and "also works offline" variants go to
   heavy, or to (1)/(2) instead.

Debugging process in `AGENTS.md` currently pushes agents toward E2E
("reproduce the bug in a test"). Amend it: reproduce at the cheapest layer
that can fail.

---

## CI / Dagger shape

Today `ci()` takes `--playwright-mode light|full` and passes it to `endToEnd`.
The workflow decides the mode; Dagger does not guess the branch.

- `endToEnd` / `ci` take `--playwright-mode light|full` (not `--e2e-mode`:
  Dagger camelCases that to `e2EMode` and the call fails).
- `main.yml` passes `full` on `develop`, `v*` tags, and manual dispatches of
  integration branches. Feature-branch pushes and PR events do not trigger it.
- Light: `--grep @smoke`, two Mancave shards or one hosted shard,
  `PLAYWRIGHT_RETRIES=1`; workers follow the selected Dagger host profile.
- Full: current command, current shards/retries.
- `pnpm` scripts: `test-e2e:light` / keep `test-e2e` = full.
- Do not grep-exclude by filename forever; tags survive file splits.

Optional later, not required for the split to pay off:

- Nightly full on `develop` with `retries=0` (flake hunting).
- `@perf` job, one shard, `workers=1`, no retries, fail on budget miss.
- Firefox/WebKit projects stay heavy-only (locks + sign-out round-trip).
- Docs-only path filter that skips Playwright entirely (Dagger cache
  already makes these cheap).

---

## What not to do

- Two copies of each spec in `tests/light/` and `tests/heavy/`.
- Light-only on `develop`. Staging would then ship on a subset.
- Deleting heavy tests whose only coverage is Playwright, "to save CI",
  before a unit/integration twin exists.
- Treating mocked `ai.spec.ts` as a substitute for tool-unit tests, or
  vice versa.
- Raising Mancave workers again to make the full suite faster. The box is
  already oversubscribed; a smaller default job is the fix.
- A new component-test framework.

---

## Build order

1. [x] Tag the draft smoke list; add `test-e2e:light`.
2. [x] Wire Dagger with light/full modes; `main.yml` now runs full for
   `develop`, tags, and dispatched integration batches.
3. [x] Document the policy in `TESTING_COVERAGE.md`, `browser/e2e/README.md`,
   `AGENTS.md` (cheapest layer first).
4. For each heavy spec that duplicates a unit file, leave the E2E in heavy
   and stop adding variants there. New variants go to vitest.
5. Grow `jsTestIntegration` for offline/sync/upload paths that currently
   exist only as Playwright.
6. Only then drop individual heavy tests that have become redundant.

Step 1–3 is the split (landed). Step 4–6 is how the heavy suite stops growing
faster than the product.

## Local reproduction and diagnostics

`pnpm test-e2e:local` builds JS, WASM and the native backend from the checkout,
serves the embedded SPA and API at one `atomic.localhost` origin on a free port,
uses fresh data, and retains failure traces. `--preview` opts into separate-origin
Vite preview; it previously missed the managed-portal CI regression. It runs
with zero retries by default. External Cloud Vault tests require an explicit
`ATOMIC_VAULT_PORTAL_URL`; managed mocks do not depend on a portal.

Failures also attach bounded resource/save and WebSocket frame metadata before
page teardown. `DiagnosticCollector` and `TransportCollector` have explicit,
idempotent start/snapshot/dispose lifecycles. Disposal detaches socket listeners
as well as page/context listeners. Closed-page transport evidence is retained
(up to five closed pages); live state reads remain capped at five pages and two
seconds each. Lifecycle checks and real open/closed WebSocket checks preserve
payload-free metadata and diagnostic strictness.


### Develop CI regression follow-up (2026-09-12, PR #1456)

The separate-origin preview pass did not cover CI's embedded `atomic.localhost`
deployment. The local runner now uses that deployment by default. Reproduction
also found Boolean read mutations, snapshot ingress starting duplicate fetches,
collections racing expected database attachment, delayed title autofocus closing
menus, and stale tag-list updates. Drive URL switching now uses real local drives;
search click retries recognize successful overlay closure.

- [x] Reproduce fixes before changing behavior, using unit tests and slowed E2Es.
- [x] Verify 457 library tests, 853 app tests, and workspace type checks.
- [x] Repeat query, menu, and drive switching three times at 4x CPU slowdown;
      repeat the final tag-search fix five times at the same slowdown.
- [x] Complete embedded-server Chromium run at `a2df542f3`: 212 passed,
      8 skipped, zero retries (15.9 minutes).
- [x] Integrate develop `424f0a026` and rebuild JS, WASM and server: all 12
      affected account/cache/managed/tag E2Es pass, as do library units, the
      synthetic-agent Rust regression, workspace types and full lint. Fix three
      missing blank lines in the new upstream worker test to restore lint.
- [ ] Confirm the full hosted suite on PR #1456; a feature-branch smoke pass is
      insufficient to establish that develop's full suite is green.
- [ ] Retain diagnostics for every failing test in CI. The current 20k log tail
      and first 12 error-context files per shard can lose later failures when
      retries consume the file budget. Preserve bounded metadata without logging
      resource values or signed payloads.
