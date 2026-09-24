import { beforeEach, describe, expect, it, vi } from 'vitest';
import { core, server } from '@tomic/react';
import type { Store } from '@tomic/react';
import {
  handleRequest,
  isHostRequest,
  isWithinApp,
  resourceToOpen,
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

  it('sends removed properties as their own write, since save only sets', async () => {
    const store = fakeStore({ 'did:ad:mine': APP });

    await handleRequest(
      store,
      APP,
      DRIVE,
      req('save', {
        subject: 'did:ad:mine',
        propVals: { p: 'v' },
        remove: ['q'],
      }),
    );

    expect(sent).toEqual([
      {
        drive: DRIVE,
        app: APP,
        op: 'remove',
        subject: 'did:ad:mine',
        properties: ['q'],
      },
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
    disconnect: vi.fn(
      async (_platform: string, also: readonly string[] = []) => [
        'c1',
        ...also,
      ],
    ),
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

describe('openResource', () => {
  const readable = (unreadable: string[] = []) =>
    ({
      getResource: async (subject: string) => ({
        subject,
        error: unreadable.includes(subject)
          ? new Error('Unauthorized')
          : undefined,
      }),
    }) as unknown as Store;

  it('opens a resource the person can read', async () => {
    await expect(resourceToOpen(readable(), 'did:ad:row')).resolves.toBe(
      'did:ad:row',
    );
    await expect(resourceToOpen(readable(), 'atomic:row')).resolves.toBe(
      'atomic:row',
    );
    await expect(
      resourceToOpen(readable(), 'https://atomicdata.dev/classes/Class'),
    ).resolves.toBe('https://atomicdata.dev/classes/Class');
  });

  it('refuses one they cannot read', async () => {
    await expect(
      resourceToOpen(readable(['did:ad:secret']), 'did:ad:secret'),
    ).rejects.toThrow(/cannot open did:ad:secret: Unauthorized/);
  });

  it.each([
    'did:ad:agent:abc',
    'did:ad:commit:abc',
    'atomic:blob:abc',
    'did:ad:node:abc',
    'javascript:alert(1)',
    '/app/dev-drive',
    'row',
    '',
    42,
    undefined,
    `did:ad:${'a'.repeat(3000)}`,
  ])('refuses %s before loading anything', async subject => {
    const store = {
      getResource: vi.fn(),
    } as unknown as Store;
    await expect(resourceToOpen(store, subject)).rejects.toThrow(
      'openResource takes a resource subject',
    );
    expect(store.getResource).not.toHaveBeenCalled();
  });
});

describe('proxy.disconnect', () => {
  const proxy = () => ({
    capability: vi.fn(),
    connections: vi.fn(),
    disconnect: vi.fn(
      async (_platform: string, also: readonly string[] = []) => [
        'c1',
        ...also,
      ],
    ),
  });

  /** An app resource that may carry `integrationConnections`, and records saves. */
  function appStore(recorded?: Record<string, string>) {
    let props: Record<string, unknown> = recorded
      ? { [server.properties.integrationConnections]: recorded }
      : {};
    const saved: Array<Record<string, unknown>> = [];
    const resource = {
      subject: APP,
      error: undefined,
      get: (p: string) => props[p],
      getPropVals: () => props,
      set: async (p: string, v: unknown) => {
        props = { ...props, [p]: v };
      },
      remove: (p: string) => {
        const { [p]: _gone, ...rest } = props;
        props = rest;
      },
      save: async () => {
        saved.push(props);
      },
    };

    return {
      store: {
        getResource: async () => resource,
      } as unknown as Store,
      saved,
    };
  }

  it('takes only this app delegation away and never touches the server', async () => {
    const p = proxy();
    const { store, saved } = appStore();

    expect(
      await handleRequest(
        store,
        APP,
        DRIVE,
        req('proxyDisconnect', { platform: 'pets' }),
        undefined,
        p,
      ),
    ).toEqual({
      status: 'disconnected',
      platform: 'pets',
      connectionIds: ['c1'],
    });
    expect(p.disconnect).toHaveBeenCalledWith('pets', []);
    // A `createApp` app records nothing on itself.
    expect(saved).toEqual([]);
    expect(sent).toEqual([]);
  });

  it('on an Installation, also forgets integrationConnections[platform]', async () => {
    const p = proxy();
    const { store, saved } = appStore({ pets: 'recorded', other: 'c-other' });

    const result = await handleRequest(
      store,
      APP,
      DRIVE,
      req('proxyDisconnect', { platform: 'pets' }),
      undefined,
      p,
    );

    // The recorded id is undelegated even when the proxy no longer lists it
    // as this app's, as the Installation page's Disconnect does.
    expect(p.disconnect).toHaveBeenCalledWith('pets', ['recorded']);
    expect(result).toMatchObject({ connectionIds: ['c1', 'recorded'] });
    expect(saved).toEqual([
      { [server.properties.integrationConnections]: { other: 'c-other' } },
    ]);
  });

  it('refuses without a proxy or with a bad platform', async () => {
    const { store } = appStore();
    await expect(
      handleRequest(
        store,
        APP,
        DRIVE,
        req('proxyDisconnect', { platform: 'pets' }),
      ),
    ).rejects.toThrow('cannot reach the integration proxy');
    const p = proxy();
    await expect(
      handleRequest(
        store,
        APP,
        DRIVE,
        req('proxyDisconnect', { platform: '../pets' }),
        undefined,
        p,
      ),
    ).rejects.toThrow('Invalid platform');
    expect(p.disconnect).not.toHaveBeenCalled();
  });
});
