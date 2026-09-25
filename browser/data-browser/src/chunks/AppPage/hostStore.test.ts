import { beforeEach, describe, expect, it, vi } from 'vitest';
import { core } from '@tomic/react';
import type { Store } from '@tomic/react';
import {
  handleRequest,
  isHostRequest,
  isWithinApp,
  ROW_DESTROY_REFUSED,
} from './hostStore';

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

describe('integration-proxy capabilities', () => {
  const minted = {
    capability: 'payload.sig',
    aud: 'https://proxy.example',
    exp: 1,
    connectionId: 'c1',
    platform: 'pets',
  };
  const proxy = {
    capability: vi.fn(async () => minted),
    connections: vi.fn(async () => [{ connectionId: 'c1', platform: 'pets' }]),
  };

  it('mints a capability for the frame key, never touching the server', async () => {
    const result = await handleRequest(
      fakeStore(),
      APP,
      DRIVE,
      req('proxyCapability', {
        platform: 'pets',
        connectionId: 'c1',
        publicKey: 'frame-key',
      }),
      undefined,
      proxy,
    );
    expect(result).toEqual(minted);
    expect(proxy.capability).toHaveBeenCalledWith({
      platform: 'pets',
      connectionId: 'c1',
      publicKey: 'frame-key',
    });
    expect(sent).toEqual([]);
  });

  it('lists connection references, and none without a proxy', async () => {
    expect(
      await handleRequest(
        fakeStore(),
        APP,
        DRIVE,
        req('proxyConnections', { platform: 'pets' }),
        undefined,
        proxy,
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

  it('refuses without a proxy, a connection or a frame key', async () => {
    await expect(
      handleRequest(
        fakeStore(),
        APP,
        DRIVE,
        req('proxyCapability', {
          platform: 'pets',
          connectionId: 'c1',
          publicKey: 'k',
        }),
      ),
    ).rejects.toThrow('cannot reach the integration proxy');
    await expect(
      handleRequest(
        fakeStore(),
        APP,
        DRIVE,
        req('proxyCapability', { platform: 'pets', publicKey: 'k' }),
        undefined,
        proxy,
      ),
    ).rejects.toThrow('connectionId is required');
    await expect(
      handleRequest(
        fakeStore(),
        APP,
        DRIVE,
        req('proxyCapability', { platform: 'pets', connectionId: 'c1' }),
        undefined,
        proxy,
      ),
    ).rejects.toThrow('publicKey is required');
  });

  it('no longer relays proxy calls through the page', async () => {
    await expect(
      handleRequest(
        fakeStore(),
        APP,
        DRIVE,
        req('proxy', { platform: 'pets', connectionId: 'c1', path: '/pets' }),
        undefined,
        proxy,
      ),
    ).rejects.toThrow();
  });
});

describe('the rows of the table an app is a view of (#1740)', () => {
  const TABLE = 'did:ad:transactions';

  it("sends a row's save to the server, which holds the grant", async () => {
    const store = fakeStore({ 'did:ad:row': TABLE });

    await handleRequest(
      store,
      APP,
      DRIVE,
      req('save', { subject: 'did:ad:row', propVals: { p: 'v' } }),
      TABLE,
    );

    expect(sent).toEqual([
      {
        drive: DRIVE,
        app: APP,
        op: 'save',
        subject: 'did:ad:row',
        propVals: { p: 'v' },
      },
    ]);
  });

  it('sends a new row to the server as well', async () => {
    await handleRequest(
      fakeStore(),
      APP,
      DRIVE,
      req('create', { parent: TABLE, isA: ['did:ad:class'] }),
      TABLE,
    );

    expect(sent).toMatchObject([{ op: 'create', parent: TABLE }]);
  });

  it('still refuses rows of other tables before anything leaves', async () => {
    const store = fakeStore({ 'did:ad:elsewhere': 'did:ad:other-table' });

    await expect(
      handleRequest(
        store,
        APP,
        DRIVE,
        req('save', { subject: 'did:ad:elsewhere', propVals: {} }),
        TABLE,
      ),
    ).rejects.toThrow('may only write its own data');
    expect(sent).toEqual([]);
  });

  it('never deletes a row: editing is not deleting', async () => {
    const store = fakeStore({ 'did:ad:row': TABLE });

    await expect(
      handleRequest(
        store,
        APP,
        DRIVE,
        req('destroy', { subject: 'did:ad:row' }),
        TABLE,
      ),
    ).rejects.toThrow(ROW_DESTROY_REFUSED);
    expect(sent).toEqual([]);
  });

  it('tells the app whether it may edit the rows', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        sent.push({ url });

        return {
          ok: true,
          json: async () => ({
            grant: {
              grantedBy: 'did:ad:agent:me',
              grantedAt: 1790000000000,
              via: 'add-view',
            },
            history: [],
          }),
          text: async () => '',
        } as unknown as Response;
      }),
    );

    expect(
      await handleRequest(fakeStore(), APP, DRIVE, req('rowAccess'), TABLE),
    ).toEqual({
      status: 'granted',
      grantedBy: 'did:ad:agent:me',
      grantedAt: 1790000000000,
      via: 'add-view',
    });
    expect(String(sent[0].url)).toContain('/app-row-grant?');
  });

  it('has no rows to give when it is not a table view', async () => {
    expect(
      await handleRequest(fakeStore(), APP, DRIVE, req('rowAccess')),
    ).toEqual({ status: 'unavailable' });
  });

  it('cannot be granted by a host with no one to ask', async () => {
    await expect(
      handleRequest(fakeStore(), APP, DRIVE, req('requestRowAccess'), TABLE),
    ).rejects.toThrow('cannot ask');
  });
});
