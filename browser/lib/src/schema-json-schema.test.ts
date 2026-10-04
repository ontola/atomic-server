import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import {
  shapeFromJsonSchema,
  shapeToJsonSchema,
  appSchemaFromJsonSchema,
  exportJsonSchema,
  importJsonSchema,
  defineAppSchema,
  rebindAppField,
  validateAppValue,
  type SchemaValue,
  type AppSchemaBundle,
} from './app-schema.js';

const fixtures = process.env.ATOMIC_SCHEMA_FIXTURE
  ? new URL('./', new URL(`file://${process.env.ATOMIC_SCHEMA_FIXTURE}`))
  : new URL('../../../lib/tests/fixtures/', import.meta.url);
const read = (name: string) =>
  JSON.parse(readFileSync(new URL(name, fixtures), 'utf8'));
const corpus = read('json-schema-interop.json') as {
  accepted: {
    schema: SchemaValue;
    valid: SchemaValue[];
    invalid: SchemaValue[];
  }[];
  rejected: { schema: SchemaValue; error: string }[];
};
const ajv = new Ajv2020({ strict: false, ownProperties: true });
addFormats(ajv);
ajv.addKeyword({
  keyword: 'x-atomic-link',
  schemaType: 'boolean',
  valid: true,
});

describe('JSON Schema 2020-12 interchange', () => {
  it('matches a standard validator before and after conversion', () => {
    for (const entry of corpus.accepted) {
      const shape = shapeFromJsonSchema(entry.schema);
      const exported = shapeToJsonSchema(shape);
      // Ajv intentionally ignores __proto__ schema properties. Keep Atomic's
      // regression in this corpus, but do not claim Ajv parity for that case.
      const hasPrototypeKey = JSON.stringify(entry.schema).includes(
        '__proto__',
      );
      const validators = hasPrototypeKey
        ? []
        : [ajv.compile(entry.schema as object), ajv.compile(exported)];

      for (const value of entry.valid) {
        expect(
          () => validateAppValue(shape, value),
          JSON.stringify(entry),
        ).not.toThrow();
        for (const validate of validators)
          expect(validate(value), JSON.stringify(validate.errors)).toBe(true);
      }

      for (const value of entry.invalid) {
        expect(
          () => validateAppValue(shape, value),
          JSON.stringify(entry),
        ).toThrow();
        for (const validate of validators)
          expect(validate(value), JSON.stringify(entry)).toBe(false);
      }
    }
  });
  it('rejects unsupported constraints and remote/recursive references explicitly', () => {
    for (const entry of corpus.rejected)
      expect(() => shapeFromJsonSchema(entry.schema)).toThrow(entry.error);
    expect(() => appSchemaFromJsonSchema('open', { type: 'object' })).toThrow(
      'explicit false',
    );
  });
  it('preserves frozen identities and local aliases through a separate sidecar', () => {
    const bundle = read('generated/bundle.json') as AppSchemaBundle;
    expect(exportJsonSchema(bundle)).toEqual(
      read('generated/schema-document.json'),
    );
    expect(importJsonSchema(read('generated/schema-document.json'))).toEqual(
      bundle,
    );
    const local = rebindAppField(bundle, 'name', 'displayName');
    const document = exportJsonSchema(local);
    document.schema.title = 'Presentation only';
    (document.schema.required as string[]).reverse();
    expect(importJsonSchema(document)).toEqual(local);
    const props = document.schema.properties as Record<
      string,
      Record<string, SchemaValue>
    >;
    props.displayName.maxLength = 1;
    expect(() => importJsonSchema(document)).toThrow('do not match');
    const forged = exportJsonSchema(local);
    forged.atomic.definitions[local.fields.displayName]['http://invalid'] =
      true;
    expect(() => importJsonSchema(forged)).toThrow();
  });
  it('exports required aliases in the same UTF-8 order as Rust', () => {
    const bundle = defineAppSchema('unicode', {
      '\u{10000}': { shape: { type: 'boolean' }, required: true },
      '\uE000': { shape: { type: 'boolean' }, required: true },
    });
    expect(exportJsonSchema(bundle).schema.required).toEqual([
      '\uE000',
      '\u{10000}',
    ]);
  });
  it('keeps nullable and overlapping union semantics and bounds integer exports', () => {
    const schema = defineAppSchema('nullable', {
      value: {
        shape: { type: 'nullable', inner: { type: 'string' } },
        required: true,
      },
      integer: { shape: { type: 'integer' } },
    });
    const doc = exportJsonSchema(schema);
    const validate = ajv.compile(doc.schema);
    expect(validate({ value: null })).toBe(true);
    expect(validate({})).toBe(false);
    expect(
      validate({ value: 'ok', integer: Number.MAX_SAFE_INTEGER + 1 }),
    ).toBe(false);
    expect(importJsonSchema(doc)).toEqual(schema);
  });
  it('does not mistake schema references for links to data', () => {
    const schema = {
      type: 'string',
      format: 'uri',
      pattern: '^(atomic:(?!//)|did:ad:|https?://)',
      'x-atomic-link': true,
    };
    const shape = shapeFromJsonSchema(schema);
    expect(shape.type).toBe('reference');
    const validate = ajv.compile(shapeToJsonSchema(shape));
    expect(validate('atomic:example')).toBe(true);
    expect(validate('ftp://example.com')).toBe(false);
    expect(
      shapeFromJsonSchema({
        $defs: { x: { type: 'string' } },
        $ref: '#/$defs/x',
      }).type,
    ).toBe('string');
  });
  it('bounds repeated-reference expansion and document size', () => {
    const defs: Record<string, SchemaValue> = { d0: { type: 'boolean' } };
    for (let i = 1; i < 13; i++)
      defs[`d${i}`] = {
        type: 'object',
        properties: {
          a: { $ref: `#/$defs/d${i - 1}` },
          b: { $ref: `#/$defs/d${i - 1}` },
        },
      };
    expect(() =>
      shapeFromJsonSchema({ $defs: defs, $ref: '#/$defs/d12' }),
    ).toThrow('budget');
    expect(() =>
      shapeFromJsonSchema({
        type: 'string',
        title: 'x'.repeat(1024 * 1024 + 1),
      }),
    ).toThrow('1 MiB');
  });
});
