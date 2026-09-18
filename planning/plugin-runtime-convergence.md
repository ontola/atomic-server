# Plugin runtime convergence: one host, two worlds, any language

Status: proposal, 2026-09-18, for
[ontola/atomic-server#1546](https://github.com/ontola/atomic-server/issues/1546).
Builds on [extension-architecture.md](extension-architecture.md) (which already
keeps class extenders as a separate "server extension" trust boundary) and
[plugin-model-review.md](plugin-model-review.md) (finding 1: the JS host has no
effective grant). Nothing here is implemented.

## What is actually disjoint

The language is the least disjoint part. Both runtimes are wasmtime components
with fuel accounting, a memory limiter and the same egress guard:

- The JS runtime is itself a WASI component: `plugin-runtime/` embeds QuickJS
  (rquickjs) and exports `run(source, input)`; the server runs it through
  wasmtime in `server/src/plugins/js_runtime.rs`.
- Rust/WASM class extenders are WASI components loaded by
  `server/src/plugins/wasm.rs` and bridged into `lib::class_extender::ClassExtender`.

What differs is everything around the guest:

| Axis | WASM class extender | JS plugin |
| --- | --- | --- |
| Host WIT | `atomic:class-extender/host`: get-resource, query, get-plugin-agent, get-config, commit, fetch | `atomic:plugin-runtime/host`: fetch, invoke-action, get-resource, query |
| Host impl | `wasm.rs` (~lines 728–1063), own egress/secret wiring | `js_runtime.rs` `StoreHost` (~256–510), own egress/secret wiring |
| Guest contract | exports `class-url`, `on-resource-get`, `before-commit`, `after-commit`; writes imperatively via `commit` signed by the plugin agent | exports `run`; returns a verdict, host plans/reviews/applies |
| Trust | operator installs; hooks run inside reads and commits | user installs; proposal-only, review, receipts |
| Manifest | `plugin.json`: `permissions[{permission,reason}]`, `network.origins`, `configSchema` | `export const manifest`: `schemaVersion`, `secrets`, `operations`, `actions` |
| Identity | zip → `PluginMeta{drive,namespace,name}` DB tree, `pluginFile` property | source-as-property on `plugin-script`, content-addressed `plugin_release` |
| Engine | its own `Engine` (`wasm.rs:246`) | its own `Engine` (`js_runtime.rs:128`) |
| UI | `ui.js` via LegacyViewAdapter | app entrypoint via FrameBridge (already converged) |

So there are two host implementations, two manifests, two identity stores and
two guest contracts, but only one sandbox technology. That is the shape to fix.

## The principle: language is orthogonal to trust

Today the language implies the contract: wasm means class extender, JS means
`run`. That coupling is accidental. Decouple them:

- **Two worlds, by trust boundary.**
  `extension` exports `run` (and later `view`, `action`); it proposes effects and
  is user-installable. `server-extension` exports the class-extender hooks and
  may write; it is operator-installed. This is exactly the boundary
  extension-architecture.md asks to keep. It becomes a property of the
  installation and manifest, not of the file extension.
- **One host interface, imported by both worlds.**
- **Any language for either world.** A wasip2 component can export `run`; a JS
  module can export `beforeCommit`. The JS runtime component is the adapter
  that turns JS exports into world exports.

## Steps, each landable on its own

### 1. One host package and one host implementation

Define `atomic:host@1` in one WIT file under `lib/wit/` (the docs already point
there) with: `get-resource`, `query`, `fetch`, `invoke-action`, `get-config`,
`commit`. Both `class-extender.wit` and `plugin-runtime.wit` import it.

Implement it once in Rust, carrying the effective grant from plugin-model-review
finding 1 (caller ∩ installation grants ∩ declared capabilities). Egress checks,
secret substitution, response caps and the `PluginHost` trait all move here;
`wasm.rs` and `js_runtime.rs` keep only component instantiation. Share one
`Engine` and one fuel/memory policy table keyed by capability.

`commit` returns an explicit "this installation is proposal-only" error for
`extension` installations. The JS host today has no commit; the wasm host today
has no grant. This step gives both the stronger half.

Exit: one egress path, one secret path, one grant check. This is the largest
payoff and removes the most duplicated security-relevant code.

### 2. One manifest

Extend the versioned JS manifest (`server/src/plugins/manifest.rs`) rather than
adding a third format:

```json
{
  "schemaVersion": 2,
  "runtime": "js" | "wasm",
  "world": "extension" | "server-extension",
  "entrypoints": { "run": true, "view": "ui.js", "classExtender": ["https://atomicdata.dev/classes/Folder"] },
  "capabilities": ["storage", "full-drive-access", "extended-fuel", "extended-memory"],
  "secrets": [], "operations": [], "actions": [],
  "configSchema": {}, "defaultConfig": {}
}
```

`plugin.json` is translated at the zip-import boundary (`install_or_update_plugin`)
and rejected if it needs `commit` without `world: server-extension`. The
`permission.reason` strings become the review text for capabilities.
`network.origins` becomes `operations`/`secrets`; that also fixes finding 5
(origins derived from stored secrets instead of declarations).

### 3. One installation and release record

A zip is a distribution form of a release, not a different identity system.
Compute the content-addressed release identity for zip contents the same way
`plugin_release.rs` does for JS source, and store the installation in one place.
`PluginMeta` (drive, namespace, name, agent secret, manifest) is the natural
installation record for both; the `plugin-script` resource keeps
`plugin-source` as the authoring form and gains a `pluginFile` pointer when it
was installed from a package. Grants, revocation tombstones and upgrade review
from the 2026-09-08 checkpoints then apply to wasm installs for free.

### 4. Class-extender hooks for JS (server-extension world only)

Give `plugin-runtime.wit` optional exports `on-resource-get`, `before-commit`,
`after-commit` that dispatch to JS exports of the same names. The host wraps the
instance with the existing `into_class_extender`. This is only reachable when the
installation is `server-extension`, so it does not widen user-installed plugins.
It lets an operator vibecode a validation hook without the Rust toolchain, which
is the concrete ask behind "JS is required for fast iteration".

Performance is the honest limit: an interpreted hook on every read of a class is
slower than a compiled one. Fuel per call and per-class scoping bound the damage;
document it and let people move hot hooks to Rust.

### 5. `run` for wasm components (extension world)

Let a wasip2 component export `run(input) -> verdict`. Then triggers, cron,
actions, sync sessions, review and receipts work for compiled plugins. Add an
`export_run!` macro next to `export_plugin!` in `atomic-plugin`. This is what
"performance-critical use cases" get: the same lifecycle as JS with native speed.

### Deferred, deliberately

- Bundling JS into a component (javy-style, runtime + source in one artifact) so
  a JS plugin can ship as a zip. Source-as-data is the better authoring path and
  step 3 already lets both forms share identity; revisit only if distribution
  needs it.
- Moving the JS runtime out of wasmtime for speed. It would lose the shared
  sandbox for a small gain; put hot code in Rust instead (step 5).
- Any change to the browser view bridge. FrameBridge is already the one path.

## What this does not merge

The proposal-only contract and the imperative hook contract stay different
because they mean different things: one proposes, the other participates in the
database. Merging them would either give user plugins commit hooks or strip
server extensions of them. The merge is of host, manifest and identity, so that
an author picks a language for speed and a world for trust, independently.

## Order and evidence

1 → 2 → 3 are refactors with existing e2e coverage (`plugins.spec.ts`,
`plugin.spec.ts`, the integration Rust tests) and should show no behavior change
except stricter grants. 4 and 5 add capability and need new fixtures: a JS
`before-commit` rejecting a commit, and a Rust `run` producing a reviewed verdict.

## Scope: server vs drive

Uploaded WASM plugins are already drive-scoped (`scoped/<drive>/`, `PluginMeta`
keyed by drive, `check_scope` compares the resource's root parent). Only files an
operator drops into `global/` are server-scoped, and those have no resource. The
real asymmetry is where state lives and where code executes:

| | WASM (drive-scoped) | JS |
| --- | --- | --- |
| Source of truth | `pluginFile` blob in the drive | `plugin-source` in the drive |
| Server-local state | extracted files, `.cwasm` cache, agent secret | agent secret, secrets, release pin |
| Executes | inside every read/commit on any node holding the drive | one owning execution host per job |

Rules:

1. Server scope is the operator's `server-extension` world, configured on disk,
   never via a commit. Scope follows from install path, not the manifest.
2. Drive-scoped install state is a derived cache. A node that receives a drive by
   sync or restore re-materializes the install from the blob and release id, like
   an index. Agent secrets stay per node and per installation.
3. Replication semantics, not language, decide placement. `on-resource-get` runs
   on every node that materializes the drive. `before-commit` runs only on the
   node accepting the commit and is skipped for replicated commits. `run` is a
   job with one owner. Open question: whether peers should re-run validation
   hooks at all, or whether the accepting node's signature is the only validation.
4. The WASM root-parent check and JS `installation::resolve` are one guard written
   twice; both move into the shared grant-carrying host (step 1).

## One install path and a marketplace

### Today: four install paths, two catalogs

| Path | Trigger | Where the code ends up |
| --- | --- | --- |
| Zip upload | `Plugin` resource + `pluginFile` commit hook (`server/src/plugins/plugin.rs`) | `scoped/<drive>/` on disk |
| Catalog JS | `/plugin-catalog` → `/plugin-package/{id}` → `createPlugin` (`routes/IntegrationStore.tsx:151`) | copied into a `plugin-script` resource, not pinned to the release |
| Bundled integrations | hardcoded list in `IntegrationDiscovery.tsx:45` | app code |
| Global server extension | files in `global/` | disk |

The catalog (`plugin-release/v1`, `plugin-catalog/v1`) lives in the `PluginMeta`
KV tree of one server. It is not a resource, so it cannot be fetched from another
server, referenced, signed or synced.

### Design: a Release is a resource, an Installation is a commit

Two classes replace the four paths.

**Release** (immutable, content-addressed, lives wherever it was published):

```
Release
  runtime        "atomic-js/1" | "wasip2/1"
  world          "extension" | "server-extension"
  manifest       JSON (the unified manifest from step 2)
  source         string        (JS runtimes)
  package        File          (wasm zip blob; blake3 already on the File)
  schemas        alias → schema identity
  releaseId      "blake3:…" over the fields above, recomputed on install
  version, previousRelease, publisher (the committing Agent)
```

Being a resource is what makes it a marketplace: a **Listing** resource (name,
emoji, description, domains, standards, evidence, support tier, `release` URL)
in any drive is a store entry. The default marketplace is a drive on
atomicdata.dev; a company or a self-hoster can run their own by creating a drive
of Listings. Discovery is a query over Listings; fetching a Release from another
server is the ordinary remote-resource fetch. Integrity is the recomputed
`releaseId`; provenance is the publisher's commit signature. `CatalogEntry` and
the KV catalog become a cache of fetched Release resources.

**Installation** (one per drive per package, replaces `Plugin` and the installed
role of `plugin-script`):

```
Installation
  release        URL of the Release
  releaseId      pinned hash
  config         JSON validated against manifest.configSchema
  grants         capabilities the installer approved
  status         draft | active | paused | revoked
```

Committing an Installation with `status: active` is the single install trigger
for both runtimes. The commit hook that today only handles zips generalizes:

1. Resolve the Release, locally or through `fetch_bytes_untrusted`, verify
   `releaseId`, reject if `world` is `server-extension`.
2. Check the manifest capabilities against the grants in the commit.
3. Materialize by runtime: JS needs nothing on disk; wasip2 extracts and
   compiles into `scoped/<drive>/` as today.
4. Mint the installation identity (`PluginMeta` agent) as today.

Uninstall is `status: revoked` or destroying the resource, same for both.

### Authoring and publishing become one flow

- `plugin-script` stays as the **draft**: source as data, editable, runnable in
  preview. It is not an installation.
- **Publish** creates a Release from the draft. `publishPluginRelease` already
  does this for JS; add the zip form so `atomic-plugin` can publish a wasm
  Release to a server with one POST instead of producing a file to upload.
- **Upload a zip** and **paste source** both become "publish a private Release
  on this server, then install it". Nothing about the install differs.
- **Bundled integrations** ship as Release and Listing resources in the server's
  defaults (like `lib/defaults/*.json`) and appear in the local marketplace on
  first boot. The hardcoded browser list goes away.
- **Global server extensions** stay operator-configured, but the config takes
  Release URLs (`ATOMIC_SERVER_EXTENSIONS=<url>,…`) so operators install from
  the same marketplace with the same integrity check. Still no resource, still
  no drive, still not installable by a drive owner.

### Store UI

One Store route: browse Listings from the local marketplace plus configured
remote marketplaces (default atomicdata.dev), search, open a Listing, review the
manifest capabilities with their reasons, install into the current drive. The
"Show experimental" and "Show API plugins" toggles become marketplace filters.
The upload-zip dialog and the paste-source dialog both end in the same
Installation review screen.

### Migration

- Each existing `Plugin` (zip) resource: create a local Release wrapping its
  `pluginFile` blob, then rewrite the resource as an Installation pinned to it.
  The on-disk files are unchanged, so no reinstall.
- Each `plugin-script` created from the catalog: create an Installation pinned
  to the Release it was copied from (the `plugin-release-pin` step already
  records this for connections); the script becomes its draft.
- The KV catalog entries: republish as Listing resources in a marketplace drive
  on the same server.

### What this depends on

Steps 1 to 3 of the runtime convergence above, in particular the unified
manifest, since the install review renders capabilities from it. The
marketplace drive itself needs nothing new from the runtime work; Listing and
Release can be added as classes first and the old paths adapted one at a time.

## Implementation checkpoint (2026-09-18)

Branch `feat/plugin-convergence`, built from four parallel tracks off develop
`ec22e345b`. All Rust suites and the browser lib suites pass; the Playwright
specs added for the Store were written but not run.

- [x] One host: `server/src/plugins/host_core.rs` backs both the wasm and JS
  hosts. Reads are authorized as the installation's agent (never Sudo), fetch is
  address-pinned with a streamed byte cap, secret substitution happens once,
  `commit` is refused for proposal-only installations. WIT interfaces unchanged.
- [x] One manifest: schemaVersion 2 in `server/src/plugins/manifest.rs`, mirrored
  in `@tomic/lib`, 41 shared fixtures under `testdata/plugin-manifest/`. v1
  upgrades and serializes byte-identically, so release ids are stable.
  `plugin.json` translates at the boundary using the component's class URLs.
- [x] One record: `PluginRelease` for both runtimes; Release, Installation and
  Listing classes in `lib/defaults/plugins.json`. An Installation commit installs
  either runtime; publishing records a Release resource at
  `<server>/releases/<id>`. `check_grants` requires the exact declared set.
  Legacy Plugin + pluginFile still works.
- [x] Store UI installs through one review dialog from a Listing or a zip upload;
  Installation page with pause, resume, revoke, uninstall.
- [ ] Listing resources are not yet read by `/plugin-catalog` (still KV).
- [ ] Bundled integrations still come from the hardcoded browser list.
- [ ] Global server extensions do not yet accept Release URLs.
- [ ] Steps 4 and 5 (JS class extenders, wasm `run`) not started.

Decision recorded: a wasip2 release whose component exports class URLs is
`world: server-extension` and may still be installed through an Installation,
where it runs drive-scoped exactly as legacy zips did. Only the operator's
`global/` directory is server-scoped. A JS `server-extension` release is
refused through an Installation until step 4 exists.
