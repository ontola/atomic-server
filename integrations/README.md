# Integrations

Plugins live in [atomic-plugins](https://github.com/ontola/atomic-plugins) and
reach a server as JS bundles fetched over HTTP from its catalog
(`https://ontola.github.io/atomic-plugins/integrations/catalog.json`, or the
URL set under Settings > Integration). Provider code, provider tests and
provider certification belong there, not here.

This folder keeps `localthought/`, the LocalThought proxy client, until
atomic-plugins takes it over; the data-browser no longer imports it. It also
keeps the docs for the host's plugin contract. Test plugins and the catalog mock the
e2e suite runs against are fixtures under [`testdata/`](../testdata/).

Named actions, automation permissions, recovery and MCP setup are documented in
[ACTIONS.md](ACTIONS.md). The MCP stdio protocol test runs in the JS CI gate.

## Declaring config

A plugin that reads `ctx.config` declares the shape it needs in its `manifest`,
beside the code that destructures it:

```js
export const manifest = {
  schemaVersion: 1,
  operations: [],
  secrets: [],
  config: {
    // Key this plugin's config sits under in the installation's stored config.
    // Omit it when the config is stored flat.
    key: 'example',
    properties: {
      table: { type: 'string', description: 'Table the records are written to' },
      properties: { type: 'object' },
    },
    required: ['table'],
  },
};
```

The host builds `ctx.config` once for preview, manual runs and scheduled runs
alike, and checks it against this declaration before starting the sandbox. An
installation that never stored its config then pauses on a problem naming the
field to set, instead of on whatever `run()` throws when it destructures
`undefined`. The declaration is optional: a plugin that omits it is run exactly
as before, so guard `ctx.config` in `run()` too.

Shared provider sign-in supports direct and managed deployments; see
[authorization service setup](AUTHORIZATION.md) for the common FOSS transport,
per-server provisioning, credential handling and current limits.

## Portable package resources (initial library API)

`@tomic/lib` can import an app definition from a standalone JSON document. See
[`app-package.json`](../browser/lib/src/fixtures/app-package.json) for the format:
metadata, a revision URI, the existing `PluginRelease` payload, and optional
validated setup metadata. No provider module needs to be imported by the host.

```ts
import {
  appPackageSchema, ensureSchema, prepareAppPackageImport,
  planVerdict, planHostFromStore,
} from '@tomic/lib';

const schema = await ensureSchema(store, drive, appPackageSchema());
const verdict = prepareAppPackageImport(importHost, json, packageFolder, schema);
const plan = await planVerdict(verdict, planHostFromStore(store));
// Show this plan for review, then use the existing applyPlan path.
```

`importHost` must read authoritative destination resources, as with other shared
imports; an incomplete UI collection is not sufficient for duplicate detection.
`readAppPackage(resource.getPropVals(), schema)` reads back the portable document.
The content uses canonical JSON text so generic graph-reference rewriting cannot
alter code or literal setup text. Top-level display labels reserve the `local:`
prefix, matching the importer. The document limit is 4 MiB.

Import produces an inert `app-package` resource under the host-chosen parent.
Repeated imports reuse its native localId. Use a new revision URI for changed
content; reusing one causes a conflict. That URI is an import identity, not a
verified signature or server release hash. Metadata is untrusted, and importing
never executes source. Package authors must not embed secrets in source/data.

The package-supplied manifest must still be compared with the sandbox-extracted
manifest during activation. Fresh installation identity, host-held credentials,
consent and schedule activation belong to installation, never the distributed
document. Imported packages are not yet exposed in the store UI or installable
through a generic sandbox setup. Schema bindings currently refer to external
resources; bundled schema/template graphs remain future work.
