# JSON Schema compatible, code-first schemas

## Goal

Make Atomic usable by app developers who want to define their data model in
code, without first publishing Classes and Properties at HTTP URLs.

The desired workflow:

1. An app declares a JSON Schema-like model in TypeScript, Rust, or another SDK.
2. Atomic turns that declaration into one local Ontology resource plus local
   Atomic Class and Property resources.
3. Those schema resources get `did:ad` subjects and are signed like normal data.
4. The app can immediately create, validate, render, query, and sync resources
   using those Classes and Properties.
5. Other devices or apps can resolve the schema from the local store, drive sync,
   or an app-provided schema bundle. HTTP hosting is optional, not required.

## Thesis

Atomic should not replace JSON Schema. Atomic should be JSON Schema compatible at
the boundary while keeping Atomic Class and Property resources as the semantic
runtime model.

JSON Schema is the developer-facing interchange and validation language. Atomic
Classes and Properties remain the graph-native form used for:

- property identity
- datatype lookup
- forms and table columns
- query building
- local-first sync
- cross-app semantic reuse

This means import/export must be first-class:

- JSON Schema -> Atomic ontology resources
- Atomic ontology resources -> JSON Schema

## Current State

- Atomic already has `Class`, `Property`, and `Datatype` resources.
- `Property` resources provide `shortname`, `datatype`, optional `classtype`,
  and optional `allowsOnly`.
- `Class` resources provide `shortname`, `requires`, and `recommends`.
- `browser/lib/src/store.ts#getProperty` resolves a Property by subject and
  expects a Resource in the store.
- `lib/src/schema.rs` has Rust `Class` and `Property` structs.
- `lib/src/validate.rs` validates datatypes and required properties.
- `https://atomicdata.dev/properties/jsonSchema` already exists and is used for
  plugin config schemas.
- `planning/SDK-API-design.md` already names "Schema creation in-code" as a
  future SDK capability.
- `@tomic/cli` already generates TypeScript ontology bindings from existing
  Ontology resources.
- The data browser already creates Ontologies, Classes, and Properties through
  the Ontology editor and table editor.

The missing piece is a coherent code-first Ontology model and SDK API that
produces locally available DID-backed schema resources from code.

## Current Status

This is not full-stack working yet.

Implemented so far:

- `browser/lib/src/schema.ts` exports `defineSchema()`, schema package types,
  canonical normalization, BLAKE3 `schemaHash`, and a pinned import shape.
- `schemaToOntologyModel()` converts the supported schema subset to an
  in-memory Ontology/Class/Property model.
- `Store.registerSchema()` creates local DID Ontology, Class, and Property
  resources in memory and registers a `schemaHash -> ontology subject` index.
- `Store.registerSchema(schema, { save: true })` pushes generated schema
  resources through the normal Commit/outbox path.
- `Store.registerSchema()` validates pinned imports with `expectedHash` and
  fails when the resolved Ontology hash does not match.
- Imported individual Properties can be reused with `$ref:
  "importAlias.properties.shortname"`; generated Classes point at the imported
  Property subject instead of creating a duplicate Property.
- Generated local Properties resolve through `store.getProperty()` after
  registration.
- `browser/lib/tests/schema-code-first.integration.test.ts` verifies the
  end-to-end target with a real server: one JS producer module defines and
  publishes a schema, another JS consumer module fetches the Ontology by DID,
  validates the expected hash, reuses one imported Property, and creates an
  instance with that Property.
- `@tomic/cli` has an initial `schema` command that loads a JS schema module
  and calls `Store.registerSchema()`, publishing by default or registering
  locally with `--local`. It can append the published Ontology subject to
  `atomic.config.json` with `--add-to-config`.
- `ad-generate schema --generate` now writes TypeScript ontology bindings
  directly from the just-registered Ontology resources, using the same Store so
  local code-first schemas do not need a server round-trip before codegen.
- The CLI accepts an optional `serverUrl` in `atomic.config.json` and falls back
  to `http://localhost:9883` for relative resource creation/publishing.
- `browser/cli/src/commands/schema.test.ts` verifies a minimal JS project can
  define a raw schema package, run `ad-generate schema --local --generate`, and
  produce TypeScript bindings with generated DID subjects.
- `browser/lib/src/schema.test.ts` verifies saved generated Ontology, Class,
  and Property DID resources can be resolved by a fresh offline `Store` from
  local DB state.
- `Store.registerSchema()` now rejects an explicit `atomic:subject` Property
  reuse when immutable fields such as datatype, classtype, or `allowsOnly`
  differ from an already-loaded Property resource.
- Focused SDK tests cover stable schema hashing, datatype-change hash changes,
  undefined normalization, invalid numeric values, pinned import metadata,
  schema conversion, local DID schema registration, and local property
  resolution, instance creation using returned schema subjects, import hash
  mismatch failures, and single imported Property reuse.
- `browser/lib/src/jcs.ts` implements RFC 8785 JCS canonicalization, used for all
  frozen hashing (and the schema-package hash), so ids are byte-reproducible
  across languages. Covered by `browser/lib/src/jcs.test.ts`.
- `browser/lib/src/freeze.ts` implements `freezeResources()`: a generic,
  schema-agnostic primitive that content-addresses a set of mutually-referencing
  resources into a `did:ad:frozen` Merkle DAG over JCS bytes, freezing each
  strongly-connected cycle as one self-verifying unit object (Tarjan SCC +
  color-refinement canonical ordering). Covered by
  `browser/lib/src/freeze.test.ts` (acyclic determinism/dedup/order-independence,
  reference rewriting, external refs, cycle-as-unit, verify-by-rehash,
  self-reference, validation).
- `browser/lib/src/schema.ts#freezeSchema()` builds **identity-only** frozen
  Ontology/Class/Property JSON-AD bodies (machine contract: shortname, datatype,
  classtype, allowsOnly, requires/recommends) with cross-references resolved to
  frozen ids, and returns descriptions + ontology version/schemaHash/jsonSchema
  separately as `presentation`. So editing a description does not churn any id.
  It enforces per-ontology shortname uniqueness (content-aware: identical
  definitions dedupe and pass, genuinely different ones sharing a shortname are
  rejected). Tested for id format, reference rewriting, identity/presentation
  split (description edit keeps ids stable, datatype edit changes them, no
  cascade), determinism, shortname dedupe/conflict, and the imported-property
  guard.

Not implemented yet:

- `did:ad:frozen` is designed and produced by `freezeSchema`, but
  `Store.registerSchema` still mints signed genesis DIDs; switching it over needs
  server-side store/serve/resolve support for `did:ad:frozen` (verify-by-rehash,
  read-only) plus a `did:ad:frozen` resolution path in the browser Store.
- The signed "latest version" pointer / overlay layer on the author's drive.
- Schema package resolution from Drive context, app registry, CLI config, synced
  Ontologies, or schema hash before the schema is explicitly registered.
- `store.getProperty()` fallback to unresolved schema packages.
- CLI-side consumer/type-generation e2e for imported schemas.
- Data browser/table/editor handling for content-locked Properties.
- Rust/server import/export or JSON Schema validation.

## Existing Touch Points

### TypeScript SDK

- `browser/lib/src/ontology.ts` defines `OntologyBaseObject`, global
  `registerOntologies()`, quick prop name lookup, and class/property type
  inference.
- `browser/lib/src/store.ts#getProperty` fetches a Property resource by subject
  and converts it to the lightweight `Property` interface used by forms, table
  cells, and validation.
- `browser/lib/src/resource.ts#set` calls `store.getProperty()` before datatype
  validation. If a generated DID property is not locally registered or synced,
  edits can only skip client-side validation and rely on server rejection.
- `browser/lib/src/store.ts#newResource` already supports locally signed
  genesis DID resources, which is the primitive needed for code-first
  Ontology/Class/Property creation.

### CLI

- `browser/cli/src/commands/ontologies.ts` validates configured Ontology
  subjects and writes generated TypeScript files.
- `browser/cli/src/generateOntology.ts` is the main Ontology resource ->
  generated code pipeline.
- `browser/cli/src/generateBaseObject.ts` reads Ontology `classes` and
  `properties`, creates the exported `OntologyBaseObject`, and builds
  `__classDefs`.
- `browser/cli/src/generateClasses.ts` and
  `browser/cli/src/generatePropTypeMapping.ts` generate native TypeScript
  class/property typings from materialized Class and Property resources.
- `browser/cli/src/validateOntologies.ts` currently requires every configured
  subject to resolve to `core.classes.ontology`.

The CLI is therefore not obsolete. It should become part of the code-first loop:

```text
code schema -> Ontology/Class/Property resources -> @tomic/cli bindings
existing Ontology resources -> @tomic/cli bindings
```

### Data Browser

- `browser/data-browser/src/views/OntologyPage` is the existing editor for
  Ontology resources. `OntologyContext` mutates the Ontology `classes` and
  `properties` arrays.
- `browser/data-browser/src/components/forms/.../NewOntologyDialog.tsx`
  creates Ontology resources with empty `classes`, `properties`, and
  `instances` arrays.
- `browser/data-browser/src/chunks/TablePage/PropertyForm/NewPropertyDialog.tsx`
  creates Property resources from table columns and adds them to the parent
  Ontology when the table class is inside an Ontology.
- `browser/data-browser/src/chunks/TablePage/useTableColumns.tsx` resolves table
  columns through `store.getProperty()`, so table rendering needs generated DID
  properties to be materialized or locally indexed.
- `browser/data-browser/src/components/forms/ResourceForm.tsx` renders required
  and recommended fields from a Class resource's `requires` and `recommends`
  arrays.

Code-first schemas must not bypass these paths. Ontology editor and table
editor output should remain valid input to codegen/export, and code-first
output should remain editable and inspectable in these views.

### Rust / Server

- `lib/src/schema.rs` has the canonical Rust `Property` and `Class` structs for
  materializing schema resources.
- `lib/src/validate.rs` and `Resource` validation fetch Properties and Classes
  by subject to check datatypes and required properties.
- `lib/src/populate.rs` defines the bootstrap schema resources and currently
  describes the `Property` and `Class` contracts.

Rust validation should continue to validate against materialized Class and
Property resources. JSON Schema validation can be layered on later for extra
constraints; it should not be required for basic Atomic datatype and required
property validation.

### Docs / Spec

- `docs/src/schema/intro.md` currently says Classes and Properties are resolved
  using HTTP and that Property URLs should resolve.
- `docs/src/schema/classes.md` documents Property, Datatype, and Class as
  first-class resources.
- `docs/src/schema/compare.md` explicitly contrasts Atomic Schema with JSON
  Schema by noting that JSON Schema scopes properties to a schema, while Atomic
  Properties are reusable.
- `docs/src/schema/migrations.md` already recommends adding new properties
  instead of changing existing relationships in place.
- `docs/src/did.md` defines DID resource resolution through Drive context and
  says `did:ad:` identifiers have no subpaths. Code-first schema references
  should therefore use normal DID resource subjects, not path-like property
  members inside one DID.

The public docs need a coordinated update after the API shape stabilizes:
resolvability should become "resolvable through URL, local store, Drive sync, or
app-bundled schema registry" rather than "must be HTTP-resolvable".

## Proposed Developer API

Start in the TypeScript SDK because that is where app builders currently feel
the HTTP ontology friction most directly.

Example shape:

```ts
import { defineSchema } from '@tomic/lib/schema';

export const todoSchema = defineSchema({
  name: 'TodoApp',
  version: '1.0.0',
  classes: {
    todo: {
      title: 'Todo',
      description: 'A task in a todo list',
      type: 'object',
      required: ['title'],
      properties: {
        title: {
          type: 'string',
          description: 'Task title',
        },
        done: {
          type: 'boolean',
          description: 'Whether the task is complete',
          default: false,
        },
        dueAt: {
          type: 'string',
          format: 'date',
          description: 'Due date',
        },
      },
    },
  },
});

const ontology = await store.registerSchema(todoSchema);

const todo = await store.newResource({
  isA: ontology.classes.todo,
  propVals: {
    [ontology.properties.title]: 'Buy milk',
    [ontology.properties.done]: false,
  },
});
```

`registerSchema` should:

- create or update local Atomic schema resources
- save them as signed `did:ad` resources
- persist them locally before returning
- return a generated ontology object compatible with existing
  `browser/lib/src/ontologies/*.ts` objects
- make the generated Class and Property resources available through normal
  `store.getResource`, `store.getProperty`, form rendering, and sync paths

## Identity Model

Schema resources need stable identity without HTTP.

**Decided: content-addressed `did:ad:frozen` identifiers.** A schema definition is
immutable by intent, so it does not need a signature (provenance) or an owner
who can edit it (authoritative mutability). Both of those are what signing buys;
neither applies to a frozen definition. So schema resources are identified by a
content hash, not a genesis signature:

```text
did:ad:frozen:{blake3-hex}
did:ad:frozen:{blake3-hex}?drive=did:ad:{your_drive}   // optional routing hint
```

- A `did:ad:frozen` subject resolves to **canonical JSON-AD** (not opaque bytes,
  which is what `did:ad:blob` is for). The resolver fetches, **re-hashes to
  verify**, parses, and materializes a read-only Resource.
- `id = blake3(JCS(content))`, where `content` is the **identity** of the
  resource — the machine contract only. For a Property that is `shortname`,
  `datatype`, `classtype`, `allowsOnly`, `isDynamic`, `isLocked`; for a Class,
  `shortname` + `requires`/`recommends`. **Presentation is excluded** —
  description, label, translations, icon, ordering live in the mutable package
  layer (see Identity vs Presentation below), so cosmetic edits never churn an
  id. Same identity -> same id (global dedup); a change to the machine contract
  (datatype, rename, add/remove a required property) -> a new id, which is a real
  new version to link.
- No commit, no signature, no history. Immutable by construction. No keypair is
  needed to mint one; ids can be computed offline and deterministically.
- Each Property, Class, and Ontology is its own frozen resource. The Ontology
  references its members by their frozen ids, so single-property reuse still
  works by pointing at a property's frozen id. Efficient ontology-level
  resolution comes from **shipping the members bundled together**, not from
  collapsing them into one blob.

Canonical bytes use **RFC 8785 JCS** (`browser/lib/src/jcs.ts`) so a frozen id is
reproducible byte-for-byte across languages (the Rust side uses a conformant JCS
crate). `id = blake3(JCS(content))`.

Because frozen resources reference each other by hash, the ids are
interdependent (an Ontology's id depends on its Classes' ids, which depend on
their Properties' ids) — a Merkle DAG built by topological hashing. Mutually
referencing definitions (e.g. a `Person` class with a `friend` property whose
classtype is `Person`) form a cycle with no leaf to start from; each
strongly-connected group is frozen **as a single unit object**
(`{ "urn:atomic-freeze:unit": [...members] }`, members in canonical order with
intra-cycle refs as `did:ad:frozen:self:{index}` tokens). All members share the
unit's id, so `blake3(JCS(bytes)) == id` holds for every stored object and stays
verifiable by re-hashing.

This is implemented as a generic, schema-agnostic primitive:
`browser/lib/src/freeze.ts#freezeResources(resources)` content-addresses any set
of mutually-referencing resources (Tarjan SCC + color-refinement canonical
ordering for cycles, one unit per cycle), and
`browser/lib/src/schema.ts#freezeSchema(schema)` builds the frozen
Ontology/Class/Property JSON-AD bodies from a defined schema.

### Identity vs presentation

Hashing the *whole* body — descriptions included — was the original plan, but it
makes identity churn on every cosmetic edit: a reworded description changes a
property's id, which cascades up through the class and ontology, producing piles
of near-duplicate versions. Descriptions change constantly; identity must not.

So the boundary is set by one test: **does it change how data is validated or
interpreted?**

- **Identity (hashed):** `shortname`, `datatype`, `classtype`, `allowsOnly`,
  `isDynamic`, `isLocked`; for a Class, `shortname` + `requires`/`recommends`.
- **Presentation (not hashed):** description, label, translations, icon,
  ordering, examples — plus the Ontology's `jsonSchema` source and `schemaHash`
  (both encode descriptions). These ride in the **mutable package layer**: the
  Ontology resource and the lockfile, keyed by frozen id / model key.

Consequences:

- Cosmetic edits cause **zero** id churn — no cascade. New ids appear only on a
  real machine-contract change (datatype, rename, add/remove a required
  property), which is exactly when a new version is warranted; the mutable
  name-pointer absorbs that churn for consumers.
- A frozen property is **not self-describing**: its human text comes from the
  package you got it through. This is arguably correct — meaning is universal,
  wording is contextual and localizable.
- The **index dedupes on meaning**, not wording, so "title: string" is one entry
  no matter how differently apps describe it.

`freezeSchema` returns this split: `resources` (identity-only frozen bodies) and
`presentation` (descriptions + ontology `version`/`schemaHash`/`jsonSchema`,
keyed by model key so each usage keeps its own text even when identical
definitions dedupe to one id). `browser/lib/src/schema-lock.ts#buildSchemaLock()`
assembles both into the committed lockfile, and `verifySchemaLock()` re-hashes
every frozen object to confirm it matches its id — the language-neutral
verification a consumer or CI guard runs, depending only on JCS + blake3.

### Two layers: frozen definitions + signed pointers

Not everything can be frozen. Three things are inherently mutable and stay
**normal signed genesis-DID resources on the author's own drive**:

1. The "latest version" pointer — `name -> latest frozen ontology id` — so an app
   can mean "the current TodoApp" even as it evolves.
2. Editable display metadata that should not be frozen into identity, when an app
   chooses to keep it mutable (labels, translations, ordering, icons).
3. Endorsement — "this is the official Ontola schema" is provenance, i.e. a
   signature, attached at the pointer layer.

There is no central schema host. Authors publish frozen definitions and signed
pointers on **their own drive**; the `?drive=` hint routes resolution to it over
HTTP, Mainline DHT, or Reticulum, and any node can replicate that drive.

### Migration from the current implementation

The shipped code currently mints **signed genesis DID** resources for Ontologies,
Classes, and Properties (`Store.registerSchema`). Moving to `did:ad:frozen` keeps
the conversion and validation code but replaces identity minting with
`freezeSchema`, and requires server-side support for storing, serving, and
resolving `did:ad:frozen` resources (verify-by-rehash, read-only). That server
work is the main remaining gap before `registerSchema` can switch over, and is
planned in detail in [did-ad-frozen-server.md](./did-ad-frozen-server.md)
(model frozen as blob-like, not resource-like; resolve over local cache /
bundle / iroh+pkarr / optional default server; resolve the cyclic-addressing
question first).

## Local Availability

The main behavior change is that Property and Class URLs no longer imply HTTP
availability.

Resolution order for `did:ad` schema resources should be:

1. in-memory store
2. local persistent store / OPFS / native DB
3. the currently opened Drive, when the subject carries `?drive=` or the caller
   has an active Drive context
4. bundled app schema registry
5. synced Ontology resources referenced by the Drive, for example the Drive's
   `defaultOntology` or app/plugin configuration
6. network / peer discovery, only when there is enough routing context to find
   a Drive replica

For `did:ad` schema resources, network fetch is not the primary mechanism. The
resource must travel with the app, the drive, or sync.

## Ontology as Bundle

Use the existing Ontology class as the schema bundle resource.

Minimum useful fields:

- `isA`: Ontology
- `shortname` / name
- `version`
- `classes`: ResourceArray of generated Class resources
- `properties`: ResourceArray of generated Property resources
- `jsonSchema`: original JSON Schema document, stored as `json`
- `schemaHash`: canonical hash of the JSON Schema document
- `replaces` / `previousVersion`: optional pointer to older bundle

Using an Ontology as the bundle solves three problems:

- app startup can register one thing and get every generated subject
- sync can discover the schema resources needed to interpret app data
- the existing OntologyPage, `defaultOntology`, code generation, and generated
  `OntologyBaseObject` shape keep working

The Ontology should not embed Properties and Classes as anonymous JSON-only
children in the first implementation. Keeping them materialized as standalone
resources preserves Atomic's semantic reuse model and avoids creating a second
schema runtime for forms, table columns, validation, graph views, usage views,
and query building.

## Schema Hash

`schemaHash` is a version fingerprint, not a resolver.

Define it as the hash of a canonical normalized schema document, for example:

```text
schemaHash = blake3(canonical_json(normalized_json_schema))
```

It answers "is this exactly the schema version I expected?", not "where do I
fetch this from?" Resolution still starts from the Ontology subject, app-bundled
registry, Drive context, or local/synced store.

The hash should be stored as a normal Atomic property on the Ontology resource.
Because the Ontology is backed by Loro like any other Resource, the hash is
already part of the resource state and signed history. It should not be stored
as a special resolver entry in the Loro oplog.

If all a caller has is a `schemaHash`, lookup requires an index:

```text
schemaHash -> ontology subject
```

That index can be derived from app-bundled schemas, local storage, and synced
Drive Ontologies. It is a cache/discovery aid, not authoritative state.

Canonical schema bytes may optionally be stored as a `did:ad:blob:{blake3}` for
package-lock style pinning. That blob is immutable byte content and cannot
replace the Ontology resource, because blobs have no class, parent, ACL,
history, or links to materialized Class and Property resources.

## Frozen lockfile (the shareable artifact)

A frozen id is a pure, deterministic function of the schema source (JCS →
blake3). So the schema does not need to be *hosted* to be *available*: ship a
self-verifying copy of the canonical bytes alongside the code. `ad-generate`
emits a `*.schema.lock.json` next to the generated bindings; it is committed and
guarded by a CI "regenerate and diff" check (stale-lockfile guard). This is
resolution step 2 ("app-bundled frozen objects") made concrete, and it makes any
default server (atomicdata.dev or a drive) a pure cache, never a dependency.

### Format

```jsonc
{
  "name": "TodoApp",
  "version": "1.0.0",
  "ontology": "did:ad:frozen:7c1…",
  "@index": {                          // human aid, NOT hashed
    "did:ad:frozen:7c1…": "TodoApp.todo",       // class
    "did:ad:frozen:9f2…": "TodoApp.title",      // property
    "did:ad:frozen:a3b…": "TodoApp.done"
  },
  "frozen": {                          // the verbatim, hashed objects (identity only)
    "did:ad:frozen:9f2…": {
      "https://atomicdata.dev/properties/isA": ["https://atomicdata.dev/classes/Property"],
      "https://atomicdata.dev/properties/shortname": "title",
      "https://atomicdata.dev/properties/datatype": "https://atomicdata.dev/datatypes/string"
      // no description here — that is presentation, below
    }
    // …one entry per frozen object; a cycle is one `urn:atomic-freeze:unit` entry
  },
  "presentation": {                    // mutable, NOT hashed
    "TodoApp.title": { "id": "did:ad:frozen:9f2…", "description": "Task title" }
    // …plus ontology-level description / version / jsonSchema
  }
}
```

### The hashing invariant

Only the values of `frozen` are hashed, and they hold **identity only** (the
machine contract), serialized as **verbatim canonical JSON-AD** (full property
URLs, `did:ad:frozen:` refs, JCS order). Descriptions/labels live in
`presentation`, which is never hashed — so re-wording text changes the lockfile
diff but not a single id. Verification is trivial and language-neutral: for each
`id -> object` in `frozen`, assert `"did:ad:frozen:" + blake3(JCS(object)) == id`;
everything else (`name`, `version`, `@index`, `presentation`) is a non-hashed
aid. We deliberately do **not** make references shortnames in the hashed form —
that would reopen the cross-language canonicalization surface JCS just closed.
Shortnames live only in `@index`.

### Why this shape

- **Verbose, not gibberish.** The "noise" is the frozen ids (hashes), which are
  intrinsic to content-addressing; `@index` decodes every one to
  `Ontology.shortname`, so a reviewer reads the index, and a changed hash in a
  diff is the visible "this identity moved" signal.
- **Consume without reimplementing freeze.** Any language embeds the file (Rust
  `include_str!`, etc.), iterates `frozen`, re-hashes to verify, and materializes
  read-only Resources. Reimplementing `freezeResources` is only needed to
  *author* schemas in another language — and the committed `frozen` bytes are then
  the cross-implementation conformance check.
- **Unambiguous index.** `freezeSchema` enforces per-ontology shortname
  uniqueness (content-aware: identical definitions across classes dedupe to one
  frozen id and pass; only genuinely different definitions sharing a shortname are
  rejected), so each `@index` value is a clean `Ontology.shortname`.

## JSON Schema Mapping

The first implementation should support a conservative, useful subset.

### Object

JSON Schema object definitions map to Atomic Classes.

- `title` -> Class `shortname` when no explicit `atomic:shortname` is set
- `description` -> Class `description`
- `required` -> Class `requires`
- `properties - required` -> Class `recommends`
- `$defs` -> additional Classes and Properties

### Properties

JSON object properties map to Atomic Property resources.

- JSON property key -> Atomic `shortname`
- JSON `description` -> Atomic `description`
- JSON type/format -> Atomic `datatype`
- `$ref` for resources -> `datatype = atomicURL` or `resource`
- array of refs -> `datatype = resourceArray`
- scalar enum -> store in JSON Schema first; map to `allowsOnly` only when the
  values are valid Atomic values for the Property

Property subjects should normally be generated once and then reused across
schema versions when the property's machine meaning is unchanged. Changes that
alter datatype or semantics should produce a new Property subject.

### Datatypes

Initial mapping:

| JSON Schema | Atomic datatype |
| --- | --- |
| `{ "type": "string" }` | `string` |
| `{ "type": "string", "format": "date" }` | `date` |
| `{ "type": "string", "format": "uri" }` | `uri` |
| `{ "type": "integer" }` | `integer` |
| `{ "type": "number" }` | `float` |
| `{ "type": "boolean" }` | `boolean` |
| `{ "type": "object" }` | `json` unless it maps to a Class |
| `{ "type": "array" }` | `resourceArray` only for references, otherwise `json` |

Atomic-specific annotations should use extension keys, for example:

```json
{
  "type": "string",
  "atomic:datatype": "https://atomicdata.dev/datatypes/markdown"
}
```

Useful extension keys:

- `atomic:subject`
- `atomic:shortname`
- `atomic:datatype`
- `atomic:classType`
- `atomic:recommends`
- `atomic:allowsOnly`
- `atomic:isDynamic`
- `atomic:isLocked`

## Validation Model

Use two validation layers:

1. Atomic validation for the mapped subset:
   - required properties
   - datatypes
   - resource class type
   - `allowsOnly`
2. JSON Schema validation for richer JSON Schema keywords:
   - `minLength`
   - `maxLength`
   - `minimum`
   - `maximum`
   - `pattern`
   - `oneOf` / `anyOf` / `allOf`
   - `additionalProperties`

The mapped Atomic subset must be enough for existing Atomic UX: forms, tables,
query builder, shortname resolution, and datatype materialization should not
need a JSON Schema engine.

JSON Schema validation can be added incrementally:

- browser SDK validation first
- Rust/server validation second
- optional strict mode per drive/app/class

## Versioning

Default to immutable schema versions and immutable property meaning.

Editing code should not silently mutate the meaning of existing data on another
device. A changed schema should normally produce a new Ontology version and
possibly new Class/Property DID subjects.

Developer API:

```ts
await store.registerSchema(todoSchema, {
  migration: 'new-version',
});
```

Supported policies:

- `new-version`: create a new bundle and new changed resources
- `update-in-place`: edit existing DID resources, useful during development
- `fail-if-changed`: production-safe mode for apps that expect exact schemas

If a developer changes only display metadata, such as description, label,
translation, icon, or ordering, the Property subject can remain stable. If
datatype or meaning changes, use a new Property subject.

Working rule:

- Ontologies are versioned packages. They may link to previous versions and can
  change by publishing a new version.
- Classes are versioned shapes over Properties. Changing required/recommended
  structure should generally create a new Class version when shared data already
  depends on the old shape.
- Properties are immutable semantic definitions. Datatype changes, `classtype`
  changes, and semantic meaning changes require a new Property subject.
- Metadata-only edits can be allowed during development, but published
  properties should be treated as content-locked.

## Sync and Trust

Schema resources are normal signed resources.

Trust rules should be explicit:

- app-bundled schema resources are trusted by the app that bundled them
- drive-published schema resources are trusted according to normal drive rights
- remote schema resources are trusted only if their signer is trusted or the
  user accepts them

Because Classes and Properties may be DID resources, validation cannot assume
the owner is an HTTP origin. The proof is the signed resource history plus the
trust context that introduced the schema.

The trusted entry point is usually the Ontology resource: it may be bundled by
the app, set as a Drive's `defaultOntology`, referenced by a plugin/app config,
or synced with a Drive. The Ontology then points to individual Class and
Property resources. Those linked resources must still be present locally,
bundled, or resolvable through the same Drive/app trust context.

## Interaction with Sign-at-Drain

Schema registration creates a small set of important resources. It should not be
mixed with the high-frequency document editing path.

Rules:

- DID genesis schema resources must be signed synchronously enough to return
  stable subjects to the caller.
- Normal schema updates can use the sign-at-drain path after the DID subject is
  known.
- `registerSchema` must not report success until the schema resources are
  durably available locally.
- Publishing to a server can be asynchronous, but local use must work
  immediately.

## Implementation Plan

### Phase 0: Decide contracts

- [x] Decide whether the grouping resource reuses `Ontology` or gets a new
      `SchemaBundle` class: reuse `Ontology`.
- [x] Decide the initial immutability contract for Property resources:
      genesis-DID with tooling enforcement first; content-derived IDs remain a
      later option before broad public release.
- [x] Decide the initial import expression in code: named `imports` map with
      Ontology `subject` plus optional `expectedHash`, and imported Properties
      referenced as `$ref: "importAlias.properties.shortname"`.
- [ ] Decide where schema discovery is attached first: Drive `defaultOntology`,
      app/plugin config, explicit `registerSchema`, or all of them.

### Phase 1: TypeScript code-first creation

- [x] Add a TypeScript schema module with `defineSchema` and type definitions
      for the supported JSON Schema subset plus `atomic:*` extensions.
- [x] Implement JSON Schema/code schema -> in-memory Ontology/Class/Property
      model conversion.
- [x] Implement schema hashing over canonical normalized schema package JSON.
- [x] Implement local DID resource creation for the generated Ontology bundle.
- [x] Implement local DID resource creation for generated Classes and
      Properties.
- [x] Add `store.registerSchema(schema, options)` in `@tomic/lib`.
- [x] Add an explicit `registerSchema(schema, { save: true })` path that saves
      generated schema resources through the normal Commit/outbox flow.
- [x] Verify registered schema resources reload from local DB after save.
- [x] Add a local/app schema index for `schemaHash -> ontology subject`.
- [x] Ensure `store.getProperty` resolves generated DID Properties from
      in-memory registered schemas without requiring HTTP.
- [x] Reject explicit Property subject reuse when immutable machine fields do
      not match the already-loaded Property definition.
- [ ] Ensure `store.getProperty` and class loading resolve DID schema resources
      from local DB, registered app schemas, and Drive context without
      requiring HTTP.

### Phase 1.5: Content-addressed frozen identity

- [x] RFC 8785 JCS canonicalization (`jcs.ts`).
- [x] Generic `freezeResources()` content-addressing primitive with one-unit-per-
      cycle (`freeze.ts`).
- [x] `freezeSchema()` building frozen JSON-AD bodies from a defined schema.
- [x] Per-ontology shortname uniqueness enforcement (content-aware).
- [ ] `did:ad:frozen` server support (storage, serve, resolve, materialize) — see
      [did-ad-frozen-server.md](./did-ad-frozen-server.md).
- [ ] Switch `Store.registerSchema` from signed genesis DIDs to `freezeSchema`
      (behind a flag during migration).
- [ ] Browser Store resolution of `did:ad:frozen:` (fetch -> verify-by-rehash ->
      materialize read-only Resource; expand `urn:atomic-freeze:unit` objects).
- [ ] Signed "latest version" pointer / overlay layer on the author's drive.

### Phase 2: CLI integration

- [x] Extend `@tomic/cli` so the existing Ontology -> TypeScript path can also
      consume locally registered/generated Ontologies.
- [x] Add a CLI command or option for code schema -> Ontology resources, using
      the same conversion code as `store.registerSchema` where possible.
- [x] Add SDK import/hash pin checks: if an external Ontology is referenced
      with an expected hash and the resolved resource does not match,
      `registerSchema()` fails.
- [ ] Add CLI import/hash pin checks: if an external Ontology or Property
      subject is referenced with an expected hash/version and the resolved
      resource does not match, generation fails.
- [ ] Keep existing `ontologies` config working for HTTP and DID Ontology
      subjects.
- [x] Generate native bindings from materialized Class and Property resources,
      not from anonymous JSON-only schema members.
- [x] Let `ad-generate schema` optionally update `atomic.config.json` with the
      published Ontology subject for a follow-up `ad-generate ontologies` run.
- [x] Let `ad-generate schema --generate` write bindings immediately from the
      materialized Ontology/Class/Property resources in the current Store.
- [x] Emit a committed `*.schema.lock.json` (frozen objects + `@index` +
      `presentation`) via `ad-generate schema --lock`, using
      `buildSchemaLock()`/`verifySchemaLock()` in `@tomic/lib`. The emitter
      refuses to write an unverifiable lock.
- [x] Load + register a lockfile at app startup for offline availability:
      `Store.loadSchemaLock(lock)` verifies every frozen object by re-hash and
      materializes them locally, so a bundled `*.schema.lock.json` resolves with
      no server. Tested (`frozen-resolve.test.ts`).
- [ ] Add a CI "regenerate and diff" guard so the lockfile cannot drift from the
      source schema (`verifySchemaLock` + a re-emit check are the building blocks).

### Phase 2.5: End-to-end target

- [x] Add a minimal JS producer schema fixture.
- [x] Add a minimal JS consumer schema fixture that imports the producer
      Ontology with an expected hash and reuses one Property.
- [x] Add an integration test where producer publishes to a real server and
      consumer fetches/reuses that schema through a separate Store.
- [x] Add a CLI test where a minimal JS project defines a schema and
      `ad-generate schema --local --generate` produces generated bindings.
- [ ] Add a CLI-side producer/consumer import e2e where one generated schema
      imports another published/local Ontology with an expected hash.

### Phase 3: Editor and table compatibility

- [ ] Keep Ontology editor creation/editing as a first-class schema authoring
      path.
- [ ] Ensure table-created Properties and Classes can be exported to JSON
      Schema/code schema and then regenerated without changing meaning.
- [ ] Add UI indicators or warnings when editing a published/content-locked
      Property would change datatype, `classtype`, or semantic meaning.
- [ ] Ensure table columns and forms continue to resolve generated DID
      Properties through `store.getProperty()`.

### Phase 4: Import/export and validation

- [ ] Add JSON Schema export from Atomic Ontology/Class/Property resources.
- [ ] Add browser SDK tests:
      - create schema from code
      - schema package hashing is stable under object key reordering
      - generated Ontology, Class, and Property resources are local DID resources
      - create an instance using returned ontology subjects
      - reload store and resolve the generated Property without HTTP
      - import an external schema with an expected hash and fail on mismatch
      - reuse one imported Property in another Class
      - table-created schema exports and re-imports
      - required/datatype validation still works
- [x] Cross-language **authoring** in Rust: `lib/src/frozen.rs#freeze_resources`
      (the content-addressing core — Tarjan SCC + color refinement +
      one-unit-per-cycle) and `freeze_schema` (the order-preserving schema DSL →
      frozen Ontology/Class/Property ids). Both byte-for-byte identical to TS,
      pinned by `test-vectors/freeze-resources.json` and `freeze-schema.json`. A
      Rust app can now author a schema and get the same `did:ad:frozen` ids as the
      TS producer. (Key sorting uses byte order; TS `localeCompare` coincides for
      lowercase-ASCII shortnames — the convention. Codegen of native Rust structs
      from frozen schemas is a further, optional step.)
- [ ] Add optional JSON Schema validation in the browser SDK and Rust/server
      (richer keywords beyond the Atomic subset).
- [ ] Add optional JSON Schema validation in the browser SDK.
- [ ] Add optional JSON Schema validation in Rust/server.

### Phase 5: Docs

- [ ] Update `docs/src/schema/intro.md` so schema resources can resolve through
      HTTP, local store, Drive sync, or app-bundled schema registry.
- [ ] Update `docs/src/schema/classes.md` with immutability/versioning guidance
      for Properties, Classes, and Ontologies.
- [ ] Update `docs/src/schema/compare.md` with the JSON Schema compatible
      boundary story.
- [ ] Update `docs/src/schema/migrations.md` with Property immutability and
      version-link examples.
- [ ] Write public docs and a tutorial once the API has survived tests.

## Non-goals for the First Pass

- Full JSON Schema 2020-12 coverage.
- Replacing Atomic Class and Property resources with raw JSON Schema documents.
- Embedding all schema meaning in a single Ontology-only JSON document without
  materialized Class and Property resources.
- Requiring all schema resources to be public HTTP URLs.
- Solving global package-manager style schema discovery.
- Automatic migrations of existing instance data.

## Open Questions

- Where should schema bundles be attached for discoverability: drive
  `defaultOntology`, app config, plugin resource, or all of them?
- Should JSON Schema validation be strict by default, or opt-in per app/class?
- How should custom JSON Schema formats map to Atomic datatypes?
- ~~Do we want a future content-derived schema DID, or are signed genesis DIDs
  enough?~~ **Decided: content-derived `did:ad:frozen` identifiers** (see Identity
  Model). Only the machine-contract identity is hashed (descriptions and other
  presentation are excluded so cosmetic edits don't churn ids); cycles are hashed
  as a unit.
- ~~For a cycle (strongly-connected group), should members keep individually
  derived ids or share one group id?~~ **Decided: one unit per cycle** — members
  share the unit id and resolve together, keeping every stored object
  verifiable by re-hash. Per-member addressing inside a cycle is deferred.
- Should canonical schema JSON also be stored as a blob by default, or only
  when callers ask for reproducible byte-level pinning?
