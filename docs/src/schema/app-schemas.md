# App-defined schemas

An app can define its data model without hosting an ontology. The Rust and
TypeScript SDKs turn named fields into ordinary Atomic Properties and a Class.
Their identifiers are `atomic:frozen:<hash>`: immutable definitions addressed by
BLAKE3 over their canonical JSON-AD bodies (JCS). Data instances still use normal
Atomic resources, permissions, signed commits and Loro synchronization.

This API is experimental. Register the same bundle on **every writer and
validating server**. Bundles are explicit app assets; this version does not
transfer missing definitions automatically through drive sync. Unknown schema
continues to follow the existing optional-schema policy. Registered frozen
properties are validated by Rust's schema-validating write path.

## TypeScript

```typescript
import { defineAppSchema, registerAppSchema, patchAppField } from '@tomic/lib';

const sliceSchema = defineAppSchema('audio-slice', {
  tune: {
    required: true,
    shape: { type: 'number', minimum: -48, maximum: 48 },
  },
  envelope: {
    required: true,
    shape: {
      type: 'object',
      properties: {
        attack: { type: 'number', minimum: 0, maximum: 2 },
        release: { type: 'number', minimum: 0, maximum: 4 },
      },
      required: ['attack', 'release'],
    },
  },
});

registerAppSchema(store, sliceSchema); // on app startup; no network needed
const slice = await store.newResource({
  isA: sliceSchema.class_id,
  parent: driveId,
  propVals: {
    [sliceSchema.fields.tune]: 0,
    [sliceSchema.fields.envelope]: { attack: 0.01, release: 0.2 },
  },
});
await patchAppField(slice, sliceSchema, 'envelope', ['attack'], 0.05);
await slice.save();
```

`setAppField(resource, schema, field, value)` validates and replaces a field.
`patchAppField` edits a nested object member; `undefined` deletes and JSON `null`
assigns null. Required-field deletion fails. Always load the existing resource
before editing so peers share its CRDT history.

## Rust

Use `atomic_lib::schema::{app::{AppSchema, Field}, shape::Shape}`. The equivalent
flow is `AppSchema::define`, `schema.register(&store).await`,
`schema.set(&mut resource, field, value, &store).await`, then
`schema.patch(&mut resource, field, &["attack"], Some(json!(0.05)), &store).await`.
Use the normal resource save API to persist and sign the resulting edits.
`None` removes a nested member; `Some(json!(null))` assigns null.

A bundle is serializable JSON with `class_id`, a `fields` name-to-ID map, and
`definitions` keyed by ID. A TypeScript-created bundle can be deserialized as
`AppSchema` in Rust, and vice versa. Registration verifies hashes, binding
completeness, supported shape keywords and datatype consistency before installing
any definition. Rust stores preserve the definitions across database restarts.

Run `cargo run -p atomic_lib --features db-redb --example app_schema` to see an
Audio slice bundle and native Loro snapshots. The shared fixture in
`lib/tests/fixtures/app-schema.json` contains a browser edit too. Both SDK test
suites merge the native `attack` edit and browser `release` edit and assert both
survive. Regenerate the fixture by saving the example's JSON there, then running
`UPDATE_APP_SCHEMA_FIXTURE=1 pnpm --dir browser/lib exec vitest run src/app-schema.test.ts`.

## Shape vocabulary

This is an explicit, bounded JSON Schema-like vocabulary, **not a full JSON
Schema implementation**. Unsupported keywords (including `$ref`, `oneOf` and
`pattern`) fail instead of being ignored.

| Shape | Constraints |
| --- | --- |
| `string` | Optional `maxLength`, counted in Unicode scalar values |
| `number`, `integer` | Optional finite `minimum` and `maximum`; integers must be safe in JavaScript |
| `boolean`, `null` | Exact value type |
| `reference` | Explicit Atomic or HTTP(S) resource identifier |
| `object` | `properties`, optional `required`, `additionalProperties` defaults to false |
| `array` | `items` and required `maxItems` (at most 16,384) |

Shapes have at most 16 levels and 128 properties per object. An app schema has
at most 128 fields. Each frozen definition is at most 256 KiB and 64 JSON levels.
A `reference` is deliberately explicit; a string that resembles a URL and a
schema reference are not automatically resource links.

Nested fields remain inside a JSON property. Object members are native Loro maps
and arrays native lists. Object path edits preserve ancestor container identities,
so concurrent changes to sibling members merge. Replacing an entire object can
supersede concurrent edits inside its old container. Array paths are not supported
by `patch`; use explicit list operations for positional editing and validate the
result on save. Nested values are not separate graph resources or individually
indexed Atomic properties. Concurrent edits to the same member follow Loro's
conflict-resolution rules; validation does not supply cross-field invariants.

## Identity and evolution

Property bodies include an app-chosen semantic scope (the schema name), field
name, datatype and shape. Choose a stable, specific scope: renaming it changes
all field IDs. Changing a field's shape changes its Property ID and its Class ID;
adding a field preserves existing field IDs. Core ontology IDs stay unchanged.
Definitions cannot be updated through commits, and content hashes are checked on
storage and registration. Legacy `did:ad:frozen:` outer identifiers are readable
in Rust; new bundles emit `atomic:frozen:`. Body identifiers are not rewritten
because they participate in the hash.

Reusing an existing Property ID means reusing its meaning. Changes to units,
meaning or datatype require a new definition and an explicit data migration.
Do not use display labels as semantic scope changes. Presentation metadata,
reference-based recursive schemas, a schema catalog, automatic discovery,
JSON Schema import/export and a Dart convenience API are follow-up work. Flutter
can call these Rust APIs through its existing native bridge; this change does
not yet migrate Atomic Audio's project format.
