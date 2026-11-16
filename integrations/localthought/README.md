# LocalThought mapper and test fixtures

This directory contains the generic snapshot mapper and a mock for local
testing. Drive apps use the [host's integration proxy API](../AUTHORIZATION.md).

- `plugin.ts` maps fetched provider records to import proposals for typed
  tables. Its tests cover stable source IDs, repeated imports, preservation of
  local edits and rejection of duplicate identities.
- `mock-proxy.mjs` serves synthetic provider data. The optional mock-proxy mode
  in the local E2E server and the demo launcher still start it. Its test
  exercises the legacy PKCE, one-time redemption and connection-code rotation
  endpoints. The mock handles only synthetic identities and data.

Run the mapper and mock tests from the repository root after installing the
browser workspace dependencies:

```sh
browser/node_modules/.bin/vitest run --config integrations/localthought/vitest.config.ts
node --test integrations/localthought/mock-proxy.test.mjs
```

## Historical verification

On September 9, 2026, the earlier snapshot importer completed live OAuth and
imported 29 GitHub issues and pull requests through LocalThought Heroku release
v38 (`5960ae43`). The proxy changes for User-Agent and pagination are tracked
in [LocalThought proxy #28](https://github.com/localthought/integration-proxy/pull/28)
and [#29](https://github.com/localthought/integration-proxy/pull/29).

Google Calendar was verified against v39 after
[LocalThought proxy #30](https://github.com/localthought/integration-proxy/pull/30)
fixed matching OpenAPI server base paths. An import bounded to September 9
through October 9, 2026 (end exclusive, UTC) fetched 22 calendar-list entries
and 32 events. The current Calendar drive app lives in
[Atomic Plugins](https://github.com/ontola/atomic-plugins/tree/main/integrations/calendar).
