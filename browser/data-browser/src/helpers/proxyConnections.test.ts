// @wc-ignore-file
import { describe, expect, it, vi } from 'vitest';
import { ProxyConnections, proxyUrl } from './proxyConnections';

const ORIGIN = 'http://proxy.test';
const PAGE = 'http://atomic.test';
const SCOPE = {
  drive: 'did:ad:drive',
  actor: 'did:ad:agent:me',
  app: 'did:ad:app',
};

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
  values() {
    return [...this.map.values()].join('\n');
  }
}

const locks = {
  request: (_name: string, run: () => Promise<unknown>) => run(),
} as unknown as Pick<LockManager, 'request'>;

function response(
  status: number,
  body: string,
  headers: Record<string, string> = {},
) {
  return new Response(body, { status, headers });
}

/** A proxy that hands out one code per call, like LocalThought's. */
function fakeProxy() {
  let n = 0;
  const calls: { url: string; init: RequestInit }[] = [];
  const http = vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });

    if (url.endsWith('/connect/redeem'))
      return response(
        200,
        JSON.stringify({ connection_code: `code-${n++}`, platform: 'pets' }),
      );

    return response(200, JSON.stringify([{ id: 1 }]), {
      'x-connection-code': `code-${n++}`,
      link: '<https://pets.example/pets?page=2>; rel="next"',
      'set-cookie': 'never=forwarded',
    });
  });

  return { http: http as unknown as typeof fetch, calls };
}

async function connected(storage = new MemoryStorage()) {
  const proxy = fakeProxy();
  const connections = new ProxyConnections(storage, ORIGIN, proxy.http, locks);
  const url = new URL(
    await connections.start(SCOPE, 'pets', `${PAGE}/app/show?subject=x`, PAGE),
  );
  const back = new URL(url.searchParams.get('redirect_uri')!);
  back.searchParams.set('connection_code', 'handoff');
  expect(connections.isReturn(back.searchParams)).toBe(true);
  const finished = await connections.finish(back.searchParams);

  return { connections, proxy, storage, url, back, finished };
}

describe('ProxyConnections', () => {
  it('starts PKCE towards the proxy and returns via /app/integrations', async () => {
    const { url, back, finished } = await connected();
    expect(url.origin + url.pathname).toBe(`${ORIGIN}/connect`);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('user_id')).toBe(SCOPE.actor);
    expect(back.pathname).toBe('/app/integrations');
    expect(back.searchParams.get('platform')).toBe('pets');
    expect(finished).toEqual({
      returnTo: `${PAGE}/app/show?subject=x`,
      connected: true,
    });
  });

  it('lists references only, and only for the app that connected', async () => {
    const { connections } = await connected();
    const [ref] = connections.list(SCOPE, 'pets');
    expect(Object.keys(ref).sort()).toEqual(['connectionId', 'platform']);
    expect(connections.list({ ...SCOPE, app: 'did:ad:other' }, 'pets')).toEqual(
      [],
    );
    expect(connections.list(SCOPE, 'notion')).toEqual([]);
  });

  it('relays a call, rotates the code, and never returns it', async () => {
    const { connections, proxy, storage } = await connected();
    const [ref] = connections.list(SCOPE, 'pets');
    const result = await connections.relay(SCOPE).request({
      ...ref,
      path: '/pets',
      query: { page: '2' },
    });
    expect(result).toEqual({
      status: 200,
      headers: {
        link: '<https://pets.example/pets?page=2>; rel="next"',
        'content-type': 'text/plain;charset=UTF-8',
      },
      body: [{ id: 1 }],
    });
    const call = proxy.calls.at(-1)!;
    expect(call.url).toBe(`${ORIGIN}/proxy/pets/pets?page=2`);
    expect((call.init.headers as Record<string, string>).Authorization).toBe(
      'Bearer code-0',
    );
    expect(JSON.stringify(result)).not.toContain('code-');
    expect(storage.values()).toContain('"code":"code-1"');
  });

  it('refuses another app, platform or path escape', async () => {
    const { connections } = await connected();
    const [ref] = connections.list(SCOPE, 'pets');
    await expect(
      connections
        .relay({ ...SCOPE, app: 'did:ad:other' })
        .request({ ...ref, path: '/pets' }),
    ).rejects.toThrow('No pets connection for this app');
    await expect(
      connections
        .relay(SCOPE)
        .request({ ...ref, platform: 'notion', path: '/pets' }),
    ).rejects.toThrow('No notion connection');
    for (const path of ['pets', '//evil.test/x', '/../../connect', '/a#b'])
      expect(() => proxyUrl(ORIGIN, 'pets', path)).toThrow();
    await expect(
      connections
        .relay(SCOPE)
        .request({ ...ref, path: '/pets', method: 'GET', body: '{}' }),
    ).rejects.toThrow('GET');
  });

  it('forgets a handoff the person refused, and ignores foreign returns', async () => {
    const storage = new MemoryStorage();
    const connections = new ProxyConnections(
      storage,
      ORIGIN,
      fakeProxy().http,
      locks,
    );
    const url = new URL(
      await connections.start(SCOPE, 'pets', `${PAGE}/app`, PAGE),
    );
    const back = new URL(url.searchParams.get('redirect_uri')!);
    back.searchParams.set('error', 'access_denied');
    expect(await connections.finish(back.searchParams)).toEqual({
      returnTo: `${PAGE}/app`,
      connected: false,
    });
    expect(storage.length).toBe(0);
    expect(
      connections.isReturn(new URLSearchParams('integration_state=nope')),
    ).toBe(false);
  });
});
