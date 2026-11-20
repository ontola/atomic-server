// @wc-ignore-file
import { describe, expect, it, vi } from 'vitest';
import { Agent, JSCryptoProvider, decodeB64 } from '@tomic/react';
import { describeAuthenticatedPrincipals } from 'syncables/browser';
import {
  CAPABILITY_TTL_SECONDS,
  ProxyConnections,
  base64url,
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
function fakeProxy(keyed = false, platform = 'pets') {
  const calls: { method: string; url: string; body?: string }[] = [];
  const sealedWith = new Map<string, string>();
  const githubUsers = new Map<string, string | number>();
  let githubUser: string | number = 100;
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
    const h = init.headers as Record<string, string>;
    calls.push({ method, url, body });
    const key = h['x-connection-key'];
    const message = [
      'atomic-request-v2',
      method,
      url,
      h['x-atomic-timestamp'],
      await sha256Hex(body ?? ''),
      ...(key !== undefined ? [await sha256Hex(key)] : []),
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
      const redemption = JSON.parse(body!);
      const id = keyed ? redemption.connection_id : 'new';

      if (keyed) {
        if (
          !/^[A-Za-z0-9_-]{43}$/.test(id) ||
          !/^k1\.[A-Za-z0-9_-]{43}$/.test(redemption.connection_key)
        )
          return Response.json(
            { error: 'invalid_connection_key' },
            { status: 400 },
          );
        sealedWith.set(id, redemption.connection_key);
        githubUsers.set(id, githubUser);
      }

      connections.push({
        connection_id: id,
        platform,
        owner: h['x-atomic-agent'],
        delegations: [],
      });

      return Response.json({
        connection_id: id,
        platform,
        owner: h['x-atomic-agent'],
      });
    }

    if (path === '/connections' && method === 'GET')
      return Response.json({ owner: USER, connections, runtimes: [] });

    const source =
      /^\/proxy\/([^/]+)\/(pets\/feed|github-issues\/user|[a-z0-9-]+\/principal)$/.exec(
        path,
      );

    if (source && (method === 'GET' || method === 'POST')) {
      if (
        !key ||
        sealedWith.get(source[1]) !== key ||
        !connections.some(
          row =>
            row.connection_id === source[1] &&
            row.owner === h['x-atomic-agent'],
        )
      )
        return Response.json(
          { error: 'connection_key_required' },
          { status: 401 },
        );
      if (
        source[2] === 'github-issues/user' ||
        source[2].endsWith('/principal')
      )
        return Response.json({
          id: githubUsers.get(source[1]),
          login: 'fixture',
        });

      return Response.json([{ id: 9, name: 'Max' }], {
        headers: {
          link: '</feed?page=2>; rel="next"',
          'x-private-test': 'discard',
        },
      });
    }

    const agents = /^\/connections\/([^/]+)\/agents$/.exec(path);

    if (agents && method === 'POST') {
      const row = connections.find(c => c.connection_id === agents[1])!;
      row.delegations.push(JSON.parse(body!));

      return Response.json({ ok: true });
    }

    const connection = /^\/connections\/([^/]+)$/.exec(path);

    if (connection && method === 'DELETE' && keyed) {
      const index = connections.findIndex(
        row =>
          row.connection_id === connection[1] &&
          row.owner === h['x-atomic-agent'],
      );

      if (index !== -1) {
        connections.splice(index, 1);

        return new Response(null, { status: 204 });
      }
    }

    return Response.json(
      { error: 'not_found', message: path },
      { status: 404 },
    );
  });

  return {
    http: http as unknown as typeof fetch,
    calls,
    connections,
    authorizeGithubUser(id: string | number) {
      githubUser = id;
    },
  };
}

function callback(handoff: string) {
  const redirect = new URL(new URL(handoff).searchParams.get('redirect_uri')!);
  redirect.searchParams.set('connection_code', 'handoff');

  return redirect.searchParams;
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
      connectionId: 'new',
    });
  });

  it('redeems signed by the user, then delegates to the app, signed too', async () => {
    const { proxy, storage } = await connected();
    expect(proxy.calls.map(c => [c.method, new URL(c.url).pathname])).toEqual([
      ['POST', '/connect/redeem'],
      ['POST', '/connections/new/agents'],
    ]);
    expect(JSON.parse(proxy.calls[0].body!)).toMatchObject({
      code: 'handoff',
    });
    expect(JSON.parse(proxy.calls[1].body!)).toEqual({
      agent: APP_AGENT,
      label: 'Pets app',
    });
    expect(proxy.connections.find(c => c.connection_id === 'new')?.owner).toBe(
      USER,
    );
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
    const { connections } = await connected();
    expect(await connections.delegated(APP_AGENT, 'pets')).toEqual([
      { connectionId: 'new', platform: 'pets' },
    ]);
    expect(
      await connections.delegated(`atomic:agent:${FRAME_KEY}`, 'pets'),
    ).toEqual([]);
  });

  it('mints a capability bound to the frame key, signed by the user', async () => {
    const { connections } = await connected();
    const minted = await connections.mintCapability({
      appAgent: APP_AGENT,
      platform: 'pets',
      connectionId: 'new',
      publicKey: FRAME_KEY,
    });
    expect(minted.aud).toBe(ORIGIN);
    expect(minted.exp).toBe(1_790_000_000 + CAPABILITY_TTL_SECONDS);
    const [payload, sig] = minted.capability.split('.');
    const json = new TextDecoder().decode(decodeB64(payload));
    expect(JSON.parse(json)).toEqual({
      v: 2,
      connection_id: 'new',
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
    const { connections } = await connected();
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
        connectionId: 'new',
        publicKey: FRAME_KEY,
      }),
    ).rejects.toThrow('is delegated to this app');
    await expect(
      connections.mintCapability({
        appAgent: APP_AGENT,
        platform: 'pets',
        connectionId: 'new',
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

  it('redeems a keyed connection and authorizes signed reads after a reload', async () => {
    const storage = new MemoryStorage();
    const proxy = fakeProxy(true);
    const first = new ProxyConnections(storage, ORIGIN, user, proxy.http);
    const url = new URL(
      await first.startKeyed(
        SCOPE,
        'pets',
        `${PAGE}/app/show?subject=x`,
        'Pets',
        PAGE,
      ),
    );
    const back = new URL(url.searchParams.get('redirect_uri')!);
    back.searchParams.set('connection_code', 'handoff');
    const reloaded = new ProxyConnections(storage, ORIGIN, user, proxy.http);
    const finished = await reloaded.finish(back.searchParams);
    const redemption = JSON.parse(proxy.calls[0].body!);
    const id = finished.connectionId!;

    expect(finished).toEqual({
      returnTo: `${PAGE}/app/show?subject=x`,
      connected: true,
      connectionId: id,
    });
    expect(id).toEqual(redemption.connection_id);
    expect(proxy.calls).toHaveLength(1);
    expect(reloaded.isReturn(back.searchParams)).toBe(false);
    const verifierDigest = new Uint8Array(
      await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(redemption.code_verifier),
      ),
    );
    expect(url.searchParams.get('code_challenge')).toBe(
      base64url(verifierDigest),
    );
    expect(url.href).not.toContain(redemption.connection_key);
    expect(storage.values()).not.toContain(redemption.connection_key);
    expect(await reloaded.listKeyed('pets')).toMatchObject([
      { connection_id: id, platform: 'pets', delegations: [] },
    ]);

    const destination = new URL(`/proxy/${id}/pets/feed`, ORIGIN);
    const read = await reloaded.readKeyed(destination);
    expect(read).toMatchObject({
      status: 200,
      body: [{ id: 9, name: 'Max' }],
      headers: { link: '</feed?page=2>; rel="next"' },
    });
    const call = vi.mocked(proxy.http).mock.calls.at(-1)!;
    expect(call[1]).toMatchObject({
      method: 'GET',
      redirect: 'error',
      credentials: 'omit',
    });
    expect(read.headers['x-private-test']).toBeUndefined();
    await expect(
      reloaded.readKeyed(new URL(destination.pathname, 'https://other.test')),
    ).rejects.toThrow('proxy origin');
    await expect(
      reloaded.readKeyed(new URL(destination.href + '#fragment')),
    ).rejects.toThrow('proxy origin');
    await expect(
      reloaded.readKeyed(
        new URL(destination.pathname.replace('/pets/', '/github/'), ORIGIN),
      ),
    ).rejects.toThrow('Reconnect');
    expect(proxy.calls).toHaveLength(3);
  });

  it('signs the body and method of catalog-declared POST list reads', async () => {
    const fixture = fakeProxy(true);
    const connections = new ProxyConnections(
      new MemoryStorage(),
      ORIGIN,
      user,
      fixture.http,
    );
    const started = await connections.startKeyed(
      SCOPE,
      'pets',
      `${PAGE}/x`,
      'Pets',
      PAGE,
    );
    const slot = (await connections.finish(callback(started))).connectionId!;
    const body = JSON.stringify({ filter: { kind: 'pet' }, cursor: 'next' });
    expect(
      await connections.readKeyed(
        new URL(`/proxy/${slot}/pets/feed`, ORIGIN),
        undefined,
        { method: 'POST', body },
      ),
    ).toMatchObject({ status: 200, body: [{ id: 9, name: 'Max' }] });
    expect(fixture.calls.at(-1)).toMatchObject({ method: 'POST', body });
    expect(vi.mocked(fixture.http).mock.calls.at(-1)?.[1]).toMatchObject({
      credentials: 'omit',
      redirect: 'error',
      headers: { 'content-type': 'application/json' },
    });
  });

  it('does not redeem a keyed handoff as a different Atomic agent', async () => {
    const storage = new MemoryStorage();
    const proxy = fakeProxy(true);
    const first = new ProxyConnections(storage, ORIGIN, user, proxy.http);
    const url = new URL(
      await first.startKeyed(SCOPE, 'pets', `${PAGE}/x`, 'Pets', PAGE),
    );
    const back = new URL(url.searchParams.get('redirect_uri')!);
    back.searchParams.set('connection_code', 'handoff');
    const different = new ProxyConnections(
      storage,
      ORIGIN,
      () => new Agent(new JSCryptoProvider('B'.repeat(42) + 'E')),
      proxy.http,
    );
    await expect(different.finish(back.searchParams)).rejects.toThrow(
      'Atomic account',
    );
    expect(proxy.calls).toEqual([]);
  });

  it('permits a keyed retry link only for the saved same-origin return', async () => {
    const storage = new MemoryStorage();
    const proxy = fakeProxy(true);
    const connections = new ProxyConnections(storage, ORIGIN, user, proxy.http);
    const returnTo = `${PAGE}/app/show?subject=mirror`;
    const handoff = callback(
      await connections.startKeyed(SCOPE, 'pets', returnTo, 'Pets', PAGE),
    );
    expect(connections.keyedReturnTo(handoff, PAGE)).toBe(returnTo);
    expect(
      connections.keyedReturnTo(handoff, 'https://other.test'),
    ).toBeUndefined();
    expect(
      connections.keyedReturnTo(new URLSearchParams(), PAGE),
    ).toBeUndefined();
    const key = storage.key(0)!;
    storage.setItem(
      key,
      JSON.stringify({
        ...JSON.parse(storage.getItem(key)!),
        returnTo: 'https://other.test/app/show',
      }),
    );
    expect(connections.keyedReturnTo(handoff, PAGE)).toBeUndefined();
  });

  it('upgrades legacy numeric provenance only after a typed numeric principal is verified', async () => {
    const storage = new MemoryStorage();
    const fixture = fakeProxy(true);
    const connections = new ProxyConnections(
      storage,
      ORIGIN,
      user,
      fixture.http,
    );
    const slot = (
      await connections.finish(
        callback(
          await connections.startKeyed(
            SCOPE,
            'pets',
            `${PAGE}/x`,
            'Pets',
            PAGE,
          ),
        ),
      )
    ).connectionId!;
    const marker = Array.from(
      { length: storage.length },
      (_, i) => storage.key(i)!,
    ).find(key => key.startsWith('atomic-proxy-keyed-v1:'))!;
    storage.setItem(
      marker,
      JSON.stringify({ platform: 'pets', githubUserId: '100' }),
    );
    const principal = {
      kind: 'authenticated' as const,
      namespace: 'https://identity.example',
      subject: 100,
    };
    expect(await connections.canReconnectKeyed('pets', slot)).toBe(false);
    const proofBefore = storage.values();
    const callsBefore = fixture.calls.length;
    expect(await connections.keyedPrincipalProvenance('pets', slot)).toEqual({
      legacyNumericSubject: 100,
    });
    expect(
      await connections.keyedPrincipalProvenance('other', slot),
    ).toBeUndefined();
    expect(storage.values()).toBe(proofBefore);
    expect(fixture.calls).toHaveLength(callsBefore);
    await expect(
      connections.rememberKeyedPrincipal(
        'pets',
        slot,
        { ...principal, subject: '100' },
        'currentPrincipal',
      ),
    ).rejects.toThrow('different authenticated principal');
    await connections.rememberKeyedPrincipal(
      'pets',
      slot,
      principal,
      'currentPrincipal',
    );
    expect(await connections.canReconnectKeyed('pets', slot)).toBe(true);
    expect(await connections.keyedPrincipalProvenance('pets', slot)).toEqual({
      principal,
    });
    expect(storage.values()).not.toContain('githubUserId');
  });

  it('keeps string principal provenance typed and owner scoped', async () => {
    const storage = new MemoryStorage();
    const fixture = fakeProxy(true);
    const connections = new ProxyConnections(
      storage,
      ORIGIN,
      user,
      fixture.http,
    );
    const slot = (
      await connections.finish(
        callback(
          await connections.startKeyed(
            SCOPE,
            'pets',
            `${PAGE}/x`,
            'Pets',
            PAGE,
          ),
        ),
      )
    ).connectionId!;
    const principal = {
      kind: 'authenticated' as const,
      namespace: 'https://identity.example',
      subject: '100',
    };
    await connections.rememberKeyedPrincipal(
      'pets',
      slot,
      principal,
      'currentPrincipal',
    );
    const before = storage.values();
    expect(await connections.keyedPrincipalProvenance('pets', slot)).toEqual({
      principal,
    });
    const other = new ProxyConnections(
      storage,
      ORIGIN,
      () => new Agent(new JSCryptoProvider('B'.repeat(42) + 'E')),
      fixture.http,
    );
    expect(await other.keyedPrincipalProvenance('pets', slot)).toBeUndefined();
    expect(storage.values()).toBe(before);
  });

  it.each(['calendar-service', 'github-issues'])(
    'keeps the original slot through generic %s reconnect and preserves typed identities',
    async platform => {
      const storage = new MemoryStorage();
      const proxy = fakeProxy(true, platform);
      const namespace = 'https://identities.example/' + platform;
      const principal = {
        kind: 'authenticated' as const,
        namespace,
        subject: 100,
      };
      const document = {
        openapi: '3.0.3',
        info: { title: 'Fixture', version: '1' },
        servers: [{ url: 'https://provider.example' }],
        paths: {
          '/principal': {
            get: {
              operationId: 'currentPrincipal',
              security: [{ oauth: [] }],
              'x-authenticated-principal': {
                kind: 'user',
                namespace,
                subject: '$response.body#/id',
                identifier: {
                  scope: 'provider',
                  stable: true,
                  reassigned: false,
                },
              },
              responses: { '200': { description: 'Current identity' } },
            },
          },
        },
      };
      const catalog = vi.fn(async () => document);
      const connections = new ProxyConnections(
        storage,
        ORIGIN,
        user,
        proxy.http,
        Date.now,
        catalog,
      );
      const returnTo = `${PAGE}/app/show?subject=mirror`;
      const slot = (
        await connections.finish(
          callback(
            await connections.startKeyed(
              SCOPE,
              platform,
              returnTo,
              'Provider',
              PAGE,
            ),
          ),
        )
      ).connectionId!;
      const reconnect = () =>
        connections.startKeyedReconnect(
          SCOPE,
          platform,
          slot,
          returnTo,
          'Provider',
          PAGE,
        );
      expect(await connections.canReconnectKeyed(platform, slot)).toBe(false);
      await expect(reconnect()).rejects.toThrow('verified account');
      const marker = Array.from(
        { length: storage.length },
        (_, index) => storage.key(index)!,
      ).find(key => key.startsWith('atomic-proxy-keyed-v1:'))!;
      storage.setItem(
        marker,
        JSON.stringify({ platform, githubUserId: '100' }),
      );
      const descriptions = describeAuthenticatedPrincipals(document);
      const saved = storage.values();
      const calls = proxy.calls.length;
      expect(
        await connections.canReconnectLegacyKeyed(
          platform,
          slot,
          principal,
          descriptions,
        ),
      ).toBe(true);
      expect(
        await connections.canReconnectLegacyKeyed(
          platform,
          slot,
          { ...principal, subject: '100' },
          descriptions,
        ),
      ).toBe(false);

      for (const invalid of [
        [...descriptions, ...descriptions],
        descriptions.map(description => ({
          ...description,
          identifier: { ...description.identifier, reassigned: true },
        })),
        descriptions.map(description => ({
          ...description,
          identifier: { ...description.identifier, scope: 'client' as const },
        })),
      ]) {
        expect(
          await connections.canReconnectLegacyKeyed(
            platform,
            slot,
            principal,
            invalid,
          ),
        ).toBe(false);
        await expect(
          connections.prepareLegacyKeyedReconnect(
            platform,
            slot,
            principal,
            invalid,
            () => undefined,
          ),
        ).rejects.toThrow('unambiguous');
      }

      expect(storage.values()).toBe(saved);
      expect(proxy.calls).toHaveLength(calls);
      await expect(
        connections.prepareLegacyKeyedReconnect(
          platform,
          slot,
          principal,
          descriptions,
          () => {
            throw new Error('Session changed');
          },
        ),
      ).rejects.toThrow('Session changed');
      expect(storage.values()).toBe(saved);
      await connections.prepareLegacyKeyedReconnect(
        platform,
        slot,
        principal,
        descriptions,
        () => undefined,
      );
      expect(proxy.calls).toHaveLength(calls);
      expect(storage.values()).not.toContain('githubUserId');
      await expect(
        connections.rememberKeyedPrincipal(
          platform,
          slot,
          { ...principal, subject: '100' },
          'currentPrincipal',
        ),
      ).rejects.toThrow('different authenticated principal');
      await expect(
        connections.rememberKeyedPrincipal(
          platform,
          slot,
          { ...principal, clientContext: 'other-client' },
          'currentPrincipal',
        ),
      ).rejects.toThrow('different authenticated principal');
      expect(await connections.canReconnectKeyed(platform, slot)).toBe(true);
      await connections.revoke(slot);
      expect(await connections.listKeyed(platform)).toMatchObject([
        { connection_id: slot, platform },
      ]);
      proxy.authorizeGithubUser('100');
      await expect(
        connections.finish(callback(await reconnect())),
      ).rejects.toThrow('same authenticated account');
      expect(await connections.activeKeyedConnection(platform, slot)).toBe(
        slot,
      );
      expect(
        proxy.connections.filter(row => row.platform === platform),
      ).toHaveLength(0);
      proxy.authorizeGithubUser(100);
      const reloaded = new ProxyConnections(
        storage,
        ORIGIN,
        user,
        proxy.http,
        Date.now,
        catalog,
      );
      expect(await reloaded.finish(callback(await reconnect()))).toEqual({
        returnTo,
        connected: true,
        connectionId: slot,
      });
      const active = await reloaded.activeKeyedConnection(platform, slot);
      expect(active).not.toBe(slot);
      expect(await reloaded.listKeyed(platform)).toMatchObject([
        { connection_id: slot, platform, delegations: [] },
      ]);
      expect(catalog).toHaveBeenCalledWith(
        ORIGIN,
        platform,
        expect.any(AbortSignal),
      );
      expect(
        proxy.calls.filter(({ url }) => url.endsWith('/agents')),
      ).toHaveLength(0);
      expect(storage.values()).toContain('"namespace":"' + namespace + '"');
      expect(storage.values()).not.toContain('connection_key');
    },
  );
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

it('keeps a successful keyed OAuth selection scoped to the owner, drive, setup and platform until consumed', async () => {
  const storage = new MemoryStorage();
  const fixture = fakeProxy(true);
  let now = 1_790_000_000_000;
  const proxy = new ProxyConnections(
    storage,
    ORIGIN,
    user,
    fixture.http,
    () => now,
  );
  const connect = async () =>
    proxy.finish(
      callback(
        await proxy.startKeyed(SCOPE, 'pets', `${PAGE}/x`, 'Pets', PAGE),
      ),
    );
  const first = (await connect()).connectionId!;
  expect(await proxy.preferredKeyedConnection(SCOPE, 'pets')).toBe(first);
  const calls = fixture.calls.length;
  expect(
    await proxy.preferredKeyedConnection(
      { ...SCOPE, drive: 'atomic:other-drive' },
      'pets',
    ),
  ).toBeUndefined();
  expect(
    await proxy.preferredKeyedConnection(
      { ...SCOPE, app: 'atomic:other-app' },
      'pets',
    ),
  ).toBeUndefined();
  expect(await proxy.preferredKeyedConnection(SCOPE, 'other')).toBeUndefined();
  const anotherUser = new Agent(
    new JSCryptoProvider('AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'),
  );
  const other = new ProxyConnections(
    storage,
    ORIGIN,
    () => anotherUser,
    fixture.http,
    () => now,
  );
  expect(await other.preferredKeyedConnection(SCOPE, 'pets')).toBeUndefined();
  expect(fixture.calls).toHaveLength(calls);
  const second = (await connect()).connectionId!;
  await proxy.consumePreferredKeyedConnection(SCOPE, 'pets', first);
  expect(await proxy.preferredKeyedConnection(SCOPE, 'pets')).toBe(second);
  await proxy.consumePreferredKeyedConnection(SCOPE, 'pets', second);
  expect(await proxy.preferredKeyedConnection(SCOPE, 'pets')).toBeUndefined();
  const third = (await connect()).connectionId!;
  expect(await proxy.preferredKeyedConnection(SCOPE, 'pets')).toBe(third);
  now += 600_001;
  expect(await proxy.preferredKeyedConnection(SCOPE, 'pets')).toBeUndefined();
});
