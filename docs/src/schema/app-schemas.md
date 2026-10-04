# App-defined schemas

An app can define its data model without hosting an ontology. The Rust and
TypeScript SDKs turn named fields into ordinary Atomic Properties and a Class.
Their identifiers are `atomic:frozen:<hash>`: immutable definitions addressed by
BLAKE3 over their canonical JSON-AD bodies (JCS). Data instances still use normal
Atomic resources, permissions, signed commits and Loro synchronization.

This API is experimental. Writers register their app bundle locally. Normal save
operations attach the required definitions to the resource's Loro document, so a
cold replica can receive and verify them through the existing sync protocol.
Missing or invalid **frozen** dependencies fail explicitly; unknown HTTP-defined
schema keeps the existing optional-schema behavior. Older peers preserve the
extra Loro root but do not enforce this validation contract.

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
reference-based recursive schemas, a schema catalog, global dependency inventory,
JSON Schema import/export and a Dart convenience API are follow-up work. Flutter
can call these Rust APIs through its existing native bridge; this change does
provide the Audio migration UI (maintained in the Audio repository).


## Delivery and trust

The reserved Loro root map `atomic:schema-definitions` contains canonical frozen
IDs mapped to canonical JSON strings. The properties map still holds app data.
Definitions travel in signed COMMIT updates and authorized UPDATE/SYNC_PUSH
snapshots or deltas, including Iroh's use of the same protocol. There is no
separate network fetch by schema hash. A receiver validates the reachable Class
and Property definitions before admitting the data; native storage installs both
in one transaction. A rejected resource does not install its definitions.

The resolver only follows schema links, never arbitrary strings or URLs. It
accepts at most 512 definitions, 1 MiB of UTF-8 keys plus bodies, 256 KiB per body,
and 16 dependency edges of depth. The entry limit accommodates two complete
128-field versions during a migration. It verifies every attachment, including unused
ones, but installs only definitions reachable from the resource's current
properties and classes. Unsupported metadata and executable migration hooks are
rejected. A hash proves content identity, not publisher trust or permission:
existing resource/drive authorization still applies. Direct cache reads do not
gain public read grants.

Definitions are initially repeated per resource. Later deltas omit unchanged
entries. The shared cache deduplicates definitions, but this is not a global
wire-level dependency inventory. Limits cover the visible schema payload after
Loro import; existing transport/frame limits still matter, and these checks do
not bound every aspect of CRDT history or decompression. This is not a complete
DoS audit of Loro or the transport.

### Automatic retrieval and repeated edits

`Resource::save` and low-level `CommitBuilder` signing, including genesis,
attach the reachable definitions from the local registry before signing. A cold
recipient therefore obtains schemas from its authorized resource transfer;
there is no separate URL lookup or executable schema loader.

Native and browser resolvers memoize verified inline bodies, capped at 256
entries and 4 MiB of encoded keys/bodies. A hit requires the exact ID and body.
Parsing, hash verification and shape-definition checks are skipped on hits;
resource values are still validated on every import. Canonical serialization
is still used when checking the aggregate dependency byte budget. Native parsing occurs
outside the cache lock. Parsed object memory adds overhead beyond the encoded
byte cap. An absent attachment cannot be resolved from this process-wide memo
cache: only the current request and the recipient's admitted store participate
in resolution. This prevents one drive from learning another drive's schemas
through memoization. Invalid bodies cannot replace a verified entry.

Keep Classes small and reuse Property IDs across related entity kinds. A note
Class should not recommend an entire instrument graph: its dependency closure
would otherwise carry those unused definitions on every new note.

## Schema migrations

A schema update creates new immutable definitions. Merely receiving them never
changes a resource's `isA`, rewrites its fields, or executes code. Versions can
coexist on disk and in the same resource. Keep schema delivery separate from an
app's decision to migrate data.

An app migration should:

1. Pin source and target Class/Property IDs, a migration identifier, and the
   input resource version. A mutable catalog's latest pointer is not enough.
2. Preview the exact transformed values, unmapped fields and any loss. Run
   trusted app code locally; do not execute transforms supplied by a peer.
3. Recheck write rights and the input version before applying. If it changed,
   recompute or ask for conflict resolution. Apply each resource conversion as
   one normal signed commit, with an idempotency marker and provenance.
4. Retain original fields during the compatibility window. Add new properties
   under new IDs and explicitly switch the class when the target requirements
   are satisfied. Avoid deleting an old nested container while older clients
   can still edit it.
5. Track progress per resource and retry idempotently. A drive migration is not
   an atomic multi-resource transaction. Interrupted runs must remain resumable.

For example, converting pitch from semitones to cents writes a new Property.
If a v1 client changes 7 semitones to 9 while the conversion writes 700 cents,
Loro retains **9 semitones and 700 cents**. This preserves the older edit, but
requires an explicit decision to refresh or supersede the converted value.
CRDT convergence does not establish a semantic relationship between the fields.

The SDK tests cover that race and importing historical states afterwards. They
do not implement a migration runner, version preconditions, provenance records,
a UI preview, or a guarantee against a write arriving after the app's version
check. Those need an application policy (and server-side conditional writes or a
coordinated cutover for strict exclusion). Reverting a migration is another
permitted commit or a copy from history; automatic reverse conversion may lose
data and is not assumed safe.
