# `atomic-plugins-mock` fixture

A static stand-in for the plugin catalog published from
[atomic-plugins](https://github.com/ontola/atomic-plugins) at
`https://ontola.github.io/atomic-plugins/integrations/catalog.json`. The e2e
suite uses it by default, so a spec's outcome never depends on what happens to
be published upstream at the time.

`serve.mjs` serves the published layout:

| Path                                         | Source                            |
| -------------------------------------------- | --------------------------------- |
| `/integrations/catalog.json`                 | `integrations/catalog.json` here  |
| `/integrations/plugin-for-testing/plugin.js` | `../plugin-for-testing/plugin.js` |
| `/integrations/plugin-sync/plugin.js`        | `../plugin-sync/plugin.js`        |

The catalog holds two entries named for the states the specs need, not real
plugins:

- `fixture-experimental`: enabled and experimental, with no API requirement.
  It is what makes "Show experimental plugins" appear.
- `fixture-api`: requires API plugins and is disabled, so by default the
  catalog offers no API plugins. Specs that need one enable it with
  `page.route` on top of this response.

Each entry's `pluginUrl` points at a bundle served next to it, relative to the
catalog. The data-browser doesn't read `pluginUrl` yet. The bundles are served
so the catalog and its bundles have the same shape as upstream.

## Running it

Playwright starts it (`webServer` in `browser/e2e/playwright.config.ts`) on
`ATOMIC_PLUGINS_MOCK_PORT` (default 9893) and seeds the app's catalog URL with
it. To test against another catalog, set `PLUGIN_CATALOG_URL`. The mock then
doesn't start. To run it by hand:

```bash
node testdata/atomic-plugins-mock/serve.mjs 9893
```
