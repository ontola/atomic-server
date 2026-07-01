# JSON Schema compatible, code-first schemas

## Goal

Make Atomic usable by app developers who want to define their data model in
code, without first publishing Classes and Properties at HTTP URLs.

The desired workflow:

1. An app declares a JSON Schema-like model in TypeScript, Rust, or another SDK.
2. Atomic turns that declaration into local Atomic Class and Property resources.
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

The missing piece is a coherent schema-bundle model and SDK API that produces
locally available DID-backed schema resources from code.

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

Schema resources need stable local identity without HTTP.

Recommended first step: signed genesis DID resources.

- Each generated Class is a normal Resource with `isA = core.classes.class`.
- Each generated Property is a normal Resource with
  `isA = core.classes.property`.
- The first registration signs each resource as a DID genesis resource.
- The returned ontology object stores those DID subjects.
- The schema bundle stores a mapping from developer keys to DID subjects:
  `todo -> did:ad:...`, `title -> did:ad:...`.

This is compatible with the current DID model and avoids inventing a new
content-addressed DID form before the rest of the stack is ready.

Open question for later: content-derived schema IDs. A future version may add a
canonical `did:ad:schema:<hash>` or a signed statement that binds a content hash
to the schema. Do not block the first implementation on that.

## Local Availability

The main behavior change is that Property and Class URLs no longer imply HTTP
availability.

Resolution order should be:

1. in-memory store
2. local persistent store / OPFS / native DB
3. synced drive schema registry
4. bundled app schema registry
5. network fetch, only if the subject is fetchable

For `did:ad` schema resources, network fetch is not the primary mechanism. The
resource must travel with the app, the drive, or sync.

## Schema Bundle Resource

Add an Atomic resource that groups generated schema resources. This could reuse
the existing Ontology class or introduce a narrower `SchemaBundle` class.

Minimum useful fields:

- `isA`: Ontology or SchemaBundle
- `shortname` / name
- `version`
- `classes`: ResourceArray of generated Class resources
- `properties`: ResourceArray of generated Property resources
- `jsonSchema`: original JSON Schema document, stored as `json`
- `schemaHash`: canonical hash of the JSON Schema document
- `replaces` / `previousVersion`: optional pointer to older bundle

Using a bundle solves two problems:

- app startup can register one thing and get every generated subject
- sync can discover the schema resources needed to interpret app data

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

Default to immutable schema versions.

Editing code should not silently mutate the meaning of existing data on another
device. A changed schema should normally produce a new schema bundle version and
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

Open question: Property identity. If a developer changes only a description, the
Property subject can probably remain stable. If datatype or meaning changes, use
a new Property subject.

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

- [ ] Decide whether the grouping resource reuses `Ontology` or gets a new
      `SchemaBundle` class.
- [ ] Add a TypeScript schema module with `defineSchema` and type definitions
      for the supported JSON Schema subset plus `atomic:*` extensions.
- [ ] Implement JSON Schema -> in-memory ontology conversion.
- [ ] Implement local DID resource creation for generated Classes and
      Properties.
- [ ] Add `store.registerSchema(schema, options)` in `@tomic/lib`.
- [ ] Ensure `store.getProperty` and class loading resolve DID schema resources
      from local storage without HTTP.
- [ ] Persist the schema bundle and generated resources before returning from
      `registerSchema`.
- [ ] Add JSON Schema export from Atomic Class/Property resources.
- [ ] Add browser SDK tests:
      - create schema from code
      - generated Class and Property resources are local DID resources
      - create an instance using returned ontology subjects
      - reload store and resolve the generated Property without HTTP
      - required/datatype validation still works
- [ ] Add Rust-side import/export structs after the TypeScript API shape is
      stable.
- [ ] Add optional JSON Schema validation in the browser SDK.
- [ ] Add optional JSON Schema validation in Rust/server.
- [ ] Write public docs and a tutorial once the API has survived tests.

## Non-goals for the First Pass

- Full JSON Schema 2020-12 coverage.
- Replacing Atomic Class and Property resources with raw JSON Schema documents.
- Requiring all schema resources to be public HTTP URLs.
- Solving global package-manager style schema discovery.
- Automatic migrations of existing instance data.

## Open Questions

- Should schema bundles be Resources of existing `Ontology`, or a new
  `SchemaBundle` class?
- Should generated Property subjects be reused across schema versions when only
  display metadata changes?
- Where should schema bundles be attached for discoverability: drive
  `defaultOntology`, app config, plugin resource, or all of them?
- Should JSON Schema validation be strict by default, or opt-in per app/class?
- How should custom JSON Schema formats map to Atomic datatypes?
- Do we want a future content-derived schema DID, or are signed genesis DIDs
  enough?

