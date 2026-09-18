# e2e handoff — PR #1500 (`codex/website-self-hosted-publishing`)

Written 2026-09-17. HEAD at handoff: `077555c32`.

Goal: get the Playwright suite green so #1500 can merge (**Rebase and merge** —
merge commits are disabled and squash would collapse 167 commits including
Michiel's).

Last measured full run: **269 passed / 5 failed / 4 flaky / 7 skipped** (19 min,
2 workers, retries=1). It was 41 failed at the start of the day.

---

## 1. Read this first: the harness lies

More of my wasted time came from the environment than from the code. Three traps,
in order of how much they cost:

### 1.1 The i18n catalogs silently corrupt results

The `wuchale` Vite plugin rewrites `browser/data-browser/src/locales/*.po` while
the dev server runs. The **compiled** catalogs live in `src/locales/.wuchale/`,
which is **gitignored**. So `git checkout -- src/locales/` restores the `.po`
files and leaves the compiled artifacts from some other state — the two disagree
and every indexed string lookup shifts.

Two failure shapes; the second is the dangerous one:

- missing entries render as `[i18n-404:2275]` — visibly broken
- shifted entries render as **a different real string** — nothing looks wrong

That second one is how `iframe[title="Website preview"]` became
`"Preserves recurring series and previews supported edits to send back to
Google."` and every website spec failed. I bisected code for an hour before
finding it.

**Before trusting any run**, regenerate both together and restart Vite:

```bash
git checkout -- browser/data-browser/src/locales/
rm -rf browser/data-browser/src/locales/.wuchale
# then restart Vite
```

Do **not** `chmod 444` the `.po` files to stop the rewrite — I tried; it freezes
them while `.wuchale` goes stale and `integration-visibility` then fails with
`[i18n-404]` toggles. The `.po` files going dirty *during* a run is fine as long
as both were generated in step.

### 1.2 redb's lock outlives the listening socket

After killing the server, port 9897 frees within a second but `atomic.redb` stays
locked for several more. Starting immediately gives `Database already open` and
the process exits — leaving **no server** while the suite runs, and every spec
fails in ways that look like product bugs. Gate on `curl` returning HTTP 200, not
on the port, and retry the spawn. `planning/start-server-9897.sh` does this.

Also: give a freshly started server ~10s before running specs.

### 1.3 Worker count and retries

CI runs **2 workers per shard, 4 shards, each with its own atomic-server**, plus
retries (`.dagger/src/index.ts`, `HOST_PROFILES.mancave`). A local 4-worker run
against one server is much harsher and invents failures. Use
`PLAYWRIGHT_WORKERS=2 PLAYWRIGHT_RETRIES=1`.

A rotating pair of specs fails per run purely from load (`plugins:909`,
`tables:482`, `drive-catalog`, `offline-tables`, … different each time). **Always
re-run a red in isolation before believing it.**

---

## 2. Running the stack

Checkout: `/private/tmp/atomic-pr-website`. Use `/opt/homebrew/bin/git` — the
Xcode git/python on PATH exit 69 (unaccepted licence). Rust builds need the
Command Line Tools env; see `project_rust_build_env.md` in the memory dir.

**Dependencies are already installed correctly.** They were previously symlinked
from an unrelated branch's checkout, which is why the loro patch was missing and
why a production build died with `null pointer passed to rust`. If you ever need
to redo it: remove the symlinks (never `rm -rf` — they point at live checkouts),
`pnpm install --frozen-lockfile` in `browser/`, then build `@tomic/service-ui`,
`@tomic/plugin`, `@tomic/react`, `@tomic/lib` before bundling the data-browser.

Three processes:

```bash
# 1. server (9897)
bash planning/start-server-9897.sh

# 2. mock integration proxy (19090)
cd integrations/localthought && MOCK_FRONTEND_ORIGIN=http://localhost:6763 \
  MOCK_PROXY_HOST=127.0.0.1 MOCK_PROXY_PORT=19090 \
  TENANT_SECRET='bW9jay10ZW5hbnQ.mock-signature' node mock-proxy.mjs &

# 3. Vite (6763) — MUST have VITE_ATOMIC_SERVER_URL or it points at :9885,
#    which is Joep's real dev server
cd browser/data-browser && VITE_ATOMIC_SERVER_URL=http://localhost:9897 \
  VITE_E2E=true VITE_INTEGRATION_PROXY_URL=http://127.0.0.1:19090 \
  node node_modules/.bin/../vite/bin/vite.js \
  --config /private/tmp/hosting-vite.config.mts --host localhost --port 6763 &
```

Verify after every Vite restart:

```bash
curl -s http://localhost:6763/src/config.ts | grep -oE '"VITE_ATOMIC_SERVER_URL": "[^"]*"'
```

Run the suite:

```bash
FRONTEND_URL=http://localhost:6763 SERVER_URL=http://localhost:9897 \
WEBSITE_HOSTING_E2E=1 ATOMIC_MOCK_INTEGRATION_PROXY=1 \
PLAYWRIGHT_WORKERS=2 PLAYWRIGHT_RETRIES=1 \
browser/e2e/node_modules/.bin/playwright test \
  --config browser/e2e/playwright.config.ts --project chromium --trace off --reporter line
```

**Note on topology:** CI builds the data-browser and embeds it in the server
(`data-browser/dist` → `server/assets_tmp`), so Playwright hits the *server*, not
Vite. I've verified both work; the dev-server topology is what the numbers above
were measured on. Prod fixes some specs and breaks the website ones (the preview
iframe wants an origin separate from the app), so don't switch topology
mid-investigation and compare.

---

## 3. What is actually failing

### 3.1 `vault-backup-restore` ×2 — blocked on a missing service

"Generate my recovery code" is clicked, the code never renders, and
`http://localhost:6763/api/recovery-secret` returns **404**. That is a
managed-node/portal API; a plain `atomic-server` does not serve it. The other
session's summary agrees: the vault panel needs the app to know a portal, and
only `atomic-managed-node` advertises one.

Nothing to fix in the spec. Either run a managed node beside it or the spec needs
to declare the dependency.

### 3.2 `website-inline-rte` — real, and the obvious fix is a dead end

Symptom: ~50% failure, always a popup inside the preview iframe (mention list at
`:58`, link field at `:92`). The `@` trigger itself works 6/6 in isolation, so it
is state from earlier steps in the long sequence.

**Diagnosis is confirmed by instrumentation.** During inline typing:

| event kind | count | path | target |
|---|---|---|---|
| non-local (`import`) | 17/17 | `["properties"]` | `cid:root-properties:Map` |
| local | 18/18 | `["doc", …]` | — |

The server echoes the author's own commit with a `lastCommit` stamp on the
resource's `properties` map. `LoroSyncPlugin` subscribes to the **doc**, not the
store (the store *does* suppress notify for an own-save echo — see
`commit-echo-and-save-cursor` in memory), so it rebuilds the whole ProseMirror
document for a change that never touches the document, and the rebuild destroys
any open popup.

**Do not re-attempt the `updateNodeOnLoroEvent` filter.** The older notes call it
a "verified fix candidate". I implemented and measured it (skip non-local events
with no `path[0] === ROOT_DOC_KEY`, only when `containerId` is unset). Result:
`website-inline-rte` + `website-inline-content` went from a steady
1-failed-1-passed to **6 failed / 2 passed** over four runs, with two separate
failures — the mention list stops populating (the Suggestion popup really was
relying on those rebuild transactions) and the character drop at
`inline-content:107` persists anyway. I reverted it; the dependency is
byte-identical to its patched state and `browser/patches/` is untouched.

The tractable framing is the **popup, not the patch**: make the tiptap Suggestion
plugin re-establish itself after a document rebuild, then the filter becomes
viable. That is product surgery in the editor — Joep has not green-lit it.

Related and already committed: `a2503df27` clears the tiptap renderer reference
on destroy (`CommandsExtension` destroyed it on Escape and left the reference
set, so `onExit` destroyed it again). Genuine latent bug; does **not** fix this
flake, and the commit message says so.

Iterating tip: edit the installed `dist/index.js` directly, then clear
`/private/tmp/hosting-vite-cache` and restart Vite. Vite pre-bundles the
dependency, so an edit is invisible until that cache is cleared — this cost me a
measurement that showed zero events.

### 3.3 `plugins:909`, `tables:482` — not real

Both pass in isolation (2/2 each). Load rotation, see §1.3.

---

## 4. Fixed today (for context on what the causes look like)

- `cc06e53ff` — `ensureAll` recovered each schema term with its own
  `findByLocalId` **inside a loop**: 19 serialised `/query` round-trips, 13 of the
  14 seconds creating an app. Now issued together. `apps` 6→0, `plugins` 11→2.
- `077555c32` — `signIn()` decided "already signed in" from the settings link
  being visible, which renders before the agent is in the store. Sessions with no
  agent navigated on, read their drive unauthenticated, never adopted one, and so
  never got a presence manager (it is keyed on the session drive). Agent state
  correlated exactly with outcome. `presence-follow` + `meetings` 15/15.
- `82847e965` — spec edited `subjects[0]` of a `parent=` query assuming it was the
  imported row; tables also hold draft placeholder rows with the same parent.
- `366156f53` — `AppSetupProvider` derived the Dialog's `show` from `isOpen`,
  which only goes false *after* a close that needs `show` false. Deadlock: the
  modal swallowed every click including its own close button.
- `6e79f6a4e` — specs hand-rolled `page.locator('[data-open]')` for the AI panel,
  which is transient state and never restored (#1475). Use `openAISidebar` /
  `sendChatMessage` from `tests/ai-mock.ts`.
- `a2f8f0125`, `45f721587` — action-menu snapshot race; Calendar spec read
  `VITE_INTEGRATION_PROXY_URL` from the test process, but that is a build input
  CI only passes to the bundler.

## 5. Things I got wrong — don't redo them

- `a5406e512` reverted `366156f53` on a measurement taken while the catalogs were
  desynced. Reinstated. **Any measurement taken with `src/locales/` dirty is
  suspect.**
- `9a1934038` retried the deep-link drive fetch on a 401, on a pending-handshake
  theory. Reverted in `077555c32`: the session simply had no agent.
- The loro filter, above.

All three shared a cause: acting on a 3–5 run sample in an environment I had not
yet established was trustworthy. Take more samples than feels necessary, and
re-check §1.1 before each.

## 6. Coordination

Another agent has been working **in this same checkout** on the same assignment
(`useChildren`, vault/portal, tombstones, perf-trace, optional diagnostics —
commits `8183a3bc6`, `993ad653b`, `0cd15fe9a`, `4117e9bd8`, `68af82756`,
`b9d03fcf7`, `fb56cfdba`, `f0de176c6`, …). Changing `node_modules` (a patch +
lockfile hash + reinstall) would swap dependencies under their running Vite, which
is why I left the loro patch alone. `366156f53` touches `AppSetupProvider`, close
to their integration work — likely conflict point.

There is also a separate manual-testing stack for Joep on **6765** (server 9899,
data `/private/tmp/atomic-manual`) — leave it running.

## 7. Suggested order

1. Confirm §1.1 is clean, run the full suite once, and see which reds reproduce in
   isolation. Expect ~2 of them not to.
2. `vault-backup-restore`: decide with Joep whether to run a managed node locally
   or have the spec declare the dependency. Cheapest real win.
3. `website-inline-rte`: only worth starting if Joep green-lights the Suggestion
   popup work. Do not touch the loro patch first.
