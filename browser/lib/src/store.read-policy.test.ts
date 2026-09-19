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

/**
 * A database that answers from `rows` and counts its round trips. `onRead`
 * runs before a bulk read answers (to hold the worker busy); `fail` makes
 * every bulk read reject with it.
 */
function fakeDb(
  rows: Record<string, ReturnType<typeof row>>,
  opts: { onRead?: (subjects: string[]) => Promise<void>; fail?: Error } = {},
) {
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
      await opts.onRead?.(subjects);
      if (opts.fail) throw opts.fail;

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

/**
 * A cold render pass issues one `getResourceLoading` miss per mounted
 * `useResource`, all in the same tick. They must share one worker round trip
 * instead of each asking the database on their own.
 */
describe('local hydration batching', () => {
  afterEach(() => vi.restoreAllMocks());

  const subjects = (n: number) =>
    Array.from({ length: n }, (_, i) => `did:ad:s${i}`);
  const rowsFor = (list: string[]) =>
    Object.fromEntries(list.map(s => [s, row(s, `Name ${s}`)]));

  it('reads every miss of one tick in a single round trip', async ({
    expect,
  }) => {
    await enableLoro();
    const { store } = await testStore();
    const wanted = subjects(30);
    const { db, calls } = fakeDb(rowsFor(wanted));
    store.setClientDb(db);
    const socket = fakeSocket(store);

    for (const subject of wanted) store.getResourceLoading(subject);
    const loaded = await Promise.all(wanted.map(s => store.getResource(s)));

    expect(calls).toEqual([wanted]);
    expect(loaded.map(r => r.get(NAME))).toEqual(wanted.map(s => `Name ${s}`));
    expect(socket.fetch).not.toHaveBeenCalled();
    expect(socket.fetchMany).not.toHaveBeenCalled();
  });

  it('asks once for a subject two callers miss in the same tick', async ({
    expect,
  }) => {
    await enableLoro();
    const { store } = await testStore();
    const { db, calls } = fakeDb(rowsFor(['did:ad:twice']));
    store.setClientDb(db);
    fakeSocket(store);

    // A render-phase miss and a direct local read of the same subject.
    const fromRender = store.getResourceLoading('did:ad:twice');
    const fromLocal = store.getLocalResource('did:ad:twice');
    const [local, awaited] = await Promise.all([
      fromLocal,
      store.getResource('did:ad:twice'),
    ]);

    expect(calls).toEqual([['did:ad:twice']]);
    expect(local).toBe(fromRender);
    expect(awaited).toBe(fromRender);
    expect(local.get(NAME)).toBe('Name did:ad:twice');
  });

  it('puts a miss issued while a batch is at the worker into the next batch', async ({
    expect,
  }) => {
    await enableLoro();
    const { store } = await testStore();
    let release!: () => void;
    let reached!: () => void;
    const busy = new Promise<void>(resolve => (release = resolve));
    const atWorker = new Promise<void>(resolve => (reached = resolve));
    const { db, calls } = fakeDb(rowsFor(['did:ad:first', 'did:ad:second']), {
      onRead: async () => {
        reached();
        await busy;
      },
    });
    store.setClientDb(db);
    fakeSocket(store);

    store.getResourceLoading('did:ad:first');
    await atWorker;
    // The first batch has been handed over; this one must not be lost.
    store.getResourceLoading('did:ad:second');
    release();
    const [first, second] = await Promise.all([
      store.getResource('did:ad:first'),
      store.getResource('did:ad:second'),
    ]);

    expect(calls).toEqual([['did:ad:first'], ['did:ad:second']]);
    expect(first.get(NAME)).toBe('Name did:ad:first');
    expect(second.get(NAME)).toBe('Name did:ad:second');
  });

  it('treats a failed bulk read as a miss for every subject in it', async ({
    expect,
  }) => {
    await enableLoro();
    const { store } = await testStore();
    const { db, calls } = fakeDb(rowsFor(['did:ad:x', 'did:ad:y']), {
      fail: new Error('worker gone'),
    });
    store.setClientDb(db);
    const socket = fakeSocket(store);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    store.getResourceLoading('did:ad:x');
    store.getResourceLoading('did:ad:y');
    await Promise.all([
      store.getResource('did:ad:x'),
      store.getResource('did:ad:y'),
    ]);

    // One round trip failed; each subject went on to the server as a miss.
    expect(calls).toEqual([['did:ad:x', 'did:ad:y']]);
    expect(
      warn.mock.calls.filter(([message]) =>
        String(message).includes('OPFS lookup failed'),
      ),
    ).toHaveLength(1);
    expect(socket.fetch).toHaveBeenCalledWith('did:ad:x');
    expect(socket.fetch).toHaveBeenCalledWith('did:ad:y');
  });

  it('splits a very large batch into worker-sized chunks', async ({
    expect,
  }) => {
    await enableLoro();
    const { store } = await testStore();
    const wanted = subjects(250);
    const { db, calls } = fakeDb(rowsFor(wanted));
    store.setClientDb(db);
    fakeSocket(store);

    for (const subject of wanted) store.getResourceLoading(subject);
    await Promise.all(wanted.map(s => store.getResource(s)));

    expect(calls.map(c => c.length)).toEqual([200, 50]);
    expect(calls.flat()).toEqual(wanted);
  });
});
