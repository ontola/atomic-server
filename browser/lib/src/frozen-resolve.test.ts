import { afterEach, describe, it, vi } from 'vitest';

import { Agent } from './agent.js';
import { JSCryptoProvider } from './CryptoProvider.js';
import { Datatype } from './datatypes.js';
import { frozenIdFor } from './freeze.js';
import { core } from './ontologies/core.js';
import { JSONADParser } from './parse.js';
import { buildSchemaLock } from './schema-lock.js';
import { Store } from './store.js';

const body = {
  [core.properties.isA]: [core.classes.property],
  [core.properties.shortname]: 'title',
  [core.properties.datatype]: Datatype.STRING,
};
const id = frozenIdFor(body);
const hash = id.replace('did:ad:frozen:', '');

const ok = (obj: unknown) => ({
  ok: true,
  status: 200,
  text: async () => JSON.stringify(obj),
});

function connectedStore(): Store {
  const store = new Store({ serverUrl: 'https://example.com' });
  store.setServerConnected(true);

  return store;
}

describe('Store frozen resolution', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fetches, verifies, and materializes a frozen resource', async ({
    expect,
  }) => {
    const fetchMock = vi.fn(async () => ok(body));
    vi.stubGlobal('fetch', fetchMock);

    const resource = await connectedStore().getResource(id);

    expect(resource.subject).toBe(id);
    expect(resource.get(core.properties.shortname)).toBe('title');
    expect(resource.get(core.properties.datatype)).toBe(Datatype.STRING);
    expect(fetchMock).toHaveBeenCalledWith(
      `https://example.com/frozen/${hash}`,
      expect.objectContaining({ headers: { Accept: 'application/ad+json' } }),
    );
  });

  it('rejects a body that fails hash verification', async ({ expect }) => {
    vi.stubGlobal('fetch', vi.fn(async () => ok({ tampered: true })));

    await expect(connectedStore().getResource(id)).rejects.toThrow(
      /hash verification/i,
    );
  });

  it('errors when the frozen resource is absent', async ({ expect }) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 404, text: async () => '' })),
    );

    await expect(connectedStore().getResource(id)).rejects.toThrow(/404/);
  });
});

const todoPackage = {
  name: 'TodoApp',
  classes: {
    todo: {
      type: 'object' as const,
      required: ['title'],
      properties: {
        title: { type: 'string' as const, description: 'Task title' },
        done: { type: 'boolean' as const },
      },
    },
  },
};

describe('Store.registerFrozenSchema', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('materializes frozen resources locally so a property resolves offline', async ({
    expect,
  }) => {
    // Any network call would throw — local materialization must need none.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('should not hit the network');
      }),
    );

    const store = new Store({ serverUrl: 'https://example.com' });
    const frozen = await store.registerFrozenSchema(todoPackage);
    const titleId = frozen.properties['todo.title'];

    expect(titleId).toMatch(/^did:ad:frozen:[0-9a-f]{64}$/);

    const prop = await store.getProperty(titleId);
    expect(prop.shortname).toBe('title');
    expect(prop.datatype).toBe(Datatype.STRING);
    // Description is presentation — excluded from the frozen body.
    expect(prop.description).toBe('');
    expect(frozen.presentation.properties['todo.title'].description).toBe(
      'Task title',
    );
  });

  it('publishes every frozen resource to /frozen with { save: true }', async ({
    expect,
  }) => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: { method: string }) => {
        calls.push(`${init.method} ${url}`);

        return { ok: true, status: 204, text: async () => '' };
      }),
    );

    const store = new Store({ serverUrl: 'https://example.com' });
    const frozen = await store.registerFrozenSchema(todoPackage, {
      save: true,
    });

    expect(calls.length).toBe(frozen.resources.length);
    expect(
      calls.every(call =>
        call.startsWith('PUT https://example.com/frozen/'),
      ),
    ).toBe(true);
  });
});

describe('Store.loadSchemaLock', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('makes a bundled lockfile resolve offline with no server', async ({
    expect,
  }) => {
    // The lockfile is the only input — any network call would throw.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('should not hit the network');
      }),
    );

    const lock = buildSchemaLock(todoPackage);
    const store = new Store({ serverUrl: 'https://example.com' });
    store.loadSchemaLock(lock);

    const titleId = lock.presentation.properties['todo.title'].id;
    const prop = await store.getProperty(titleId);

    expect(prop.shortname).toBe('title');
    expect(prop.datatype).toBe(Datatype.STRING);

    const todoClass = await store.getResource(lock.presentation.classes.todo.id);
    expect(todoClass.get(core.properties.shortname)).toBe('todo');
  });

  it('rejects a tampered lockfile', ({ expect }) => {
    const lock = buildSchemaLock(todoPackage);
    const [firstId] = Object.keys(lock.frozen);
    const tampered = {
      ...lock,
      frozen: {
        ...lock.frozen,
        [firstId]: { ...(lock.frozen[firstId] as object), tampered: true },
      },
    };

    const store = new Store({ serverUrl: 'https://example.com' });
    expect(() => store.loadSchemaLock(tampered as typeof lock)).toThrow(
      /invalid schema lock/i,
    );
  });
});

describe('Store.createSchemaPointer', () => {
  it('creates a signed Ontology pointing at the frozen ids', async ({
    expect,
  }) => {
    const keys = await Agent.generateKeyPair();
    const store = new Store({ serverUrl: 'https://example.com' });
    store.setAgent(
      new Agent(
        new JSCryptoProvider(keys.privateKey),
        `did:ad:agent:${keys.publicKey}`,
      ),
    );

    const frozen = await store.registerFrozenSchema({
      ...todoPackage,
      version: '1.0.0',
    });
    const pointer = await store.createSchemaPointer(frozen);

    // Stable, signed DID — the durable "name" for the latest version.
    expect(pointer.subject).toMatch(/^did:ad:/);
    expect(pointer.hasClasses(core.classes.ontology)).toBe(true);
    // Its members point at the immutable frozen ids.
    expect(pointer.props.classes).toEqual([frozen.classes.todo]);
    expect(pointer.props.properties).toEqual(
      expect.arrayContaining([
        frozen.properties['todo.title'],
        frozen.properties['todo.done'],
      ]),
    );
  });
});

describe('Store.freezeStructure', () => {
  const P = 'https://atomicdata.dev/properties/';
  const propSubject = 'https://my.drive/p/title';
  const classSubject = 'https://my.drive/c/todo';
  const ontSubject = 'https://my.drive/o/todoapp';

  const seeded = (): Store => {
    const store = new Store({ serverUrl: 'https://my.drive' });

    const add = (obj: Record<string, unknown>) => {
      const [res] = new JSONADParser().parse(obj, obj['@id'] as string);
      res.loading = false;
      store.addResource(res, { skipCommitCompare: true });
    };

    add({
      '@id': propSubject,
      [`${P}isA`]: ['https://atomicdata.dev/classes/Property'],
      [`${P}shortname`]: 'title',
      [`${P}datatype`]: Datatype.STRING,
    });
    add({
      '@id': classSubject,
      [`${P}isA`]: ['https://atomicdata.dev/classes/Class'],
      [`${P}shortname`]: 'todo',
      [`${P}requires`]: [propSubject],
    });
    add({
      '@id': ontSubject,
      [`${P}isA`]: ['https://atomicdata.dev/class/ontology'],
      [`${P}shortname`]: 'todoapp',
      [`${P}classes`]: [classSubject],
      [`${P}properties`]: [propSubject],
      [`${P}parent`]: 'https://my.drive',
    });

    return store;
  };

  it('freezes a resource and the structure it references', async ({
    expect,
  }) => {
    const frozen = await seeded().freezeStructure(ontSubject);

    expect(Object.keys(frozen.frozen)).toHaveLength(3);
    expect(frozen.root).toBe(frozen.bySubject[ontSubject]);
    expect(frozen.root).toMatch(/^did:ad:frozen:[0-9a-f]{64}$/);

    // Cross-references rewritten to frozen ids; hierarchy stripped.
    const ontBody = frozen.frozen[frozen.root] as Record<string, unknown>;
    expect(ontBody[`${P}classes`]).toEqual([frozen.bySubject[classSubject]]);
    expect(ontBody[`${P}properties`]).toEqual([frozen.bySubject[propSubject]]);
    expect(ontBody[`${P}parent`]).toBeUndefined();

    const classBody = frozen.frozen[frozen.bySubject[classSubject]] as Record<
      string,
      unknown
    >;
    expect(classBody[`${P}requires`]).toEqual([frozen.bySubject[propSubject]]);
  });

  it('freezes only the root with { closure: false }', async ({ expect }) => {
    const frozen = await seeded().freezeStructure(ontSubject, {
      closure: false,
    });

    expect(Object.keys(frozen.frozen)).toHaveLength(1);
    // The reference stays as the original subject, not rewritten.
    const ontBody = frozen.frozen[frozen.root] as Record<string, unknown>;
    expect(ontBody[`${P}classes`]).toEqual([classSubject]);
  });
});
