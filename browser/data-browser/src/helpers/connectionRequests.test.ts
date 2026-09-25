// @vitest-environment jsdom
// @wc-ignore-file
import { describe, expect, it, vi } from 'vitest';
import {
  Agent,
  JSCryptoProvider,
  core,
  server,
  type Resource,
  type Store,
} from '@tomic/react';

/** `parent → children`, standing in for the server's `parent=` query. */
const children = new Map<string, string[]>();

vi.mock('@tomic/react', async original => {
  const actual = await original<typeof import('@tomic/react')>();

  class CollectionBuilder {
    private value = '';
    setProperty() {
      return this;
    }
    setValue(value: string) {
      this.value = value;

      return this;
    }
    setPageSize() {
      return this;
    }
    build() {
      const value = this.value;

      return { getAllMembers: async () => children.get(value) ?? [] };
    }
  }

  return { ...actual, CollectionBuilder };
});

const { readConnectionRequests, clearConnectionRequests, isOpenRequest } =
  await import('./connectionRequests');
const { delegateExistingConnection } =
  await import('./installationConnections');
const { ProxyConnections } = await import('./proxyConnections');

const PRIVATE_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const USER_PUBLIC = 'O2onvM62pC1io6jQKm8Nc2UyFXcd4kOmOsBIoYtZ2ik';
const APP = `atomic:agent:${'A'.repeat(42)}E`;
const NODE = `atomic:agent:${'B'.repeat(42)}E`;
const OTHER = `atomic:agent:${'C'.repeat(42)}E`;
const INSTALLATION = 'did:ad:installation';
const RUNTIME = 'did:ad:runtime';

const user = () =>
  new Agent(new JSCryptoProvider(PRIVATE_KEY), `did:ad:agent:${USER_PUBLIC}`);

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

function request(
  subject: string,
  platform: string,
  extra: Record<string, unknown> = {},
  createdBy = NODE,
) {
  return fakeResource(
    subject,
    {
      [core.properties.isA]: [server.classes.connectionRequest],
      [core.properties.parent]: RUNTIME,
      [server.properties.connectionRequestPlatform]: platform,
      [server.properties.connectionRequestReason]: 'not-connected',
      [server.properties.connectionRequestedAt]: 1000,
      ...extra,
    },
    createdBy,
  );
}

/** An Installation with one node's runtime, and `requests` under it. */
function setup(...requests: ReturnType<typeof request>[]) {
  const installation = fakeResource(INSTALLATION, {
    [core.properties.name]: 'Timesheets',
    [core.properties.parent]: 'did:ad:drive',
    [server.properties.integrationAppAgent]: APP,
  });
  const runtime = fakeResource(
    RUNTIME,
    {
      [core.properties.isA]: [server.classes.installationRuntime],
      [core.properties.parent]: INSTALLATION,
      [server.properties.integrationRuntimeAgent]: NODE,
      [core.properties.name]: 'Server',
    },
    NODE,
  );
  children.clear();
  children.set(INSTALLATION, [RUNTIME]);
  children.set(
    RUNTIME,
    requests.map(r => r.resource.subject),
  );
  const all = new Map(
    [installation, runtime, ...requests].map(
      r => [r.resource.subject, r.resource] as const,
    ),
  );
  const store = {
    getAgent: user,
    getResource: async (s: string) => {
      const found = all.get(s);
      if (!found) throw new Error(`not found: ${s}`);

      return found;
    },
  } as unknown as Store;

  return { store, installation };
}

/** A proxy that accepts the delegation the use-existing path posts. */
function proxy() {
  const calls: string[] = [];
  const http = vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push(`${init.method ?? 'GET'} ${new URL(url).pathname}`);

    return Response.json({ ok: true });
  }) as unknown as typeof fetch;

  return {
    calls,
    connections: new ProxyConnections(
      new Map() as unknown as Storage,
      'http://proxy.test',
      user,
      http,
    ),
  };
}

describe('reading connection requests', () => {
  it('reads the requests a node wrote under its own runtime', async () => {
    const open = request('did:ad:open', 'clockify', {}, NODE);
    const forged = request('did:ad:forged', 'github', {}, OTHER);
    const cleared = request('did:ad:cleared', 'notion', {
      [server.properties.connectionRequestClearedAt]: 2000,
    });
    const { store } = setup(open, forged, cleared);

    const found = await readConnectionRequests(store, INSTALLATION);

    // Written by someone other than the runtime's agent: not a request.
    expect(found.map(r => r.subject)).toEqual([
      'did:ad:open',
      'did:ad:cleared',
    ]);
    expect(found.filter(isOpenRequest).map(r => r.platform)).toEqual([
      'clockify',
    ]);
    expect(found[0].runtime.label).toBe('Server');
  });

  it('a request asked again after it was cleared is open', async () => {
    const reopened = request('did:ad:again', 'clockify', {
      [server.properties.connectionRequestClearedAt]: 500,
    });
    const { store } = setup(reopened);

    const [found] = await readConnectionRequests(store, INSTALLATION);
    expect(isOpenRequest(found)).toBe(true);
  });
});

describe('clearing connection requests', () => {
  it('connecting a platform records it and clears its open requests, signed by the user', async () => {
    const clockify = request('did:ad:clockify', 'clockify');
    const github = request('did:ad:github', 'github');
    const { store, installation } = setup(clockify, github);
    const { calls, connections } = proxy();

    await delegateExistingConnection(
      store,
      connections,
      installation.resource,
      {
        connection_id: 'conn-1',
        platform: 'clockify',
        delegations: [],
      },
    );

    expect(calls).toEqual(['POST /connections/conn-1/agents']);
    expect(
      installation.props[server.properties.integrationConnections],
    ).toEqual({ clockify: 'conn-1' });
    // The clockify request is cleared in its own commit; github's is left.
    expect(clockify.saves).toHaveLength(1);
    expect(
      clockify.props[server.properties.connectionRequestClearedAt],
    ).toBeGreaterThanOrEqual(1000);
    expect(github.saves).toHaveLength(0);
    expect(await readConnectionRequests(store, INSTALLATION)).toMatchObject([
      { platform: 'clockify', clearedAt: expect.any(Number) },
      { platform: 'github', clearedAt: undefined },
    ]);
  });

  it('clears nothing that is already cleared', async () => {
    const cleared = request('did:ad:cleared', 'clockify', {
      [server.properties.connectionRequestClearedAt]: 2000,
    });
    const { store } = setup(cleared);

    expect(await clearConnectionRequests(store, INSTALLATION, 'clockify')).toBe(
      0,
    );
    expect(cleared.saves).toHaveLength(0);
  });
});
