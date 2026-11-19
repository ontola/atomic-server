# Flat Syncable collections and filtered sync rules

Design proposed by Michiel on 2026-11-19. Implementation has not started.
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

- [ ] Settle canonical entity identity, typed filter and observation contracts
  with atomic-plugins; keep provider behavior in catalog metadata.
- [ ] Add generic library planning, bound traversal and scope observations,
  reusing its existing request, pagination and projection implementations.
- [ ] Add Atomic entity-table storage and per-scope membership reconciliation.
- [ ] Add saved filtered Collection views and per-filter sync controls.
- [ ] Review adoption of existing nested mirrors; retain subjects, manual moves
  and user edits, and report ambiguity before creating competing rows.
- [ ] Verify overlap deduplication, scoped identities, changed transport addresses,
  principal isolation, partial/401/cancel retention, independent pause, field/null
  evidence, multi-part completeness, forged filters and offline navigation.

Current nested-source implementation remains in PR #2522. This document records
the next model; it does not claim those storage or sync-rule changes are built.
