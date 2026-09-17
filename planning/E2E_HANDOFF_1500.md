# Handoff: e2e suite for PR #1500

Updated 2026-09-16 (second session). Goal unchanged: get the Playwright suite
green for `codex/website-self-hosted-publishing`, then **Rebase and merge**.

## The most important correction to the previous handoff

Most of the "unexplained" website failures (group 4) and a good share of the
rest were **not product bugs — there was no server running**.

`redb`'s lock outlives the listening socket. Killing the server frees port 9897
within a second, but `atomic.redb` stays locked for several more, so a restart
that only waits for the port exits immediately with
`Error: Failed to create redb ...: Database already open. Cannot acquire lock.`
The suite then runs against nothing and every spec fails in ways that look like
real defects: missing menu items, disabled buttons, empty panels.

**Never gate on the port. Gate on `curl` returning HTTP 200, and retry the
spawn — not just the wait — when the log says "Database already open".**
`scripts/start-server.sh` (below) does this. Also give a freshly started server
~10s before running specs; within that window `menu-item-website-prepare`
renders but stays `disabled`.

## Stack setup (delta from the previous handoff)

Everything in the previous handoff still applies, plus:

1. **Patched loro-prosemirror.** `data-browser/node_modules` resolves
   loro-prosemirror out of `~/dev/atomic-server-plugin-model`, where
   `browser/patches/loro-prosemirror@0.4.3.patch` is **not** applied (that
   checkout's `.modules.yaml` has no `patchedDependencies`). CI applies it.
   Without it the inline editors drop characters and
   `website-inline-content` / `website-inline-rte` fail. Fix, touching neither
   of Joep's checkouts:
   - copy the resolved package to `/private/tmp/lp-patched/node_modules/loro-prosemirror`
   - `/opt/homebrew/bin/git apply` the patch there
   - symlink its five sibling deps (`lib0`, `loro-crdt`, `prosemirror-model`,
     `-state`, `-view`) beside it so its own imports resolve
   - alias `loro-prosemirror` to that `dist/index.js` in
     `/private/tmp/hosting-vite.config.mts` and add `/private/tmp/lp-patched`
     to `server.fs.allow`
   - `rm -rf /private/tmp/hosting-vite-cache` and restart Vite, or the stale
     pre-bundle is still served

2. **Mock integration proxy**, matching `atomicService` in `.dagger/src/index.ts`:
   ```
   cd integrations/localthought && MOCK_FRONTEND_ORIGIN=http://localhost:6763 \
     MOCK_PROXY_HOST=127.0.0.1 MOCK_PROXY_PORT=19090 \
     TENANT_SECRET='bW9jay10ZW5hbnQ.mock-signature' node mock-proxy.mjs
   ```
   The server wants `ATOMIC_INTEGRATION_PROXY_URL`, `TENANT_SECRET` and
   `ATOMIC_INTEGRATION_FRONTEND_ORIGIN`; Vite wants `VITE_E2E=true` and
   `VITE_INTEGRATION_PROXY_URL=http://127.0.0.1:19090`.
   `ATOMIC_MOCK_INTEGRATION_PROXY=1` on the Playwright side only gates one
   `test.skip` in `plugins.spec.ts` — it cannot affect any other spec.

3. **create-template** needs building and its own `node_modules`:
   `../node_modules/.bin/tsc` in `browser/create-template` emits
   `bin/src/index.js` (type errors are expected without deps), and
   `browser/create-template/node_modules` can symlink to the one in
   `/private/tmp/atomic-assistant-website`, matching the other packages.

4. **Worker count matters.** At `PLAYWRIGHT_WORKERS=4`, `documents.spec.ts`,
   `username-live.spec.ts` and two `apps.spec.ts` tests fail and then pass at 2
   workers. Treat 4-worker-only failures as contention until reproduced lower.

## Fixed this session (commit `6e79f6a4e`)

- **Test bug class, the right panel is transient (#1475).**
  `RightPanelProvider` keeps open/closed in `useState` and deletes
  `atomic.rightPanel.active`; `atomic.sidebar-panels` only controls which
  panels are *available*. Specs must click the navbar toggle —
  `openAISidebar(page)` / `sendChatMessage(page, ...)` in `tests/ai-mock.ts`.
  `website.spec.ts`, `assistant-file-drop.spec.ts` and the shared
  `tests/legacy-github-setup.ts` (which broke both `app-setup.spec.ts` tests)
  hand-rolled `page.locator('[data-open]')` instead. A bare `[data-open]`
  locator is the smell; correct uses scope it to a testid.
- **`integration-workspace.spec.ts`**: `ConnectGitHub.tsx` became a thin
  wrapper around the schema-driven `AppSetupForm` and no longer names the
  installer path the spec regexes out of the served module — read
  `githubInstaller.ts` instead. The button is labelled "Edit with AI".
- **`browser/lib/src/websockets.ts`**: guard `importEnvelopes` the way
  `client-db.node.ts` does. `getClientDb()` can return an implementation
  without it, and the unguarded call threw a TypeError out of the SYNC_PUSH
  handler, taking the rest of that frame's handling with it. This was the one
  real product defect the previous session identified; `onboarding-storage`
  passes now. **Rebuild `browser/lib/dist` (`pnpm exec tsup`) after changing
  lib, and restart Vite.**

## Where the numbers stand

Two full runs on a correct stack, both **236 passed / 42 failed / 7 skipped**
(the previous session's baseline was 231/46/8). The headline is the same at 4
and 2 workers but the *composition* differs — `apps.spec.ts` contributed 4
failures in one run and 6 in the other, `documents.spec.ts` and
`username-live.spec.ts` failed only at 4 workers. A meaningful share of the 42
is flake, so treat any single run's list as provisional and reproduce before
chasing.

Latest run, by spec: plugins 11, apps 6, table-create-perf 3,
vault-backup-restore 2, template 2, recovery-option 2, meetings 2,
google-calendar-import 2, file-upload-offline 2, drive-template-onboarding 2,
and one each in website-inline-rte, second-device-load, opfs-init-perf,
offline-tables, kanban, integration-workspace, integration-visibility,
devonian-issue-sync.

`@smoke` — the only gate CI runs — is 17/18, the exception being the
order-dependent `second-device-load` noted below.

## Still failing — triage

- **`plugins.spec.ts` (9), `google-calendar-import` (2),
  `integration-visibility` (2), `devonian-issue-sync` (1).** Not yet diagnosed
  individually. These now run against a real mock proxy, so what remains is
  worth reading as real.
- **Diagnostics group: `offline-tables`, `file-upload-offline` (2),
  `opfs-init-perf`, `recovery-option` (2), `vault-backup-restore` (2).** These
  fail the fixture's zero-console-error gate, not their own assertions. The
  error is always the same: the app fetches `http://localhost:9897/` and the
  server 404s it. On this branch drives are `did:ad:drive:...` subjects and
  **nothing lives at the server's HTTP root** — a fresh data dir with
  `ATOMIC_INITIALIZE=true` 404s there too, so this is architectural, not
  misconfiguration. Either the client should not fetch the root, or these
  tests should declare the diagnostic. `fixtures.ts` has no global allowlist by
  design ("expected failures belong to the test that causes them").
- **`integration-workspace.spec.ts:159`** — genuine product suspicion. After
  "New automation", `WorkspaceControls` calls `onStart={() => close()}` and
  `askAI(...)`, but the `<dialog open data-top-level>` stays open with its
  content unmounted, and it is the only thing in the a11y tree. If
  `handleClosed` never runs, `useDialog` also leaves `inert` on `<body>`,
  which would make the app unclickable. Worth chasing in
  `components/Dialog/index.tsx` (`finishClose` / the `data-closing` effect).
- **`apps.spec.ts`** is the worst flake in the suite: 4 failures in one full
  run and 6 in the next, a different test at 1 vs 2 workers, always waiting on
  `iframe[title="App"]`. Look at what gates that iframe before reading any
  individual failure as real.
- **`second-device-load.spec.ts` (@smoke)** fails standalone but passed inside
  the OPFS group run — order-dependent. Green on CI.
- **`template.spec.ts` (2)** should be unblocked by the build above, but each
  test scaffolds and builds a real Next/SvelteKit site and is very slow.
- **Not investigated:** `table-create-perf` (3, perf thresholds), `kanban:177`,
  `meetings` (2), `drive-template-onboarding` (2).

## Merge posture

CI's e2e gate is `@smoke` only (~18 tests) and is green. The full suite has
never been green on this branch, and several of the failures above are stale
tests or missing declarations in code the PR itself introduces — they are not
regressions against `develop`. Deciding how many of them must be green before
merging is Joep's call.

---

# Second pass: where the failures actually come from

Prompted by "develop is 0 failed" — that is **not reproducible in this
environment**, and the comparison needs care.

## The local harness was never the CI harness

**The checkout's dependencies came from a different branch.** Every
`node_modules` under `browser/` was a symlink into
`/private/tmp/atomic-assistant-website` (which itself resolves into
`~/dev/atomic-server-plugin-model`). This branch's own `pnpm-lock.yaml` had
never been installed. Consequences, all of which looked like product bugs:

- `browser/patches/loro-prosemirror@0.4.3.patch` was not applied (the manual
  copy + Vite alias described above is no longer needed — a real install
  applies it, and the result is byte-identical).
- A **hard WASM crash** in the production build: `[ClientDb Worker Error]
  Uncaught Error: null pointer passed to rust`, which broke every `@smoke`
  test (18/18 failing).

Fix: remove the symlinks (never `rm -rf` — they point at other checkouts) and
`pnpm install --frozen-lockfile` in `browser/`. It takes ~8s. Several workspace
packages must then be built before the data-browser will bundle:
`@tomic/service-ui`, `@tomic/plugin`, `@tomic/react`, `@tomic/lib`
(`pnpm --filter <pkg> build`). After that the prod `@smoke` run went 18 failed
→ **2 failed, 16 passed**.

**CI serves a production build, not Vite.** `.dagger/src/index.ts` builds
`data-browser/dist`, copies it to `server/assets_tmp`, and the server embeds
and serves it; Playwright's `FRONTEND_URL` is the server itself. Reproduce with:

```
cd browser/data-browser && SKIP_WASM_BUILD=1 VITE_E2E=true \
  VITE_INTEGRATION_PROXY_URL=http://127.0.0.1:19090 pnpm build
cd ../.. && rm -rf server/assets_tmp && mkdir -p server/assets_tmp \
  && cp -R browser/data-browser/dist/. server/assets_tmp/
cargo build -p atomic-server      # with the CLT env; build.rs embeds assets_tmp
# then FRONTEND_URL=http://localhost:9897
```

## Measured, on a correct install

| Stack | Result |
|---|---|
| Vite dev, correct deps | 230 passed / **47 failed** / 7 skipped |
| Production build (CI topology) | 229 passed / **49 failed** / 7 skipped |
| `@smoke` on the production build | 16 passed / 2 failed |

The *number* barely moved; the *composition* did (prod fixes meetings,
table-create-perf, opfs-init-perf, template, recovery-option and breaks the
website specs — the website preview iframe wants an origin separate from the
app, which the same-origin prod topology does not give it). Failures stable
across all three topologies are the real ones.

## Attribution — the answer to "develop is 0 failed"

Of the failing specs, **these do not exist on develop at all**: `plugins`
(11), `apps` (6), `google-calendar-import` (2), `integration-workspace` (2),
`integration-visibility` (2), `drive-template-onboarding` (2),
`devonian-issue-sync` (1), `website-inline-rte` (1). That is **~27 of 47** —
new tests for new features, which develop cannot fail because it does not have
them. `develop` being green says nothing about them.

Four failing specs are **byte-identical** to develop: `meetings`,
`second-device-load`, `opfs-init-perf`, `offline-tables`. Run against a
develop stack built in this same environment (worktree at
`/private/tmp/atomic-develop-base`, server on 9898, Vite on 6764), **all of
them fail there too** — 7 failures on develop versus 4 on the branch. So they
are not branch regressions. (That develop stack has its own setup gap —
`/app/dev-drive` times out for most specs — so treat it as evidence about
these four specs, not as a full baseline.)

Conclusion: the branch is not ~47 regressions deep. The bulk is new-feature
tests that have never passed, plus environment and flake. What genuinely needs
work before "green" is the new-feature specs, led by `plugins` and `apps`.

## `apps.spec.ts` — two real bugs found (6 failures)

1. **A freshly created app renders its generic resource page, not its own
   view; a reload fixes it.** `ResourcePage` gates the app view on
   `appClass !== undefined && resource.hasClasses(appClass)`, and `appClass`
   comes from `useDriveClass` in `chunks/PluginRuns/runScript.ts`. That hook
   reads the drive's `defaultOntology` once and subscribes to it — but a drive
   with no plugin schema yet **has no `defaultOntology`**, so it subscribes to
   nothing. Creating the first app mints the schema and sets the property, and
   the hook never hears about it; `appClass` stays `undefined` until a
   remount. Fix direction: also subscribe to the drive resource and
   re-subscribe when the ontology appears. (Written and reverted here — it is
   correct on its own terms but bug 2 masks any test-visible benefit, so it
   should land with a test that proves it.)
2. **App creation itself races.** In some runs `createApp` completes and
   navigation lands on the app (verified by instrumenting the action:
   `run:start → createApp:done → handOver:ok → navigate:<app>`). In others the
   URL stays on the drive and `findSchema(store, drive, pluginSchema())`
   returns a schema with an **empty `classes` map**. Same code, same stack —
   so `ensureSchema` has a race. This is the one to chase first.

---

# Third session, 2026-09-17 — 41 failures down to 14

Full suite on the local stack (Vite dev, 2 workers): **265 passed / 14 failed /
7 skipped**, from 237/41/7 at the start of the session.

## The operational finding that mattered most

**The server degrades as its data dir grows.** After a day of runs
`/private/tmp/atomic-hosting-node/data` had reached **1.1 GB**, and on that
server all six `apps` tests and most of `plugins` failed on a 10s
`iframe[title="App"]` wait — which reads exactly like a product bug and is not
one. Moving the data dir aside and restarting took `apps` + `plugins` at two
workers from **16 failures to 1**. Do this before any full run;
`scripts/start-server.sh` in the session scratchpad starts the server and gates
on HTTP 200 (never on the port — redb's lock outlives the socket).

Everything else about the stack is as the second session described. Firefox was
missing from the Playwright cache (`pnpm exec playwright install firefox`);
`client-db-locks` passes with it.

## Fixed — product

- `027c09094` **The empty string is not a subject.** `normalizeSubject('')`
  resolves against the server URL, so `useResource(x ?? '')` and every render
  before the drive setting hydrated fetched `http://localhost:9897/`. Nothing
  lives at the root on a DID-drive branch, so each of those 404s and logged two
  console errors — failing the zero-diagnostics gate in `offline-tables`,
  `sync`, `file-upload-offline` and `drive-deeplink @smoke`. Guarded in
  `getResourceLoading` and the async `getResource`. `CustomViewProvider` had
  the same shape one level up (`/plugin-list?drive=`).
- `d1e91ddba` **The app-setup dialog could not close.** It derived `show` from
  `useDialog`'s post-animation `isOpen`, which only goes false once the Dialog
  has seen `show` go false: a deadlock, with the modal swallowing every click
  behind it. That was `plugins.spec.ts:893`.
- `e4141c008` **A regression from #1510.** Reusing a same-shortname select
  property threw when it lacked a requested option, and the Student and
  Personal templates each pair a task "Status" with a reading-list "Status".
  The whole gallery died with `has no option "Want to read"`. Now it
  disambiguates to `status-2`, as the incompatible-datatype branch already did.

## Fixed — tests

- `2bf4e927f` / `3e86c4be2` **Kanban drags.** The board FLIP-animates after a
  drop, so the second drag pressed where the card used to be and dnd-kit never
  activated. `await source.hover()` first; measure the drop target after
  activation, not before. Same fix in the Devonian spec.
- `00414440d` `integration-visibility` used `check()` on a toggle that
  disappears once checked; `integration-workspace` asserted "no dialog at all"
  when the app legitimately raises the AI model-setup dialog.

## What is still red, and why

| Spec | Verdict |
|---|---|
| `recovery-option` (2), `opfs-init-perf`, `table-create-perf` (3) | Dev-topology only. The SW warning `recovery-option` declares happens only in a production build (VitePWA is off in dev); the `clientdb.*` perf marks are likewise absent from the dev module graph. All pass in CI's topology. |
| `vault-backup-restore` (2) | Points at a portal on :49237, which is **another checkout's** atomic-saas dev server. Needs this branch's portal to mean anything. |
| `google-calendar-import` (2) | Real gap. The new integration-visibility preference is only readable with the server reachable, and this spec runs the whole scenario with the server cut off. Enabling discovery before the interception starts lists the Calendar card; the reload that follows loses it again. Fix = make the preference and its schema readable from the local DB. |
| `second-device-load` @smoke | Real, pre-existing flake — ~1 in 3 passes locally, green on CI. Evidence: after unlocking, `document.body` has no `SecondDeviceChild`; **a reload makes it appear**, so the data is on the server and it is the post-unlock render that misses it. A `StoreEvents.AgentChanged` → `invalidateCollection` hook in `useCollection` was tried and did **not** fix it (reverted). Next place to look is what the sidebar's `useChildren` collection does between "locked, anonymous query" and "signed in". |
| `offline-chatroom`, `website-inline-rte` | Flaky; each passes when run alone. `website-inline-rte` is the known dropped-character flake in the preview editor. |

Nothing in the remaining list is a regression this branch introduces, and the
`@smoke` gate CI runs is green apart from the `second-device-load` flake above.

## Later the same night — 41 → 11, and three more real fixes

Full suite, dev topology, 2 workers: **268 passed / 11 failed / 7 skipped**.

- `f0de176c6` **A children page older than its own count.**
  `getMemberWithIndex` returns undefined when the page it reads does not hold
  the index the count implies; `useChildren` dropped that slot and never looked
  again, so a child could be missing for the life of the view.
  `second-device-load @smoke` went from ~1 pass in 3 to 6 in 7. The retry only
  runs while the hook has never produced a list — after a delete the count runs
  ahead of the page too, and refreshing there would pull the destroyed resource
  back into the store.
- `993ad653b` **A child that did not exist when the query was answered.**
  The collection has no reason to ask again, so a folder created moments
  earlier stayed missing from the drive's list until a reload —
  `server-only-fallback.spec.ts`, failing about half the time. `useChildren`
  already listens for `ResourceUpdated` to re-sort; it now also re-reads the
  query when the changed resource names this parent and is absent from the
  list. That spec: 4/4. `e2e.spec.ts` "delete resource" @smoke, which had been
  ~50/50 in this environment, also went 4/4.
- `8183a3bc6` **`google-calendar-import` (both tests) now pass.** They enabled
  API-plugin discovery *after* cutting the server off, and that preference is a
  write whose `/commit` the spec aborts. Set it up first, read the card back so
  the preference and schema are in the local DB, flush, then go offline. The
  offline phase must also open the drive by subject — `/app/dev-drive`
  bootstraps the drive and, with no server, rebuilds the ontology empty.

### What is left, honestly

`vault-backup-restore` (2) needs its own control plane: `atomic-saas`
hardcodes port 3030, where Joep already runs one, and `vault-stack.sh` points
enrolled drives at the node in `.env.development` (9885 — the real dev server).
Not something to start from a session that must not disturb that stack.

`table-create-perf` (3), `opfs-init-perf` and `recovery-option` (2) were
called "dev-topology only" above. That is right for `recovery-option` (the
service-worker warning it declares only happens in a production build), but a
production build made in this environment fails the other two *differently*
(`/app/dev-drive` never reaches a drive), so the prod topology here is not
clean enough to prove them either way. Treat them as unexplained rather than
explained.

The rest is flake that passes when run alone: `offline-chatroom`,
`tables.spec.ts` Shift+Enter, `website-inline-rte` (the known dropped-character
flake in the preview editor).

**CI is red for an unrelated reason.** Every Mancave run in the repo since
10:34 on 2026-09-16 fails in `Log in to Docker Hub` with `Error: spawn EIO`,
before any build step — `develop`, `feat/plugin-catalog` and three other
branches alike. The runner host needs attention; re-running does not help.
