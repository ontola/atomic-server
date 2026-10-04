# App-defined immutable schemas

Branch: `codex/atomic-schema-sdk`, based on current develop (81f560484).

Implement an additive developer API: app-defined Class/Property definitions with
`atomic:frozen:<BLAKE3 of JCS JSON-AD>` identities, nested typed objects/arrays,
explicit links, local bundle registration and ordinary Atomic resources/commits.
Core vocabulary keeps its existing identifiers. App schemas need no HTTP host.

- [x] Verified immutable schema bundles, persisted in existing stores, with commit rejection.
- [x] Bounded nested shapes and path-specific validation; unknown constraints rejected.
- [x] Rust code-first schema and field/path editing without replacing sibling Loro containers.
- [x] TypeScript API and shared cross-language fixtures.
- [x] Audio slice example proving domain-free schema definitions and concurrent envelope edits.
- [x] Tests, documentation and full browser lint.
- [ ] Upstream review and adoption in Atomic Audio.

The initial package format embeds acyclic shape definitions; arbitrary freezing
of cyclic RDF graphs, catalog/discovery UI and automatic schema migrations are
separate features. Bundles are explicit and portable; no network schema lookup is
required for registered definitions. Existing HTTP-defined data remains readable.

Do not revive PR #1262 wholesale: it predates the canonical atomic: scheme and
has unresolved materialization/persistence gaps. Preserve semantic property IDs
when reusing definitions; a changed definition produces a new identity.

The draft intentionally leaves a Dart convenience API and Audio data migration
for a follow-up. Writers register the app bundle; upgraded receivers learn the
needed definitions from the resource state.

## Automatic exchange and hostile peers

- [x] Carry bounded, hash-verified definitions in a reserved Loro root map
  `atomic:schema-definitions` (ID -> canonical JSON body). Existing signed
  COMMIT, UPDATE and SYNC_PUSH payloads then carry dependencies with the data;
  no unauthenticated global schema-by-hash endpoint is introduced.
- [x] Resolve only the closure of a resource's frozen Property and Class IDs.
  Limit bytes, entries and traversal depth; verify even unused attachments,
  but install only reachable definitions. Never run schema-supplied code or URLs.
- [x] Validate against attached definitions without installing them first.
  Persist dependencies and data in one native transaction only after normal
  commit/sync authorization. Surface bad attachments as sync failure.
- [x] Match browser behavior, including rejecting malformed incoming state
  before mutating a live document or installing definitions.
- [x] Test cold replicas, deltas, tampering, missing definitions, oversized
  dependency sets, unauthorized pushes, and unchanged legacy resources.

Definitions live in a separate root from mutable project properties. This adds
no new frame type: an immutable entry is written once per resource, thereafter
ordinary Loro deltas omit unchanged entries. Older replicas preserve opaque root
state but cannot enforce the new validation contract. A future inventory/fetch
extension can deduplicate definitions across resources without changing their IDs.


- [x] Document migration identity, authorization, retries, provenance, old-writer
  compatibility and the limits of client-side version checks.
- [x] Reproduce a migration racing with an old-schema write; preserve both
  properties and require explicit reconciliation of stale converted values.
- [ ] Migration runner/preview, conditional commit API, and per-app cutover policy.
- [ ] Deployed mixed-version WebSocket/Iroh acceptance and CRDT history fuzzing.

## Audio adoption and retrieval cost

- [x] Cover lower-level CommitBuilder authoring: automatically resolve and attach
  schema definitions before signing, including genesis, without network URLs.
- [x] Bound and memoize verified inline schema bodies. Cache hits require exact
  ID/body equality; cache entries never satisfy a missing dependency by themselves.
- [x] Exercise cold retrieval from an authorized GET response and real Audio Iroh
  sync with no schema registration on the receiving process.
- [x] Migrate Audio entities and saved versions, retain legacy reads, validate
  edits before writes, preserve historical data and document migration behavior.
