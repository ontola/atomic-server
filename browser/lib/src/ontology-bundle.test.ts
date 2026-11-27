import { describe, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { Store, core } from './index.js';
import { enableLoro } from './loro-loader.js';

// The fixture `atomic_lib` runs too (`lib/tests/ontology_bundle.rs`).
const bundle = JSON.parse(
  readFileSync(
    new URL(
      '../../../lib/tests/fixtures/ontology-bundle.json',
      import.meta.url,
    ),
    'utf8',
  ),
) as Record<string, unknown>[];

const ONTOLOGY = 'https://atomicdata.dev/medical/v1';
const CLASS = `${ONTOLOGY}/class/lab-result`;
const PROP = `${ONTOLOGY}/property/med-value`;

const newStore = async () => {
  await enableLoro();
  const store = new Store({ serverUrl: 'https://example.com' });
  store.setServerConnected(false);

  return store;
};

describe('installOntology', () => {
  it('stores the bundle at its subjects without a request or a commit', async ({
    expect,
  }) => {
    const store = await newStore();
    const fetch = vi.spyOn(globalThis, 'fetch');
    const report = await store.installOntology(bundle);

    expect(report.created).toHaveLength(26);
    expect(fetch).not.toHaveBeenCalled();
    expect(store.resources.get(CLASS)?.get(core.properties.shortname)).toBe(
      'lab-result',
    );
    expect(store.resources.get(PROP)?.get(core.properties.datatype)).toBe(
      'https://atomicdata.dev/datatypes/float',
    );
    expect(store.outbox.hasPending(CLASS)).toBe(false);
  });

  it('does nothing the second time', async ({ expect }) => {
    const store = await newStore();
    await store.installOntology(bundle);
    const again = await store.installOntology(bundle);

    expect(again.created).toEqual([]);
    expect(again.updated).toEqual([]);
    expect(again.unchanged).toHaveLength(26);
  });

  it('refuses a changed meaning, takes a new label, writes nothing on refusal', async ({
    expect,
  }) => {
    const store = await newStore();
    await store.installOntology(bundle);

    const edit = (key: string, value: string) =>
      bundle.map(r => (r['@id'] === PROP ? { ...r, [key]: value } : r));

    await expect(
      store.installOntology(
        edit(
          core.properties.datatype,
          'https://atomicdata.dev/datatypes/boolean',
        ),
      ),
    ).rejects.toThrow(/different/);

    const report = await store.installOntology(
      edit(core.properties.description, 'A new description'),
    );

    expect(report.updated).toEqual([PROP]);
    expect(store.resources.get(PROP)?.get(core.properties.description)).toBe(
      'A new description',
    );
  });

  it('refuses what is not schema, an unknown ontology class and reserved subjects', async ({
    expect,
  }) => {
    const store = await newStore();

    await expect(
      store.installOntology([
        ...bundle,
        { '@id': `${ONTOLOGY}/x`, [core.properties.isA]: [core.classes.agent] },
      ]),
    ).rejects.toThrow(/not an Ontology/);
    await expect(
      store.installOntology(
        JSON.parse(
          JSON.stringify(bundle).replaceAll(
            'https://atomicdata.dev/class/ontology',
            'https://atomicdata.dev/classes/Ontology',
          ),
        ),
      ),
    ).rejects.toThrow(/exactly one Ontology/);
    await expect(
      store.installOntology(
        JSON.parse(
          JSON.stringify(bundle).replaceAll(
            'atomicdata.dev/medical/v1/class',
            'atomicdata.dev/classes/med',
          ),
        ),
      ),
    ).rejects.toThrow(/shared vocabulary/);
    expect(store.resources.has(ONTOLOGY)).toBe(false);
  });
});
