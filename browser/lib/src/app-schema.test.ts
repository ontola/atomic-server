import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import {
  defineAppSchema,
  registerAppSchema,
  setAppField,
  patchAppField,
  frozenSchemaId,
  canonicalSchemaJson,
  validateAppValue,
  type AppField,
  type AppSchemaBundle,
  type SchemaValue,
} from './app-schema.js';
import { Resource } from './resource.js';
import { Store } from './store.js';
import { testStore } from './test-store.js';
import { core } from './ontologies/core.js';

const fixturePath =
  process.env.ATOMIC_SCHEMA_FIXTURE ??
  new URL('../../../lib/tests/fixtures/app-schema.json', import.meta.url);
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as {
  input: { name: string; fields: Record<string, AppField> };
  bundle: AppSchemaBundle;
  rust_base: string;
  rust_edit: string;
  typescript_edit?: string;
};
const schema = () => defineAppSchema(fixture.input.name, fixture.input.fields);

function setup(bundle = schema()) {
  const store = new Store();
  registerAppSchema(store, bundle);
  const resource = new Resource('atomic:example');
  resource.setStore(store);

  return { store, resource, bundle };
}

describe('app-defined schemas', () => {
  it('shares every property and class hash with Rust, including normalized shapes', () => {
    expect(schema()).toEqual(fixture.bundle);
    const { store } = setup();
    registerAppSchema(store, fixture.bundle);
    expect(
      store.resources.get(fixture.bundle.class_id)?.getLoroDoc(),
    ).toBeUndefined();
  });

  it('validates nested edits before changing state', async () => {
    const { resource, bundle } = setup();
    await setAppField(resource, bundle, 'envelope', {
      attack: 0.01,
      release: 0.2,
    });
    expect(resource.get(bundle.fields.envelope)).toEqual({
      attack: 0.01,
      release: 0.2,
    });
    await expect(
      patchAppField(resource, bundle, 'envelope', ['attack'], 5),
    ).rejects.toThrow('$/attack');
    await expect(
      patchAppField(resource, bundle, 'envelope', ['attack'], undefined),
    ).rejects.toThrow('required');
    await patchAppField(resource, bundle, 'envelope', ['attack'], 0.05);
    expect(resource.get(bundle.fields.envelope)).toEqual({
      attack: 0.05,
      release: 0.2,
    });
    await expect(setAppField(resource, bundle, 'tune', 49)).rejects.toThrow();
  });

  it('merges a native Rust attack edit with a browser release edit on a cold store', async () => {
    const bundle = schema();
    const store = new Store();
    const resource = new Resource('atomic:example');
    resource.setStore(store);
    resource.importLoroUpdate(
      new Uint8Array(Buffer.from(fixture.rust_base, 'base64')),
    );
    expect(store.resources.has(bundle.class_id)).toBe(true);
    resource.getLoroDoc()!.setPeerId('123456');
    await patchAppField(resource, bundle, 'envelope', ['release'], 0.9);
    const snapshot = Buffer.from(
      resource.getLoroDoc()!.export({ mode: 'snapshot' }),
    ).toString('base64');

    // Explicit fixture regeneration only; ordinary tests never write artifacts.
    if (process.env.UPDATE_APP_SCHEMA_FIXTURE === '1') {
      writeFileSync(
        fixturePath,
        JSON.stringify({ ...fixture, typescript_edit: snapshot }, null, 2) +
          '\n',
      );
    }

    resource.importLoroUpdate(
      new Uint8Array(Buffer.from(fixture.rust_edit, 'base64')),
    );
    expect(resource.get(bundle.fields.envelope)).toEqual({
      attack: 0.05,
      release: 0.9,
    });
    expect(resource.get(bundle.fields.tune)).toBe(7);
  });

  it('does not allow frozen definitions to change or accept a forged bundle', async () => {
    const { store, bundle } = setup();
    const definition = store.resources.get(bundle.class_id)!;
    await expect(
      definition.set(core.properties.description, 'changed', false),
    ).rejects.toThrow('immutable');
    expect(() => definition.remove(core.properties.description)).toThrow(
      'immutable',
    );
    await expect(definition.save()).rejects.toThrow('immutable');
    const forged = structuredClone(bundle);
    forged.definitions[bundle.class_id][core.properties.description] =
      'tampered';
    const empty = new Store();
    expect(() => registerAppSchema(empty, forged)).toThrow();
    expect(empty.resources.has(bundle.class_id)).toBe(false);
  });

  it('retains JSON null inside maps and lists and distinguishes deletion', async () => {
    const bundle = defineAppSchema('nulls', {
      data: {
        shape: {
          type: 'object',
          properties: {
            optional: { type: 'null' },
            list: { type: 'array', items: { type: 'null' }, maxItems: 3 },
          },
        },
      },
    });
    const { resource } = setup(bundle);
    await setAppField(resource, bundle, 'data', {
      optional: null,
      list: [null, null],
    });
    expect(resource.get(bundle.fields.data)).toEqual({
      optional: null,
      list: [null, null],
    });
    await patchAppField(resource, bundle, 'data', ['optional'], undefined);
    expect(resource.get(bundle.fields.data)).toEqual({ list: [null, null] });
    await patchAppField(resource, bundle, 'data', ['optional'], null);
    expect(resource.get(bundle.fields.data)).toEqual({
      optional: null,
      list: [null, null],
    });
  });

  it('creates and signs an ordinary Atomic resource using the registered class', async () => {
    const { store, posted } = await testStore();
    const bundle = schema();
    registerAppSchema(store, bundle);
    const resource = await store.newResource({
      isA: bundle.class_id,
      noParent: true,
      propVals: {
        [bundle.fields.tune]: 0,
        [bundle.fields.envelope]: { attack: 0.01, release: 0.2 },
      },
    });
    await patchAppField(resource, bundle, 'envelope', ['attack'], 0.05);
    await resource.save();
    expect(posted.length).toBeGreaterThan(0);
    expect(posted.at(-1)?.loroUpdate).toBeTruthy();
    expect(resource.get(bundle.fields.envelope)).toEqual({
      attack: 0.05,
      release: 0.2,
    });
  });

  it('retains a top-level JSON null with its datatype across snapshots', async () => {
    const bundle = defineAppSchema('nullable', {
      value: { shape: { type: 'null' } },
    });
    const { resource } = setup(bundle);
    await setAppField(resource, bundle, 'value', null);
    const { resource: reloaded } = setup(bundle);
    reloaded.importLoroUpdate(
      resource.getLoroDoc()!.export({ mode: 'snapshot' }),
    );
    expect(reloaded.get(bundle.fields.value)).toBeNull();
  });

  it('rejects unsupported constraints and noncanonical values', () => {
    expect(() =>
      defineAppSchema('bad', {
        x: {
          shape: {
            type: 'string',
            pattern: '.*',
          } as unknown as AppField['shape'],
        },
      }),
    ).toThrow('Unsupported');
    expect(() => frozenSchemaId({ x: Infinity })).toThrow();
    expect(() => frozenSchemaId({ x: '\ud800' })).toThrow();
    expect(() => frozenSchemaId({ '@id': 'atomic:wrong' })).toThrow();
    expect(() =>
      frozenSchemaId({ x: undefined } as unknown as SchemaValue),
    ).toThrow();
    expect(canonicalSchemaJson({ '\ufffd': 1, '\ud83d\ude00': -0 })).toBe(
      '{"😀":0,"�":1}',
    );
    expect(() =>
      validateAppValue({ type: 'reference' }, 'plain text'),
    ).toThrow();
    expect(() => validateAppValue({ type: 'integer' }, 1.5)).toThrow();
  });
});
