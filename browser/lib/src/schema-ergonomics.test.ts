import { describe, it, expect, expectTypeOf } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  defineAppSchema,
  defineAppProperty,
  composeAppSchema,
  rebindAppField,
  bindAppProperty,
  registerAppSchema,
  setAppField,
  readAppModel,
  replaceAppList,
  editAppList,
  validateAppValue,
  type AppModel,
  type InferShape,
  type AppField,
} from './app-schema.js';
import { Store } from './store.js';
import { Resource } from './resource.js';

const bundle = defineAppSchema('typed', {
  mode: { shape: { type: 'enum', values: ['mono', 'poly'] }, required: true },
  comment: { shape: { type: 'nullable', inner: { type: 'string' } } },
  object: {
    shape: {
      type: 'object',
      properties: { x: { type: 'number' }, y: { type: 'boolean' } },
      required: ['x'],
    },
  },
});
// These are checked by tsc, not just runtime assertions.
type Model = AppModel<typeof bundle>;
const valid: Model = { mode: 'mono', object: { x: 1 } };
// @ts-expect-error enum values are checked
const wrongMode: Model = { mode: 'bad' };
// @ts-expect-error required top-level field
const missingMode: Model = {};
// @ts-expect-error nested x is required
const wrongNested: Model = { mode: 'mono', object: { y: true } };
void [valid, wrongMode, missingMode, wrongNested];
type OptionalObject = InferShape<{
  type: 'object';
  properties: { x: { type: 'number' } };
}>;
const optionalObject: OptionalObject = {};
void optionalObject;

function compileCheckedSet(r: Resource) {
  // @ts-expect-error incorrect enum
  void setAppField(r, bundle, 'mode', 'bad');
  // @ts-expect-error incorrect field
  void setAppField(r, bundle, 'missing', 1);
}

void compileCheckedSet;

describe('schema ergonomics', () => {
  it('retains enum and reused property inference', () => {
    const property = defineAppProperty(
      'music',
      'mode',
      { type: 'enum', values: ['mono', 'poly'] },
      true,
    );
    const reused = composeAppSchema('instrument', 'Instrument', {
      voiceMode: property,
    });
    expectTypeOf<AppModel<typeof reused>>().toEqualTypeOf<
      { voiceMode: 'mono' | 'poly' } & {}
    >();
    expectTypeOf<typeof bindAppProperty<typeof bundle, 'mode'>>();
    const extracted = composeAppSchema('other', 'Other', {
      mode: bindAppProperty(bundle, 'mode'),
    });
    const model: AppModel<typeof extracted> = { mode: 'poly' };
    void model;
    // @ts-expect-error extracted bindings retain their enum
    const invalid: AppModel<typeof extracted> = { mode: 'bad' };
    void invalid;
    const alias = rebindAppField(reused, 'voiceMode', 'mode');
    expect(alias.class_id).toBe(reused.class_id);
    expect(alias.definitions).toEqual(reused.definitions);
    registerAppSchema(new Store(), alias);
  });
  it('rejects mismatched binding metadata and handles hostile aliases', () => {
    const property = defineAppProperty('music', 'value', { type: 'number' });
    expect(() =>
      composeAppSchema('x', 'X', {
        value: { ...property, shape: { type: 'string' } },
      }),
    ).toThrow();
    const unusual = composeAppSchema('x', 'X', { ['__proto__']: property });
    expect(Object.hasOwn(unusual.fields, '__proto__')).toBe(true);
    registerAppSchema(new Store(), unusual);
  });
  it('reads typed models and validates extended shape bounds', async () => {
    const store = new Store();
    registerAppSchema(store, bundle);
    const r = new Resource('atomic:typed');
    r.setStore(store);
    await setAppField(r, bundle, 'mode', 'mono');
    await setAppField(r, bundle, 'comment', null);
    expect(readAppModel(r, bundle)).toEqual({ mode: 'mono', comment: null });
    expect(() =>
      validateAppValue(
        { type: 'union', variants: [{ type: 'number' }, { type: 'boolean' }] },
        'x',
      ),
    ).toThrow();
    expect(() =>
      validateAppValue({ type: 'enum', values: ['x', 'x'] }, 'x'),
    ).toThrow();
  });
  it('merges a move with a concurrent edit to that same item', async () => {
    const schema = defineAppSchema('steps', {
      steps: {
        shape: {
          type: 'array',
          items: { type: 'integer', minimum: 0, maximum: 127 },
          maxItems: 4,
        },
      },
    });
    const store = new Store();
    registerAppSchema(store, schema);
    const base = new Resource('atomic:steps');
    base.setStore(store);
    await replaceAppList(base, schema, 'steps', [60, 64, 67]);
    const snapshot = base.getLoroDoc()!.export({ mode: 'snapshot' });
    const a = new Resource('atomic:steps'),
      b = new Resource('atomic:steps');

    for (const r of [a, b]) {
      r.setStore(store);
      r.importLoroUpdate(snapshot);
    }

    a.getLoroDoc()!.setPeerId('101');
    b.getLoroDoc()!.setPeerId('102');
    await editAppList(a, schema, 'steps', { type: 'move', from: 0, to: 2 });
    await editAppList(b, schema, 'steps', { type: 'set', index: 0, value: 61 });
    a.importLoroUpdate(b.getLoroDoc()!.export({ mode: 'snapshot' }));
    expect(a.get(schema.fields.steps)).toEqual([64, 67, 61]);
    await expect(
      editAppList(a, schema, 'steps', { type: 'set', index: 0, value: 200 }),
    ).rejects.toThrow();
    expect(a.get(schema.fields.steps)).toEqual([64, 67, 61]);
  });
  it('matches native enum, union and nullable definition hashes', () => {
    const fixtureDir = process.env.ATOMIC_SCHEMA_FIXTURE
      ? new URL('./', new URL(`file://${process.env.ATOMIC_SCHEMA_FIXTURE}`))
      : new URL('../../../lib/tests/fixtures/', import.meta.url);
    const fixture = JSON.parse(
      readFileSync(new URL('model-schema.json', fixtureDir), 'utf8'),
    ) as { input: { name: string; fields: Record<string, AppField> } };
    const expected = JSON.parse(
      readFileSync(new URL('generated/bundle.json', fixtureDir), 'utf8'),
    );
    expect(defineAppSchema(fixture.input.name, fixture.input.fields)).toEqual(
      expected,
    );
  });
});

it('keeps Class identity when local aliases change ordering', () => {
  const a = defineAppProperty('shared', 'a', { type: 'boolean' });
  const b = defineAppProperty('shared', 'b', { type: 'boolean' });
  expect(composeAppSchema('pair', 'Pair', { a, b }).class_id).toBe(
    composeAppSchema('pair', 'Pair', { z: a, a: b }).class_id,
  );
});
it('bounds failed union alternatives with one shared budget', () => {
  const variant = {
    type: 'array',
    items: { type: 'boolean' },
    maxItems: 16384,
  } as const;
  const value = Array.from({ length: 16384 }, () => true) as (
    | boolean
    | string
  )[];
  value[16383] = 'invalid';
  expect(() =>
    validateAppValue(
      { type: 'union', variants: Array.from({ length: 8 }, () => variant) },
      value,
    ),
  ).toThrow('100000');
});
