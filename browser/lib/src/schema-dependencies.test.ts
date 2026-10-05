import {
  validateIncomingSchema,
  clearSchemaAdmissionReplica,
} from './schema-admission.js';
import { LoroLoader } from './loro-loader.js';
import {
  resolveSchemaDependencies,
  validateSchemaData,
} from './schema-dependencies.js';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { Resource } from './resource.js';
import { Store } from './store.js';
import { core } from './ontologies/core.js';
import {
  defineAppSchema,
  registerAppSchema,
  setAppField,
  canonicalSchemaJson,
  frozenSchemaId,
} from './app-schema.js';
import {
  SCHEMA_ROOT,
  attachSchemaDependencies,
} from './schema-dependencies.js';

const v1 = defineAppSchema('tuning', {
  semitones: {
    required: true,
    shape: { type: 'number', minimum: -48, maximum: 48 },
  },
});

async function author() {
  const store = new Store();
  registerAppSchema(store, v1);
  const resource = new Resource('atomic:dependency-test');
  resource.setStore(store);
  await resource.set(core.properties.isA, [v1.class_id], false);
  await setAppField(resource, v1, 'semitones', 7);
  const doc = resource.getLoroDoc()!;
  attachSchemaDependencies(doc, id => store.resources.get(id));

  return { store, resource, doc };
}

function receiver() {
  const store = new Store();
  const resource = new Resource('atomic:dependency-test');
  resource.setStore(store);

  return { store, resource };
}

describe('schema dependencies in sync state', () => {
  it('does not resolve absent definitions from another receiver memo cache', async () => {
    const source = await author();
    const first = receiver();
    expect(
      first.resource.importLoroUpdate(source.doc.export({ mode: 'snapshot' }))
        .complete,
    ).toBe(true);
    // Warm verification cache, then make the next independent store receive
    // a resource without that schema. It must still fail closed.
    source.doc.getMap(SCHEMA_ROOT).delete(v1.class_id);
    const cold = receiver();
    const result = cold.resource.importLoroUpdate(
      source.doc.export({ mode: 'snapshot' }),
    );
    expect(result.complete).toBe(false);
    expect(result.schemaError).toContain('Missing frozen');
    expect(cold.store.resources.has(v1.class_id)).toBe(false);
    expect(first.resource.get(v1.fields.semitones)).toBe(7);
  });

  it('imports a cold snapshot and a delta without manual schema registration', async () => {
    const source = await author();
    const { store, resource } = receiver();
    expect(
      resource.importLoroUpdate(source.doc.export({ mode: 'snapshot' }))
        .complete,
    ).toBe(true);
    expect(store.resources.has(v1.class_id)).toBe(true);
    expect(resource.get(v1.fields.semitones)).toBe(7);
    const version = source.doc.version();
    await setAppField(source.resource, v1, 'semitones', 9);
    const delta = source.doc.export({ mode: 'update', from: version });
    expect(resource.importLoroUpdate(delta).complete).toBe(true);
    expect(resource.get(v1.fields.semitones)).toBe(9);
  });

  it.each([
    'tamper',
    'missing',
    'noncanonical',
    'wrong-type',
    'too-many',
    'too-big',
    'code',
    'invalid-data',
  ])('rejects %s before cache or document changes', async attack => {
    const { doc } = await author();
    const map = doc.getMap(SCHEMA_ROOT);

    switch (attack) {
      case 'tamper':
        map.set(v1.class_id, '{}');
        break;
      case 'missing':
        map.delete(v1.class_id);
        break;
      case 'noncanonical':
        map.set(
          v1.class_id,
          JSON.stringify(v1.definitions[v1.class_id], null, 2),
        );
        break;
      case 'wrong-type':
        map.set(v1.class_id, 1);
        break;
      case 'too-many':
        for (let n = 0; n < 513; n++) map.set(`key-${n}`, '{}');
        break;
      case 'too-big':
        map.set(v1.class_id, 'x'.repeat(256 * 1024 + 1));
        break;

      case 'code': {
        const body = {
          ...v1.definitions[v1.class_id],
          'urn:migration:execute': 'fetch("https://attacker.invalid/")',
        };
        map.set(frozenSchemaId(body), canonicalSchemaJson(body));
        break;
      }

      case 'invalid-data':
        doc.getMap('properties').set(v1.fields.semitones, 99);
        break;
    }

    const { store, resource } = receiver();
    await resource.set(core.properties.name, 'keep me', false);
    const before = resource.getLoroDoc()!.version().toJSON();
    const result = resource.importLoroUpdate(doc.export({ mode: 'snapshot' }));
    expect(result.complete).toBe(false);
    expect(result.schemaError).toBeTruthy();
    expect(resource.getLoroDoc()!.version().toJSON()).toEqual(before);
    expect(resource.get(core.properties.name)).toBe('keep me');
    expect(store.resources.has(v1.class_id)).toBe(false);
    expect(store.resources.has(v1.fields.semitones)).toBe(false);
  });

  it('preserves last good state when a later schema attachment is poisoned', async () => {
    const { doc } = await author();
    const { resource } = receiver();
    resource.importLoroUpdate(doc.export({ mode: 'snapshot' }));
    const version = doc.version();
    doc.getMap(SCHEMA_ROOT).set(v1.class_id, '{}');
    doc.getMap('properties').set(v1.fields.semitones, 10);
    expect(
      resource.importLoroUpdate(doc.export({ mode: 'update', from: version }))
        .complete,
    ).toBe(false);
    expect(resource.get(v1.fields.semitones)).toBe(7);
  });

  it('preserves an old-client edit racing an explicit migration and installs only reachable definitions', async () => {
    const source = await author();
    const old = receiver();
    old.resource.importLoroUpdate(source.doc.export({ mode: 'snapshot' }));
    await setAppField(old.resource, v1, 'semitones', 9);
    const v2 = defineAppSchema('tuning-cents', {
      cents: { required: true, shape: { type: 'integer' } },
    });
    registerAppSchema(source.store, v2);
    await setAppField(source.resource, v2, 'cents', 700);
    await source.resource.set(core.properties.isA, [v2.class_id], false);
    attachSchemaDependencies(source.doc, id => source.store.resources.get(id));
    source.resource.importLoroUpdate(
      old.resource.getLoroDoc()!.export({ mode: 'snapshot' }),
    );
    const cold = receiver();
    expect(
      cold.resource.importLoroUpdate(source.doc.export({ mode: 'snapshot' }))
        .complete,
    ).toBe(true);
    expect(cold.resource.get(v1.fields.semitones)).toBe(9);
    expect(cold.resource.get(v2.fields.cents)).toBe(700);
    expect(cold.store.resources.has(v1.class_id)).toBe(false);
    expect(cold.store.resources.has(v1.fields.semitones)).toBe(true);
    expect(cold.store.resources.has(v2.class_id)).toBe(true);
  });
});

it('bounds dependency traversal and total bytes before installing anything', async () => {
  for (const deep of [false, true]) {
    const { doc } = await author();
    const map = doc.getMap(SCHEMA_ROOT);
    let previous: string | undefined;

    for (let index = 0; index < (deep ? 19 : 5); index++) {
      const body = {
        [core.properties.isA]: [core.classes.class],
        [core.properties.shortname]: `class-${index}`,
        [core.properties.description]: deep ? '' : 'x'.repeat(220 * 1024),
        [core.properties.requires]: previous ? [previous] : [],
        [core.properties.recommends]: [],
      };
      const id = frozenSchemaId(body);
      map.set(id, canonicalSchemaJson(body));
      previous = id;
    }

    doc.getMap('properties').set(core.properties.isA, [previous!]);
    const { resource, store } = receiver();
    const result = resource.importLoroUpdate(doc.export({ mode: 'snapshot' }));
    expect(result.complete).toBe(false);
    expect(result.schemaError).toContain(
      deep ? 'traversal limit' : 'byte budget',
    );
    expect(store.resources.has(v1.class_id)).toBe(false);
  }
});

it.each([false, true])(
  'does not bypass required fields through a scalar or JSON string isA (%s)',
  async encoded => {
    const { doc } = await author();
    doc
      .getMap('properties')
      .set(
        core.properties.isA,
        encoded ? JSON.stringify([v1.class_id]) : v1.class_id,
      );
    doc.getMap('properties').delete(v1.fields.semitones);
    const { resource } = receiver();
    expect(
      resource.importLoroUpdate(doc.export({ mode: 'snapshot' })).schemaError,
    ).toContain('required');
  },
);

it('allows two complete 128-field versions during a migration', async () => {
  const fields = Object.fromEntries(
    Array.from({ length: 128 }, (_, i) => [
      `field${i}`,
      { shape: { type: 'string' as const } },
    ]),
  );
  const first = defineAppSchema('full-v1', fields);
  const second = defineAppSchema('full-v2', fields);
  const store = new Store();
  registerAppSchema(store, first);
  registerAppSchema(store, second);
  const resource = new Resource('atomic:dependency-test');
  resource.setStore(store);
  await resource.set(
    core.properties.isA,
    [first.class_id, second.class_id],
    false,
  );
  const doc = resource.getLoroDoc()!;
  attachSchemaDependencies(doc, id => store.resources.get(id));
  expect(doc.getMap(SCHEMA_ROOT).size).toBe(258);
  const cold = receiver();
  expect(
    cold.resource.importLoroUpdate(doc.export({ mode: 'snapshot' })).complete,
  ).toBe(true);
  expect(cold.store.resources.has(first.class_id)).toBe(true);
  expect(cold.store.resources.has(second.class_id)).toBe(true);
});

describe('isolated schema admission hot path', () => {
  afterEach(() => {
    clearSchemaAdmissionReplica();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('does not deep-read unrelated canvas bodies', () => {
    const doc = new LoroLoader.Loro.LoroDoc();
    doc
      .getMap('properties')
      .set('https://example.test/canvas', { points: [1, 2, 3] });
    const deep = vi
      .spyOn(Object.getPrototypeOf(doc.getMap('properties')), 'toJSON')
      .mockImplementation(() => {
        throw new Error('Unexpected full property materialization');
      });
    const definitions = resolveSchemaDependencies(doc, () => undefined);
    validateSchemaData(doc, definitions);
    expect(deep).not.toHaveBeenCalled();
  });

  it.each(['valid', 'poison', 'missing'])(
    'checks newly introduced schema dependencies on an ordinary resource: %s',
    async kind => {
      const source = new Resource('atomic:plain-to-frozen');
      const store = new Store();
      registerAppSchema(store, v1);
      const doc = source.getLoroDoc()!;
      doc.getMap('properties').set(core.properties.name, 'Before');
      const target = new Resource(source.subject);
      expect(
        target.importLoroUpdate(doc.export({ mode: 'snapshot' })).complete,
      ).toBe(true);
      const from = doc.version();
      doc.getMap('properties').set(core.properties.isA, [v1.class_id]);
      doc.getMap('properties').set(v1.fields.semitones, 7);
      doc.getMap('properties').set(core.properties.name, 'After');
      attachSchemaDependencies(doc, id => store.resources.get(id));
      if (kind === 'poison') doc.getMap(SCHEMA_ROOT).set(v1.class_id, '{}');
      if (kind === 'missing') doc.getMap(SCHEMA_ROOT).delete(v1.class_id);
      expect(
        target.importLoroUpdate(doc.export({ mode: 'update', from })).complete,
      ).toBe(kind === 'valid');
      expect(target.get(core.properties.name)).toBe(
        kind === 'valid' ? 'After' : 'Before',
      );
    },
  );

  it('reuses one replica, incorporates local edits and expires it', () => {
    vi.useFakeTimers();
    const base = new LoroLoader.Loro.LoroDoc();
    base.getMap('properties').set(core.properties.name, 'Before');
    base.commit();
    const remote = base.fork();
    const from = remote.version();
    remote.getMap('properties').set(core.properties.description, 'Remote');
    const delta = remote.export({ mode: 'update', from });
    const fork = vi.spyOn(base, 'fork');
    expect(validateIncomingSchema(base, delta, () => undefined).complete).toBe(
      true,
    );
    base.import(delta);
    base.getMap('properties').set(core.properties.name, 'Local');
    base.commit();
    expect(validateIncomingSchema(base, delta, () => undefined).complete).toBe(
      true,
    );
    expect(fork).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(5001);
    expect(validateIncomingSchema(base, delta, () => undefined).complete).toBe(
      true,
    );
    expect(fork).toHaveBeenCalledTimes(2);
  });

  it('discards a replica ahead of the live state after an unapplied import', async () => {
    const source = await author();
    const base = source.doc;
    const snapshot = base.export({ mode: 'snapshot' });
    const from = base.version();
    const abandoned = new LoroLoader.Loro.LoroDoc();
    abandoned.import(snapshot);
    abandoned.getMap('properties').delete(core.properties.isA);
    abandoned.getMap('properties').delete(v1.fields.semitones);
    expect(
      validateIncomingSchema(
        base,
        abandoned.export({ mode: 'update', from }),
        () => undefined,
      ).complete,
    ).toBe(true);
    // Simulate live persistence/import failure: the preceding candidate never
    // reaches base. A later removal must be checked against base's required class.
    const malicious = new LoroLoader.Loro.LoroDoc();
    malicious.import(snapshot);
    malicious.getMap('properties').delete(v1.fields.semitones);
    expect(() =>
      validateIncomingSchema(
        base,
        malicious.export({ mode: 'update', from }),
        () => undefined,
      ),
    ).toThrow('Missing required');
    expect(base.getMap('properties').get(v1.fields.semitones)).toBe(7);
  });

  it('rejects a local invalid edit when refreshing a cached replica', async () => {
    const source = await author();
    const base = source.doc;
    const bytes = base.export({ mode: 'snapshot' });
    expect(validateIncomingSchema(base, bytes, () => undefined).complete).toBe(
      true,
    );
    base.getMap('properties').set(v1.fields.semitones, 1000);
    base.commit();
    expect(() =>
      validateIncomingSchema(base, bytes, () => undefined),
    ).toThrow();
  });

  it('seals a local edit before speculative fork can commit it without a token', async () => {
    const target = new Resource('atomic:local-history');
    const remote = new LoroLoader.Loro.LoroDoc();
    remote.import(target.getLoroDoc()!.export({ mode: 'snapshot' }));
    await target.set(core.properties.name, 'Local', false);
    remote.getMap('properties').set(core.properties.description, 'Remote');
    expect(
      target.importLoroUpdate(remote.export({ mode: 'snapshot' })).complete,
    ).toBe(true);
    const changes = target.getLoroDoc()!.exportJsonUpdates().changes;
    expect(changes.some(change => change.msg?.startsWith('c-'))).toBe(true);
    expect(target.get(core.properties.name)).toBe('Local');
  });
});
