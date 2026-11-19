# Flat Syncable collections and filtered sync rules

Implementation requested by Michiel on 2026-11-19; work is in progress.
This replaces nested physical mirrors with one collection per API item type:

`Drive → platform App → authenticated principal / Public → item type`

Following a declared relationship opens a filtered view of that collection.
For example, opening an organization's repositories selects its membership in
the account's Repositories collection. Issues for a repository select a view of
the same account's Issues collection. The discovery path supplies a read plan
and provenance; it does not create another physical table.

## Data contract

- An entity table is identified by drive, proxy, platform, typed principal and
  exact canonical CRUD resource type. Display names and navigation paths are
  presentation, not identity.
- A row uses the declared canonical entity identity. Include only required
  identity context: issue number 7 in two repositories remains two entities.
  Overlapping root and organization repository reads share one repository row.
- A saved filter contains typed predicates, a catalog-derived read plan,
  independent sync/pause policy and status. Several filters share an entity table.
- Each observation records scope membership, actual request/Link provenance,
  completeness and generation. A complete read can replace membership only for
  its exact scope. Absence is not proof of remote deletion.
- Incomplete, unauthorized, cancelled, paused or budget-limited reads retain
  accepted rows and memberships. A multi-repository rule completes only after
  discovery and all selected partitions complete.
- Merge field evidence across representations. Missing fields in a narrower
  response do not erase richer observations; explicit null remains distinct.
  Older overlapping runs must not overwrite newer evidence.

Proposed defaults: the main collection shows retained cached rows. Pause stops
fetching for that rule; another active rule can still update their shared rows.
Show freshness and active rules so this behavior is understandable.

## Catalog and security boundaries

The IAP catalog supplies identity, relationships and filter/request bindings.
Use existing CRUD identities and actual-response OpenAPI Links. Filtering 0.2
already describes one logical collection with multiple views, but additional
relationship/fan-out drafts are not fully implemented. Complete their generic
validator/runtime contracts before depending on them.

Do not infer Organization from a URL segment or add fictional provider fields
to the raw table schema. Until a field predicate is described, represent
"returned through this organization relationship" as proven membership.
The native Collection view can display relationship context separately.

The host compiles provider access from the current trusted catalog and selected
filter. Sharing storage does not authorize arbitrary principal-wide API reads.
Retain the existing bridge and collection-root write boundary. Recheck principal,
connection, catalog, filter definition and run generation after awaits. Public
reads remain credential-free. Filter cancellation stops only its own worker.

## Implementation sequence

- [x] Settle canonical entity identity, typed filter and observation contracts
  with atomic-plugins; keep provider behavior in catalog metadata.
- [x] Add generic library planning, bound traversal and scope observations,
  reusing its existing request, pagination and projection implementations.
- [x] Add Atomic entity-table storage and per-scope membership reconciliation.
- [x] Add saved filtered Collection views and per-filter sync controls.
- [x] Review adoption of existing nested mirrors; retain subjects, manual moves
  and user edits, and report ambiguity before creating competing rows.
- [ ] Verify overlap deduplication, scoped identities, changed transport addresses,
  principal isolation, partial/401/cancel retention, independent pause, field/null
  evidence, multi-part completeness, forged filters and offline navigation.

## Owned work and integration contract

- Server: existing owned `builtin-syncables-completion/atomic-server` worktree,
  `codex/builtin-syncables-completion`, base
  `4168698c224d2739b1f22891e8fd7d29088f9b4a`, existing PR #2522.
- Library: restored owned `catalog-collection-hierarchy/atomic-plugins` worktree,
  `codex/flat-syncable-collections`, base
  `91a2c7418b64092aa90277b17148bb359690d978`.
- Library agent owns generic entity descriptions, typed canonical identity,
  bound/related/fan-out selections, current-catalog request validation and
  observations. Existing paging, projection and public APIs stay shared.
- Iframe agent owns v3 storage identities, reconciliation, durable observation
  and run records, and sync controls. Native host agent owns saved rule parsing,
  authority checks and per-rule worker profiles. Coordinator owns vocabulary,
  native filtered views/navigation, table query plumbing, worker serialization,
  docs, release integration and browser acceptance.
- Rules are ordinary View resources under canonical Tables, configured through
  `syncable-source-config`: `{version:3,kind:'rule',resource,definition,ruleKey}`.
  Each rule has its own `syncable-mirror-status`, including pause and active run.
- Row metadata uses `syncable-rule-memberships` and
  `syncable-navigation-intents`. Durable `syncable-observation` and
  `syncable-sync-run` records retain evidence separately from projections.
  Run identity is `{generation,runId,startOrder}`; stale generations cannot write.
- Rule execution keys include drive, canonical Table and rule. Whole workers
  queue per Table, with independent queued cancellation/pause and captured
  definition/authority checks. This uses the existing bridge. Core's existing
  independent-offline-peer identity collision/review policy remains applicable.
- Principal metadata discovery provisions resource Tables without descendant
  reads. A source worker writes navigation intent only under its own Table;
  explicit native Open creates the target saved rule locally and opens it.
- Test against a matching optimized native executable and isolated test drives
  before replacing this task's localhost process. Keep real drive data, credentials
  and unrelated checkouts/services intact. Shared server CI belongs to trekmeester.


## Integration evidence (in progress)

- Paired library PR #749, head `aa9732ac2ab1b368e3d22dd594c7c83ad9599836`,
  contains `syncables@0.30.0`; 2,123 local library tests pass. Await relevant PR
  checks before merge/publication and replace the temporary local candidate
  dependency with the exact registry package before server publication.
- Native saved-filter and navigation unit checks pass, including idempotent
  sibling rule creation, active-scope preservation and refusal of missing,
  ambiguous, detached or malformed scopes. No provider transport in native views.
- Review corrections preserve raw address evidence when a later representation
  omits fields, keep invalid rule links from widening to all cached rows, and
  seed worker ordering from durable state rather than relying on wall-clock time.
- Pending: adoption validation, full app checks, matching optimized browser run,
  actual localhost replacement/asset verification, screenshots and PR handoff.

- Library PR #749 merged as `e9933e8fbf772c48476e3345d2263494598664ee` after
  every relevant PR check passed, including Node 22/24/26, native macOS and peer,
  overlay reads and integration/browser lanes. npm publication run 44556325558
  passed. Registry `syncables@0.30.0` is now pinned; its archive exactly matches
  candidate revision 2, SHA-256
  `1b6e095688d44264a5ebf5d37384d070c44922441ae769480d0c631d44509ab2`.
  Published SLSA provenance names the official workflow and merged commit.
- Full app unit pass after final migration/guard fixes: 2,923 tests across 374
  files, plus both MCP checks, UTC. Latest strict typecheck passes.
- All six language catalogs extracted through a single Vite writer, inspected,
  translated and re-served without changes; translation audit reports zero issues.
- Native browser run is in progress, optimized profile, one worker and no retries.
  First cancelled build was intentionally superseded before browser execution
  when native write-guard and localization fixes required rebuilding.
