# Optional schema: nudge, don't force

**Status:** Decision. Rust `Resource::set` no longer requires a Property
resource. Remaining force-points listed below.

## The question

Can someone build an app on `atomic_lib` without specifying an ontology
(Classes and Properties)? If not, should we change that?

## Answer

**Yes.** Persistence, commits, and sync already work without Classes or
Properties. Atomic Schema is the recommended path, not a write-path
requirement.

An app can create resources, set URL-keyed properties, sign commits, and
sync them over WebSocket or Iroh with no `isA` and no Property resources
in the store. What they lose is the *product* of schema: required-field
checks, shortnames, generated types, generic forms/tables, query UX, and
cross-app meaning.

## Policy

1. **Atomic Core is enough to store and sync.** A Resource is property →
   value pairs with a subject. Property *keys* are URLs. A Property
   *resource* (shortname, datatype, description) is optional.
2. **When schema is present, enforce it.** A resolvable Class's
   `requires` must be present. A resolvable Property's datatype and
   `allowsOnly` must match. That is the contract the author published.
3. **When schema is absent, accept the write.** An unknown Property is
   not invalid. An unresolvable Class is skipped (already the
   `get_classes` rule — a store cannot enforce a contract it does not
   have). A resource with no `isA` has no required properties.
4. **Nudge toward Atomic Schema in DX, not in the commit gate.** The
   easy, documented path is still to declare a schema. Code-first
   [`defineSchema`](./json-schema-code-first.md) is the on-ramp that
   removes HTTP-ontology friction. Tutorials, generated types, and the
   Data Browser generic UI should make schema feel like the default.
5. **Do not reject commits for unknown properties.** `validate_schema`
   means "check this resource against the Classes it claims", not
   "every key must resolve to a Property resource".

This matches Atomic Data Core vs Atomic Schema in the spec: Core is
required; Schema is a module. See
[`docs/src/core/concepts.md`](../docs/src/core/concepts.md) and
[`docs/src/schema/intro.md`](../docs/src/schema/intro.md).

## What already worked without schema

- Classless resources. Internal tests already create them on purpose
  (`lib/src/sync/tests.rs` "Classless (no `isA`) so there are no
  required-property schema constraints").
- `@tomic/lib` `Resource.set`: if `getProperty` fails, validation is
  skipped and the value still lands in Loro.
- Flutter `set_property` already calls `set_unsafe`.
- Loro `datatypes` tags come from the `Value` variant, not from a
  Property lookup. Load-bearing types survive a round-trip without a
  Property resource.
- JSON-AD serialize (`propvals_to_json_ad_map`) does not fetch
  Properties.
- `check_required_props` is a no-op when `isA` is missing or every
  class is unresolvable.

## What still forced schema (and what we changed)

| Surface | Was | Now |
| --- | --- | --- |
| Rust `Resource::set` | `get_property` hard-failed | If the Property resource is missing, trust the `Value` and write. If it exists, still enforce datatype + `allowsOnly`. |
| Docs / SDK examples | Ontology-first only | FAQ + JS getting-started show a classless write. Schema examples stay the default. |

## Remaining force-points (nudge surfaces, leave for now)

These need schema to do their job. That is a nudge, not a write-path
gate. Do not "fix" them by inventing implicit Properties.

| Surface | Why it needs schema |
| --- | --- |
| `set_string` / `set_shortname` | Must look up datatype / resolve a shortname. |
| JSON-AD *parse* | Chooses the `Value` variant from the Property datatype. Loro commits do not go through this path. |
| JSON-LD / pretty JSON export | Shortnames and `@context` come from Property resources. |
| `resource.props` / `@tomic/cli` types | Generated from Classes. Untyped `.get(url)` works without them. |
| Data Browser forms, tables, query builder | Columns, inputs, and filters are schema-driven. A classless resource still opens; you get a generic property list. |
| HTTP ontology + `@tomic/cli` workflow | The current documented app-builder path. Replaced by [`json-schema-code-first.md`](./json-schema-code-first.md), not by dropping schema. |

JSON-AD parse is the one import-path sharp edge: posting JSON-AD with a
key that has no Property resource fails unless `skip_unknown_props`.
Commits (`loroUpdate`) do not have this problem. Softening parse to
infer from JSON (string/number/boolean/array/object) is a later change;
do not block app builders on it — they should use `set` + `save`.

## How to nudge

Keep these as the happy path. None of them should become required.

- **Code-first schema.** `defineSchema` / `store.registerSchema` produces
  local DID-backed Class and Property resources. See
  [`json-schema-code-first.md`](./json-schema-code-first.md). This is
  how we want app developers to *start*, once it exists — not HTTP
  ontology editor + CLI export.
- **Generated types.** Annotating `getResource<Todo>()` is the reward
  for having a schema.
- **Generic UI.** Forms, tables, and the assistant get better as soon as
  Classes exist. A schemaless app can still render its own views.
- **Docs.** Lead examples use `isA` and ontology objects. One
  classless example exists so "do I have to?" is answered with "no,
  but you will want to."
- **Shortnames.** `description` instead of a URL only works when a
  Property resource is in the store.

## How not to nudge

- Do not require `isA` on `newResource` / `create_resource`.
- Do not require Property resources to exist before `set`.
- Do not require an HTTP-hosted ontology.
- Do not invent a second schemaless key format (plain `"title"` keys).
  Property identity stays a URL. An app that skips schema still uses
  URL keys — `https://example.com/title` or a `did:ad:` Property they
  create later. That keeps the data Atomic-Core-valid and upgradeable
  to a schema without rewriting subjects.

## Relation to other plans

- [`json-schema-code-first.md`](./json-schema-code-first.md) is the
  on-ramp for people who *want* a schema without publishing HTTP
  Classes. This doc is the rule for people who do not want one yet.
- [`SDK-API-design.md`](./SDK-API-design.md) should keep "schema in
  code" as the recommended tutorial path, and mention that schema is
  optional at the store.
- [`habits-app.md`](./habits-app.md) still defines an ontology. That is
  the intended external-app shape.

## Checklist

- [x] Decision: schema recommended, not required.
- [x] Rust `Resource::set` accepts unknown Property URLs.
- [x] Unit test: classless resource + unknown property saves and reloads.
- [x] Unit test: known Property still rejects a datatype mismatch.
- [x] FAQ + JS getting-started mention the classless path.
- [ ] Soften JSON-AD parse to infer JSON types when the Property is
      missing (only if an importer hits it).
- [ ] `defineSchema` / `registerSchema` (tracked in
      [`json-schema-code-first.md`](./json-schema-code-first.md)).
- [ ] Tutorial leads with code-first schema, shows one schemaless
      snippet.
