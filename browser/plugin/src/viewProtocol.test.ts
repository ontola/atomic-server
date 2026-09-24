import { afterEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { RPCClient } from './rpc';
import { isViewRequest, viewRequest } from './viewProtocol';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function frame() {
  const listeners: Array<(event: MessageEvent) => void> = [];
  const parent = { postMessage: vi.fn() };
  const window = {
    parent,
    addEventListener: (_: string, listener: (typeof listeners)[number]) =>
      listeners.push(listener),
    removeEventListener: vi.fn(),
  };
  const reply = (data: unknown, source: unknown = parent) =>
    listeners.forEach(listener => listener({ source, data } as MessageEvent));

  return { window, reply, parent };
}

it('validates version, correlation id, operation and argument envelope', () => {
  const valid = viewRequest('one', 'get', { subject: 'row' });
  expect(isViewRequest(valid)).toBe(true);
  for (const change of [
    { version: 2 },
    { id: NaN },
    { id: '' },
    { op: 'sign-as-owner' },
    { args: [] },
    { args: null },
  ])
    expect(isViewRequest({ ...valid, ...change })).toBe(false);
});

it.each(['packaged', 'generated'])(
  'uses the same resource contract and trusts only the parent: %s',
  async kind => {
    const f = frame();
    vi.stubGlobal('window', f.window);
    let getResource: (
      subject: string,
    ) => Promise<{ subject: string; props: unknown }>;

    if (kind === 'packaged') {
      const client = new RPCClient();
      getResource = subject => client.getResource(subject);
    } else {
      const source = readFileSync(
        new URL(
          '../../../server/src/plugins/assets/view-client.js',
          import.meta.url,
        ),
        'utf8',
      );
      const store = new Function(
        'window',
        'setTimeout',
        source.replace('export const store', 'const store') + '\nreturn store;',
      )(f.window, () => 0);
      getResource = subject => store.getResource(subject);
    }

    const pending = getResource('row');
    const request = f.parent.postMessage.mock.calls[0][0];
    expect(isViewRequest(request)).toBe(true);
    expect(request).toMatchObject({ op: 'get', args: { subject: 'row' } });
    const result = {
      subject: 'row',
      props: { name: 'Shared shape' },
      title: 'Shared shape',
      loading: false,
    };
    const response = {
      type: 'atomic.view.response',
      version: 1,
      id: request.id,
      result,
    };
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    f.reply(response, {});
    await Promise.resolve();
    expect(settled).toBe(false);
    f.reply(response);
    expect(await pending).toMatchObject({
      subject: 'row',
      props: result.props,
    });
  },
);

it('lets a generated view wait for host recovery but still rejects a silent host', async () => {
  vi.useFakeTimers();
  const f = frame();
  const source = readFileSync(
    new URL(
      '../../../server/src/plugins/assets/view-client.js',
      import.meta.url,
    ),
    'utf8',
  );
  const store = new Function(
    'window',
    'setTimeout',
    'clearTimeout',
    source.replace('export const store', 'const store') + '\nreturn store;',
  )(f.window, setTimeout, clearTimeout);
  const pending = store.query({ property: 'parent', value: 'table' });
  const outcome = pending.then(
    (value: unknown) => ({ value }),
    (error: Error) => ({ error: error.message }),
  );
  // ClientDb's follower recovery and websocket authentication each allow 30s.
  // A view must not abandon the host halfway through that supported recovery.
  await vi.advanceTimersByTimeAsync(30_000);
  f.reply({
    type: 'atomic.view.response',
    version: 1,
    id: f.parent.postMessage.mock.calls[0][0].id,
    result: ['row'],
  });
  expect(await outcome).toEqual({ value: ['row'] });
  expect(vi.getTimerCount()).toBe(0);

  const silent = store.query({ property: 'parent', value: 'table' });
  const rejected = expect(silent).rejects.toThrow(
    'The host did not answer query in time.',
  );
  await vi.advanceTimersByTimeAsync(60_000);
  await rejected;
  expect(vi.getTimerCount()).toBe(0);
});

function generatedStore(f: ReturnType<typeof frame>) {
  const source = readFileSync(
    new URL(
      '../../../server/src/plugins/assets/view-client.js',
      import.meta.url,
    ),
    'utf8',
  );

  return new Function(
    'window',
    'setTimeout',
    'clearTimeout',
    source.replace('export const store', 'const store') + '\nreturn store;',
  )(
    f.window,
    () => 0,
    () => undefined,
  );
}

const b64 = (s: string) =>
  Uint8Array.from(atob(s.replaceAll('-', '+').replaceAll('_', '/')), c =>
    c.charCodeAt(0),
  );

async function sha256Hex(text: string) {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)),
    ),
    b => b.toString(16).padStart(2, '0'),
  ).join('');
}

/** Lets queued promise callbacks (WebCrypto, postMessage replies) run. */
const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise(r => setTimeout(r, 0));
};

it('carries the proxy ops; the relay op is gone', () => {
  for (const op of [
    'proxyCapability',
    'proxyConnections',
    'proxyConnect',
  ] as const)
    expect(isViewRequest(viewRequest(1, op, { platform: 'pets' }))).toBe(true);
  expect(isViewRequest({ ...viewRequest(1, 'get'), op: 'proxy' })).toBe(false);

  const f = frame();
  const store = generatedStore(f);
  void store.proxy.connections({ platform: 'pets' });
  void store.proxy.connect({ platform: 'pets' });
  const sent = f.parent.postMessage.mock.calls.map(([m]) => m);
  expect(sent.every(isViewRequest)).toBe(true);
  expect(sent.map(m => [m.op, m.args.platform])).toEqual([
    ['proxyConnections', 'pets'],
    ['proxyConnect', 'pets'],
  ]);
});

it('calls the proxy directly with a capability and a v2 signature by its own key', async () => {
  const f = frame();
  const store = generatedStore(f);
  const fetches: { url: string; init: RequestInit }[] = [];
  let refusals = 1;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      fetches.push({ url, init });

      if (refusals-- > 0)
        return new Response(
          JSON.stringify({ error: 'capability_expired', message: 'expired' }),
          { status: 401 },
        );

      return new Response(JSON.stringify([{ id: 1 }]), {
        status: 200,
        headers: {
          'content-type': 'application/json',
          link: '<https://pets.example/pets?page=2>; rel="next"',
          'set-cookie': 'never=forwarded',
        },
      });
    }),
  );

  const pending = store.proxy.request({
    platform: 'pets',
    connectionId: 'c 1',
    path: '/pets',
    method: 'post',
    query: { page: '2' },
    body: '{"name":"Rex"}',
  });

  // Two mints: the first capability is refused as expired, once.
  for (let mint = 0; mint < 2; mint++) {
    await settle();
    const ask = f.parent.postMessage.mock.calls.at(-1)![0];
    expect(isViewRequest(ask)).toBe(true);
    expect(ask.op).toBe('proxyCapability');
    expect(ask.args).toMatchObject({ platform: 'pets', connectionId: 'c 1' });
    expect(ask.args.publicKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    f.reply({
      type: 'atomic.view.response',
      version: 1,
      id: ask.id,
      result: {
        capability: `cap-${mint}`,
        aud: 'https://proxy.example',
        exp: Math.floor(Date.now() / 1000) + 600,
      },
    });
  }

  const result = await pending;
  expect(result).toEqual({
    status: 200,
    headers: {
      'content-type': 'application/json',
      link: '<https://pets.example/pets?page=2>; rel="next"',
    },
    body: [{ id: 1 }],
  });
  expect(fetches).toHaveLength(2);

  const { url, init } = fetches[1];
  expect(url).toBe('https://proxy.example/proxy/c%201/pets/pets?page=2');
  expect(init).toMatchObject({
    method: 'POST',
    body: '{"name":"Rex"}',
    credentials: 'omit',
    redirect: 'error',
  });
  const headers = init.headers as Record<string, string>;
  expect(headers.Authorization).toBe('Capability cap-1');
  expect(headers['x-atomic-signature-version']).toBe('2');
  const publicKey = headers['x-atomic-public-key'];
  expect(headers['x-atomic-agent']).toBe(`atomic:agent:${publicKey}`);
  const message = [
    'atomic-request-v2',
    'POST',
    url,
    headers['x-atomic-timestamp'],
    await sha256Hex('{"name":"Rex"}'),
  ].join('\n');
  const key = await crypto.subtle.importKey(
    'raw',
    b64(publicKey),
    { name: 'Ed25519' },
    false,
    ['verify'],
  );
  expect(
    await crypto.subtle.verify(
      { name: 'Ed25519' },
      key,
      b64(headers['x-atomic-signature']),
      new TextEncoder().encode(message),
    ),
  ).toBe(true);
  // Same frame key for both attempts; it never leaves the frame.
  expect(
    (fetches[0].init.headers as Record<string, string>)['x-atomic-public-key'],
  ).toBe(publicKey);
});

it('refuses a path that would leave the connection, before asking anything', async () => {
  const f = frame();
  const store = generatedStore(f);
  vi.stubGlobal('fetch', vi.fn());
  const pending = store.proxy.request({
    platform: 'pets',
    connectionId: 'c1',
    path: '/../../connections',
  });
  await settle();
  const ask = f.parent.postMessage.mock.calls.at(-1)![0];
  f.reply({
    type: 'atomic.view.response',
    version: 1,
    id: ask.id,
    result: {
      capability: 'cap',
      aud: 'https://proxy.example',
      exp: Math.floor(Date.now() / 1000) + 600,
    },
  });
  await expect(pending).rejects.toThrow('Invalid proxy path');
  expect(fetch).not.toHaveBeenCalled();
});

it('says so plainly where WebCrypto has no Ed25519', async () => {
  const f = frame();
  const store = generatedStore(f);
  const original = crypto.subtle.generateKey;
  (crypto.subtle as { generateKey: unknown }).generateKey = () =>
    Promise.reject(new DOMException('Unrecognized name', 'NotSupportedError'));

  try {
    await expect(
      store.proxy.request({ platform: 'pets', connectionId: 'c1', path: '/' }),
    ).rejects.toThrow(/cannot make an Ed25519 key/);
  } finally {
    (crypto.subtle as { generateKey: unknown }).generateKey = original;
  }

  expect(f.parent.postMessage).not.toHaveBeenCalled();
});

function timedStore(f: ReturnType<typeof frame>) {
  const source = readFileSync(
    new URL(
      '../../../server/src/plugins/assets/view-client.js',
      import.meta.url,
    ),
    'utf8',
  );

  return new Function(
    'window',
    'setTimeout',
    'clearTimeout',
    source.replace('export const store', 'const store') + '\nreturn store;',
  )(f.window, setTimeout, clearTimeout);
}

it('asks the host to open links and resources, and waits on the person as long as it takes', async () => {
  for (const op of ['openExternal', 'openResource'] as const)
    expect(isViewRequest(viewRequest(1, op, {}))).toBe(true);

  vi.useFakeTimers();
  const f = frame();
  const store = timedStore(f);

  const external = store.openExternal(new URL('https://www.notion.so/p'));
  const resource = store.openResource('did:ad:row');
  const outcome = resource.then(
    () => 'answered',
    (e: Error) => e.message,
  );
  const [ask, open] = f.parent.postMessage.mock.calls.map(([m]) => m);
  expect([ask, open].every(isViewRequest)).toBe(true);
  expect(ask).toMatchObject({
    op: 'openExternal',
    args: { url: 'https://www.notion.so/p' },
  });
  expect(open).toMatchObject({
    op: 'openResource',
    args: { subject: 'did:ad:row' },
  });

  // The person may take minutes to decide; that is not a silent host.
  expect(vi.getTimerCount()).toBe(1);
  await vi.advanceTimersByTimeAsync(10 * 60_000);
  expect(await outcome).toMatch('did not answer openResource');
  f.reply({
    type: 'atomic.view.response',
    version: 1,
    id: ask.id,
    result: { status: 'cancelled' },
  });
  expect(await external).toEqual({ status: 'cancelled' });
});
