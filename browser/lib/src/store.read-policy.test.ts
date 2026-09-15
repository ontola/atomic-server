import { describe, it, vi, afterEach } from 'vitest';
import { enableLoro } from './loro-loader.js';
import { Resource } from './resource.js';
import { AtomicError, ErrorType } from './error.js';
import { testStore } from './test-store.js';
import type { Store } from './store.js';

/**
 * One read policy for every caller: memory, then the embedded database, then
 * the server. `getResource` and `getResources` used to carry their own copies
 * of the offline and local-only rules and went to the server for anything not
 * in memory; these pin the shared behaviour.
 */

const NAME = 'https://atomicdata.dev/properties/name';
const IS_A = 'https://atomicdata.dev/properties/isA';

function row(subject: string, name: string) {
  return {
    jsonAd: JSON.stringify({
      '@id': subject,
      [IS_A]: ['https://atomicdata.dev/classes/Document'],
      [NAME]: name,
    }),
    snapshot: null,
  };
}

/** A database that answers from `rows` and counts its round trips. */
function fakeDb(rows: Record<string, ReturnType<typeof row>>) {
  const calls: string[][] = [];
  const db = {
    isReady: true,
    isInitialized: true,
    waitForInit: async () => undefined,
    waitForReady: async () => true,
    getResourceWithSnapshot: async (subject: string) => {
      calls.push([subject]);

      return rows[subject] ?? { jsonAd: null, snapshot: null };
    },
    getResourcesWithSnapshots: async (subjects: string[]) => {
      calls.push(subjects);

      return subjects.map(s => rows[s] ?? { jsonAd: null, snapshot: null });
    },
    putResourceWithSnapshot: async () => undefined,
    putResource: async () => undefined,
    flush: async () => undefined,
  };

  return { db: db as unknown as Parameters<Store['setClientDb']>[0], calls };
}

function fakeSocket(store: Store) {
  const fetch = vi.fn(async (subject: string) => {
    const resource = new Resource(subject);
    resource.setStore(store);
    resource.loading = false;
    store.addResource(resource, { skipCommitCompare: true });

    return resource;
  });
  const fetchMany = vi.fn(async (subjects: string[]) =>
    Promise.all(subjects.map(s => fetch(s))),
  );
  vi.spyOn(store, 'getWebSocketForSubject').mockReturnValue({
    readyState: WebSocket.OPEN,
    fetch,
    fetchMany,
    supportsGetMany: true,
    unsubscribeAgentProfile: vi.fn(),
    subscribeAgentProfile: vi.fn(),
    subscribe: vi.fn(),
  } as never);

  return { fetch, fetchMany };
}

describe('store read policy', () => {
  afterEach(() => vi.restoreAllMocks());

  it('serves getResource from the embedded database without asking the server', async ({
    expect,
  }) => {
    await enableLoro();
    const { store } = await testStore();
    const { db, calls } = fakeDb({ 'did:ad:doc': row('did:ad:doc', 'Local') });
    store.setClientDb(db);
    const socket = fakeSocket(store);

    const resource = await store.getResource('did:ad:doc');

    expect(resource.get(NAME)).toBe('Local');
    expect(socket.fetch).not.toHaveBeenCalled();
    expect(calls).toEqual([['did:ad:doc']]);
  });

  it('goes to the server for a subject the database does not have', async ({
    expect,
  }) => {
    await enableLoro();
    const { store } = await testStore();
    store.setClientDb(fakeDb({}).db);
    const socket = fakeSocket(store);

    const resource = await store.getResource('did:ad:elsewhere');

    expect(resource.subject).toBe('did:ad:elsewhere');
    expect(socket.fetch).toHaveBeenCalledWith('did:ad:elsewhere');
  });

  it('resolves a missing subject to a resource carrying the error', async ({
    expect,
  }) => {
    await enableLoro();
    const { store } = await testStore();
    store.setClientDb(fakeDb({}).db);
    const socket = fakeSocket(store);
    socket.fetch.mockRejectedValue(
      new Error('Resource not found. did:ad:gone'),
    );

    const resource = await store.getResource('did:ad:gone');

    expect(resource.error?.message).toContain('Resource not found');
  });

  it('never sends a local-only subject to the server', async ({ expect }) => {
    await enableLoro();
    const { store } = await testStore();
    store.registerLocalOnlyDrive('did:ad:localdrive');
    const { db } = fakeDb({});
    store.setClientDb(db);
    const socket = fakeSocket(store);
    vi.spyOn(store, 'isLocalOnlySubject').mockReturnValue(true);

    const resource = await store.getResource('did:ad:private-note');

    expect((resource.error as AtomicError).type).toBe(ErrorType.Transport);
    expect(socket.fetch).not.toHaveBeenCalled();
  });

  it('getResources reads the whole list from the database in one round trip', async ({
    expect,
  }) => {
    await enableLoro();
    const { store } = await testStore();
    const { db, calls } = fakeDb({
      'did:ad:a': row('did:ad:a', 'A'),
      'did:ad:b': row('did:ad:b', 'B'),
    });
    store.setClientDb(db);
    const socket = fakeSocket(store);

    const [a, b, c, aAgain] = await store.getResources([
      'did:ad:a',
      'did:ad:b',
      'did:ad:c',
      'did:ad:a',
    ]);

    expect([a.get(NAME), b.get(NAME)]).toEqual(['A', 'B']);
    expect(aAgain).toBe(a);
    expect(c.subject).toBe('did:ad:c');
    // One bulk read for the misses in memory, then only the true miss on the wire.
    expect(calls).toEqual([['did:ad:a', 'did:ad:b', 'did:ad:c']]);
    expect(socket.fetchMany).toHaveBeenCalledWith(['did:ad:c']);
  });
});
