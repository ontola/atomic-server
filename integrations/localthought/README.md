# LocalThought browser integrations

> **Currently broken on this branch.** The WASM Syncables engine was removed
> (#1618), so `engine()` in
> `browser/data-browser/src/chunks/PluginRuns/localThought.ts` throws and every
> LocalThought proxy call (connect, validation, import, refresh) fails. The fix,
> making those proxy calls inside the plugin iframe, is a follow-up. The rest of
> this document describes the intended flow.

The LocalThought flow runs entirely in the browser: catalog discovery, OAuth
consent, PKCE-protected return handling, paginated provider reads, ontology
creation and local Store/OPFS writes. Installation validates access once, creates
a folder, and starts an automatic inbound import without a proposal dialog. No AtomicServer HTTP
instance is needed. LocalThought remains the remote OAuth and API proxy.

Open Integrations, select a platform and choose **Install and connect**. The
browser creates a PKCE verifier and opens LocalThought's consent page, where
the selected platform is shown before you approve access. OAuth returns to the
same frontend `/app/integrations` page, and the browser redeems the one-time
handoff with the verifier. No tenant secret is entered in the browser. The
short-lived return is bound to the agent, drive and proxy; its code is removed
from the address bar immediately. A ten-minute, non-secret session marker resumes
setup if removing those parameters remounts the page; completing installation or
closing its setup dialog clears the marker.
Connection codes are stored in this browser's localStorage, outside the synced
graph, and may be read by code running on this frontend origin. Clearing site
data requires reconnecting. Existing server-held connections require reconnecting.
Web Locks serialize rotating codes across tabs; a request consumes its code
before dispatch and saves the replacement before processing data. Uncertain
requests cannot silently replay credentials.

The vendored Syncables crate and its wasm-bindgen bridge were removed in #1618.
The shipped pure import mapper reads a local snapshot and produces the existing
reviewed intents; user-edited plugin source is not executed on this path.
Local edits and repeated imports retain the existing reconciliation behavior.

## Installation and browser refresh

After connecting, choose the scope and select **Complete installation**. The
browser checks one catalog-selected provider API URL (HTTP success and a JSON
response), without following pagination or saving that response. This is an
access check, not a guarantee that every collection can be imported. Catalog
metadata requests are separate from that one provider request.

Installation immediately creates a normal folder and offers **Open folder**.
The full, paginated import runs in the background and creates typed tables and
views inside it. There is no JSON preview or Apply step for inbound records.
Opening the folder or a table refreshes it automatically, including after a
reload. While it remains open, a visible, online tab refreshes every five
minutes; returning to the tab or reconnecting the network also triggers refresh.
**Sync now** is available alongside **Syncing…**, the last successful sync time,
and any error. An import already started continues when navigating elsewhere
within the app. Closing the page stops it; reopening retries from the provider.

Settings, connection identifiers and sync status are saved only in this browser,
scoped to the installing agent and drive. The folder and imported records are
normal Atomic data. Another browser can read those records but needs its own
connection to refresh them. No server runner or closed-tab schedule is created.
A Web Lock covers the whole fetch/map/apply cycle, so simultaneous folder opens
across tabs cannot independently import the same snapshot.

Refresh uses the shared import baselines: stable source IDs reuse existing rows,
Atomic-only fields and local edits are preserved, and conflicts stop application
with a visible error. Missing rows do not imply deletion. Failed fetches leave
existing records readable and retain the last success time. A partial local
write is retried through the same stable identities on the next refresh.
Provider writes are still explicitly reviewed; opening a folder never sends
edits back to a provider.

Existing manual installations remain readable. Completing installation with an
existing connection creates a new browser-refresh folder; it does not move or
silently take over the old plugin tables.

## Build and proxy requirements

- Build `atomic-wasm` using `cd browser/data-browser && pnpm build:wasm`.
- Open **Settings → Integration** to select the integration-proxy URL. The
  preference is saved in this browser and applies without rebuilding. Connections
  are isolated by proxy origin; switching back restores that proxy’s connections.
  HTTPS or loopback HTTP origins only. **Reset to default** uses the deployment’s
  `VITE_INTEGRATION_PROXY_URL`, or `https://localthought.io` when unset. A build-time
  value that would not pass the same check is ignored, so a bad one cannot lock
  you out of this screen.
- Proxy cards have an accent border and a “Via integration proxy” label.
- Deploy the companion integration-proxy CORS change. It handles preflights for
  explicit Authorization headers and exposes `X-Connection-Code`, `Link`,
  pagination/count headers, `ETag` and `Retry-After`. Cookie credentials are not
  enabled; login and consent use top-level navigation. The browser sends
  `platform`, `redirect_uri`, `user_id`, `code_challenge`,
  `code_challenge_method=S256` and `credentials=connection` to `/connect`, then
  redeems the callback code at `/connect/redeem` with its PKCE verifier.
- Native AtomicServer's `TENANT_SECRET`, `ATOMIC_INTEGRATION_PROXY_URL` and
  `ATOMIC_INTEGRATION_FRONTEND_ORIGIN` no longer configure this flow. Its
  `/integration-proxy/*` handlers and Syncables dependency have been removed.

Consumer limits are 10,000 requests, 5,000 records, 10 MB per page/document
and 30 minutes per import, with a 30-second timeout per provider request. Calendar imports require explicit UTC date bounds.
Closed tabs do not run schedules. Other legacy integrations,
server plugin execution, actions and schedules are outside this migration.

## Checks

```sh
cargo check -p atomic-wasm --target wasm32-unknown-unknown
browser/node_modules/.bin/vitest run --config integrations/localthought/vitest.config.ts
```

For the browser-only mock journey (no AtomicServer on port 19999):

```sh
MOCK_PROXY_PORT=19091 MOCK_FRONTEND_ORIGIN=http://localhost:6748 node integrations/localthought/mock-proxy.mjs
# Separate terminal, browser/data-browser:
VITE_INTEGRATION_PROXY_URL=http://127.0.0.1:19091 VITE_ATOMIC_SERVER_URL=http://127.0.0.1:19999 pnpm exec vite --host 127.0.0.1 --port 6748
# Repository root:
node integrations/localthought/browser-smoke.mjs  # fails until the iframe move
```

The mock is test-only. It uses a synthetic signed-in identity and data; never
deploy it.

## Historical server-flow verification

The server-owned tenant-secret flow described by the historical notes below is
superseded by the browser redirect and PKCE flow. Live verification of the new
LocalThought login, selected-platform consent and one-time redemption is checked
separately after matching deployments and recorded in PR/release verification.
The fixture tests below do not claim live-provider verification.

Live verification on 2026-09-09 succeeded against proxy Heroku release v38
(`5960ae43`): OAuth returned to AtomicServer, Syncables fetched 29 issue/PR
records from `localthought/integration-proxy` and queried all 29 comment
collections (empty), and the reviewed records were applied and displayed in
the local AtomicServer table with generated platform properties.

Proxy fixes [#28](https://github.com/localthought/integration-proxy/pull/28)
and [#29](https://github.com/localthought/integration-proxy/pull/29) add the
required GitHub User-Agent and preserve query parameters and Link headers.
This live repository fit on one issues page; multi-page traversal is covered
by the mock and Rust tests. Google Calendar was also live-verified against proxy v39 after
[PR #30](https://github.com/localthought/integration-proxy/pull/30) fixed matching
OpenAPI server base paths. OAuth returned successfully, and a UTC range from
2026-09-09 through 2026-10-09 (exclusive) imported 22 calendar-list entries and
32 events after review. Event contents are not included in these test notes.
An unbounded fetch successfully traversed multiple pages but exceeded the
5,000-record preview limit; the UI now defaults to the next 30 days. Date
bounds and recurrence expansion are passed to Syncables as collection query
settings. That historical verification exercised the earlier manual snapshot importer.

## Google Calendar

The Calendar lens (Calendar view projection, reviewed two-way event edits,
`calendar.test.ts`, `calendar-sync.test.ts` and the
`google-calendar-import.spec.mts` E2E) was removed from this repo. Provider
plugins live in [atomic-plugins](https://github.com/ontola/atomic-plugins).
`calendar-proxy.patch` remains as the companion proxy change for write scopes
and `If-Match` CORS.

Each OAuth authorization creates a separate import installation. The proxy does
not provide a verified provider account identity, so reconnecting (even to the
same account to change scopes) creates new tables instead of reusing a previous
account’s tables. Repeated imports using the same connection reuse its tables.
