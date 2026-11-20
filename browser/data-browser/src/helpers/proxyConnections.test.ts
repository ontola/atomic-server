// @wc-ignore-file
import { describe, expect, it, vi } from 'vitest';
import {
  AGENT_VAULT_PROOF_MESSAGE,
  Agent,
  JSCryptoProvider,
  decodeB64,
} from '@tomic/react';
import { deriveConnectionKey, fromBase64url } from './connectionKeys';
import {
  CAPABILITY_TTL_SECONDS,
  ProxyConnections,
  canonicalAgent,
  capabilityClaims,
} from './proxyConnections';

const ORIGIN = 'http://proxy.test';
const PAGE = 'http://atomic.test';
/** The key of `lib/src/authentication_v2_vectors.json`. */
const PRIVATE_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const USER_PUBLIC = 'O2onvM62pC1io6jQKm8Nc2UyFXcd4kOmOsBIoYtZ2ik';
const USER = `atomic:agent:${USER_PUBLIC}`;
const APP_AGENT = `atomic:agent:${'A'.repeat(42)}E`;
const FRAME_KEY = `${'B'.repeat(42)}E`;
const SCOPE = { drive: 'atomic:drive', app: 'atomic:app', appAgent: APP_AGENT };
/** Any 32 bytes do as the proxy's grant public key here. */
const PROXY_GRANT_KEY = 'C'.repeat(42) + 'E';

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

const user = () =>
  new Agent(new JSCryptoProvider(PRIVATE_KEY), `did:ad:agent:${USER_PUBLIC}`);

async function verify(publicKey: string, message: Uint8Array, sig: string) {
  const key = await crypto.subtle.importKey(
    'raw',
    new Uint8Array(decodeB64(publicKey)),
    { name: 'Ed25519' },
    false,
    ['verify'],
  );

  return crypto.subtle.verify(
    { name: 'Ed25519' },
    key,
    new Uint8Array(decodeB64(sig)),
    new Uint8Array(message),
  );
}

async function sha256Hex(text: string) {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)),
    ),
    b => b.toString(16).padStart(2, '0'),
  ).join('');
}

/**
 * A proxy that checks every call's v2 signature the way the real one does,
 * and keeps connections and delegations.
 */
function fakeProxy() {
  const calls: { method: string; url: string; body?: string }[] = [];
  const connections: {
    connection_id: string;
    platform: string;
    owner: string;
    delegations: { agent: string; label?: string }[];
  }[] = [
    {
      connection_id: 'old',
      platform: 'pets',
      owner: USER,
      delegations: [],
    },
  ];
  const http = vi.fn(async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    const body = init.body as string | undefined;
    const h = (init.headers ?? {}) as Record<string, string>;
    calls.push({ method, url, body });

    // Public and unsigned.
    if (new URL(url).pathname === '/connection-key-grants/key')
      return Response.json({
        kem: 'DHKEM(X25519, HKDF-SHA256)',
        kdf: 'HKDF-SHA256',
        aead: 'AES-256-GCM',
        info: 'integration-proxy-connection-key-grant-v1',
        public_key: PROXY_GRANT_KEY,
      });
    const message = [
      'atomic-request-v2',
      method,
      url,
      h['x-atomic-timestamp'],
      await sha256Hex(body ?? ''),
    ].join('\n');

    if (
      h['x-atomic-signature-version'] !== '2' ||
      h['x-atomic-agent'] !== `atomic:agent:${h['x-atomic-public-key']}` ||
      !(await verify(
        h['x-atomic-public-key'],
        new TextEncoder().encode(message),
        h['x-atomic-signature'],
      ))
    )
      return Response.json(
        { error: 'bad_signature', message: 'no' },
        { status: 401 },
      );

    const path = new URL(url).pathname;

    if (path === '/connect/redeem') {
      const { connection_id, connection_key } = JSON.parse(body!);

      if (
        !/^[A-Za-z0-9_-]{43}$/.test(connection_id) ||
        !/^k1\.[A-Za-z0-9_-]{43}$/.test(connection_key)
      )
        return Response.json(
          { error: 'bad_request', message: 'id or key' },
          { status: 400 },
        );

      connections.push({
        connection_id,
        platform: 'pets',
        owner: h['x-atomic-agent'],
        delegations: [],
      });

      return Response.json({
        connection_id,
        platform: 'pets',
        owner: h['x-atomic-agent'],
      });
    }

    if (path === '/connections' && method === 'GET')
      return Response.json({ owner: USER, connections, runtimes: [] });

    const agents = /^\/connections\/([^/]+)\/agents$/.exec(path);

    if (agents && method === 'POST') {
      const row = connections.find(c => c.connection_id === agents[1])!;
      row.delegations.push(JSON.parse(body!));

      return Response.json({ ok: true });
    }

    return Response.json(
      { error: 'not_found', message: path },
      { status: 404 },
    );
  });

  return { http: http as unknown as typeof fetch, calls, connections };
}

async function connected(storage = new MemoryStorage()) {
  const proxy = fakeProxy();
  const connections = new ProxyConnections(
    storage,
    ORIGIN,
    user,
    proxy.http,
    () => 1_790_000_000_000,
  );
  const url = new URL(
    await connections.start(
      SCOPE,
      'pets',
      `${PAGE}/app/show?subject=x`,
      'Pets app',
      PAGE,
    ),
  );
  const back = new URL(url.searchParams.get('redirect_uri')!);
  back.searchParams.set('connection_code', 'handoff');
  expect(connections.isReturn(back.searchParams)).toBe(true);
  const finished = await connections.finish(back.searchParams);

  return { connections, proxy, storage, url, back, finished };
}

describe('ProxyConnections', () => {
  it('starts PKCE towards the proxy without a user id', async () => {
    const { url, back, finished } = await connected();
    expect(url.origin + url.pathname).toBe(`${ORIGIN}/connect`);
    expect(url.searchParams.get('user_id')).toBeNull();
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(back.origin + back.pathname).toBe(`${PAGE}/app/integrations`);
    expect(finished).toEqual({
      returnTo: `${PAGE}/app/show?subject=x`,
      connected: true,
      connectionId: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
    });
  });

  it('chooses the connection id and sends the key derived for it', async () => {
    const { proxy, finished } = await connected();
    const id = finished.connectionId!;
    const redeem = JSON.parse(proxy.calls[0].body!);
    expect(redeem.connection_id).toBe(id);
    // The key is the user's vault proof through HKDF, for this proxy and id:
    // every device holding the agent derives it again, and nothing stores it.
    const proof = new Uint8Array(
      decodeB64(await user().signBytes(AGENT_VAULT_PROOF_MESSAGE)),
    );
    const key = deriveConnectionKey(proof, ORIGIN, id);
    expect(redeem.connection_key).toBe(
      `k1.${btoa(String.fromCharCode(...key))
        .replaceAll('+', '-')
        .replaceAll('/', '_')
        .replaceAll('=', '')}`,
    );
    // Another proxy or connection gets another key.
    expect(deriveConnectionKey(proof, 'https://other.example', id)).not.toEqual(
      key,
    );
    // A second connect picks a new id.
    const second = await connected();
    expect(second.finished.connectionId).not.toBe(id);
  });

  it('redeems signed by the user, then delegates to the app, signed too', async () => {
    const { proxy, storage, finished } = await connected();
    expect(proxy.calls.map(c => [c.method, new URL(c.url).pathname])).toEqual([
      ['POST', '/connect/redeem'],
      ['POST', `/connections/${finished.connectionId}/agents`],
    ]);
    expect(JSON.parse(proxy.calls[0].body!)).toMatchObject({
      code: 'handoff',
    });
    expect(JSON.parse(proxy.calls[1].body!)).toEqual({
      agent: APP_AGENT,
      label: 'Pets app',
    });
    expect(
      proxy.connections.find(c => c.connection_id === finished.connectionId)
        ?.owner,
    ).toBe(USER);
    // The handoff state is spent, and nothing credential-like stays behind.
    expect(storage.length).toBe(0);
  });

  it('does not redeem a return twice', async () => {
    const { connections, back } = await connected();
    expect(connections.isReturn(back.searchParams)).toBe(false);
    await expect(connections.finish(back.searchParams)).rejects.toThrow(
      'not one this browser started',
    );
  });

  it('lists only connections delegated to the app', async () => {
    const { connections, finished } = await connected();
    expect(await connections.delegated(APP_AGENT, 'pets')).toEqual([
      { connectionId: finished.connectionId, platform: 'pets' },
    ]);
    expect(
      await connections.delegated(`atomic:agent:${FRAME_KEY}`, 'pets'),
    ).toEqual([]);
  });

  it('mints a capability bound to the frame key, signed by the user', async () => {
    const { connections, finished, proxy } = await connected();
    const id = finished.connectionId!;
    const minted = await connections.mintCapability({
      appAgent: APP_AGENT,
      platform: 'pets',
      connectionId: id,
      publicKey: FRAME_KEY,
    });
    // With it, a key grant for the frame to pass on: HPKE to the proxy's
    // grant key, so the frame never holds the key itself. Its plaintext is
    // checked by the proxy's tests and the RFC 9180 vector in
    // `connectionKeys.test.ts`; here, only its shape.
    expect(minted.connectionKey).toMatch(/^s1\.[A-Za-z0-9_-]+$/);
    const sealed = fromBase64url(minted.connectionKey.slice(3));
    const plaintext = JSON.stringify({
      v: 1,
      connection_id: id,
      sub: APP_AGENT,
      key: 'x'.repeat(43),
      exp: minted.exp,
    });
    expect(sealed.length).toBe(32 + plaintext.length + 16);
    // The grant key was fetched once, unsigned.
    const grantKeyCalls = proxy.calls.filter(
      c => new URL(c.url).pathname === '/connection-key-grants/key',
    );
    expect(grantKeyCalls).toHaveLength(1);
    expect(minted.aud).toBe(ORIGIN);
    expect(minted.exp).toBe(1_790_000_000 + CAPABILITY_TTL_SECONDS);
    const [payload, sig] = minted.capability.split('.');
    const json = new TextDecoder().decode(decodeB64(payload));
    expect(JSON.parse(json)).toEqual({
      v: 2,
      connection_id: id,
      platform: 'pets',
      aud: ORIGIN,
      app: APP_AGENT,
      cnf: `atomic:agent:${FRAME_KEY}`,
      exp: minted.exp,
    });
    expect(
      await verify(
        USER_PUBLIC,
        new TextEncoder().encode(`integration-proxy-capability-v2\n${json}`),
        sig,
      ),
    ).toBe(true);
  });

  it('refuses to mint for a connection not delegated to the app', async () => {
    const { connections, finished } = await connected();
    await expect(
      connections.mintCapability({
        appAgent: APP_AGENT,
        platform: 'pets',
        connectionId: 'old',
        publicKey: FRAME_KEY,
      }),
    ).rejects.toThrow('is delegated to this app');
    await expect(
      connections.mintCapability({
        appAgent: APP_AGENT,
        platform: 'github',
        connectionId: finished.connectionId!,
        publicKey: FRAME_KEY,
      }),
    ).rejects.toThrow('is delegated to this app');
    await expect(
      connections.mintCapability({
        appAgent: APP_AGENT,
        platform: 'pets',
        connectionId: finished.connectionId!,
        publicKey: 'short',
      }),
    ).rejects.toThrow('Ed25519');
  });

  it('delegates an existing connection without OAuth', async () => {
    const proxy = fakeProxy();
    const connections = new ProxyConnections(
      new MemoryStorage(),
      ORIGIN,
      user,
      proxy.http,
    );
    await connections.delegate('old', APP_AGENT, 'Pets app');
    expect(await connections.delegated(APP_AGENT, 'pets')).toEqual([
      { connectionId: 'old', platform: 'pets' },
    ]);
  });

  it('needs a signed-in user', async () => {
    const connections = new ProxyConnections(
      new MemoryStorage(),
      ORIGIN,
      () => undefined,
      fakeProxy().http,
    );
    await expect(connections.list('pets')).rejects.toThrow('Sign in');
  });

  it('passes the proxy error code along', async () => {
    const connections = new ProxyConnections(
      new MemoryStorage(),
      ORIGIN,
      user,
      fakeProxy().http,
    );
    await expect(connections.revoke('old')).rejects.toMatchObject({
      status: 404,
      code: 'not_found',
    });
  });

  it('drops a refused handoff and still goes back', async () => {
    const storage = new MemoryStorage();
    const proxy = fakeProxy();
    const connections = new ProxyConnections(storage, ORIGIN, user, proxy.http);
    const url = new URL(
      await connections.start(SCOPE, 'pets', `${PAGE}/x`, 'Pets app', PAGE),
    );
    const back = new URL(url.searchParams.get('redirect_uri')!);
    back.searchParams.set('error', 'access_denied');
    expect(await connections.finish(back.searchParams)).toEqual({
      returnTo: `${PAGE}/x`,
      connected: false,
    });
    expect(proxy.calls).toEqual([]);
    expect(storage.length).toBe(0);
  });
});

describe('canonicalAgent', () => {
  it('normalises prefix and alphabet, and refuses anything else', () => {
    const standard = 'gJRZVTGPngaG3mSPA/e6LEewKixYpZtuUYQhNg+t7Y4=';
    const url = 'gJRZVTGPngaG3mSPA_e6LEewKixYpZtuUYQhNg-t7Y4';
    expect(canonicalAgent(`did:ad:agent:${standard}`)).toBe(
      `atomic:agent:${url}`,
    );
    expect(canonicalAgent(`atomic:agent:${url}`)).toBe(`atomic:agent:${url}`);
    expect(() => canonicalAgent('https://example.com/agents/x')).toThrow();
    expect(() => canonicalAgent('atomic:agent:AAAA')).toThrow('Ed25519');
  });
});

/**
 * A fixed capability, for the proxy's tests to verify: the user key of
 * `lib/src/authentication_v2_vectors.json`, fixed claims. Ed25519 in noble
 * is deterministic, so this is the exact string the page produces.
 */
describe('capability vector', () => {
  it('is stable', async () => {
    const { json, message } = capabilityClaims({
      connection_id: 'c_123',
      platform: 'google-calendar',
      aud: 'https://proxy.example',
      app: APP_AGENT,
      cnf: `atomic:agent:${FRAME_KEY}`,
      exp: 1_790_000_600,
    });
    const sig = await user().signBytes(message);
    const payload = btoa(json)
      .replaceAll('+', '-')
      .replaceAll('/', '_')
      .replaceAll('=', '');
    expect(json).toBe(
      `{"v":2,"connection_id":"c_123","platform":"google-calendar","aud":"https://proxy.example","app":"${APP_AGENT}","cnf":"atomic:agent:${FRAME_KEY}","exp":1790000600}`,
    );
    expect(`${payload}.${sig}`).toMatchInlineSnapshot(
      `"eyJ2IjoyLCJjb25uZWN0aW9uX2lkIjoiY18xMjMiLCJwbGF0Zm9ybSI6Imdvb2dsZS1jYWxlbmRhciIsImF1ZCI6Imh0dHBzOi8vcHJveHkuZXhhbXBsZSIsImFwcCI6ImF0b21pYzphZ2VudDpBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFFIiwiY25mIjoiYXRvbWljOmFnZW50OkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkUiLCJleHAiOjE3OTAwMDA2MDB9.mKOEe3SnRDDRYFZ94kAqkXl_RnRy-pS-B5KdEzpdQVDPNE3PEHZq1e7aT9dL0GKhv00uZ2WiWmftEvto09xRDw"`,
    );
  });
});
