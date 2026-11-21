# Atomic Data Browser E2E tests

We use `playwright` to run end-to-end tests in the browser. Each test signs in with a new agent on the server under test.
Set `SERVER_URL` and `FRONTEND_URL` to the test instance. Set
`ATOMIC_E2E_AGENT_INVITE` to a reusable local invite. For a freshly initialized,
disposable server, set `ATOMIC_E2E_SETUP_INVITE` to its setup invite instead.
The setup step uses it once to create a read-only invite for ordinary test agents.

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
