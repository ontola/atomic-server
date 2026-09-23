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

  it('saves the terms it has to create at the same time', async () => {
    // One save per term, awaited one after the other, is the whole wait
    // between asking for a plugin and seeing its page: on a drive with no
    // schema that was sixteen round trips before anything appeared, which the
    // e2e suite saw as a page that never arrived. The terms are independent,
    // so a slow save must not hold up the next one.
    const store = makeStore();
    let openSaves = 0;
    let mostAtOnce = 0;
    const releases: Array<() => void> = [];

    const inner = store.newResource;
    store.newResource = vi.fn(async opts => {
      const resource = await inner(opts);

      return {
        ...resource,
        save: async () => {
          openSaves += 1;
          mostAtOnce = Math.max(mostAtOnce, openSaves);
          // Hold every save open until they have all arrived. Sequential code
          // deadlocks here rather than passing slowly, so this cannot regress
          // into a test that merely takes longer.
          await new Promise<void>(resolve => releases.push(resolve));
          openSaves -= 1;
        },
      };
    });

    const spec: SchemaSpec = {
      properties: ['one', 'two', 'three'].map(shortname => ({
        shortname,
        name: shortname,
        description: shortname,
        datatype: Datatype.STRING,
      })),
      classes: [],
    };

    const pending = ensureSchema(store, DRIVE, spec);
    await vi.waitFor(() => expect(releases.length).toBe(3));
    for (const release of releases) release();

    const schema = await pending;
    expect(Object.keys(schema.properties)).toEqual(['one', 'two', 'three']);
    expect(mostAtOnce).toBe(3);
  });

  it('refuses an incompatible shared term before creating any sibling', async () => {
    const shared = 'https://x/drive/shared-count';
    const store = makeStore({
      [shared]: {
        subject: shared,
        isA: [],
        props: {
          [core.properties.isA]: [core.classes.property],
          [core.properties.datatype]: Datatype.STRING,
        },
      },
    });

    const spec: SchemaSpec = {
      properties: [
        ...['one', 'two', 'three'].map(shortname => ({
          shortname,
          name: shortname,
          description: shortname,
          datatype: Datatype.STRING,
        })),
        {
          shortname: 'count',
          name: 'Count',
          description: 'Bound to a term of the wrong datatype.',
          datatype: Datatype.INTEGER,
          subject: shared,
        },
      ],
      classes: [],
    };

    await expect(ensureSchema(store, DRIVE, spec)).rejects.toThrow(
      /incompatible property datatype/,
    );
    expect(store.newResource).not.toHaveBeenCalled();
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

  it('keeps the ontology in spec order when only some terms are new', async () => {
    // The created terms are awaited together, so their order is whatever the
    // server answers first. What an ontology lists is read by people, so it
    // follows the spec regardless.
    const spec: SchemaSpec = {
      properties: ['alpha', 'beta', 'gamma'].map(shortname => ({
        shortname,
        name: shortname,
        description: shortname,
        datatype: Datatype.STRING,
      })),
      classes: [],
    };

    const store = makeStore();
    await ensureSchema(store, DRIVE, {
      properties: [spec.properties[1]],
      classes: [],
    });
    const beta = store.world[ONTOLOGY].props[core.properties.properties];
    expect(beta).toHaveLength(1);

    await ensureSchema(store, DRIVE, spec);
    const listed = store.world[ONTOLOGY].props[
      core.properties.properties
    ] as string[];
    const shortnameOf = (subject: string) =>
      store.world[subject].props[core.properties.shortname];
    expect(listed.map(shortnameOf)).toEqual(['beta', 'alpha', 'gamma']);
  });
});
