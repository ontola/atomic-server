# did:ad:frozen / code-first schema — iteration notes

Branch: `cursor/did-frozen-schema-b359` (from `origin/schema-in-code#1207` onto `develop`).

## Clean API (current)

| Layer | API | Role |
| --- | --- | --- |
| Offline authoring | `defineSchema(pkg)` from `@tomic/lib` or `@tomic/lib/schema` | Typed `.classes` / `.properties` → `did:ad:frozen:` ids |
| Lockfile | `buildSchemaLock` / `verifySchemaLock` / `isSchemaLock` | Commit + verify immutable bodies |
| Store (preferred) | `store.useSchema(schema \| lock, { publish? })` | Materialize locally; optional publish |
| Store (compat) | `registerFrozenSchema`, `loadSchemaLock` | Same as `useSchema` halves |
| Mutable ontologies | `registerSchema` (signed genesis DIDs) | Imports / editable packages during development |
| Version pointer | `createSchemaPointer(frozen)` | Signed "latest" Ontology → frozen ids |
| Generic freeze | `freezeStructure(subject)` | Any resource graph → frozen DAG |

Happy path (matches docs): **define → use handles → `save()` auto-publishes referenced frozen bodies**.

## Speed wins landed

- [x] Local-first frozen resolve: in-memory → body registry (`defineSchema`) → network
- [x] Precompute blanked cycle content before color-refinement rounds
- [x] `Cache-Control: public, immutable, max-age=31536000` on `GET /frozen`
- [x] Smoke test: 250-node acyclic freeze &lt; 200ms

## Still open

- [ ] Materialize cycle **units** as individually addressable resources (fragment / sibling ids)
- [ ] Switch or soft-deprecate signed `registerSchema` once import story is frozen-native
- [ ] Iroh `FROZEN_REQUEST` sync (Phase D in `did-ad-frozen-server.md`)
- [ ] CI lockfile drift guard (`verifySchemaLock` + re-emit diff)
