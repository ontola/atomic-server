import { afterEach, describe, it, vi } from 'vitest';

import { Datatype } from './datatypes.js';
import { frozenIdFor } from './freeze.js';
import { core } from './ontologies/core.js';
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
