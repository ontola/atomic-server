# JSON Schema interoperability

Atomic supports a bounded JSON Schema 2020-12 profile. Existing typed builders
remain available. This is not a complete JSON Schema validator: unsupported
constraints fail with a path-specific error instead of being ignored.

```ts
import { appSchemaFromJsonSchema, exportJsonSchema, importJsonSchema } from '@tomic/lib';

const instrument = appSchemaFromJsonSchema('my-app/instrument/v1', {
  type: 'object',
  properties: {
    name: { type: 'string', maxLength: 100 },
    midiKey: { type: 'integer', minimum: 0, maximum: 127 },
    mode: { type: 'string', enum: ['mono', 'poly'] },
  },
  required: ['name'],
  additionalProperties: false,
});
const document = exportJsonSchema(instrument);
// Give document.schema to a standard validator or compatible form tool.
// Keep document.atomic alongside it when transferring Atomic identity.
const sameInstrument = importJsonSchema(document);
```

Rust provides `AppSchema::from_json_schema(name, &json)`, `to_json_schema()`,
`export_json_schema()` and `JsonSchemaDocument::import()`. Shape-only conversion
uses `Shape::from_json_schema`/`to_json_schema` (TypeScript:
`shapeFromJsonSchema`/`shapeToJsonSchema`). These are trusted application or
build-time operations; receiving a schema over sync does not run codegen.

## Supported constraints

| JSON Schema | Atomic behavior |
| --- | --- |
| `type` string, boolean, null, number | Same JSON value kind; finite numbers only |
| `type: integer` | Requires explicit minimum/maximum within ±9,007,199,254,740,991 |
| `minimum`, `maximum` | Inclusive numeric bounds |
| `maxLength` | Unicode code point count |
| String `enum` / `const` | 1–128 enum values / one enum value |
| `properties`, `required` | Nested typed objects; required names must be declared |
| `additionalProperties` | Boolean only; defaults to true as in JSON Schema |
| `items`, `maxItems` | Homogeneous arrays; explicit maximum 0–16,384 required |
| `anyOf` | 2–8 alternatives; overlapping alternatives are allowed |
| `type: [T, "null"]` | Nullable value; cannot be combined with enum/const |
| Root `$defs`, local `$ref` | Acyclic `#/$defs/name` references, including `~0`/`~1` escapes |

App schemas require a closed root object (`additionalProperties: false`);
open nested objects are supported. Missing and null are distinct. Defaults are
annotations, never inserted into data. `title`, `description`, `$comment`,
`examples` and `default` do not change Atomic identity and are not retained by
shape conversion. Root `$id` may be an absolute URI, but is not an Atomic ID
and is never fetched. Omit `$schema` or specify the 2020-12 dialect exactly.

Remote/recursive references, reference assertion siblings, nested `$id`,
`oneOf`, conditionals, arbitrary regex, arbitrary formats, tuple schemas and
schema-valued additional properties are rejected. Unbounded JSON Schema
integers/arrays are rejected rather than silently receiving tighter constraints.
Existing Atomic integers export their safe-range bounds explicitly.

## Links, tooling and identity

An Atomic data link exports as a URI string with `format: uri`, an Atomic URI
scheme pattern, and `x-atomic-link: true`. Configure external tooling to allow
that annotation and assert URI format. Atomic also performs its own URI
validation; external validators can differ on malformed URI edge cases.
A JSON Schema `$ref` never means a link to an Atomic resource.

A plain schema import creates definitions under the supplied semantic name.
It cannot recover the identities of separately reused Properties. To preserve
identity, transfer `{ schema, atomic }` from `exportJsonSchema`: import verifies
all frozen bodies, bindings and normalized constraints before returning the
original bundle. Presentation changes and ordering of required/enum/anyOf
members are tolerated. Changed constraints fail: define a new version and use
an explicit migration. This comparison is conservative, not a general proof of
logical equivalence between arbitrary schemas.

Rust and TypeScript share import/rejection fixtures and exact exported identity
fixtures. Supported value cases are checked with Ajv 2020. One known tooling
exception: Ajv ignores a property named `__proto__`; Atomic retains and validates
it as an ordinary own property. Avoid that name when targeting Ajv-based tools.

## Resource limits

Interchange documents are limited to 1 MiB, depth 64 and 32,768 raw nodes.
Expanded shapes share a 2,048-node/depth-16 budget, including unused definitions.
Repeated references spend that budget; cycles fail. No network access,
executable validators or peer-supplied migrations are allowed. These limits are
additional to the existing frozen-schema sync attachment limits.

## Generate models

```sh
# Import plain JSON Schema; the last argument sets the semantic scope.
cargo run -p atomic_lib --example schema_codegen -- instrument.json InstrumentModel generated my-app/instrument/v1
# Reuse exact identity from an exported schema-document.json.
cargo run -p atomic_lib --example schema_codegen -- schema-document.json InstrumentModel generated
```

The example accepts existing Atomic bundles too. It writes Rust/Dart models,
`bundle.json`, standard `schema.json` and `schema-document.json`. Accessors use
Rust snake_case and Dart lowerCamelCase, preserving original JSON names. Keyword
escapes/suffixes are deterministic and name collisions fail generation.
