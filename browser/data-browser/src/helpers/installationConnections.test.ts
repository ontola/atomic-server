// @vitest-environment jsdom
// @wc-ignore-file
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  Agent,
  JSCryptoProvider,
  core,
  server,
  type Resource,
  type Store,
} from '@tomic/react';
import { ProxyConnections } from './proxyConnections';
import {
  connectionsOf,
  delegateExistingConnection,
  disconnectInstallationPlatform,
  finishProxyReturn,
  installationUsesProxy,
  proxyPlatformsOf,
  startInstallationConnect,
} from './installationConnections';
import {
  forgetRegisteredRuntimes,
  registerInstallationRuntimes,
} from './installationRuntimes';
import { registerRuntimesInBackground } from './useInstallationRuntimes';
import { getIntegrationProxy } from './integrationProxy';

const ORIGIN = 'http://proxy.test';
const PAGE = location.origin;
const PRIVATE_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const USER_PUBLIC = 'O2onvM62pC1io6jQKm8Nc2UyFXcd4kOmOsBIoYtZ2ik';
const USER = `atomic:agent:${USER_PUBLIC}`;
const APP = `atomic:agent:${'A'.repeat(42)}E`;
const NODE = `atomic:agent:${'B'.repeat(42)}E`;
const INSTALLATION = 'did:ad:installation';
const RELEASE = 'did:ad:release';
const RUNTIME = 'did:ad:runtime';

const user = () =>
  new Agent(new JSCryptoProvider(PRIVATE_KEY), `did:ad:agent:${USER_PUBLIC}`);

/**
 * The proxy routes this flow uses. Every call must carry a v2 signature by
 * the user (checked in `installationRuntimes.test.ts` and
 * `proxyConnections.test.ts`; here only the headers are).
 */
function fakeProxy() {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const connections = [
    {
      connection_id: 'old-demo',
      platform: 'demo',
      owner: USER,
      delegations: [] as { agent: string; label?: string }[],
    },
  ];
  const http = vi.fn(async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    const headers = init.headers as Record<string, string>;
    const path = new URL(url).pathname;
    const body = init.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ method, path, body });

    if (
      headers['x-atomic-signature-version'] !== '2' ||
      headers['x-atomic-agent'] !== USER
    )
      return Response.json({ error: 'bad_signature' }, { status: 401 });

    if (path === '/connect/redeem' && method === 'POST') {
      connections.push({
        connection_id: 'new-demo',
        platform: 'demo',
        owner: USER,
        delegations: [],
      });

      return Response.json({ connection_id: 'new-demo', platform: 'demo' });
    }

    if (path === '/connections' && method === 'GET')
      return Response.json({ owner: USER, connections, runtimes: [] });

    const agents = /^\/connections\/([^/]+)\/agents(?:\/([^/]+))?$/.exec(path);
    const row = agents && connections.find(c => c.connection_id === agents[1]);

    if (row && method === 'POST' && !agents![2]) {
      row.delegations.push(body);

      return Response.json({ ok: true });
    }

    if (row && method === 'DELETE' && agents![2]) {
      const agent = decodeURIComponent(agents![2]);
      const before = row.delegations.length;
      row.delegations = row.delegations.filter(d => d.agent !== agent);

      return before === row.delegations.length
        ? Response.json({ error: 'not_found' }, { status: 404 })
        : new Response(null, { status: 204 });
    }

    if (path === '/runtimes' && method === 'POST') return Response.json(body);

    return Response.json({ error: 'not_found' }, { status: 404 });
  });

  return { http: http as unknown as typeof fetch, calls, connections };
}

class MemoryStorage implements Storage {
  private map = new Map<string, string>();
  get length() {
    return this.map.size;
  }
  clear() {
    this.map.clear();
  }
  getItem(key: string) {
    return this.map.get(key) ?? null;
  }
  key(i: number) {
    return [...this.map.keys()][i] ?? null;
  }
  removeItem(key: string) {
    this.map.delete(key);
  }
  setItem(key: string, value: string) {
    this.map.set(key, value);
  }
}

/** A resource as far as these helpers read and write one. */
function fakeResource(
  subject: string,
  props: Record<string, unknown>,
  createdBy?: string,
) {
  const saves: Record<string, unknown>[] = [];
  const resource = {
    subject,
    get: (p: string) => props[p],
    hasClasses: (...c: string[]) =>
      c.every(x =>
        ((props[core.properties.isA] as string[]) ?? []).includes(x),
      ),
    getCreatedBy: () => createdBy,
    set: async (p: string, v: unknown) => {
      props[p] = v;
    },
    remove: (p: string) => {
      delete props[p];
    },
    save: async () => {
      saves.push(structuredClone(props));
    },
  } as unknown as Resource;

  return { resource, props, saves };
}

function fakeStore(...resources: Resource[]) {
  const all = new Map(resources.map(r => [r.subject, r] as const));

  return {
    getAgent: user,
    getResource: async (s: string) => {
      const found = all.get(s);
      if (!found) throw new Error(`not found: ${s}`);

      return found;
    },
  } as unknown as Store;
}

function installation(extra: Record<string, unknown> = {}) {
  return fakeResource(INSTALLATION, {
    [core.properties.name]: 'Demo plugin',
    [core.properties.parent]: 'did:ad:drive',
    [server.properties.integrationAppAgent]: APP,
    [server.properties.release]: RELEASE,
    ...extra,
  });
}

const release = (manifest: unknown) =>
  fakeResource(RELEASE, { [server.properties.manifest]: manifest }).resource;

const runtime = () =>
  fakeResource(
    RUNTIME,
    {
      [core.properties.isA]: [server.classes.installationRuntime],
      [core.properties.parent]: INSTALLATION,
      [server.properties.integrationRuntimeAgent]: NODE,
      [core.properties.name]: 'Laptop',
    },
    NODE,
  ).resource;

const connectionsFor = (
  proxy: ReturnType<typeof fakeProxy>,
  storage = new MemoryStorage(),
) => new ProxyConnections(storage, ORIGIN, user, proxy.http);

beforeEach(() => forgetRegisteredRuntimes());

describe('reading the manifest and the map', () => {
  it('reads proxy platforms and connections, dropping junk', () => {
    expect(proxyPlatformsOf({ proxy: ['demo', 'Bad!', 'demo', 3] })).toEqual([
      'demo',
    ]);
    expect(proxyPlatformsOf('{"proxy":["a-b"]}')).toEqual(['a-b']);
    expect(proxyPlatformsOf({})).toEqual([]);
    expect(connectionsOf('{"demo":"c1","x":5}')).toEqual({ demo: 'c1' });
    expect(connectionsOf(['demo'])).toEqual({});
  });
});

describe('connecting a platform on an Installation', () => {
  it('connect: /connect, signed redeem, delegation to the app id, then integrationConnections', async () => {
    const proxy = fakeProxy();
    const storage = new MemoryStorage();
    const inst = installation();
    const store = fakeStore(inst.resource, release({ proxy: ['demo'] }));

    const start = new URL(
      await startInstallationConnect(
        connectionsFor(proxy, storage),
        inst.resource,
        'demo',
        `${PAGE}/app/show?subject=x`,
      ),
    );
    expect(start.origin + start.pathname).toBe(`${ORIGIN}/connect`);
    expect(start.searchParams.get('platform')).toBe('demo');

    const back = new URL(start.searchParams.get('redirect_uri')!);
    back.searchParams.set('connection_code', 'handoff');
    const returnTo = await finishProxyReturn(
      store,
      connectionsFor(proxy, storage),
      back.searchParams,
    );

    expect(returnTo).toBe(`${PAGE}/app/show?subject=x`);
    expect(proxy.calls.map(c => [c.method, c.path])).toEqual([
      ['POST', '/connect/redeem'],
      ['POST', '/connections/new-demo/agents'],
    ]);
    expect(proxy.calls[1].body).toEqual({ agent: APP, label: 'Demo plugin' });
    expect(inst.saves).toHaveLength(1);
    expect(inst.props[server.properties.integrationConnections]).toEqual({
      demo: 'new-demo',
    });
  });

  it('a connect started by an app frame records nothing on an Installation', async () => {
    const proxy = fakeProxy();
    const storage = new MemoryStorage();
    const inst = installation();
    const connections = connectionsFor(proxy, storage);
    const start = new URL(
      await connections.start(
        { drive: 'd', app: INSTALLATION, appAgent: APP },
        'demo',
        `${PAGE}/x`,
        'App',
        PAGE,
      ),
    );
    const back = new URL(start.searchParams.get('redirect_uri')!);
    back.searchParams.set('connection_code', 'handoff');
    await finishProxyReturn(
      fakeStore(inst.resource),
      connections,
      back.searchParams,
    );
    expect(inst.saves).toEqual([]);
  });

  it('use existing connection: delegates it and records it, keeping other platforms', async () => {
    const proxy = fakeProxy();
    const inst = installation({
      [server.properties.integrationConnections]: { other: 'c-other' },
    });
    const store = fakeStore(inst.resource);

    await delegateExistingConnection(
      store,
      connectionsFor(proxy),
      inst.resource,
      {
        connection_id: 'old-demo',
        platform: 'demo',
        delegations: [],
      },
    );

    expect(proxy.calls.map(c => [c.method, c.path, c.body])).toEqual([
      [
        'POST',
        '/connections/old-demo/agents',
        { agent: APP, label: 'Demo plugin' },
      ],
    ]);
    expect(inst.props[server.properties.integrationConnections]).toEqual({
      other: 'c-other',
      demo: 'old-demo',
    });
  });

  it('refuses without an app id, before calling the proxy', async () => {
    const proxy = fakeProxy();
    const inst = installation({
      [server.properties.integrationAppAgent]: undefined,
    });
    await expect(
      startInstallationConnect(
        connectionsFor(proxy),
        inst.resource,
        'demo',
        `${PAGE}/x`,
      ),
    ).rejects.toThrow('no app id');
    expect(proxy.calls).toEqual([]);
  });
});

describe('disconnecting a platform', () => {
  it('removes the delegation at the proxy, then the key', async () => {
    const proxy = fakeProxy();
    proxy.connections[0].delegations.push({ agent: APP });
    const inst = installation({
      [server.properties.integrationConnections]: {
        demo: 'old-demo',
        other: 'c-other',
      },
    });

    await disconnectInstallationPlatform(
      fakeStore(inst.resource),
      connectionsFor(proxy),
      inst.resource,
      'demo',
    );

    expect(proxy.calls.map(c => [c.method, c.path])).toEqual([
      ['DELETE', `/connections/old-demo/agents/${encodeURIComponent(APP)}`],
    ]);
    expect(proxy.connections[0].delegations).toEqual([]);
    expect(inst.props[server.properties.integrationConnections]).toEqual({
      other: 'c-other',
    });
  });

  it('removes the property once the last key goes, and treats a missing delegation as gone', async () => {
    const proxy = fakeProxy();
    const inst = installation({
      [server.properties.integrationConnections]: { demo: 'old-demo' },
    });

    await disconnectInstallationPlatform(
      fakeStore(inst.resource),
      connectionsFor(proxy),
      inst.resource,
      'demo',
    );

    expect(proxy.calls).toHaveLength(1);
    expect(server.properties.integrationConnections in inst.props).toBe(false);
    expect(inst.saves).toHaveLength(1);
  });

  it('keeps the key when the proxy refuses', async () => {
    const proxy = fakeProxy();
    const inst = installation({
      [server.properties.integrationConnections]: { demo: 'old-demo' },
    });
    const refusing = new ProxyConnections(
      new MemoryStorage(),
      ORIGIN,
      user,
      (async () =>
        Response.json(
          { error: 'unavailable', message: 'down' },
          { status: 503 },
        )) as unknown as typeof fetch,
    );

    await expect(
      disconnectInstallationPlatform(
        fakeStore(inst.resource),
        refusing,
        inst.resource,
        'demo',
      ),
    ).rejects.toThrow('down');
    expect(inst.props[server.properties.integrationConnections]).toEqual({
      demo: 'old-demo',
    });
    expect(proxy.calls).toEqual([]);
  });
});

describe('no proxy traffic for a plain Installation', () => {
  const fetchSpy = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
    Response.json({}),
  );

  beforeEach(() => {
    fetchSpy.mockClear();
    vi.stubGlobal('fetch', fetchSpy);
  });
  afterEach(() => vi.unstubAllGlobals());

  const toProxy = () =>
    fetchSpy.mock.calls.filter(([url]) =>
      String(url).startsWith(getIntegrationProxy()),
    );

  it('never fetches the proxy when the manifest declares no proxy and nothing is connected', async () => {
    const inst = installation();
    const store = fakeStore(
      inst.resource,
      release({ schemaVersion: 1, operations: [] }),
      runtime(),
    );

    expect(await installationUsesProxy(store, inst.resource)).toBe(false);
    expect(
      await registerInstallationRuntimes(
        store,
        connectionsFor(fakeProxy()),
        INSTALLATION,
        [RUNTIME],
      ),
    ).toEqual([]);

    // The path the Installation page and app frames take, on the real fetch.
    registerRuntimesInBackground(store, INSTALLATION, [RUNTIME]);
    await new Promise(resolve => setTimeout(resolve, 20));

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('does contact the proxy once the manifest declares a platform', async () => {
    const inst = installation();
    const store = fakeStore(
      inst.resource,
      release({ proxy: ['demo'] }),
      runtime(),
    );

    registerRuntimesInBackground(store, INSTALLATION, [RUNTIME]);
    await vi.waitFor(() => expect(toProxy().length).toBeGreaterThan(0));
    expect(String(toProxy()[0][0])).toBe(
      `${getIntegrationProxy()}/connections`,
    );
  });

  it('does contact the proxy when a connection is recorded, whatever the manifest says', async () => {
    const inst = installation({
      [server.properties.integrationConnections]: { demo: 'c1' },
      [server.properties.release]: undefined,
    });

    expect(
      await installationUsesProxy(fakeStore(inst.resource), inst.resource),
    ).toBe(true);
  });
});
