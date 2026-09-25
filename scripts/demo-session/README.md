# Demo sessions

Tooling for live user-testing sessions: one command starts an isolated
atomic-server and data-browser for a branch, with demo data seeded and a
dev-only interaction log that an observer (a person, or an agent using a
file-tail monitor) can follow while the tester works.

```sh
scripts/demo-session/demo-session.sh develop
```

Then open the printed URL,
`http://localhost:6757/app/dev-drive?demo-seed=calendar`. That page makes a
fresh agent and drive in the browser, so there is no signup and no secret to
type. The seed then builds the demo tables and opens the first one, which takes
about 3 seconds.

## What it does

1. Uses the branch's existing worktree, or creates one under
   `~/.cache/atomic-demo/worktrees/`.
2. Builds what is missing or stale:
   - `pnpm install`
   - the workspace packages the data-browser imports from `dist/`
   - the wasm pair, cached by the git trees of `wasm/` and `lib/`
   - `cargo build -p atomic-server`, with `SKIP_WASM_BUILD=1` and
     `ATOMICSERVER_SKIP_JS_BUILD=true`

   The server embeds a placeholder page instead of a production frontend build,
   because the app is served by Vite. Pass `--no-build` to skip this step.
3. Starts atomic-server on port 9893 with a fresh data, config and cache dir.
4. Starts Vite on port 6757 against that server, with the interaction logger.

Each run writes to its own folder, `~/.cache/atomic-demo/sessions/<stamp>-<branch>/`,
and `sessions/latest` points at the newest one:

| File          | Contents                                           |
| ------------- | -------------------------------------------------- |
| `ux.jsonl`    | the interaction log, one JSON object per line      |
| `server.log`  | atomic-server output                               |
| `vite.log`    | Vite output, including compile errors              |
| `session.env` | branch, commit, URLs                               |
| `data/`       | the store; delete the folder to throw it away      |

Ctrl-C stops both processes and keeps the folder.

## The interaction log

`uxLogPlugin.ts` is a Vite plugin with `apply: 'serve'`. It is only added
when `VITE_UX_LOG=true`, by the config the script generates, so it cannot end
up in a production build. The plugin injects `uxLogClient.js` into the page,
and the client posts batches to `/__ux-log` on the Vite server, which appends
them to `ux.jsonl`. It records:

- clicks, with visible text, accessible label, role, `data-testid`, the
  enclosing test id and calendar date, and a short selector
- committed input values, Enter and Escape. Values are cut to 80 characters.
  Password fields and fields labelled secret, key, token or password are
  recorded as `[redacted]`.
- route changes and page loads
- dialogs and toasts as they become visible
- `console.error` and `console.warn`, uncaught errors, unhandled rejections,
  failed resource loads and Vite error overlays
- failed fetches (with status and the first 80 characters of the body),
  fetches slower than 3 s, and WebSocket closes that were not clean

Follow it with, for example:

```sh
tail -f ~/.cache/atomic-demo/sessions/latest/ux.jsonl
```

Not recorded: typing before a field is committed, scrolling, hovering, or
what is on screen. Use screenshots for those.

## Seeds

`seed.js` runs in the page through the app's own creation code
(`buildTableFromSpec`, `createPropertyOnClass`), so it exercises the same
paths as the UI. It can also be run by hand from the console:
`await window.__demoSeed('calendar')`.

`calendar` creates:

- **Team calendar**: calendar and table views. Its columns use the shortnames
  the calendar view reads ranges and recurrence from (`atomic-calendar-day`,
  `-all-day`, `-end-day`, `-notes`, `-recurrence`). It has 17 rows:
  - recurring events: weekly on several days with an `UNTIL` and an `EXDATE`,
    one instance moved to another day, biweekly with a `COUNT`, the first
    Tuesday of each month, an all-day monthly event, a two-day quarterly event,
    a yearly event, and a weekly New York meeting that falls on the next day
    in Amsterdam
  - single events: all-day, multi-day, one across a month boundary, one on
    the European clock change (25 Oct 2026), one all-day without an end day,
    one in January 2027, and one without a date
- **Content plan**: a table with a `Publish date` column and no calendar view
  yet, for testing how a user adds one.

## Ports and parallel sessions

`--port` and `--vite-port` pick other ports. Two sessions on the same branch
share one worktree, and so they share its Vite translation catalogs (see
AGENTS.md). Run a second branch instead of a second session on the same one.
