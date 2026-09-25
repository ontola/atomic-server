import { beforeEach, describe, expect, it, vi } from 'vitest';
import { core, server } from '@tomic/react';
import type { Store } from '@tomic/react';
import type { ApplyReport, PluginManifest, RunPlan } from '@tomic/react';
import {
  FOREIGN_IMPORTER,
  NO_IMPORTER,
  handleRequest,
  importerRunSummary,
  isHostRequest,
  isWithinApp,
  MAX_GET_MANY,
  resolveAppImporter,
  resourceToOpen,
  ROW_DESTROY_REFUSED,
} from './hostStore';

vi.mock('@tomic/react', async () => {
  const actual =
    await vi.importActual<typeof import('@tomic/react')>('@tomic/react');

  // Signing needs a real key and a real agent; what these tests are about is
  // which requests leave and which are refused before they do.
  return {
    ...actual,
    signRequest: async () => ({}),
    // Reading an importer's stored config is tested in @tomic/lib
    // (plugin-destination.test.ts); here only what `data` passes on.
    destinationTablesFor: async (
      _store: unknown,
      _drive: string,
      table: string,
    ) => (table === 'did:ad:transactions' ? DESTINATION_TABLES : undefined),
    // Likewise: which plugin's Set up made a table is tested in @tomic/lib.
    destinationOwnerOf: async (
      _store: unknown,
      _drive: string,
      table: string,
    ) =>
      table === 'did:ad:transactions' || table === 'did:ad:statements'
        ? IMPORTER
        : undefined,
    findSchema: async () => ({ properties: PLUGIN_TERMS }),
  };
});

const IMPORTER = 'did:ad:importer';
const PLUGIN_TERMS = {
  'plugin-source': 'did:ad:p:source',
  'plugin-schemas': 'did:ad:p:schemas',
  'plugin-connection': 'did:ad:p:connection',
};

const DESTINATION_TABLES = {
  statements: { table: 'did:ad:statements', rowClass: 'did:ad:statement' },
  closingBalances: { table: 'did:ad:balances', rowClass: 'did:ad:balance' },
};

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

  it('names the other tables of a multi-class destination by their keys', async () => {
    const store = fakeStore();

    await expect(
      handleRequest(store, APP, DRIVE, req('data'), 'did:ad:transactions'),
    ).resolves.toEqual({
      table: 'did:ad:transactions',
      rowClass: undefined,
      tables: DESTINATION_TABLES,
    });
    // A single-table destination, or any other table, answers as before.
    await expect(
      handleRequest(store, APP, DRIVE, req('data'), 'did:ad:other'),
    ).resolves.toEqual({ table: 'did:ad:other', rowClass: undefined });
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

describe('getMany', () => {
  /** A store holding `rows` in memory; anything else cannot be read. */
  function rowStore(rows: Record<string, Record<string, unknown>>) {
    const getResource = vi.fn(async (subject: string) => ({
      subject,
      title: String(rows[subject]?.name ?? subject),
      error: rows[subject] ? undefined : new Error(`Unauthorized: ${subject}`),
      getPropVals: () => ({ ...rows[subject] }),
    }));

    return { store: { getResource } as unknown as Store, getResource, rows };
  }

  it('reads each subject as get does, in order, in one answer', async () => {
    const { store, rows } = rowStore({
      'did:ad:a': { name: 'A' },
      'did:ad:b': { name: 'B' },
    });

    const many = (await handleRequest(
      store,
      APP,
      DRIVE,
      req('getMany', { subjects: ['did:ad:b', 'did:ad:a'] }),
    )) as unknown[];
    expect(many).toEqual([
      { subject: 'did:ad:b', title: 'B', props: { name: 'B' }, loading: false },
      { subject: 'did:ad:a', title: 'A', props: { name: 'A' }, loading: false },
    ]);

    // Same store, same state as `get`: a write this page already applied is
    // what both see.
    rows['did:ad:a'] = { name: 'A, edited' };
    const [one] = (await handleRequest(
      store,
      APP,
      DRIVE,
      req('getMany', { subjects: ['did:ad:a'] }),
    )) as Array<{ props: unknown }>;
    const single = (await handleRequest(
      store,
      APP,
      DRIVE,
      req('get', { subject: 'did:ad:a' }),
    )) as { propVals: unknown };
    expect(one.props).toEqual(single.propVals);
    expect(one.props).toEqual({ name: 'A, edited' });
    expect(sent).toEqual([]);
  });

  it('reports one it cannot read in its place, without failing the rest', async () => {
    const { store } = rowStore({ 'did:ad:a': { name: 'A' } });

    expect(
      await handleRequest(
        store,
        APP,
        DRIVE,
        req('getMany', { subjects: ['did:ad:secret', 'did:ad:a'] }),
      ),
    ).toEqual([
      { subject: 'did:ad:secret', error: 'Unauthorized: did:ad:secret' },
      expect.objectContaining({ subject: 'did:ad:a' }),
    ]);
  });

  it(`refuses more than ${MAX_GET_MANY} before reading any`, async () => {
    const { store, getResource } = rowStore({});
    const subjects = Array.from(
      { length: MAX_GET_MANY + 1 },
      (_, i) => `did:ad:${i}`,
    );

    await expect(
      handleRequest(store, APP, DRIVE, req('getMany', { subjects })),
    ).rejects.toThrow(`at most ${MAX_GET_MANY}`);
    expect(getResource).not.toHaveBeenCalled();
  });

  it.each([undefined, 'did:ad:a', [42], [''], [{ subject: 'did:ad:a' }]])(
    'refuses %j as subjects',
    async subjects => {
      const { store, getResource } = rowStore({});
      await expect(
        handleRequest(store, APP, DRIVE, req('getMany', { subjects })),
      ).rejects.toThrow('array of subjects');
      expect(getResource).not.toHaveBeenCalled();
    },
  );
});

describe('route tokens', () => {
  it('lists and revokes through the host, with the arguments in the signed URL', async () => {
    const calls: Array<{ url: string; method?: string }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, method: init.method });

        return {
          ok: true,
          text: async () =>
            url.includes('revoke=')
              ? '{"revoked":true}'
              : '{"tokens":[{"id":"tok_1","name":"storage","scopes":["notes:r"]}]}',
        } as unknown as Response;
      }),
    );

    expect(
      await handleRequest(fakeStore(), APP, DRIVE, req('routeTokens')),
    ).toEqual({
      tokens: [{ id: 'tok_1', name: 'storage', scopes: ['notes:r'] }],
    });
    expect(
      await handleRequest(
        fakeStore(),
        APP,
        DRIVE,
        req('revokeRouteToken', { tokenId: 'tok_1' }),
      ),
    ).toEqual({ revoked: true });
    expect(calls).toEqual([
      {
        url: 'https://node.test/plugin-route-tokens?installation=did%3Aad%3Aapp',
        method: 'GET',
      },
      {
        url: 'https://node.test/plugin-route-tokens?installation=did%3Aad%3Aapp&revoke=tok_1',
        method: 'POST',
      },
    ]);
    await expect(
      handleRequest(fakeStore(), APP, DRIVE, req('revokeRouteToken')),
    ).rejects.toThrow('tokenId is required');
  });
});

describe('readRouteStatus', () => {
  let calls: Array<{ url: string; method?: string }>;

  beforeEach(() => {
    calls = [];
  });

  const storeThatCanWrite = (canWrite: boolean) =>
    ({
      ...(fakeStore() as unknown as Record<string, unknown>),
      getResource: async (subject: string) => ({
        subject,
        canWrite: async () => [canWrite, undefined],
      }),
    }) as unknown as Store;

  const answer = (status: number, text: string) =>
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, method: init.method });

        return {
          ok: status < 400,
          status,
          text: async () => text,
        } as unknown as Response;
      }),
    );

  it('answers the app’s endpoint health, read through the host', async () => {
    answer(
      200,
      JSON.stringify({
        installation: APP,
        state: 'active',
        level: 'read-write',
        routes: [
          {
            id: 'inbox',
            url: 'https://node.test/_routes/x/inbox',
            methods: ['POST'],
            auth: 'none',
            requests24h: 3,
            errors24h: 1,
            lastError: { at: 1, status: 502, message: 'boom' },
            queueDepth: 0,
          },
        ],
        deliveries: {
          queued: 0,
          dead: 1,
          sentToday: 2,
          dailyCap: 10,
          lastFailures: [],
        },
      }),
    );

    const result = await handleRequest(
      storeThatCanWrite(true),
      APP,
      DRIVE,
      req('readRouteStatus'),
    );

    expect(calls).toEqual([
      {
        url: 'https://node.test/plugin-route-status?installation=did%3Aad%3Aapp',
        method: 'GET',
      },
    ]);
    expect(result).toMatchObject({
      installation: APP,
      state: 'active',
      routes: [
        {
          id: 'inbox',
          methods: ['POST'],
          requests24h: 3,
          errors24h: 1,
          lastError: { status: 502, message: 'boom' },
        },
      ],
      deliveries: { dead: 1, sentToday: 2, dailyCap: 10 },
    });
  });

  it('answers null on a server without plugin routes', async () => {
    answer(404, 'Not found');

    expect(
      await handleRequest(
        storeThatCanWrite(true),
        APP,
        DRIVE,
        req('readRouteStatus'),
      ),
    ).toBeNull();
  });

  it('refuses someone who may not write the app, before asking the server', async () => {
    answer(200, '{}');

    await expect(
      handleRequest(
        storeThatCanWrite(false),
        APP,
        DRIVE,
        req('readRouteStatus'),
      ),
    ).rejects.toThrow('Only people who can edit this app see this');
    expect(calls).toEqual([]);
  });
});

describe('running its own importer', () => {
  const MANIFEST: PluginManifest = {
    secrets: [],
    accepts: [{ extensions: ['.sta'], as: 'text', maxBytes: 10 }],
    config: { key: 'bank', required: ['table'] },
  } as unknown as PluginManifest;
  const describePlugin = async () => MANIFEST;

  /** The importer as Set up leaves it: its source, and its config under its key. */
  function importerStore(
    stored: Record<string, unknown> = { table: 'did:ad:transactions' },
  ) {
    const values: Record<string, Record<string, unknown>> = {
      [IMPORTER]: {
        [PLUGIN_TERMS['plugin-source']]: 'export function run() {}',
        [PLUGIN_TERMS['plugin-schemas']]: { bank: stored },
      },
    };

    return {
      getResource: async (subject: string) => ({
        subject,
        title: subject === IMPORTER ? 'Bank statements' : subject,
        get: (property: string) => values[subject]?.[property],
      }),
    } as unknown as Store;
  }

  const resolve = (
    table: string | undefined,
    request: Record<string, unknown> = {},
    store = importerStore(),
  ) => resolveAppImporter(store, DRIVE, table, request, describePlugin);

  it('finds the importer whose table the app shows, from any of its tables', async () => {
    for (const table of ['did:ad:transactions', 'did:ad:statements'])
      await expect(resolve(table)).resolves.toMatchObject({
        importer: IMPORTER,
        title: 'Bank statements',
        source: 'export function run() {}',
        config: { table: 'did:ad:transactions' },
      });
  });

  it('checks a file the app hands over, and passes it on as the upload', async () => {
    await expect(
      resolve('did:ad:transactions', {
        file: { name: 'a.sta', mediaType: 'text/plain', text: ':20:X' },
        importer: IMPORTER,
      }),
    ).resolves.toMatchObject({
      upload: {
        name: 'a.sta',
        mediaType: 'text/plain',
        size: 5,
        text: ':20:X',
      },
    });
    await expect(
      resolve('did:ad:transactions', {
        file: { name: 'big.sta', text: 'x'.repeat(11) },
      }),
    ).rejects.toThrow(/accepts at most 10 bytes/);
    await expect(
      resolve('did:ad:transactions', { file: { text: 'no name' } }),
    ).rejects.toThrow('file must be { name, mediaType?, text }');
  });

  it('takes base64 for an accepts entry read as base64, and only there', async () => {
    const store = importerStore();
    const withBase64: PluginManifest = {
      ...MANIFEST,
      accepts: [
        ...MANIFEST.accepts!,
        { extensions: ['.willow'], as: 'base64', maxBytes: 4 },
      ],
    } as PluginManifest;
    const run = (file: unknown) =>
      resolveAppImporter(
        store,
        DRIVE,
        'did:ad:transactions',
        { file },
        async () => withBase64,
      );

    // Four bytes, 0x00 0x01 0xfe 0xff.
    await expect(
      run({ name: 'a.willow', base64: 'AAH+/w==' }),
    ).resolves.toMatchObject({
      upload: { name: 'a.willow', mediaType: '', size: 4, base64: 'AAH+/w==' },
    });
    // Bounded by the base64 entry, not the text one.
    await expect(run({ name: 'a.willow', base64: 'AAAAAAA=' })).rejects.toThrow(
      /accepts at most 4 bytes/,
    );
    await expect(run({ name: 'a.willow', text: 'abc' })).rejects.toThrow(
      'pass file.base64',
    );
    await expect(run({ name: 'a.sta', base64: 'AAAA' })).rejects.toThrow(
      'pass file.text',
    );
    await expect(
      run({ name: 'a.willow', base64: 'not base64!' }),
    ).rejects.toThrow('standard, padded base64');
    await expect(
      run({ name: 'a.willow', base64: 'AAAA', text: 'x' }),
    ).rejects.toThrow('file must be');
  });

  it('has none on its own page or on a table no importer made', async () => {
    await expect(resolve(undefined)).rejects.toThrow(NO_IMPORTER);
    await expect(resolve('did:ad:someone-elses-table')).rejects.toThrow(
      NO_IMPORTER,
    );
  });

  it('refuses an importer of another package, even one the person can run', async () => {
    await expect(
      resolve('did:ad:transactions', { importer: 'did:ad:other-importer' }),
    ).rejects.toThrow(FOREIGN_IMPORTER);
  });

  it('refuses an importer that still needs Set up', async () => {
    await expect(
      resolve('did:ad:transactions', {}, importerStore({})),
    ).rejects.toThrow(/needs Set up/);
  });

  it('never runs or applies unseen, where the host cannot show the review', async () => {
    await expect(
      handleRequest(
        fakeStore(),
        APP,
        DRIVE,
        req('runImporter', { file: { name: 'a.sta', text: 'x' } }),
        'did:ad:transactions',
      ),
    ).rejects.toThrow(/cannot show an import review/);
    expect(sent).toHaveLength(0);
  });
});

describe('the summary the app gets back', () => {
  const plan = (over: Partial<RunPlan> = {}): RunPlan =>
    ({
      changes: [],
      problems: [],
      minted: {},
      blocked: false,
      ...over,
    }) as RunPlan;

  it('counts what was applied, by kind, and names what failed', () => {
    const report = {
      outcomes: [
        { op: 'create', planned: 'a', subject: 'r1', status: 'applied' },
        { op: 'create', planned: 'b', subject: 'r2', status: 'applied' },
        { op: 'set', planned: 'r3', subject: 'r3', status: 'applied' },
        { op: 'remove', planned: 'r3', subject: 'r3', status: 'applied' },
        { op: 'destroy', planned: 'r4', subject: 'r4', status: 'applied' },
        {
          op: 'create',
          planned: 'c',
          subject: 'c',
          status: 'failed',
          error: 'refused',
        },
      ],
      applied: 5,
      skipped: 0,
      failed: 1,
      subjects: {},
      stoppedEarly: false,
    } as ApplyReport;

    expect(importerRunSummary(IMPORTER, { report, plan: plan() })).toEqual({
      status: 'applied',
      importer: IMPORTER,
      created: 2,
      updated: 1,
      destroyed: 1,
      failed: 1,
      errors: ['refused'],
    });
  });

  it('tells a closed review apart from a refused file and from nothing new', () => {
    expect(importerRunSummary(IMPORTER, {})).toEqual({
      status: 'cancelled',
      importer: IMPORTER,
    });
    expect(
      importerRunSummary(IMPORTER, {
        plan: plan({ changes: [{ op: 'create' }] as RunPlan['changes'] }),
      }),
    ).toEqual({ status: 'cancelled', importer: IMPORTER });
    expect(importerRunSummary(IMPORTER, { plan: plan() })).toEqual({
      status: 'nothing',
      importer: IMPORTER,
    });
    expect(
      importerRunSummary(IMPORTER, {
        plan: plan({
          blocked: true,
          problems: [
            { severity: 'error', message: 'does not reconcile' },
            { severity: 'warning', message: 'just so you know' },
          ],
        }),
      }),
    ).toEqual({
      status: 'blocked',
      importer: IMPORTER,
      errors: ['does not reconcile'],
    });
    expect(
      importerRunSummary(IMPORTER, { error: 'Not a bank statement' }),
    ).toEqual({
      status: 'blocked',
      importer: IMPORTER,
      errors: ['Not a bank statement'],
    });
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
