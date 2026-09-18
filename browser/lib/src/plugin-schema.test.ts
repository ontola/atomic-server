import { describe, expect, it, vi } from 'vitest';
import { Datatype } from './datatypes.js';
import { core } from './ontologies/core.js';
import { server } from './ontologies/server.js';
import { ensureSchema, findSchema, type SchemaSpec } from './plugin-schema.js';
import type { JSONValue } from './value.js';

const DRIVE = 'https://x/drive';
const ONTOLOGY = 'https://x/drive/ontology';

interface Stored {
  subject: string;
  isA: string[];
  props: Record<string, JSONValue>;
}

/** A store just real enough to exercise shortname resolution against an ontology. */
const makeStore = (seed: Record<string, Stored> = {}) => {
  const world: Record<string, Stored> = {
    [DRIVE]: {
      subject: DRIVE,
      isA: [],
      props: { [server.properties.defaultOntology]: ONTOLOGY },
    },
    [ONTOLOGY]: { subject: ONTOLOGY, isA: [], props: {} },
    ...seed,
  };

  let n = 0;

  const wrap = (stored: Stored) => ({
    subject: stored.subject,
    get: (property: string) => stored.props[property],
    set: async (property: string, value: JSONValue) => {
      stored.props[property] = value;
    },
    save: async () => undefined,
  });

  return {
    world,
    findByLocalId: async () => undefined,
    getResource: vi.fn(async (subject: string) => {
      world[subject] ??= { subject, isA: [], props: {} };

      return wrap(world[subject]);
    }),
    newResource: vi.fn(
      async (opts: {
        parent: string;
        isA: string[];
        propVals: Record<string, JSONValue>;
      }) => {
        const subject = `${opts.parent}/created-${++n}`;
        world[subject] = {
          subject,
          isA: opts.isA,
          props: {
            ...opts.propVals,
            [core.properties.parent]: opts.parent,
            [core.properties.isA]: opts.isA,
          },
        };

        return wrap(world[subject]);
      },
    ),
  };
};

/** Two unrelated columns (e.g. two tables' own "Status" select) that share a shortname. */
const withColliding = () => ({
  'https://x/drive/status-a': {
    subject: 'https://x/drive/status-a',
    isA: [],
    props: { [core.properties.shortname]: 'status' },
  },
  'https://x/drive/status-b': {
    subject: 'https://x/drive/status-b',
    isA: [],
    props: { [core.properties.shortname]: 'status' },
  },
  [ONTOLOGY]: {
    subject: ONTOLOGY,
    isA: [],
    props: {
      [core.properties.properties]: [
        'https://x/drive/status-a',
        'https://x/drive/status-b',
      ],
    },
  },
});

const pluginLikeSpec: SchemaSpec = {
  properties: [
    {
      shortname: 'run-status',
      name: 'Status',
      description: 'blocked, applied, partial or failed.',
      datatype: Datatype.STRING,
    },
  ],
  classes: [],
};

describe('findSchema', () => {
  it('ignores a shortname collision unrelated to the requested spec', async () => {
    const store = makeStore(withColliding());

    await expect(findSchema(store, DRIVE, pluginLikeSpec)).resolves.toEqual({
      properties: {},
      classes: {},
    });
  });

  it('still reports ambiguity for a shortname the spec actually asks about', async () => {
    const store = makeStore(withColliding());
    const spec: SchemaSpec = {
      properties: [
        {
          shortname: 'status',
          name: 'Status',
          description: 'Status',
          datatype: Datatype.RESOURCEARRAY,
        },
      ],
      classes: [],
    };

    await expect(findSchema(store, DRIVE, spec)).rejects.toThrow(
      'ambiguous schema shortname: status',
    );
  });
});

describe('ensureSchema', () => {
  it('creates and reuses its own terms despite an unrelated shortname collision', async () => {
    const store = makeStore(withColliding());

    const first = await ensureSchema(store, DRIVE, pluginLikeSpec);
    expect(first.properties['run-status']).toBeDefined();

    const second = await ensureSchema(store, DRIVE, pluginLikeSpec);
    expect(second).toEqual(first);
  });

  it('creates independent terms together rather than one round trip each', async () => {
    const store = makeStore();

    let inFlight = 0;
    let peak = 0;

    const slow = async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise(resolve => setTimeout(resolve, 5));
      inFlight--;
    };

    const create = store.newResource;
    store.newResource = vi.fn(async opts => {
      await slow();

      return create(opts);
    });
    store.findByLocalId = vi.fn(async () => {
      await slow();

      return undefined;
    });

    const spec: SchemaSpec = {
      properties: Array.from({ length: 6 }, (_, i) => ({
        shortname: `field-${i}`,
        name: `Field ${i}`,
        description: 'A field.',
        datatype: Datatype.STRING,
      })),
      classes: [],
    };

    const terms = await ensureSchema(store, DRIVE, spec);

    expect(Object.keys(terms.properties)).toHaveLength(6);
    // Sequentially this never rises above one, and a six-property schema costs
    // twelve round trips before the user sees anything.
    expect(peak).toBe(6);
  });

  it('keeps the ontology list in spec order however the creates finish', async () => {
    const store = makeStore();
    const create = store.newResource;
    store.newResource = vi.fn(async opts => {
      // Later specs finish first: the last one waits the least.
      const shortname = String(opts.propVals[core.properties.shortname]);
      const delay = 20 - Number(shortname.split('-')[1]) * 5;
      await new Promise(resolve => setTimeout(resolve, delay));

      return create(opts);
    });

    const spec: SchemaSpec = {
      properties: Array.from({ length: 4 }, (_, i) => ({
        shortname: `field-${i}`,
        name: `Field ${i}`,
        description: 'A field.',
        datatype: Datatype.STRING,
      })),
      classes: [],
    };

    const terms = await ensureSchema(store, DRIVE, spec);
    const listed = store.world[ONTOLOGY].props[core.properties.properties];

    expect(listed).toEqual([
      terms.properties['field-0'],
      terms.properties['field-1'],
      terms.properties['field-2'],
      terms.properties['field-3'],
    ]);
  });
});
