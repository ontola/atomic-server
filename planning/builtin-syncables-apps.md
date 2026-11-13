# Built-in Syncables apps: architecture and decisions

**Status:** agreed design, implementation pending · **Date:** 2026-11-13  
**Issues:** [atomic-server#2521](https://github.com/ontola/atomic-server/issues/2521), [atomic-plugins#733](https://github.com/ontola/atomic-plugins/issues/733)  
**Wireframes and click-through:** [builtin-syncables-wireframes.md](builtin-syncables-wireframes.md).

## Product contract

The Apps page shows an integration-proxy's available platforms (e.g. GitHub) as **apps**. Installing one creates a *configured instance of Atomic Server's built-in Syncables implementation* in the active drive. It does **not** install executable JavaScript from the proxy.

The browser-side Syncables UI, picker and logic are **owned and bundled by atomic-server** but **execute in a sandboxed, null-origin iframe**. This is intentional. Built-in is a distribution and responsibility distinction, not permission to execute in the parent page. Keep AppFrame's host/iframe bridge, the host's Atomic and proxy capabilities, scoped permissions and CSP boundaries. Later, a built-in provider app can be replaced with a separately published provider-specific module without changing the resource structure or host contract.

### Ownership and distribution

| Responsibility | Owner | Transport into browser |
| --- | --- | --- |
| Main Data Browser, host view mounting, capability enforcement, iframe shell/bridge | atomic-server | Bundled in the Atomic Server/Data Browser release |
| Built-in Syncables iframe UI for accounts, collection types and mirrors | atomic-server | Bundled with Atomic Server and delivered to the sandbox on view open (no third-party module fetch) |
| Generic collection reader/reconciliation primitives (`syncables/browser`) | atomic-plugins package | A pinned dependency bundled into the built-in iframe code |
| Provider OpenAPI documents/extensions and composed API catalog | integration-proxy (source maintained in atomic-plugins) | Declarative data from configured proxy; **never executable code** |
| OAuth, account credential vault, API forwarding | integration-proxy | OAuth redirects and credentialed HTTP proxy calls only |
| Third-party provider-specific plugins, if later needed | Independently shipped app catalog | Existing immutable SRI-verified module installation, still hosted in a sandbox |

**Existing reference points:** `browser/data-browser/src/chunks/AppPage/AppFrame.tsx`, `appFrameDocument.ts`, `hostStore.ts`, `browser/lib/src/catalog-app.ts`, `browser/data-browser/src/routes/IntegrationStore.tsx`, `browser/data-browser/src/chunks/TablePage/TableViewTabs.tsx`. Do not conflate the trusted built-in module with `installCatalogApp`, which installs external bundles.

## Intended hierarchy

```text
Current drive root (folder; logical platforms listing)
└── GitHub [platform table, SyncableAccountsTable]
    └── michiel [connected account resource]
        └── Organizations [collection-type table, SyncableCollectionTypeTable]
            ├── ontola [organization resource; provider-stable identity]
            │   └── Repositories [collection-type table, SyncableCollectionTypeTable]
            │       └── atomic-server [repository resource born in ontola]
            │           └── Issues [mirrored Atomic table, SyncableCollection]
            └── michiel [personal owner namespace, NOT necessarily GitHub Organization]
                └── Repositories [collection-type table]
                    └── personal-notes [repository resource born in personal namespace]
                        └── Issues [mirrored Atomic table]
```

**Do not confuse GitHub authentication with ownership.** A connection authorizes discovering an account's accessible organizations and repositories; the organization is not owned by that account. A personal username acts as a repository owner namespace, but need not be represented as a GitHub Organization object. Repositories belong under their canonical provider owner (organization or personal namespace), not directly under an OAuth account. A single organization may be reachable through multiple accounts.

The first hierarchy is an initial organizing layout, not the remote identity model. Users may move and link resources without breaking a mirror. A mirror's source key is based on the configured proxy, connection identity, platform, collection definition, remote instance ID/context and target table identity, **never the Atomic parent path**. If another connection discovers the same organization or repository, reuse canonical provider resource identities and model access via links, avoiding duplicate logical organizations. Whether to share one mirrored table between separate credential contexts requires an explicit policy; do not silently merge permissions.

## Views: three stable built-in kinds

1. **SyncableAccountsTable:** shown on the platform table. Connect/reconnect account; show existing connections, health and link to account's Organizations listing.
2. **SyncableCollectionTypeTable:** shown on a collection-type table (Organizations, Repositories, etc.). Discovers and displays remote collection instances; enables mirroring explicitly per instance; "Open" reuses an existing table; refresh of listing does not synchronize every descendant.
3. **SyncableCollection:** shown on a mirrored data table. Sync status, last good snapshot, row counts, partial errors, Sync now, Pause/Resume, source details. The ordinary Atomic Table view remains available separately.

These are host-recognized view kinds that can be rendered by one generic built-in iframe module with context-driven behavior. Provider-specific implementations may eventually be substituted behind the same view/bridge contract.

## Installation and navigation sequence

1. Apps loads the configured proxy's **structured, versioned service metadata** (or legacy `GET /catalog` platform-name array as fallback), preserving existing third-party app cards and visibility controls. Service icons are optional metadata, safely resolved; never scrape proxy catalog HTML.
2. User clicks **Install GitHub**. Host idempotently creates the platform table in the **current drive root** with a `SyncableAccountsTable` view and records the platform/proxy identity. No OAuth happens on merely viewing the catalog. Reinstall/open reuses the same platform resource for that drive/platform/proxy.
3. User clicks **Connect account**. Existing signed PKCE handoff goes to the selected integration proxy and the provider's OAuth account chooser. Proxy owns refresh tokens; Atomic receives a non-secret connection reference. Return is restored to the original drive and platform table; errors/cancellation leave a recoverable platform table, not an orphan.
4. The connected-account resource points to a discoverable Organizations collection-type table. Syncables enumerates authorized organization namespaces (and the account's personal owner namespace) using OpenAPI resource metadata; unsupported discovery is explicit, not silently empty.
5. An organization/owner namespace row opens a Repositories collection-type table **for that canonical owner**. Its repository items are born under the owner resource and retain source ID/context.
6. A repository row exposes available child collection types such as Issues. **Create and sync Issues** idempotently creates the mirrored table, source binding and `SyncableCollection` view, then opens that table. Do not eagerly download every repository's issues.
7. When the view is open or the user presses Sync now, sandboxed browser code uses a **scoped host proxy capability** and `syncables/browser` with an injected transport. It paginates and upserts typed Atomic rows; status records partial reads. Pause retains all local records.
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
- True background jobs/offline syncing.
- Whether all source/collection classes are shared vocabularies or generated per integration; retain stable schema identities until settled.

## Milestones and validation

1. Host can fetch `GET /catalog`, distinguish platform metadata from installable app bundles, show failures, and render provider tiles using the configured proxy.
2. Built-in iframe displays platform/account/organization/repository discovery, using the real host bridge and a mock proxy.
3. Idempotent provisioner creates a platform table and a GitHub organization/repository hierarchy in a test drive, with host-enforced rights.
4. Select Issues and create one mirror, then read through the proxy and upsert rows using Syncables.
5. E2E proves OAuth return, connection reuse, personal namespace, two organizations, repo ownership, move/link stability, no credential leaks, cancellation, reconnect and partial-read safety.

A clickable HTML **concept** (not a production host implementation) accompanies the wireframes; use it to validate wording and navigation before wiring the live state.
