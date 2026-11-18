# Built-in Syncables apps: architecture and decisions

**Status:** GitHub implementation under verification · **Date:** 2026-11-13
**Issues:** [atomic-server#2521](https://github.com/ontola/atomic-server/issues/2521), [atomic-plugins#733](https://github.com/ontola/atomic-plugins/issues/733)  
**Wireframes and click-through:** [builtin-syncables-wireframes.md](builtin-syncables-wireframes.md).

## Product contract

The Apps page shows an integration-proxy's available platforms (e.g. GitHub) as **apps**. Installing one creates a *configured instance of Atomic Server's built-in Syncables implementation* in the active drive. It does **not** install executable JavaScript from the proxy.

GitHub discovery and synchronization execute in the server-bundled, opaque
iframe app through the existing AppFrame / hostStore bridge. Organizations and
Repositories are ordinary native views over stored Atomic data. Opening or
revisiting them performs no provider request. Explicit refresh belongs in Sync.
The host retains credential signing, narrow destination authorization and app
execution lifetime; provider discovery, mapping and reconciliation belong to the
iframe app. No drive-root grant is exposed to an iframe.

### Ownership and distribution

| Responsibility | Owner | Transport into browser |
| --- | --- | --- |
| Main Data Browser, host view mounting, capability enforcement, iframe shell/bridge | atomic-server | Bundled in the Atomic Server/Data Browser release |
| Built-in Syncables iframe UI for accounts, collection types and mirrors | atomic-server | Bundled with Atomic Server and delivered to the sandbox on view open (no third-party module fetch) |
| Generic collection reader/reconciliation primitives (`syncables/browser`) | atomic-plugins package | Paired contract; the initial GitHub connector uses its bundled provider adapter |
| Provider OpenAPI documents/extensions and composed API catalog | integration-proxy (source maintained in atomic-plugins) | Declarative data from configured proxy; **never executable code** |
| OAuth, account credential vault, API forwarding | integration-proxy | OAuth redirects and credentialed HTTP proxy calls only |
| Third-party provider-specific plugins, if later needed | Independently shipped app catalog | Existing immutable SRI-verified module installation, still hosted in a sandbox |

**Existing reference points:** `browser/data-browser/src/chunks/AppPage/AppFrame.tsx`, `appFrameDocument.ts`, `hostStore.ts`, `browser/lib/src/catalog-app.ts`, `browser/data-browser/src/routes/IntegrationStore.tsx`, `browser/data-browser/src/chunks/TablePage/TableViewTabs.tsx`. Do not conflate the trusted built-in module with `installCatalogApp`, which installs external bundles.

## Intended hierarchy

```text
Current drive root (folder; logical platforms listing)
└── GitHub [platform table, SyncableAccountsTable]
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
4. The connected-account resource points to a discoverable Organizations collection-type table. The bundled GitHub sync app enumerates authorized organization namespaces and the account's personal owner namespace; unsupported discovery is explicit, not silently empty.
5. An organization/owner namespace row opens a Repositories collection-type table **for that canonical owner**. Its repository items are born under the owner resource and retain source ID/context.
6. A repository row exposes available child collection types such as Issues. **Create and sync Issues** idempotently creates the mirrored table, source binding and `SyncableCollection` view, then opens that table. Do not eagerly download every repository's issues.
7. Only when the user requests Refresh list or Sync now does the sandboxed app use the **scoped shared host proxy transport**. It paginates and upserts typed Atomic rows; status records partial reads. Pause retains all local records.
8. Subsequent rediscovery, reauthentication and view opens reuse identities and tables. Moving/linking affects navigation only.

## Runtime / security boundaries

- The sandbox is null-origin with strong CSP; host message validation must bind iframe window, session and request identity. Prefer extending `AppFrame` / `FrameBridge` / `hostStore` rather than inventing a parallel privileged runtime.
- Credentials and account refresh tokens remain at the proxy. Never write a token to the Atomic graph, view resource, URL, browser persistence or iframe. Proxy operation capabilities are short-lived, origin-bound and scoped to a selected platform/connection.
- Only host-approved actions may create platform/account/collection-type/mirror resources. A general iframe does **not** receive unrestricted drive-root write access: the host checks the requested operation and source identity, prompts/reviews authorization as appropriate and scopes each destination.
- Treat OpenAPI descriptions, remote names, response data, icons and catalog descriptions as untrusted data. Do not execute script from provider metadata. Enforce valid platform identifiers, CORS, response size/timeouts and strict URL allowlists.
- Default remote sync is **read-only**. Do not infer deletion from a failed, partial, rate-limited or non-exhaustive read; record coverage and last success. Avoid duplicate rows with canonical upstream IDs and idempotent upserts.
- Browser-driven sync is foreground/on open/on demand in the MVP. Unattended background synchronization and remote writes/review queue are separate enhancements.
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
  Final native run: 2 passed, no failures, skips or flakes; 121 focused tests
  and Data Browser/E2E typechecks pass.
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
allowed routes and pagination arguments and signs the request. The iframe never receives a signing key or connection key. Browser
Syncables' separate selected-read API is tested in atomic-plugins. The
initial Atomic Server connector uses a GitHub-specific read adapter.

GitHub can omit an organization from the signed account listings when it
restricts the OAuth app. The Public view accepts an explicit `owner/repo`.
The host limits public reads to repository metadata and the selected Issues
endpoint. The sync app verifies canonical owner and repository IDs before
provisioning a tree under Public. Its Issues view
uses credential-free GitHub reads, with source identities separate from
mirrors that use a signed account connection.


### Live verification on 2026-11-18

The `michielbdejong` account connected through `integrations.atomic.place`.
The Public branch linked `ontola/atomic-server` as a separate anonymous
source, completed all GitHub cursor pages, and imported 1,217 Issues.
GitHub search returned the same count with `incomplete_results: false`.
Open issue #2566 and closed issue #2454 matched the imported titles and
URLs. The sidebar shows Public alongside the connected account, with
navigation resources through Issues and no imported issue rows or table
view definitions underneath.

The latest local Chromium walkthrough passed both the authenticated and
Public flows with zero failures, flakes or skips. Typechecks and 81
focused unit tests passed. The full server CI still needs a completed
run on the final commit.


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
