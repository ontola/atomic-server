import { beforeEach, describe, expect, it, vi } from 'vitest';
import { core } from '@tomic/react';
import type { Store } from '@tomic/react';
import { handleRequest, isHostRequest, isWithinApp } from './hostStore';

vi.mock('@tomic/react', async () => {
  const actual =
    await vi.importActual<typeof import('@tomic/react')>('@tomic/react');

  // Signing needs a real key and a real agent; what these tests are about is
  // which requests leave and which are refused before they do.
  return { ...actual, signRequest: async () => ({}) };
});

const APP = 'did:ad:app';
const DRIVE = 'did:ad:drive';

/** Every write the host asked the server to make on the app's behalf. */
let sent: Array<Record<string, unknown>>;

beforeEach(() => {
  sent = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit) => {
      sent.push(JSON.parse(init.body as string));

      return {
        ok: true,
        json: async () => ({ subject: 'did:ad:written' }),
        text: async () => '',
      } as unknown as Response;
    }),
  );
});

/** A store with a parent chain, which is what the write rule is about. */
function fakeStore(parents: Record<string, string | undefined> = {}) {
  return {
    getAgent: () => ({ subject: 'did:ad:agent:me' }),
    getServerUrl: () => 'https://node.test',
    getResource: async (subject: string) => ({
      subject,
      error: undefined,
      get: (property: string) =>
        property === core.properties.parent ? parents[subject] : undefined,
      getPropVals: () => ({ [core.properties.parent]: parents[subject] }),
    }),
    search: async () => ['did:ad:found'],
  } as unknown as Store;
}

const req = (op: string, extra: Record<string, unknown> = {}) =>
  ({ __atomic: true as const, id: 1, op, ...extra }) as never;

describe('writing as the app', () => {
  it('asks the server to write, rather than signing as the person', async () => {
    const store = fakeStore({ 'did:ad:mine': APP });

    await handleRequest(
      store,
      APP,
      DRIVE,
      req('save', { subject: 'did:ad:mine', propVals: { p: 'v' } }),
    );

    // The point of the round trip: the server holds the app's key, so the
    // commit is authored by the app and bounded by the app's rights.
    expect(sent).toEqual([
      {
        drive: DRIVE,
        app: APP,
        op: 'save',
        subject: 'did:ad:mine',
        propVals: { p: 'v' },
      },
    ]);
  });

  it('re-reads what it saved, so the app reads its own write back', async () => {
    const store = fakeStore({ 'did:ad:mine': APP });
    const order: string[] = [];
    vi.mocked(fetch).mockImplementationOnce((async () => {
      order.push('write');

      return {
        ok: true,
        json: async () => ({ subject: 'did:ad:mine' }),
      } as unknown as Response;
    }) as typeof fetch);
    Object.assign(store, {
      fetchResourceFromServer: vi.fn(async (subject: string) => {
        order.push(`reread ${subject}`);
      }),
    });

    await handleRequest(
      store,
      APP,
      DRIVE,
      req('save', { subject: 'did:ad:mine', propVals: { p: 'v' } }),
    );

    expect(order).toEqual(['write', 'reread did:ad:mine']);
  });

  it('reports a landed save as saved even when the re-read fails', async () => {
    const store = fakeStore({ 'did:ad:mine': APP });
    Object.assign(store, {
      fetchResourceFromServer: vi.fn(async () => {
        throw new Error('offline');
      }),
    });

    await expect(
      handleRequest(
        store,
        APP,
        DRIVE,
        req('save', { subject: 'did:ad:mine', propVals: { p: 'v' } }),
      ),
    ).resolves.toEqual({ subject: 'did:ad:mine' });
  });

  it('creates under the app when given no parent', async () => {
    const store = fakeStore();

    await handleRequest(store, APP, DRIVE, req('create'));

    expect(sent[0]).toMatchObject({ op: 'create', parent: APP });
  });

  it('reaches data nested deeper inside itself', async () => {
    const store = fakeStore({
      'did:ad:deep': 'did:ad:mid',
      'did:ad:mid': APP,
    });

    await expect(isWithinApp(store, 'did:ad:deep', APP)).resolves.toBe(true);
  });

  it('refuses outside itself before anything leaves', async () => {
    const store = fakeStore({ 'did:ad:elsewhere': 'did:ad:drive' });

    await expect(
      handleRequest(
        store,
        APP,
        DRIVE,
        req('save', { subject: 'did:ad:elsewhere', propVals: { p: 'v' } }),
      ),
    ).rejects.toThrow(/only write its own data/);

    // Refused early so the app gets an error it can render, rather than a
    // round trip that the rights walk was always going to reject.
    expect(sent).toHaveLength(0);
  });

  it('refuses to destroy outside itself', async () => {
    const store = fakeStore({ 'did:ad:elsewhere': 'did:ad:drive' });

    await expect(
      handleRequest(
        store,
        APP,
        DRIVE,
        req('destroy', { subject: 'did:ad:elsewhere' }),
      ),
    ).rejects.toThrow(/only write its own data/);
    expect(sent).toHaveLength(0);
  });

  it('refuses to create outside itself', async () => {
    const store = fakeStore({ 'did:ad:elsewhere': 'did:ad:drive' });

    await expect(
      handleRequest(
        store,
        APP,
        DRIVE,
        req('create', { parent: 'did:ad:elsewhere' }),
      ),
    ).rejects.toThrow(/only write its own data/);
    expect(sent).toHaveLength(0);
  });

  it('does not loop forever on a parent cycle', async () => {
    const store = fakeStore({ a: 'b', b: 'a' });

    await expect(isWithinApp(store, 'a', APP)).resolves.toBe(false);
  });

  it('reads stay on this session and never leave', async () => {
    const store = fakeStore({ 'did:ad:elsewhere': 'did:ad:drive' });

    // An app sees what the person looking at it can see. A write persists and
    // is attributable; a read is already on their screen.
    await expect(
      handleRequest(
        store,
        APP,
        DRIVE,
        req('get', { subject: 'did:ad:elsewhere' }),
      ),
    ).resolves.toMatchObject({ subject: 'did:ad:elsewhere' });
    expect(sent).toHaveLength(0);
  });

  it('sees the table it is a view of, not its own', async () => {
    const store = fakeStore();

    // The same app is its own thing on its own page and a way of looking at
    // someone else's rows on a table tab. It should not have to know which.
    const viewing = (await handleRequest(
      store,
      APP,
      DRIVE,
      req('data'),
      'did:ad:someone-elses-table',
    )) as { table: string };

    expect(viewing.table).toBe('did:ad:someone-elses-table');
  });

  it('refuses an operation it does not implement', async () => {
    const store = fakeStore();

    await expect(handleRequest(store, APP, DRIVE, req('sudo'))).rejects.toThrow(
      /does not do/,
    );
  });
});

describe('isHostRequest', () => {
  it('ignores messages that are not ours', () => {
    expect(isHostRequest({ type: '__atomic_plugin_ready' })).toBe(false);
    expect(isHostRequest(null)).toBe(false);
    expect(isHostRequest({ __atomic: true })).toBe(false);
    expect(isHostRequest({ __atomic: true, id: 1 })).toBe(true);
  });
});

describe('relaying the integration proxy', () => {
  const relay = {
    request: vi.fn(async () => ({ status: 200, headers: {}, body: [] })),
    connections: vi.fn(() => [{ connectionId: 'c1', platform: 'pets' }]),
  };

  it('passes a call to the relay by reference, never touching the server', async () => {
    const result = await handleRequest(
      fakeStore(),
      APP,
      DRIVE,
      req('proxy', {
        platform: 'pets',
        connectionId: 'c1',
        path: '/pets',
        query: { page: '2' },
      }),
      undefined,
      relay,
    );
    expect(result).toEqual({ status: 200, headers: {}, body: [] });
    expect(relay.request).toHaveBeenCalledWith(
      expect.objectContaining({
        platform: 'pets',
        connectionId: 'c1',
        path: '/pets',
        query: { page: '2' },
      }),
    );
    expect(sent).toEqual([]);
  });

  it('lists connection references, and none without a relay', async () => {
    expect(
      await handleRequest(
        fakeStore(),
        APP,
        DRIVE,
        req('proxyConnections', { platform: 'pets' }),
        undefined,
        relay,
      ),
    ).toEqual([{ connectionId: 'c1', platform: 'pets' }]);
    expect(
      await handleRequest(
        fakeStore(),
        APP,
        DRIVE,
        req('proxyConnections', { platform: 'pets' }),
      ),
    ).toEqual([]);
  });

  it('refuses a proxy call without a relay or without a connection', async () => {
    await expect(
      handleRequest(
        fakeStore(),
        APP,
        DRIVE,
        req('proxy', { platform: 'pets', connectionId: 'c1', path: '/pets' }),
      ),
    ).rejects.toThrow('cannot reach the integration proxy');
    await expect(
      handleRequest(
        fakeStore(),
        APP,
        DRIVE,
        req('proxy', { platform: 'pets', path: '/pets' }),
        undefined,
        relay,
      ),
    ).rejects.toThrow('connectionId is required');
  });
});
