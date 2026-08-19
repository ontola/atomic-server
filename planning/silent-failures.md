# Silent failures

A running list of places where **error handling** let us down — kept separately
from the bugs themselves.

The pattern is always the same: a command reports success, a health check
passes, a tool "updates" nothing, and the damage surfaces hours later disguised
as an unrelated bug. Almost every expensive debugging session here has been a
silent failure rather than a hard one. The time goes into *discovering that
something did nothing*, not into fixing it.

**Rule of thumb:** prefer failures that cannot be missed — refuse to start, wipe
the bad state, exit non-zero — over printing a note. Notes scroll past, and most
of these tools run with output redirected to a log nobody reads.

Each entry: what happened, what it looked like, what should have shouted.

---

## Build and deploy

**`ATOMICSERVER_SKIP_JS_BUILD=true` silently embeds a stale frontend.**
The flag reuses whatever bundle was embedded last. `cargo build` prints success.
The server then serves a frontend older than its own sources — and since the
data layer is TypeScript, a fix that lives in the browser package is simply
absent while everything looks freshly deployed.
*Should have:* warned, at minimum, that the embedded bundle is older than the
sources it was built from. The README recommended this flag for e2e, which is
precisely where it does the most damage.

**A typecheck artifact in `dist/` made `build.rs` skip the JS build.**
`tsconfig.build.json` sets `outDir: ./dist`, so a plain `pnpm typecheck` drops
`tsconfig.build.tsbuildinfo` beside the bundle. `build.rs` compares the newest
file in `dist` against the sources, so that one file read as "dist is current".
Observed: sources 14:42, tsbuildinfo 14:43, actual bundle 13:47 — and a 17s
"successful" build. Cost several wrong diagnoses, one of them confidently
blamed on unrelated work.
*Should have:* compared against a file the JS build actually produces, and said
"skipping JS build because X is newer than Y" loudly enough to notice.
*Fixed 2026-08-18 (28865b4e).*

**A stale server binary diverges from vite, invisibly.**
`build.rs` embeds the data-browser bundle, and the invite and dev-drive pages
are served from *that* copy while every other page comes from vite. A binary
built on another branch therefore serves two different frontends at once. Three
e2e specs failed in a way that looked like a bug in the personal-drive work.
*Should have:* refused to run the suite against a binary older than its sources.
*Fixed 2026-08-18 (87e12c9a) — `test-server` now refuses and names the file.*

## Test harness

**An oversized `.e2e-store` invents 4–8 different failures per run.**
The script printed a NOTE past 150MB and carried on. The usual way to start it
is backgrounded with output to a log, so nobody read it. One full suite takes a
fresh store from 5MB to ~103MB, so the line is always about a run and a half
away.
*Should have:* wiped it. A warning is the wrong shape when the consequence is a
failure list that changes every run.
*Fixed 2026-08-18 (87e12c9a) — wipes by default, `--keep-store` to override.*

**`waitForSearchIndex(page)` with no query is a 1.5s sleep wearing a
readiness-helper's name.**
It "succeeds" whether or not the index is ready. Held on a warm store, failed on
a fresh one.
*Should have:* required the query, or at least not presented a fixed sleep under
a name that promises a readiness check.
*Fixed 2026-08-19 (a0ecf095).*

**Playwright's `-g` silently keeps only the last one.**
Passing two spec files with two `-g` filters ran one test and reported
`1 passed`. Nothing indicated the other filter had been discarded.

**No `webServer` block, so every spec fails on a dead port.**
With no dev server on 6747 the whole suite fails at `page.goto` with
`ERR_CONNECTION_REFUSED`, which reads as a suite-wide code regression.
*Should have:* one clear "nothing is serving 6747" rather than 176 identical
connection errors.

## Sync and data

**Hydration writes entered the outbox as if they were user edits.**
Opening a resource you can read but not write queued a commit the server rejects
forever. Those went through the entire backoff ladder and parked as blocked
entries, visible only in an activity feed. Underneath, `isOwnedSubject` answered
a *rights* question with a *domain* answer and no one noticed because it never
errored.
*Should have:* not been possible to enqueue a write nobody asked for; failing
that, a rejected write should surface where the person who caused it is looking.
*Fixed 2026-08-18 (ecaa4a63).*

**Two servers hold different data and both report healthy sync.** *(open)*
Desktop and HA are peered, mutually authenticated, live loops running — and the
desktop computes `SYNC_DIFF: server pushes 0, server pulls 1`, i.e. "I have
nothing to send you", while holding 27 children of a table the peer renders as
15 rows.
*Should have:* convergence failure is the loudest thing a sync system can have
to say, and it says nothing. There is no signal anywhere that two replicas
disagree — no divergence counter, no mismatch warning, nothing surfaced in the
UI. This is the most important entry in this file.

**`fetchResourceHTTP(url, {agent})` silently ignores the option.**
Returns `Unauthorized` rather than either signing the request or rejecting an
unknown option. Reads as a permissions problem, is actually a typo-shaped API
gap.

## Environment and deployment

**A Home Assistant add-on pinned to an image tag nobody publishes.**
`latest` came from a one-off manual push in June 2026; CI only refreshes
`develop`. "Update" re-pulled the same digest and reported success, so the
add-on served a two-month-old server while looking current.
*Should have:* a publish pipeline that never leaves a referenced tag stale, and
an add-on that surfaces the image digest/age it is actually running.
*Fixed 2026-08-19 — add-on now tracks a tag CI publishes.*

**A Cloudflare tunnel pointing at a stopped add-on.**
`atomic.ontola.io` returned 502 while Atomic was healthy and serving. The
ingress named a container that no longer existed; only cloudflared's own log had
`no such host`, and the add-on itself reported `started`.
*Should have:* the tunnel's ingress targets are configuration that can be
validated — an unresolvable origin should be visible where the add-on's health
is shown, not only in a log.

**`ha addons reload` reports success without reloading the add-on repo.**
The config change had merged upstream and HA still showed the old version.
`ha store reload` is the one that works.
*Should have:* not returned "Command completed successfully" for a no-op.

**Two add-ons for the same app have separate databases.**
Repointing the tunnel between them silently switches the entire dataset. Nothing
indicates you are now looking at different data — which is exactly the kind of
thing that makes a sync investigation chase ghosts.

**vite started from the repo root serves the built `dist/index.html`.**
No config loaded, no error — the Tauri window is simply white. The only clue was
an unresolved-dependency warning about `plugin-examples/`, which looks unrelated.
*Should have:* refused to start, or said which config it loaded and which root
it is serving.

**A running vite rewrites `src/locales/*.po` during git operations.**
Two writers (dev server + a build, or two dev servers) corrupt the catalogs.
Shows up much later as `[i18n-404]` or a misleading "Invalid hook call".
*Should have:* a lock, or a refusal to extract while another extractor holds the
catalogs.
