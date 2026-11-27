# Built-in Syncables: integration handoff

Real-data import acceptance passed on `18c46ed3a`; the SDK counter fix is
`d993656e6`. Production revision `fa9cb95f4` introduced native resource
actions, paged entity Collection compatibility, faster Sync controls, accepted
background preparation, source invalidation recovery and generic reference-origin
navigation. All 18 native browser journeys passed. The follow-up production
revision `847a1955b` hides generated duplicate Collection tabs and makes bare
links use the ordinary Table settings.

- [ ] Trekmeester resolves PR #2522's conflicts with develop, runs full shared
  Main/server CI on the final integration candidate, reviews and merges.
  Integration and shared CI remain with trekmeester; workers must not rebase,
  dispatch or rerun shared CI. Remove this handoff after that acceptance.
- [x] Signed-in Chrome verification on `fa9cb95f4` completed 25 November.
  The existing GitHub account synced the embedded Apptorrent organization's
  saved Repositories filter. Its Table showed five rows, and the run completed
  at 15:09:57 UTC. GitHub returned the rows early; local reconciliation took
  most of the 9m50s total. The Ontola check was stopped after seven minutes
  and its previous enabled state was restored.
- [x] Attached the [current real-data walkthrough](https://github.com/ontola/atomic-server/pull/2522#issuecomment-7102109541)
  on 23 November 2026: 25 seconds from My drive through the principal App to
  the 2,608 stored Issues/PRs and linked authors. This edited capture uses the
  existing connection and completed import; it does not repeat OAuth.
  The earlier real sign-in recording shows the historical UI.

## Contract

`Drive → provider · principal / Public (App) → item type`.

Each typed principal has one App for the selected drive/proxy/provider. The
provider chooser stays in Apps; Public is its own App. Promotion preserves the
existing principal subject/local ID, child tables/rows/rules, user fields and
views. Native registrations outside iframe write roots prevent duplicate Apps,
including after reload, a new OAuth slot, renaming and same-drive moves. The
OAuth return opens and installs the exact newly connected account in the
selected drive. App binding changes revoke old workers; child sync inherits
the verified current slot. Opening the chooser independently leaves account
selection to the user.
Existing conflicting data is preserved and reported rather than merged.
Reinstalling after permanent deletion requires a signed server Not Found for
the former App plus a complete drive-scoped identity check that includes
Trash. The host retires the stale registration's local ID and uses the normal
native uniqueness check to install the replacement.

Apps and Sync reads, query results, subscriptions and writes stay in the selected
Drive even while another is active or cached. Local and server queries retain
explicit Drive scope. Hosted identity lookups require complete server results;
known foreign legacy rows are filtered before ambiguity and pagination, while
unproven ancestry fails closed. Native Open keeps cached/offline behavior.
Deterministic identity collisions park pending writes for review, retaining
genesis/edits instead of replaying indefinitely or deleting data.

The catalog supplies identity, API schemas, relationships and filter bindings.
One canonical table holds each item type; following a relationship saves a filter
of that table. Filters have independent sync/pause status and memberships.
Overlapping reads share typed rows, explicit field evidence and durable run order.
Complete reads replace only their own membership; incomplete/cancelled reads
retain accepted data. Canonical identity survives same-drive moves.

Canonical entity collections use ordinary Table and Sync. Existing Collection
links render native Table with the same saved filters and view settings; only
unconfigured duplicate Collection tabs are hidden. A bare item-table link uses
ordinary Table settings when its stored default is such a duplicate. Genesis
metadata and the creator's standard write permission are not view settings.
New reference tables also start with Table and Sync. App directories use the
Syncable Collections label. Ordinary Table cells show stored resource links.
Table Open and ordinary Resource actions share one guarded catalog relationship
resolver.
Imported organizations and embedded owner summaries with suitable evidence can
open repositories and catalog-declared issue collections. Sync verifies the
stored source against the current catalog before reading from the provider.
Open leads the default Table columns on small screens, while explicit saved column
order still wins. Each action opens an exact saved filter without provider or
catalog reads. The navigation column adds no API schema field. Sync
runs in an opaque iframe through the existing bridge; the proxy retains
credentials. Request authority comes from the selected filter, current catalog
and actual response provenance, without Drive-root iframe write grants.
Opening an empty Table starts its first sync when a single direct saved filter
is eligible. Sync defaults to the direct or sole saved filter, and leaves a
choice when the selection is ambiguous. Reopening Sync revalidates selected
source, principal, catalog and permissions without restarting its worker.
Canonical controls skip whole-integration legacy and adoption scans; actual
workers and setup retain their full evidence checks. Running status shows the
page being read and includes a total when declared for a single walk. Progress
is held in the active host execution and status updates retain the same controls.
An unconfigured item's Sync tab shows its catalog inputs directly and hides
the saved-filter picker until it has rules. Its host can resolve entrypoints
for that table's entity type before a saved filter exists. The GitHub catalog
requires a repository scope for Issues and pull requests.
Completed status belongs to the selected saved filter. Cached rows do not imply
that a new filter has completed a sync or contains those rows. Column label
changes retain stable Property IDs; API-owned cell values can change on the next
sync.

The catalog's `x-embeddedResources` declarations supply object, object-array,
discriminator-selected and explicit scalar reference links. Host-held response
observations authorize native materialization only within the same
Drive/proxy/platform/typed principal. No extra provider reads or recursive
expansion are needed. Canonical target IDs survive richer hydration and
same-drive moves; moved rows are reused without reparenting or updating them.
Partial-reference resources retain actual identity evidence until required API
and class fields are proved. Raw values and richer/user-authored data remain
stored; reference-only targets claim no invented collection read or membership.
Trash, ambiguity, unproven ancestry and changed permissions fail closed. The
reference guard compares write grants as a set of canonical writer IDs.
Genesis can publish the signer in both schemes, and reordered entries grant
the same rights. A distinct writer added or removed still stops the import. Link
schema/view migration preserves existing row/class IDs and user column choices.

The Sync setup for an authenticated collection uses catalog relationships to find
enumerable sources in the same principal and Drive. Opening an empty dependent
Table without a saved filter, or opening its Sync setup, starts the sources'
eligible first saved-filter syncs through the existing background runtime.
The runtime serializes reads for the same principal and Drive to avoid races
when those reads publish a shared linked record. The picker browses stored
source records and groups them by a declared Atomic link when available. Saving
a choice uses a related selection tied to its stable identity. Public collections
can still use catalog entry points when they have no enumerable sources.

Proven legacy sources preserve subjects, local IDs, user fields and read plans.
Ambiguous/unprovable sources block competing allocations. Out-of-root moves remain
protected. Adopted tables are navigation leaves despite retained old local IDs;
cold rows hydrate before ownership validation. Canonical `github` replaces
`github-issues`; Michiel approved reinstall/reconnect of all old clients. Old data
is retained rather than deleted or merged automatically.

## Dependency and verification

- Inline sync scope passed 96 focused tests, both typechecks, and ten Chromium
  journeys. The authenticated GitHub Issues test verifies the initial scope
  fields and the absence of provider reads. The Public test also saves and runs
  a repository filter and verifies the form at mobile width.

- In-place collection source setup and the Syncable Collections label passed
  112 focused tests, both typechecks, all six translation catalog checks, and
  ten native Chromium journeys. The Public Issues test saved and ran a repository
  filter on the same table. The report is under
  `.e2e-runs/2026-11-26T17-07-07.981Z-4VjwAT/`.

- The same-drive reinstall fix passed 183 focused tests and both typechecks.
  The native Chromium regression confirmed Public reinstallation after deletion,
  and a subsequent visit reused the replacement. The other eight Syncables
  journeys passed against the same build.

- The OAuth return, first table sync, page progress and writer-ID fix passed
  3,221 Data Browser tests, both MCP tests, the app and E2E typechecks, and
  all eight native Syncables Chromium journeys. Chromium verified page progress
  while an Issues request was held and after reopening Sync. The report is
  under `.e2e-runs/2026-11-26T14-08-53.154Z-kYmYFT/`.

- Collection tab follow-up `847a1955bb73bb5947d9bc3fbd709043cbd03a6d` passed
  46 focused tests, app and E2E typechecks, lint, and one native Chromium
  journey using a signed legacy default. The bare link applies the ordinary
  Table filter; the explicit legacy link retains its original rows. Report and
  screenshot are under `.e2e-runs/2026-11-25T15-24-08.043Z-GNEFm2/`.
  [Flutter 45644799764](https://github.com/ontola/atomic-server/actions/runs/45644799764)
  passed on that revision.

- Production source: `fa9cb95f420b739db18f3b34b0b9ad4b9927c081`, owned branch
  `codex/builtin-syncables-completion`, published through
  `feat/builtin-syncables-foundation` in
  [PR #2522](https://github.com/ontola/atomic-server/pull/2522).
- The actual registry package `syncables@0.32.0` is bundled into the Sync app.
  Plugins [#758](https://github.com/ontola/atomic-plugins/pull/758) merged at
  `606c667e566d482d6c51e8db30a22730887990d1` after required CI and all other
  checks passed. Local library validation passed 2,163 tests (85 optional/database
  skips). [Publication 45208128186](https://github.com/ontola/atomic-plugins/actions/runs/45208128186)
  passed. The registry archive is byte-identical to the tested release candidate:
  SHA-1 `eebb2b6058113393439cc39febed15234fcb2c06`. All 230 installed files match;
  npm provenance names the merge and publication workflow. The exact version has
  a narrowly bounded release-age exception alongside the earlier paired releases.
- Reference origins may omit their own collection read. Compilation still proves
  canonical identity from the current catalog and raw/context evidence; response
  Links still check the provider detail identity. Navigation creates no origin
  read, membership or success. Old stored summaries use bounded declarative
  candidates; Sync must validate missing route bindings before provider transport.
- Child imports reuse active, host-proved source links without enriching those
  origins during the read. Other references still enrich normally. Existing
  source guards subscribe to rows and bounded cached ancestry, including Drive
  Trash changes, and refresh subscriptions after valid same-Drive moves. Real
  outside changes cancel preparing/active work; stale visible controls reprepare
  using fresh proof. No timeout extension or weaker identity comparison was used.
- 3,210 Data Browser tests across 385 files and both MCP tests pass in UTC.
  App typecheck, staged lint/format and React compiler checks pass. All six
  translation catalogs retain their complete 3,148 keys; no new UI copy was added
  by the reference-origin fix. The focused lifecycle/rule/projector run passed
  115 cases, including the reproduced self-invalidation and stale controls.
- SDK validation from `3d54dbada` passed 1,814 tests (one existing skip), with no
  later SDK production change. Explicit Drive queries keep retained trashed rows
  out after direct reads and follow ancestor changes without fetching ancestry.
  Earlier Rust paging/Trash/authorization checks passed; no later Rust code changed.
- Read limits remain 128 requests, 4,000 records, 32 partitions, five minutes and
  zero retries. Accepted incomplete reads retain data; complete reads replace
  membership only for their own filter. Native data views do not fetch providers.
- The optimized native build `fa9cb95f4` passed 18 Chromium journeys in 279
  seconds with one worker and zero retries, skips or flakes. It includes the
  embedded-organization relationship sync that exposed self-invalidation.
  The run reports and desktop/mobile fixtures are in
  `.e2e-runs/2026-11-23T17-57-35.101Z-kOvuFs/`.
  Executable SHA256
  `77f91f481cb9f8e7cc897ee0a00d75efae4c95d835229070529a1aa07e12f872`.
  Localhost on port 52771 serves that same executable with the existing data.
  Served host JS, Sync JS and WASM match the built assets, and the built-in
  iframe response retains `connect-src 'none'`.
- [Flutter 45206261415](https://github.com/ontola/atomic-server/actions/runs/45206261415)
  passed on `8e811627a`; the sole earlier embed-size failure is fixed by lazy
  standalone mock loading (first-use gzip 1000.3 → 984.4 kB, unchanged 1000 kB
  budget). [Flutter 45211049900](https://github.com/ontola/atomic-server/actions/runs/45211049900)
  also passed on `fa9cb95f4`. Full shared Main/server CI awaits integration.
  The PR stays draft/conflicting for trekmeester's
  integration, review and shared CI; workers must not dispatch or rerun it.

## Real-data acceptance

The existing real GitHub connection, running `18c46ed3a`, completed the `ontola/atomic-server` Issues
and pull requests filter at **2026-11-21 07:41:12.909 UTC**: 2,608 rows,
708 added, one changed and 1,899 unchanged, `incomplete=false`, `error=null`.
The worker finished with no queued execution. All 2,608 author fields contain
stored Atomic links to 43 distinct author resources. Full signed row scans
verified target IDs, Drive, proxy, platform and typed principal; no invalid links
were found. Original issue and author subjects were retained, including the
formerly failing #1829, whose undeclared structured `type` remains in raw data.

The provider returned 27 Issues pages. The 41 total provider requests comprise
identity, repository discovery and Issues; embedded owner/author summaries
required no extra detail fetches. The current shared reader preserves catalog
query defaults and projects only fields declared on each resource schema.

The preceding repository backfill completed 1,274 rows with zero added and
1,274 changed, `incomplete=false`, `error=null`. Every repository has a stored
owner link. The existing `ontola/atomic-server` subject and its same-drive
`ontola` organization link were rechecked after the Issues import.

Ordinary Table and an author resource were verified as native stored-data views:
zero iframes and no provider refresh on opening. The final SDK-only build keeps
2,608 data rows (2,609 ARIA rows including the header); the Sync bundle and WASM
bytes are unchanged from the accepted import. Dev drive's old App remains in
Trash as explicitly requested, and the 22 historical blocked drafts are retained.
No restore, deletion or initialization was performed.

On the SDK counter fix build, explicitly refreshing 30 existing off-page Issues
kept all 41 Table count samples at 2,608 data rows plus the header. This used only
signed Atomic reads, with zero iframes or provider requests.

On the subsequent control latency build `3d54dbada`, the live Repositories Sync
controls appeared in 776 ms in a warm Table-to-Sync interaction. The earlier
opening still showed its loading state at 33.6 seconds. The signed-in Table
showed 1,274 rows and retained the user label `name changed`. These observations
predate the final reference-origin change.

The immutable record-links catalog is active on `integrations.atomic.place` via
[catalog-only rollout 44760703345](https://github.com/ontola/atomic-saas/actions/runs/44760703345),
which retained runtime, connection keys, credentials and other provider profiles.
This acceptance used the existing connection; the earlier real OAuth
[walkthrough](https://github.com/user-attachments/assets/f8f7e24a-d23e-47ea-8193-bf8ae75dc51c)
shows the historical UI, not this final refactor.

Earlier Main CI passes are not evidence for this head. Bidirectional provider
writes and unattended server-side synchronization remain outside this MVP.
