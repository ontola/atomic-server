# Light vs heavy E2E, and where unit tests should grow

**Status: proposal, not built.** Analysis 2026-08-20.

Yes: split Playwright into a **light** suite that gates everyday CI, and a
**heavy** suite that gates `develop` / tags / releases. Also yes: that only
works if the cases we drop from the PR gate already have a cheaper test at
the right layer. Do not shrink E2E first and hope unit tests appear later.

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

Job 1 belongs on every PR. Job 2 belongs on `develop`, on `v*` tags, and
whenever someone is about to ship. The missing piece is not more Playwright:
it is using the layers we already have so job 2 does not have to live in a
browser.

---

## What is expensive today

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

## Proposed model

Three layers, two E2E gates.

```
unit (vitest / cargo)     always, PR + develop + tag
integration (jsTestIntegration, server `it`, lib sync)
                          always
e2e light  (@smoke)       every PR, and local `pnpm test-e2e:light`
e2e heavy  (full suite)   develop, v* tags, workflow_dispatch, nightly-optional
```

Mechanism: Playwright **tags**, not two folders. A test can be `@smoke` and
still run in heavy (heavy = unfiltered). Light is `--grep @smoke`. Optional
later: `@perf` excluded from both default jobs and run on a schedule.

### When each gate runs

| Trigger | Light | Heavy |
|---|---|---|
| PR / feature-branch push | required | no |
| `develop` push (staging) | included in heavy | required |
| `v*` tag (production) | included in heavy | required |
| Local default `pnpm test-e2e` | — | full (today's behavior) |
| Local inner loop | `test-e2e:light` | on demand |

PRs stay mergeable without waiting for website-template applies and kanban
operator matrices. `develop` still refuses to stage a build that broke an
offline table reload.

Retries: light can run `retries=1` (or 0 locally). Heavy keeps `retries=2`
on Mancave until the host is less contended. A smaller light job also *is*
the contention fix: fewer browsers next to cargo.

Shards: light likely needs **1–2 shards**, not 4. That frees CPU for
clippy/nextest on the same box.

---

## What belongs in light (~25–35 tests)

One happy path per product surface a user hits in the first hour. Draft
list — tag these, do not copy them into a new file:

| Journey | Source spec | Keep in light |
|---|---|---|
| Create identity / sign in / sign out | `e2e.spec.ts`, `onboarding.spec.ts` | 1–2 tests |
| Invite + share + second context accepts | `e2e.spec.ts` authorization | 1 (this *is* a flow test; protocol coverage is not a substitute) |
| Chatroom | `e2e.spec.ts` | 1 |
| Folder + document edit | `e2e.spec.ts` / `documents.spec.ts` | 1 |
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

## CI / Dagger shape (when building)

Today `ci()` always calls `this.endToEnd(...)`, which shards the full
suite. Change:

- `endToEnd(mode: 'light' | 'full')`.
- `ci()` takes the same flag (or infers from git ref inside the workflow,
  not inside Dagger — the workflow already knows branch vs tag).
- Light: `--grep @smoke`, 1–2 shards, `PLAYWRIGHT_RETRIES=1`,
  `PLAYWRIGHT_WORKERS=2` on Mancave.
- Full: current command, current shards/retries.
- `pnpm` scripts: `test-e2e:light` / keep `test-e2e` = full.
- Do not grep-exclude by filename forever; tags survive file splits.

`develop` and tags keep today's contract: staging/production only move
when the heavy suite is green. Feature branches get the light gate plus
the always-on unit/integration jobs (those are cheap and already
parallel).

Optional later, not required for the split to pay off:

- Nightly heavy on `develop` even if a push already ran it (catches flake
  that slipped a retry).
- `@perf` job, one shard, `workers=1`, no retries, fail on budget miss.
- Firefox/WebKit projects stay heavy-only (locks + sign-out round-trip).

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

## Build order (not started)

1. Tag the draft smoke list; add `test-e2e:light`. Measure locally:
   count, wall time, failures vs full.
2. Wire Dagger + `main.yml` so PRs run light, `develop`/tags run full.
   Confirm staging still waits on the full job.
3. Document the policy in `TESTING_COVERAGE.md`, `browser/e2e/README.md`,
   `AGENTS.md` (cheapest layer first).
4. For each heavy spec that duplicates a unit file, leave the E2E in heavy
   and stop adding variants there. New variants go to vitest.
5. Grow `jsTestIntegration` for offline/sync/upload paths that currently
   exist only as Playwright.
6. Only then drop individual heavy tests that have become redundant.

Step 1–3 is the split. Step 4–6 is how the heavy suite stops growing
faster than the product.
