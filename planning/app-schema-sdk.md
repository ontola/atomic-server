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
for a follow-up. Each writer/server must register the app bundle; automatic
schema delivery through sync is not part of this draft.
