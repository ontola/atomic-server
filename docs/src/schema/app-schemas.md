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
reference-based recursive schemas, a schema catalog, a global dependency inventory
and a complete Dart client remain follow-up work. Bounded JSON Schema interchange
and generated Dart models are available below. Flutter calls the Rust store APIs
through its native bridge; Audio's migration UI lives in the separate Audio
repository.


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

## Reuse properties and keep display names local

`defineAppProperty(scope, semanticName, shape)` / `PropertyBinding::define`
creates an immutable vocabulary term. `composeAppSchema` / `AppSchema::compose`
binds existing terms to a Class. Reusing a binding reuses its Property ID:

```typescript
const pitch = defineAppProperty('music', 'pitch', {
  type: 'integer', minimum: 0, maximum: 127,
}, true);
const note = composeAppSchema('note', 'Musical note', { pitch });
const pad = composeAppSchema('pad', 'Drum pad', { triggerKey: pitch });
const localNote = rebindAppField(note, 'pitch', 'midiKey');
// Same Property in both classes; localNote retains note's Class ID too.
```

Rust equivalents are `schema.binding("pitch")`, `AppSchema::compose(...)` and
`schema.rebind("pitch", "midiKey")`. Membership ordering uses immutable semantic
shortnames and IDs, so changing aliases cannot reorder the hashed Class body.
Store translated labels and UI grouping in the application, keyed by Property
ID. Changing a semantic definition still produces a different identifier.
Duplicate aliases to the same Property in a Class are rejected.

## Typed models and richer shapes

Shapes now include `{type:'enum', values:['mono','poly']}`,
`{type:'nullable', inner:{type:'string'}}`, and
`{type:'union', variants:[{type:'number'}, objectShape]}`. A union accepts any
matching alternative. Optional means absent; nullable means present with null.
Enums allow 1–128 unique strings, unions 2–8 alternatives. The schema has a
2,048-node/16-depth budget; value validation shares 100,000 checks across all
union alternatives. Upgraded peers are required to validate these new kinds;
old bundles retain their previous hashes.

TypeScript `defineAppSchema` and reused Property bindings infer literal enums,
required/optional fields and nested objects. `AppModel<typeof schema>`,
`readAppModel(resource, schema)` and `setAppField` use those types. A bundle
loaded as plain JSON needs runtime validation and has no compile-time literals.

Rust provides `encode_field`, `read_field<T>`, `decode_model<T>` and
`replace_model`. Complete model replacement validates everything first, stages
an independent resource, removes omitted optional fields, and retains unsaved
changes outside the model. Rust serde decoding alone does not enforce numeric
ranges; use these schema helpers at application boundaries.

`AppSchema::generate_models("InstrumentModel")` generates Rust serde structs
and Dart models from a portable bundle. A command-line example is included:

```sh
cargo run -p atomic_lib --example schema_codegen -- bundle.json InstrumentModel generated
```

Generated accessors use Rust `snake_case` and Dart `lowerCamelCase`. Rust
keywords use raw identifiers (`r#type`); Dart reserved/member names get a
`Value` suffix. Collisions fail generation with a request to rebind an alias.
JSON keys and frozen identities remain unchanged.
Codegen accepts ASCII identifier aliases; use `rebind` for other local names.
Model names start uppercase and end in `Model`. Each generated file has its own
type namespace. Rust `Optional<Option<T>>` distinguishes missing from null;
Dart exposes `hasAlias`, typed getters, checked `fromJson` and copied `toJson`.
Union wrappers expose typed `asVariantN` getters. Dart output needs only
`dart:convert`; format it with `dart format` after generation. Generation is a
trusted build step, never something triggered by a schema arriving over sync.

## Choose the edit operation deliberately

| Intent | Rust | TypeScript |
| --- | --- | --- |
| Replace a field/object | `set` | `setAppField` |
| Edit/remove an object member | `patch` | `patchAppField` |
| Replace an entire list with a movable list | `replace_list` | `replaceAppList` |
| Insert/delete/set/move a list item | `edit_list(ListEdit::...)` | `editAppList` |

A move preserves item identity: a concurrent edit to the moved item follows it.
Destination indices refer to the resulting list. List items are whole JSON
values; use a separate resource for nested independently editable entities.
Legacy ordinary lists reject movable-list edits. Explicit replacement converts
them, but concurrent edits in the old container do not transfer to the new one.
Do that as a deliberate conversion, not silently during a user's move gesture.
All candidate edits are shape-checked before changing the resource.

## Trusted copy migrations

`schema::migration::CopyPlan::prepare` accepts authoritative, permission-checked
source snapshots and locally transformed `CopyItem`s. It validates all outputs
and hashes source versions/values, target Class and Property bindings, the
application's migration version, and output values. `preview()` performs no
writes. Rebuild the plan from current source membership when applying, then
supply the preview revision to `apply`.

A `CopyTarget` adapter provides `begin`, idempotent durable `write`, and `finish`.
`CopyProgress` reports the destination, completed item keys and completion flag.
The adapter owns access checks, local serialization and persistence; it finds
pending copies by source and revision and only exposes a completed destination.
The runner skips durably completed items on retry and rejects stale previews
before calling the adapter. Atomic Audio now uses this runner with its existing
session metadata. Its original sessions remain available.

There is no global transaction across resources or automatic mirroring after
cutover. Remote edits arriving after the captured versions remain on the source.
Neither definitions nor sync messages can execute a migration. The generic
runner is currently native Rust; TypeScript applications need their own trusted
persistence adapter/runner until a browser equivalent is provided.


## JSON Schema interchange

Use JSON Schema 2020-12 at the application boundary with the [supported
profile](./json-schema.md). Rust and TypeScript import/export the same bounded
subset. Standard JSON Schema describes the data; a separate verified Atomic
bundle preserves Class/Property identities and local aliases. JSON Schema
`$ref` resolves a local schema definition, whereas an Atomic reference shape
represents a link **in the data**.


## Compatibility when upgrading existing applications

This draft also changes shared value encoding, including resources without app
schemas. New writers preserve nested JSON `null` entries and tag strings that
look like JSON or resource identifiers as `string`. Old readers may still parse
those strings as objects, arrays or links; code that distinguishes an absent key
from a key containing `null` also observes a change. These are semantic changes,
not a guarantee of mixed-version equivalence. Upgrade readers and writers together
and test stored representative data before rollout. Explicit schema migrations
change app data; they do not upgrade a remote peer's decoder or enforcement.

Rust `Resource::set_string` now validates through `set`, including `allowsOnly`
and app shapes. Callers must handle rejected values that were previously accepted.
Frozen definitions remain immutable: publish a new definition and migrate data
instead of attempting to edit a frozen subject.

The existing plugin-schema API still creates mutable ontology resources. This
draft does not convert existing plugin schemas or expose the app SDK's nested
and list edit operations through plugin RPC. Choosing a common plugin contract
and adding those RPC operations require a separate coordinated change.
