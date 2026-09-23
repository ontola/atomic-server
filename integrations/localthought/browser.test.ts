import { afterEach, expect, it, vi } from 'vitest';
import { BrowserIntegrations, proxyOrigin } from './browser';
const origin = 'https://proxy.example';

function setup() {
  const values = new Map<string, string>();
  const storage = {
    getItem: (k: string) => values.get(k) ?? null,
    setItem: (k: string, v: string) => {
      values.set(k, v);
    },
    removeItem: (k: string) => {
      values.delete(k);
    },
  } as Storage;
  vi.stubGlobal('location', { origin: 'https://atomic.example' });
  vi.stubGlobal('navigator', {
    locks: { request: (_: string, f: () => unknown) => f() },
  });
  const http = vi.fn(async (url: string, init?: RequestInit) => {
    expect(init?.credentials).toBe('omit');
    expect(init?.redirect).toBe('error');
    if (url.endsWith('/catalog')) return new Response('["pets"]');
    if (url.endsWith('/connect/redeem'))
      return Response.json({ connection_code: 'first', platform: 'pets' });

    return new Response('{}');
  });
  const client = new BrowserIntegrations(storage, origin, http as typeof fetch);
  const start = () =>
    client.start(
      'drive',
      'actor',
      'pets',
      'https://atomic.example/app/integrations',
    );

  return { values, storage, http, client, start };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
it('rejects non-origin proxy URLs', () => {
  expect(() => proxyOrigin('https://proxy.example/path')).toThrow();
  expect(() => proxyOrigin('http://proxy.example')).toThrow();
});
it('starts a platform-bound PKCE redirect without a tenant session', async () => {
  const { start, values, http } = setup();
  const { state, url } = await start();
  const redirect = new URL(url);
  const callback = new URL(redirect.searchParams.get('redirect_uri')!);
  const pending = JSON.parse([...values.values()][0]);
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(pending.codeVerifier),
  );
  const expectedChallenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');

  expect(redirect.pathname).toBe('/connect');
  expect(Object.fromEntries(redirect.searchParams)).toEqual({
    platform: 'pets',
    redirect_uri: callback.href,
    user_id: 'actor',
    code_challenge: expectedChallenge,
    code_challenge_method: 'S256',
    credentials: 'connection',
  });
  expect(callback.searchParams.get('integration_state')).toBe(state);
  expect(callback.searchParams.get('platform')).toBe('pets');
  expect(pending.codeVerifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(
    http.mock.calls.some(([request]) => String(request).endsWith('/session')),
  ).toBe(false);
});
it('binds redemption to actor, drive, platform and expiry', async () => {
  const { client, start, values, http } = setup();
  const { state } = await start();
  await expect(
    client.finish('other', 'actor', state, 'code'),
  ).rejects.toThrow();
  await expect(
    client.finish('drive', 'other', state, 'code'),
  ).rejects.toThrow();
  http.mockImplementationOnce(async (_url, init) => {
    const pending = JSON.parse([...values.values()][0]);
    expect(pending.codeVerifier).toBeUndefined();
    expect(init).toMatchObject({
      method: 'POST',
      body: expect.any(String),
      credentials: 'omit',
      redirect: 'error',
    });
    expect(JSON.parse(init!.body as string)).toEqual({
      code: 'code',
      code_verifier: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
    });

    return Response.json({ connection_code: 'first', platform: 'pets' });
  });
  await expect(client.finish('drive', 'actor', state, 'code')).resolves.toEqual(
    {
      connection: state,
      platform: 'pets',
    },
  );
  expect(JSON.parse([...values.values()][0])).toMatchObject({
    platform: 'pets',
    ready: true,
    code: 'first',
  });
  expect(JSON.parse([...values.values()][0]).codeVerifier).toBeUndefined();
  await expect(
    client.finish('drive', 'actor', state, 'code'),
  ).rejects.toThrow();
});
it('does not save a credential when redemption returns another platform', async () => {
  const { client, start, values, http } = setup();
  const { state } = await start();
  http.mockImplementationOnce(async () =>
    Response.json({ connection_code: 'first', platform: 'github-issues' }),
  );
  await expect(client.finish('drive', 'actor', state, 'code')).rejects.toThrow(
    'platform',
  );
  expect(JSON.parse([...values.values()][0])).toMatchObject({ ready: false });
  expect(JSON.parse([...values.values()][0]).code).toBeUndefined();
});
it('clears expired and denied pending verifiers', async () => {
  const { client, start, values, http } = setup();
  const expired = await start();
  const [expiredKey, expiredValue] = [...values.entries()][0];
  values.set(
    expiredKey,
    JSON.stringify({ ...JSON.parse(expiredValue), expires: Date.now() - 1 }),
  );
  await expect(
    client.finish('drive', 'actor', expired.state, 'code'),
  ).rejects.toThrow('Reconnect');
  expect(values.has(expiredKey)).toBe(false);

  const denied = await start();
  client.cancel('drive', 'actor', denied.state);
  expect([...values.values()]).toHaveLength(0);
  expect(
    http.mock.calls.some(([request]) => String(request).endsWith('/redeem')),
  ).toBe(false);
});
it('never retries an uncertain redemption after consuming its verifier', async () => {
  const { client, start, http } = setup();
  const { state } = await start();
  http.mockImplementationOnce(async () => {
    throw new Error('connection lost');
  });
  await expect(client.finish('drive', 'actor', state, 'code')).rejects.toThrow(
    'lost',
  );
  const calls = http.mock.calls.length;
  await expect(client.finish('drive', 'actor', state, 'code')).rejects.toThrow(
    'Reconnect',
  );
  expect(http.mock.calls).toHaveLength(calls);
});
it('consumes before dispatch and preserves rotation', async () => {
  const { client, start, http, values } = setup();
  const { state } = await start();
  await client.finish('drive', 'actor', state, 'handoff');
  const codes: string[] = [];
  http.mockImplementation(async (_url, init) => {
    expect(JSON.parse([...values.values()][0]).code).toBeUndefined();
    codes.push((init!.headers as Record<string, string>).Authorization);

    return new Response('[]', {
      headers: { 'x-connection-code': 'second' },
    });
  });
  await client.request('drive', 'actor', state, 'pets', '/pets');
  expect(codes).toEqual(['Bearer first']);
});
it('never retries an uncertain consumed credential', async () => {
  const { client, start, http } = setup();
  const { state } = await start();
  await client.finish('drive', 'actor', state, 'handoff');
  http.mockImplementation(async () => {
    throw new Error('connection lost');
  });
  await expect(
    client.request('drive', 'actor', state, 'pets', '/pets'),
  ).rejects.toThrow('lost');
  const calls = http.mock.calls.length;
  await expect(
    client.request('drive', 'actor', state, 'pets', '/pets'),
  ).rejects.toThrow('Reconnect');
  expect(http.mock.calls).toHaveLength(calls);
});

it('calls the browser fetch function without binding it to the client', async () => {
  const { storage } = setup();
  vi.stubGlobal('fetch', function (this: unknown) {
    expect(this).not.toBeInstanceOf(BrowserIntegrations);

    return Promise.resolve(new Response('["pets"]'));
  });
  const client = new BrowserIntegrations(storage, origin);
  expect(await client.catalog()).toEqual(['pets']);
});

it('supports the demo callback and write credentials', async () => {
  const { client, http, values } = setup();
  const { state } = await client.start(
    'drive',
    'actor',
    'pets',
    'https://atomic.example/app/devonian-demo',
  );
  await client.finish('drive', 'actor', state, 'handoff');
  http.mockImplementation(async (_url, init) => {
    expect(JSON.parse([...values.values()][0]).code).toBeUndefined();
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe('{"title":"new"}');

    return new Response('{"id":1}', {
      status: 201,
      headers: { 'X-Connection-Code': 'next', Link: '<https://x/?p=2>' },
    });
  });
  await expect(
    client.request('drive', 'actor', state, 'github-issues', '/issues'),
  ).rejects.toThrow('another platform');
  await expect(
    client.request('drive', 'actor', state, 'pets', '//evil.example'),
  ).rejects.toThrow('Invalid proxy path');
  expect(
    await client.request('drive', 'actor', state, 'pets', '/issues', {
      method: 'POST',
      body: '{"title":"new"}',
    }),
  ).toEqual({
    status: 201,
    // Response headers reach the caller (pagination needs `Link`), except
    // the rotated code, which never leaves this class.
    headers: {
      'content-type': 'text/plain;charset=UTF-8',
      link: '<https://x/?p=2>',
    },
    body: '{"id":1}',
  });
  expect(JSON.parse([...values.values()][0]).code).toBe('next');
});
it('forwards the conditional event version while keeping authorization host-owned', async () => {
  const { client, start, http } = setup();
  const { state } = await start();
  await client.finish('drive', 'actor', state, 'handoff');
  http.mockImplementation(async (_url, init) => {
    expect(init?.headers).toEqual({
      Authorization: 'Bearer first',
      'Content-Type': 'application/json',
      'If-Match': '"version"',
    });
    expect(init?.method).toBe('PATCH');
    expect(init?.body).toBe('{"summary":"Updated"}');

    return new Response('{}', { headers: { 'x-connection-code': 'next' } });
  });
  await client.request('drive', 'actor', state, 'pets', '/events/id', {
    method: 'PATCH',
    body: '{"summary":"Updated"}',
    ifMatch: '"version"',
  });
});
