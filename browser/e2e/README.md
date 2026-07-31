# Atomic Data Browser E2E tests

We use `playwright` to run end-to-end tests in the browser.

## Running the server

The suite needs the data-browser dev server on **6747** and an `atomic-server` on
whatever port **`VITE_ATOMIC_SERVER_URL`** names in
`browser/data-browser/.env.development` (currently 9885).

That indirection is the single easiest thing to get wrong here. The suite's own
`SERVER_URL` variable only points the test _helpers_; the app the tests drive
reads the vite env. Start a server on 9883 while the SPA is pointed at 9885 and
every test fails on a connection refused that mentions neither port.

Start the server with **its own store**, not your dev one:

```sh
# build a server binary once
ATOMICSERVER_SKIP_JS_BUILD=true cargo build -p atomic-server
# then, from browser/e2e:
pnpm test-server         # serves the configured port from <repo>/.e2e-store
pnpm test-server-fresh   # same, but wipes that store first
```

It prints the URL it chose and the matching `SERVER_URL=… pnpm test-e2e` to run.

Sharing your own store costs more than it looks like it saves. Every run adds
drives, tables and rows to the store you work in, and once it has a few hundred
runs' worth the suite starts failing on timing instead of on bugs — the totals
footer and the template specs lose races there that they win in isolation. A red
run then tells you nothing. Keep them separate, and reach for
`test-server-fresh` when a failure smells like load.

If a spec does fail, **reproduce it alone before believing it**:

```sh
pnpm playwright test some.spec.ts --project=chromium --workers=1
```

Comparing failure _sets_ against a known baseline beats expecting all-green.

```sh
# install deps
pnpm i
# install chromium
pnpm playwright-install
# run all tests, creates a `playwright-report` folder with HTML files + images
pnpm test-e2e
# run all tests and updates snapshots
pnpm test-update
# run all tests in debug mode
pnpm test-debug
# run a single test (e.g. 'table')
pnpm test-query table
# create a new test
pnpm test-new
# deploy report to netlify
netlify deploy --dir playwright-report --prod --site atomic-tests
```
