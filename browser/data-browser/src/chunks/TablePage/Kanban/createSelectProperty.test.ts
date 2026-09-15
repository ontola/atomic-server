import { describe, expect, it, vi } from 'vitest';
import {
  Datatype,
  type JSONValue,
  type Resource,
  type Store,
  core,
  dataBrowser,
} from '@tomic/react';

// `createSelectProperty.ts` only wants the color palette, but the real
// `@components/Tag/tagColours` module drags in the whole app shell (routes,
// providers, bugsnag's `window` access), which doesn't survive import outside
// a browser. Stub it so this file can test the plain creation logic in Node.
vi.mock('@components/Tag/tagColours', () => ({
  tagColours: ['blue', 'red', 'green'],
}));

const { createPropertyOnClass, createSelectPropertyOnClass } =
  await import('./createSelectProperty');

/**
 * A minimal in-memory double of `@tomic/lib`'s `Store`/`Resource`, just
 * enough surface (`get`/`set`/`push`/`save`/`hasClasses`/`newResource`/
 * `getResource`/`buildUniqueSubjectFromParts`) for the creation functions
 * under test — no network, no CRDT signing, no real ontology validation.
 */
function fakeStore() {
  const resources = new Map<
    string,
    { classes: Set<string>; props: Map<string, JSONValue> }
  >();
  let counter = 0;

  function makeResource(subject: string): Resource {
    const record = resources.get(subject);

    if (!record) {
      throw new Error(`fakeStore: no such resource ${subject}`);
    }

    return {
      subject,
      get title() {
        return String(record.props.get(core.properties.name) ?? subject);
      },
      get: (prop: string) => record.props.get(prop),
      set: async (prop: string, value: JSONValue) => {
        record.props.set(prop, value);
      },
      push: (prop: string, values: JSONValue[], unique?: boolean) => {
        const existing = (record.props.get(prop) as JSONValue[]) ?? [];
        const next = unique
          ? [...new Set([...existing, ...values])]
          : [...existing, ...values];
        record.props.set(prop, next);
      },
      save: async () => 'persisted',
      hasClasses: (...classSubjects: string[]) =>
        classSubjects.some(c => record.classes.has(c)),
    } as unknown as Resource;
  }

  const store = {
    getResource: async (subject: string) => makeResource(subject),
    newResource: async (opts: {
      subject?: string;
      parent?: string;
      isA?: string | string[];
      propVals?: Record<string, JSONValue>;
    }) => {
      const subject = opts.subject ?? `test:${++counter}`;
      const isA = opts.isA
        ? Array.isArray(opts.isA)
          ? opts.isA
          : [opts.isA]
        : [];
      const props = new Map<string, JSONValue>(
        Object.entries(opts.propVals ?? {}),
      );

      if (opts.parent) {
        props.set(core.properties.parent, opts.parent);
      }

      resources.set(subject, { classes: new Set(isA), props });

      return makeResource(subject);
    },
    buildUniqueSubjectFromParts: async (parts: string[], parent: string) =>
      `${parent}/${parts.join('-')}`,
  } as unknown as Store;

  return store;
}

/** An ontology and two row classes parented under it — the shared shape every
 *  "two tables on the same drive" scenario in this file starts from. */
async function twoTablesOnOneOntology(store: Store) {
  const ontology = await store.newResource({
    isA: core.classes.ontology,
    propVals: { [core.properties.properties]: [] },
  });
  const rowClassA = await store.newResource({
    isA: core.classes.class,
    parent: ontology.subject,
  });
  const rowClassB = await store.newResource({
    isA: core.classes.class,
    parent: ontology.subject,
  });

  return { ontology, rowClassA, rowClassB };
}

const STATUS_TAGS = [{ name: 'Todo' }, { name: 'Doing' }, { name: 'Done' }];

describe('table column creation dedupes ontology shortnames', () => {
  it('reuses an existing select property instead of creating a duplicate shortname', async () => {
    const store = fakeStore();
    const { ontology, rowClassA, rowClassB } =
      await twoTablesOnOneOntology(store);

    const first = await createSelectPropertyOnClass(store, rowClassA, {
      name: 'Status',
      tags: STATUS_TAGS,
    });
    const second = await createSelectPropertyOnClass(store, rowClassB, {
      name: 'Status',
      tags: STATUS_TAGS,
    });

    expect(second.subject).toBe(first.subject);
    expect(second.tags).toEqual(first.tags);

    const refreshedOntology = await store.getResource(ontology.subject);
    const properties = (refreshedOntology.get(core.properties.properties) ??
      []) as string[];
    expect(
      properties.filter(subject => subject === first.subject),
    ).toHaveLength(1);

    const property = await store.getResource(first.subject);
    expect(property.get(core.properties.shortname)).toBe('status');
  });

  it('reuses an existing plain property instead of creating a duplicate shortname', async () => {
    const store = fakeStore();
    const { rowClassA, rowClassB } = await twoTablesOnOneOntology(store);

    const first = await createPropertyOnClass(store, rowClassA, {
      name: 'Priority',
      datatype: Datatype.INTEGER,
    });
    const second = await createPropertyOnClass(store, rowClassB, {
      name: 'Priority',
      datatype: Datatype.INTEGER,
    });

    expect(second).toBe(first);
  });

  it('disambiguates the shortname when an existing property is incompatible', async () => {
    const store = fakeStore();
    const { rowClassA, rowClassB } = await twoTablesOnOneOntology(store);

    await createPropertyOnClass(store, rowClassA, {
      name: 'Status',
      datatype: Datatype.INTEGER,
    });
    const select = await createSelectPropertyOnClass(store, rowClassB, {
      name: 'Status',
      tags: STATUS_TAGS,
    });

    const property = await store.getResource(select.subject);
    expect(property.get(core.properties.shortname)).toBe('status-2');
    expect(property.hasClasses(dataBrowser.classes.selectProperty)).toBe(true);
  });

  it('rejects requesting an option the reused select property does not have', async () => {
    const store = fakeStore();
    const { rowClassA, rowClassB } = await twoTablesOnOneOntology(store);

    await createSelectPropertyOnClass(store, rowClassA, {
      name: 'Status',
      tags: STATUS_TAGS,
    });

    await expect(
      createSelectPropertyOnClass(store, rowClassB, {
        name: 'Status',
        tags: [{ name: 'Todo' }, { name: 'Blocked' }],
      }),
    ).rejects.toThrow('has no option "Blocked"');
  });

  it('does not dedupe when the row classes have no shared ontology', async () => {
    const store = fakeStore();
    const drive = await store.newResource({});
    const rowClassA = await store.newResource({
      isA: core.classes.class,
      parent: drive.subject,
    });
    const rowClassB = await store.newResource({
      isA: core.classes.class,
      parent: drive.subject,
    });

    const first = await createPropertyOnClass(store, rowClassA, {
      name: 'Priority',
      datatype: Datatype.INTEGER,
    });
    const second = await createPropertyOnClass(store, rowClassB, {
      name: 'Priority',
      datatype: Datatype.INTEGER,
    });

    // No shared ontology to collide on — each class gets its own property.
    expect(second).not.toBe(first);
  });
});
