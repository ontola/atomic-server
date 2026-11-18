# Built-in Syncables apps: architecture and decisions

**Status:** Shared Syncables library integration under verification · **Date:** 2026-11-18
**Issues:** [atomic-server#2521](https://github.com/ontola/atomic-server/issues/2521), [atomic-plugins#733](https://github.com/ontola/atomic-plugins/issues/733)  
**Wireframes and click-through:** [builtin-syncables-wireframes.md](builtin-syncables-wireframes.md).

## Product contract

The Apps page shows an integration-proxy's available platforms (e.g. GitHub) as **apps**. Installing one creates a *configured instance of Atomic Server's built-in Syncables implementation* in the active drive. It does **not** install executable JavaScript from the proxy.

GitHub discovery and synchronization execute in the server-bundled, opaque
iframe app through the existing AppFrame / hostStore bridge. Organizations and
Repositories are ordinary native views over stored Atomic data. Opening or
revisiting them performs no provider request. Explicit refresh belongs in Sync.
The host retains credential signing, narrow destination authorization and app
execution lifetime. The iframe uses the actual `syncables/browser` library
for collection discovery and pagination, and Atomic-specific code projects
returned snapshots into drive resources and typed rows. No drive-root grant is exposed to an iframe.

### Ownership and distribution

| Responsibility | Owner | Transport into browser |
| --- | --- | --- |
| Main Data Browser, host view mounting, capability enforcement, iframe shell/bridge | atomic-server | Bundled in the Atomic Server/Data Browser release |
| Built-in Syncables iframe UI for accounts, collection types and mirrors | atomic-server | Bundled with Atomic Server and delivered to the sandbox on view open (no third-party module fetch) |
| Generic collection discovery and pagination (`syncables/browser`) | `syncables` npm package, maintained in atomic-plugins | Pinned dependency bundled into the server-delivered iframe module at build time |
| Provider OpenAPI documents/extensions and composed API catalog | integration-proxy (source maintained in atomic-plugins) | Declarative data from configured proxy; **never executable code** |
| OAuth, account credential vault, API forwarding | integration-proxy | OAuth redirects and credentialed HTTP proxy calls only |
| Third-party provider-specific plugins, if later needed | Independently shipped app catalog | Existing immutable SRI-verified module installation, still hosted in a sandbox |

**Existing reference points:** `browser/data-browser/src/chunks/AppPage/AppFrame.tsx`, `appFrameDocument.ts`, `hostStore.ts`, `browser/lib/src/catalog-app.ts`, `browser/data-browser/src/routes/IntegrationStore.tsx`, `browser/data-browser/src/chunks/TablePage/TableViewTabs.tsx`. Do not conflate the trusted built-in module with `installCatalogApp`, which installs external bundles.

## Intended hierarchy

```text
Current drive root (folder; logical platforms listing)
└── GitHub [App, provider icon from catalog metadata]
    └── Accounts [Table, app-data, SyncableAccountsTable]
        ├── Public [public repository picker]
        │   └── ontola
        │       └── atomic-server
        │           └── Issues [public mirror]
        └── michiel [connected account resource]
            └── Organizations [collection-type table, SyncableCollectionTypeTable]
                └── michiel [personal owner namespace]
                    └── Repositories [collection-type table]
                        └── personal-notes [repository resource]
                            └── Issues [authenticated mirror, SyncableCollection]
```

The GitHub install also has a **Public** branch alongside its account
resources. It contains only explicitly linked public repositories. The
sidebar expands discovery tables and keeps imported issue rows in the grid.

### Provider App installation and migration

- [x] Install the existing drive-local App class, retain the provider root's
  stable subject, local ID and index, and link its Accounts table with the
  existing `app-data` property. Opening a built-in App mounts the existing Sync
  app host against that Accounts table, with the same scoped bridge.
- [x] Register built-in execution with the closed `builtin-app: syncables`
  marker, independent of provider IDs and provider-supplied URLs. Ordinary Apps
  keep their existing entrypoint path. Native resolution only reads saved data.
- [x] On explicit Add/Open from Apps, migrate a legacy root Table into an App:
  preserve its name and location; reparent direct account/Public rows and listed
  views into Accounts without changing subjects, source keys or nested data.
  Preserve the saved default view and leave unrelated or manually moved rows
  alone. The root App is finalized after its Accounts table and views exist.
- [x] Reject mismatched or foreign Accounts bindings and stale drive stamps.
  Renaming or moving the App inside its drive preserves its identity and data.
- [ ] Verify the real root App, provider icon and migrated navigation together
  in the final native browser run after all implementation parts are complete.

**Do not confuse GitHub authentication with ownership.** A connection authorizes discovering an account's accessible organizations and repositories; the organization is not owned by that account. A personal username acts as a repository owner namespace, but need not be represented as a GitHub Organization object. Repositories belong under their canonical provider owner (organization or personal namespace), not directly under an OAuth account. A single organization may be reachable through multiple accounts.

The first hierarchy is an initial organizing layout, not the remote identity model. Users may move and link resources without breaking a mirror. A mirror's source key is based on the configured proxy, connection identity, platform, collection definition, remote instance ID/context and target table identity, **never the Atomic parent path**. If another connection discovers the same organization or repository, reuse canonical provider resource identities and model access via links, avoiding duplicate logical organizations. Whether to share one mirrored table between separate credential contexts requires an explicit policy; do not silently merge permissions.

## Views: three stable built-in kinds

1. **SyncableAccountsTable:** shown on the platform table. Connect/reconnect account; show existing connections, health and link to account's Organizations listing.
2. **SyncableCollectionTypeTable:** Sync controls for a collection-type table (Organizations, Repositories, etc.). Explicit refresh stores discovered instances; optional native directory views browse saved rows and expose Open/Sync issues actions. Refresh does not synchronize every descendant.
3. **SyncableCollection:** shown on a mirrored data table. Sync status, last good snapshot, row counts, partial errors, Sync now, Pause/Resume, source details. The ordinary Atomic Table view remains available separately.

These are host-recognized view kinds that can be rendered by one generic built-in iframe module with context-driven behavior. Provider-specific implementations may eventually be substituted behind the same view/bridge contract.

## Installation and navigation sequence

1. Apps loads the configured proxy's **structured, versioned service metadata** (or legacy `GET /catalog` platform-name array as fallback), preserving existing third-party app cards and visibility controls. Service icons are optional metadata, safely resolved; never scrape proxy catalog HTML.
2. User clicks **Install GitHub**. Host idempotently creates the platform table in the **current drive root** with a `SyncableAccountsTable` view and records the platform/proxy identity. No OAuth happens on merely viewing the catalog. Reinstall/open reuses the same platform resource for that drive/platform/proxy.
3. User clicks **Connect account**. Existing signed PKCE handoff goes to the selected integration proxy and the provider's OAuth account chooser. Proxy owns refresh tokens; Atomic receives a non-secret connection reference. Return is restored to the original drive and platform table; errors/cancellation leave a recoverable platform table, not an orphan.
4. The connected-account resource points to an Organizations collection-type table. The shared Syncables reader discovers its named collections from composed IAP metadata. Atomic code combines the returned organizations, repository owners and authenticated principal into stored owner namespaces; unsupported discovery is explicit, not silently empty.
5. An organization/owner namespace row opens a Repositories collection-type table **for that canonical owner**. Its repository items are born under the owner resource and retain source ID/context.
6. A repository row exposes available child collection types such as Issues. **Create and sync Issues** idempotently creates the mirrored table, source binding and `SyncableCollection` view, then opens that table. Do not eagerly download every repository's issues.
7. Only when the user requests Refresh list or Sync now does the sandboxed app use the **scoped shared host proxy transport**. `readCollections` performs selected collection reads and pagination; Atomic code upserts the returned snapshots into typed rows and records incomplete reads. Pause retains all local records.
8. Subsequent rediscovery, reauthentication and view opens reuse identities and tables. Moving/linking affects navigation only.

## Runtime / security boundaries

- The sandbox is null-origin with strong CSP; host message validation must bind iframe window, session and request identity. Prefer extending `AppFrame` / `FrameBridge` / `hostStore` rather than inventing a parallel privileged runtime.
- Provider OAuth credentials and refresh tokens remain at the proxy; they are never written to the Atomic graph, browser persistence or iframe. Browser-held connection keys and user signing keys stay outside the iframe. The host binds each request to the configured proxy, selected connection and allowed read endpoints.
- Only host-approved actions may create platform/account/collection-type/mirror resources. A general iframe does **not** receive unrestricted drive-root write access: the host checks the requested operation and source identity, prompts/reviews authorization as appropriate and scopes each destination.
- Treat OpenAPI descriptions, remote names, response data, icons and catalog descriptions as untrusted data. Do not execute script from provider metadata. Enforce valid platform identifiers, CORS, response size/timeouts and strict URL allowlists.
- Default remote sync is **read-only**. Do not infer deletion from a failed, partial, rate-limited or non-exhaustive read; record coverage and last success. Avoid duplicate rows with canonical upstream IDs and idempotent upserts.
- Sync starts only on an explicit request and can continue while the user navigates inside the open app. Closing or reloading the app stops it. Unattended synchronization and remote writes/review queues are separate enhancements.
- Preserve the normal table view and user-owned fields. Pausing/disconnecting a source must not destroy local tables or records.

## Known questions intentionally deferred

- Whether folders and tables should ultimately be unified. This design describes logical roles only.
- Whether mirror tables can be provisioned in bulk or only lazily (MVP: only on explicit selection).
- Cross-account reuse policies and grants when multiple OAuth connections can access one canonical organization.
- Full bidirectional editing and conflict resolution.
- Durable background jobs/offline syncing after the app closes.
- Whether all source/collection classes are shared vocabularies or generated per integration; retain stable schema identities until settled.

## Milestones and validation

1. Host can fetch `GET /catalog`, distinguish platform metadata from installable app bundles, show failures, and render provider tiles using the configured proxy.
2. Sync iframe exposes account setup and explicit refresh controls using the shared host bridge and a mock proxy. Native directory views display stored organizations/repositories.
3. Idempotent provisioner creates a platform table and a GitHub organization/repository hierarchy in a test drive, with host-enforced rights.
4. Select Issues and create one mirror, then read through the proxy and upsert rows using Syncables.
5. E2E proves OAuth return, connection reuse, personal namespace, two organizations, repo ownership, move/link stability, no credential leaks, cancellation, reconnect and partial-read safety.

A clickable HTML **concept** (not a production host implementation) accompanies the wireframes; use it to validate wording and navigation before wiring the live state.

## Implementation and verification

### Optional GitHub row-type views

- [x] Offer GitHub Organizations and GitHub Repositories through **+** and
  the tab menus for matching per-drive row classes. Do not create these tabs
  automatically or add presentation columns to the raw Table schema.
- [x] Keep kinds, counts and Open actions in native views of stored Atomic data.
  Compatible unbound tables can browse stored rows without provider capabilities,
  iframes or refreshing on entry.
- [x] Separate Sync controls/status from directory tables. Run issue imports
  in root-mounted hidden iframes so resource navigation retains the run.
  Bind every run to its source, drive, signed-in agent, server and proxy;
  deduplicate per mirror and cancel on pause or identity/source changes.
- [x] Verify custom-view navigation and a running sync with native E2E.
  Before library bundling, the `a4a2479b4` native run passed both GitHub flows
  and the 10 existing app journeys. The library integration requires a fresh run.
- [x] Check live rendered custom views on localhost using the real GitHub account.
- [x] Complete new UI translations in all five non-English catalogs; keep
  catalog identities, references and placeholders unchanged.
- [ ] Verify final exact-commit CI. The previous full run stopped at
  translation completeness; focused Linux browser validation passed.
  Translation repair passes all 2,697 Data Browser tests and both MCP tests
  with CI’s UTC setting; the existing Amsterdam date-fixture gap is recorded
  in TESTING_COVERAGE.md.

- [x] Configured catalog, account-menu entry and idempotent GitHub installation.
- [x] Source-scoped iframe operations and owner-signed keyed proxy reads.
- [x] Personal and organization discovery, stable repository and mirror
  identities, typed idempotent issue rows and pause.
- [x] Verify keyed OAuth return, retry, reconnect and repository issue sync
  with the native Playwright walkthrough against a protocol-checking proxy
  fixture.
- [ ] Verify PR checks on the final revision.
- [x] Verify GitHub OAuth and the account listing on the deployed keyed
  proxy at `integrations.atomic.place`.
- [x] Verify public repository linking and issue import against live GitHub.
  GitHub reports 1,217 issues and the local Public mirror contains 1,217.
  The signed-in account still uses the deployed keyed proxy.

The GitHub sync app uses the shared ViewStore CRUD, proxy and execution APIs.
The host profile fixes the proxy origin, active connection, destination root,
allowed routes and query constraints. The iframe never receives a signing key
or connection key. Its injected transport forwards library requests through
that profile. The actual Syncables reader owns named collection discovery,
pagination and partial snapshots; there is no separate GitHub page loop or
cursor parser in Atomic Server.

GitHub can omit an organization from the signed account listings when it
restricts the OAuth app. The Public view accepts an explicit `owner/repo`.
The host limits public reads to repository metadata and the selected Issues
endpoint. The sync app verifies canonical owner and repository IDs before
provisioning a tree under Public. Its Issues view
uses credential-free GitHub reads, with source identities separate from
mirrors that use a signed account connection.


### Live verification before shared library bundling

The `michielbdejong` account connected through `integrations.atomic.place`.
The Public branch linked `ontola/atomic-server` as a separate anonymous
source, completed all GitHub cursor pages, and imported 1,217 Issues.
GitHub search returned the same count with `incomplete_results: false`.
Open issue #2566 and closed issue #2454 matched the imported titles and
URLs. The sidebar shows Public alongside the connected account, with
navigation resources through Issues and no imported issue rows or table
view definitions underneath.

This live verification predates the shared library change. Its final
production build, real-server Chromium walkthrough and exact-head CI remain
release gates below; the earlier successful run does not satisfy them.


## Shared bridge and stored browsing refactor

Owned checkout: `codex/builtin-syncables-completion`, based on `49e207dca`.
The existing feature worktree is reused. Parent owns built-in profile/runtime,
provider schema, docs and integration; shared_bridge owns AppFrame/hostStore/
viewClient generic profile support; sync_app owns iframe discovery/reconciliation;
native_views owns native directory rendering and its browser regression coverage.

- [x] Replace SyncablesFrame and Syncables-specific host RPC with the existing
  AppFrame / handleRequest / ViewStore CRUD and proxy APIs.
- [x] Keep host-selected source, connection, destination and cancellation scope;
  preserve user signing and existing generated-app defaults.
- [x] Persist organization counts and repository visibility/Issues metadata;
  retain unknown/prior totals after incomplete reads.
- [x] Native directory views use stored Atomic rows only; no iframe, provider
  fetch, refresh button or automatic discovery on entry/reentry.
- [x] All provider refresh occurs explicitly in Sync; root-mounted generic app
  workers survive navigation and stop on pause/source/session changes.
- [x] Reuse moved source identities without broadening write permissions.
- [x] Run focused security, local-view, typed-sync, translation and real-server
  browser tests; inspect rendered desktop/mobile and updated LOC totals.
  Refactor validation: 2,702 Data Browser tests + 2 MCP tests, 76 library
  tests and 26 plugin protocol tests; Data Browser/E2E/lib/plugin typechecks.
  Native Chromium run covers both GitHub flows and the 10 existing app
  journeys. Production diff versus 49e207dca: 2,748 additions, 3,218 removals
  (470 fewer lines; includes comments/blank lines, excludes tests/catalogs).
- [ ] Update PR/issue descriptions and follow exact-commit CI.

## Generic collection browsing and provider App roots (2026-11-18)

User requested a generic native `SyncableCollection` view instead of GitHub-specific
Organizations/Repositories renderers, followed by a root provider resource of class
App with its integration icon. Reuse this task's worktree and preserve the pending
library integration. Provider reads remain in Sync; browse only stored Atomic data.

- [x] Design stored, provider-independent collection presentation and navigation.
- [x] Replace provider-specific view kinds and renderers with the generic view.
- [x] Cover an unrelated provider/schema, malformed metadata and scoped navigation.
- [x] Provision/migrate a real App root with provider branding and stable identities.
- [x] Verify native browsing during sync, raw Table schema, build and local UI.
- [ ] Update docs, PRs and exact-head CI after integration.

Architecture: `library_architecture`; renderer/metadata: `library_sync_app`;
E2E: `library_e2e`; coordinator owns App provisioning integration and publication.

## Shared Syncables library bundling

Owned server worktree `codex/builtin-syncables-completion`, base `a4a2479b4`;
paired owned plugins worktree `codex/syncables-proxy-contract`, base `e72b2eea`.
Parent owns dependency pins/build integration, metadata transport, docs and CI.
Library agent owns the standard IAP overlay/catalog and library selection
fix/release.
App agent owns Sync app reader replacement and its regression tests.

- [x] Read current library/browser APIs and establish ownership boundary.
- [x] Pin the published `syncables/browser` npm release and bundle it into the
  shipped iframe; obtain the composed API/read metadata from the IAP catalog.
- [x] Replace local provider discovery/pagination with `describePlatform` and
  named `readCollections`; retain partial snapshots and fixed read budgets.
- [x] Keep Atomic schema/storage/UI and host route/permission enforcement here;
  preserve stable identities, anonymous Public sources and pause/cancellation.
- [x] Verify the final published dependency installs with the frozen lockfile
  and the production artifact contains the real library, with no Node builtins
  or runtime external imports.
- [x] Run final library/unit/type/build and real-server Chromium acceptance
  checks after the published dependency is installed.
- [x] Release the npm version and publish/deploy the new standard IAP catalog.
- [ ] Update paired PRs/issues and follow exact-head CI.

The configured proxy supplies declarative composed OpenAPI metadata from a new
versioned IAP catalog. A standard OpenAPI Overlay uses CRUD Causality and
Pagination Schemes for GitHub organizations/repositories/canonical Issues;
historic catalogs stay immutable. No provider read definitions or runtime
JavaScript are bundled from a separate metadata package. The library owns
collection selection and pagination; Atomic owner grouping and typed
reconciliation remain in the server-bundled app. User explicitly authorized
merging the paired PR and publishing a new Syncables npm version after CI.

The source app is `browser/data-browser/src/chunks/PluginRuns/builtinSyncApp.js`.
The browser build bundles it with the reader into `builtin-syncables.js`, and
Atomic Server serves that embedded asset through the existing sandbox endpoint.
Worker preparation loads `/catalog/github-issues.yaml` and the optional
`.selection.json` from the configured proxy with bounded, credential-free
requests. The iframe receives parsed public metadata through its existing
context API, then selects `githubOrganizations`, `githubRepositories` or
`repositoryIssues`. The canonical Issues collection is an alias on the existing
issue resource. Page sizes come from catalog query defaults, and the read's
`state=all` comes from ordinary collection metadata.

The final published dependency is `syncables@0.28.0`, built from merged
atomic-plugins commit `3470118414fb0b10d7cffd8aed060fe1ff5bd21f` (#734). npm
provenance and tarball SHA-512 were verified; the exact registry dependency and
frozen lockfile install pass. The bundle test proves real reader inclusion and
no external runtime imports. All 2,755 Data Browser tests and its typecheck pass
with this dependency. New locale strings are translated in every supported
catalog. The fresh final Chromium run passes all 12 journeys, including App/icon, native
collection browsing, background sync, raw Table schema and 390px mobile actions.
Exact-head server CI remains pending.

The first full hosted run on `e10005512` (44324010397) passed its static gates
but failed browser-test discovery: the fresh Dagger Playwright image copied the
existing app SDK fixture, but omitted the new Syncables SVG/catalog fixtures.
Both shards stopped with `ENOENT` before executing tests. The focused Linux
workflow and private downstream build passed on that revision. Include the
shared fixture directory in the full-suite container and cover its availability
with the Dagger regression harness, then rerun full CI on the corrected head.

The opt-in catalog, overlays and provider icon are published and byte-matched.
The live integrations.atomic.place catalog-only update (run 44318123388) preserves
all 17 providers and verifies its runtime binary and public connection key are
unchanged. OAuth credentials, vault and agent permissions were not modified.

Remaining architecture scope: provider-specific discovery/grouping and Atomic
field bindings still live inside the server-delivered iframe adapter. The native
collection view and App installation/branding are generic. Moving that adapter
to an atomic-plugins app package is separate unfinished work; this plan is kept
for that boundary and the pending PR/CI follow-through.
