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
