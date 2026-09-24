// @wc-ignore-file
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  Agent,
  JSCryptoProvider,
  core,
  decodeB64,
  server,
  type Resource,
  type Store,
} from '@tomic/react';
import { ProxyConnections } from './proxyConnections';
import {
  asRuntime,
  forgetRegisteredRuntimes,
  registerInstallationRuntimes,
  registerRuntimes,
  unregisterRuntimes,
} from './installationRuntimes';

const ORIGIN = 'http://proxy.test';
/** The key of `lib/src/authentication_v2_vectors.json`. */
const PRIVATE_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const USER_PUBLIC = 'O2onvM62pC1io6jQKm8Nc2UyFXcd4kOmOsBIoYtZ2ik';
const USER = `atomic:agent:${USER_PUBLIC}`;
const APP = `atomic:agent:${'A'.repeat(42)}E`;
const NODE_A = `atomic:agent:${'B'.repeat(42)}E`;
const NODE_B = `atomic:agent:${'C'.repeat(42)}E`;
const INSTALLATION = 'did:ad:installation';

const user = () =>
  new Agent(new JSCryptoProvider(PRIVATE_KEY), `did:ad:agent:${USER_PUBLIC}`);

async function sha256Hex(text: string) {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)),
    ),
    b => b.toString(16).padStart(2, '0'),
  ).join('');
}

async function verified(
  method: string,
  url: string,
  body: string | undefined,
  h: Record<string, string>,
) {
  const message = [
    'atomic-request-v2',
    method,
    url,
    h['x-atomic-timestamp'],
    await sha256Hex(body ?? ''),
  ].join('\n');
  const key = await crypto.subtle.importKey(
    'raw',
    new Uint8Array(decodeB64(h['x-atomic-public-key'])),
    { name: 'Ed25519' },
    false,
    ['verify'],
  );

  return (
    h['x-atomic-signature-version'] === '2' &&
    h['x-atomic-agent'] === `atomic:agent:${h['x-atomic-public-key']}` &&
    crypto.subtle.verify(
      { name: 'Ed25519' },
      key,
      new Uint8Array(decodeB64(h['x-atomic-signature'])),
      new TextEncoder().encode(message),
    )
  );
}

/**
 * The proxy's runtimes routes as atomic-plugins#122 implements them: every
 * call signed v2 by the owner, `POST /runtimes {app, agent, label?}` with no
 * other fields, upserted on (owner, agent), and `DELETE /runtimes/{agent}`.
 */
function fakeProxy() {
  const calls: {
    method: string;
    url: string;
    body?: string;
    headers: Record<string, string>;
  }[] = [];
  const runtimes = new Map<
    string,
    { agent: string; app: string; label: string | null }
  >();
  let failNext: number | undefined;
  const http = vi.fn(async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    const body = init.body as string | undefined;
    const headers = init.headers as Record<string, string>;
    calls.push({ method, url, body, headers });

    if (!(await verified(method, url, body, headers)))
      return Response.json(
        { error: 'bad_signature', message: 'no' },
        { status: 401 },
      );

    if (failNext) {
      const status = failNext;
      failNext = undefined;

      return Response.json(
        { error: 'unavailable', message: 'try later' },
        { status },
      );
    }

    const path = new URL(url).pathname;

    if (path === '/connections' && method === 'GET')
      return Response.json({
        owner: headers['x-atomic-agent'],
        connections: [],
        runtimes: [...runtimes.values()],
      });

    if (path === '/runtimes' && method === 'POST') {
      const parsed = JSON.parse(body!);
      const keys = Object.keys(parsed).sort();
      if (
        !['agent,app', 'agent,app,label'].includes(keys.join(',')) ||
        parsed.agent === parsed.app ||
        parsed.agent === headers['x-atomic-agent']
      )
        return Response.json(
          { error: 'bad_request', message: 'body' },
          { status: 400 },
        );
      runtimes.set(parsed.agent, {
        agent: parsed.agent,
        app: parsed.app,
        label: parsed.label ?? null,
      });

      return Response.json(parsed);
    }

    const del = /^\/runtimes\/([^/]+)$/.exec(path);

    if (del && method === 'DELETE') {
      runtimes.delete(decodeURIComponent(del[1]));

      return new Response(null, { status: 204 });
    }

    return Response.json(
      { error: 'not_found', message: path },
      { status: 404 },
    );
  });

  return {
    http: http as unknown as typeof fetch,
    calls,
    runtimes,
    fail(status: number) {
      failNext = status;
    },
  };
}

const connectionsFor = (proxy: ReturnType<typeof fakeProxy>) =>
  new ProxyConnections(
    new Map() as unknown as Storage,
    ORIGIN,
    user,
    proxy.http,
  );

const RUNTIMES = [
  { subject: 'did:ad:rt-a', agent: NODE_A, label: 'Laptop' },
  { subject: 'did:ad:rt-b', agent: NODE_B, label: 'Server' },
];

/** A resource as far as these helpers read one. */
function fakeResource(
  subject: string,
  props: Record<string, unknown>,
  createdBy?: string,
): Resource {
  return {
    subject,
    get: (p: string) => props[p],
    hasClasses: (...c: string[]) =>
      c.every(x =>
        ((props[core.properties.isA] as string[]) ?? []).includes(x),
      ),
    getCreatedBy: () => createdBy,
  } as unknown as Resource;
}

const runtimeChild = (
  subject: string,
  agent: string,
  name: string,
  createdBy = agent,
) =>
  fakeResource(
    subject,
    {
      [core.properties.isA]: [server.classes.installationRuntime],
      [core.properties.parent]: INSTALLATION,
      [server.properties.integrationRuntimeAgent]: agent,
      [core.properties.name]: name,
    },
    createdBy,
  );

beforeEach(() => forgetRegisteredRuntimes());

describe('registerRuntimes', () => {
  it('posts {app, agent, label} signed v2 by the user over method, URL and body', async () => {
    const proxy = fakeProxy();
    const posted = await registerRuntimes(
      connectionsFor(proxy),
      USER,
      APP,
      RUNTIMES,
    );

    expect(posted.sort()).toEqual([NODE_A, NODE_B].sort());
    expect(proxy.calls.map(c => [c.method, c.url])).toEqual([
      ['GET', `${ORIGIN}/connections`],
      ['POST', `${ORIGIN}/runtimes`],
      ['POST', `${ORIGIN}/runtimes`],
    ]);
    // The two POSTs run concurrently, so either may come first.
    const post = proxy.calls.find(
      c => c.method === 'POST' && JSON.parse(c.body!).agent === NODE_A,
    )!;
    expect(JSON.parse(post.body!)).toEqual({
      app: APP,
      agent: NODE_A,
      label: 'Laptop',
    });
    expect(post.headers['Content-Type']).toBe('application/json');
    expect(post.headers['x-atomic-agent']).toBe(USER);
    // The fake proxy answered 200 only because each signature verified.
    expect(await verified(post.method, post.url, post.body, post.headers)).toBe(
      true,
    );
    // Tampering with the body breaks the signature.
    expect(
      await verified(post.method, post.url, `${post.body} `, post.headers),
    ).toBe(false);
    expect(proxy.runtimes.get(NODE_A)).toEqual({
      agent: NODE_A,
      app: APP,
      label: 'Laptop',
    });
    expect(proxy.runtimes.get(NODE_B)).toEqual({
      agent: NODE_B,
      app: APP,
      label: 'Server',
    });
  });

  it('is idempotent: nothing is posted again in this page or after a reload', async () => {
    const proxy = fakeProxy();
    await registerRuntimes(connectionsFor(proxy), USER, APP, RUNTIMES);
    proxy.calls.length = 0;

    // Same page: remembered, the proxy is not asked at all.
    expect(
      await registerRuntimes(connectionsFor(proxy), USER, APP, RUNTIMES),
    ).toEqual([]);
    expect(proxy.calls).toEqual([]);

    // A reload: the proxy already lists them for this app and label.
    forgetRegisteredRuntimes();
    expect(
      await registerRuntimes(connectionsFor(proxy), USER, APP, RUNTIMES),
    ).toEqual([]);
    expect(proxy.calls.map(c => c.method)).toEqual(['GET']);
    expect(proxy.runtimes.size).toBe(2);
  });

  it('posts again when the label or the app changed, and only for that one', async () => {
    const proxy = fakeProxy();
    await registerRuntimes(connectionsFor(proxy), USER, APP, RUNTIMES);
    forgetRegisteredRuntimes();
    proxy.calls.length = 0;

    await registerRuntimes(connectionsFor(proxy), USER, APP, [
      RUNTIMES[0],
      { ...RUNTIMES[1], label: 'Renamed server' },
    ]);
    expect(proxy.calls.map(c => c.method)).toEqual(['GET', 'POST']);
    expect(proxy.runtimes.get(NODE_B)?.label).toBe('Renamed server');
  });

  it('accepts the app id in its did:ad spelling and sends it canonical', async () => {
    const proxy = fakeProxy();
    await registerRuntimes(
      connectionsFor(proxy),
      USER,
      APP.replace('atomic:agent:', 'did:ad:agent:'),
      [RUNTIMES[0]],
    );
    expect(JSON.parse(proxy.calls[1].body!).app).toBe(APP);
  });

  it('skips a runtime that is the app or the owner, which the proxy refuses', async () => {
    const proxy = fakeProxy();
    expect(
      await registerRuntimes(connectionsFor(proxy), USER, APP, [
        { subject: 'x', agent: APP },
        { subject: 'y', agent: USER },
      ]),
    ).toEqual([]);
    expect(proxy.calls).toEqual([]);
  });

  it('rejects with the proxy error, and a later call retries', async () => {
    const proxy = fakeProxy();
    await registerRuntimes(connectionsFor(proxy), USER, APP, []);
    proxy.fail(503);
    await expect(
      registerRuntimes(connectionsFor(proxy), USER, APP, [RUNTIMES[0]]),
    ).rejects.toThrow(
      'The integration proxy refused GET /connections: try later',
    );

    expect(
      await registerRuntimes(connectionsFor(proxy), USER, APP, [RUNTIMES[0]]),
    ).toEqual([NODE_A]);
  });
});

describe('unregisterRuntimes', () => {
  it('sends DELETE /runtimes/{agent}, signed, and forgets the registration', async () => {
    const proxy = fakeProxy();
    await registerRuntimes(connectionsFor(proxy), USER, APP, RUNTIMES);
    proxy.calls.length = 0;

    await unregisterRuntimes(connectionsFor(proxy), RUNTIMES);
    expect(proxy.calls.map(c => [c.method, c.url, c.body]).sort()).toEqual([
      ['DELETE', `${ORIGIN}/runtimes/${encodeURIComponent(NODE_A)}`, undefined],
      ['DELETE', `${ORIGIN}/runtimes/${encodeURIComponent(NODE_B)}`, undefined],
    ]);
    for (const call of proxy.calls)
      expect(
        await verified(call.method, call.url, call.body, call.headers),
      ).toBe(true);
    expect(proxy.runtimes.size).toBe(0);

    // Registering again after a revoke goes back to the proxy.
    proxy.calls.length = 0;
    await registerRuntimes(connectionsFor(proxy), USER, APP, RUNTIMES);
    expect(proxy.calls.map(c => c.method)).toEqual(['GET', 'POST', 'POST']);
  });
});

describe('asRuntime', () => {
  it('reads a runtime child the named agent published itself', () => {
    expect(
      asRuntime(runtimeChild('did:ad:rt-a', NODE_A, 'Laptop'), INSTALLATION),
    ).toEqual({ subject: 'did:ad:rt-a', agent: NODE_A, label: 'Laptop' });
    // The genesis signer may be in the did:ad spelling.
    expect(
      asRuntime(
        runtimeChild(
          'did:ad:rt-a',
          NODE_A,
          'Laptop',
          NODE_A.replace('atomic:agent:', 'did:ad:agent:'),
        ),
        INSTALLATION,
      )?.agent,
    ).toBe(NODE_A);
  });

  it('ignores a child naming an agent that did not publish it', () => {
    expect(
      asRuntime(
        runtimeChild('did:ad:rt-a', NODE_A, 'Laptop', NODE_B),
        INSTALLATION,
      ),
    ).toBeUndefined();
  });

  it('ignores other children and other parents', () => {
    expect(
      asRuntime(
        fakeResource('did:ad:note', {
          [core.properties.parent]: INSTALLATION,
        }),
        INSTALLATION,
      ),
    ).toBeUndefined();
    expect(
      asRuntime(runtimeChild('did:ad:rt-a', NODE_A, 'Laptop'), 'did:ad:other'),
    ).toBeUndefined();
  });
});

describe('registerInstallationRuntimes', () => {
  function fakeStore(installation: Resource, children: Resource[]) {
    const all = new Map(
      [installation, ...children].map(r => [r.subject, r] as const),
    );

    return {
      getAgent: user,
      getResource: async (s: string) => all.get(s)!,
    } as unknown as Store;
  }

  it('registers the published runtimes under the Installation app id', async () => {
    const proxy = fakeProxy();
    const store = fakeStore(
      fakeResource(INSTALLATION, {
        [server.properties.integrationAppAgent]: APP,
      }),
      [
        runtimeChild('did:ad:rt-a', NODE_A, 'Laptop'),
        runtimeChild('did:ad:forged', NODE_B, 'Forged', NODE_A),
      ],
    );

    expect(
      await registerInstallationRuntimes(
        store,
        connectionsFor(proxy),
        INSTALLATION,
        ['did:ad:rt-a', 'did:ad:forged'],
      ),
    ).toEqual([NODE_A]);
    expect([...proxy.runtimes.values()]).toEqual([
      { agent: NODE_A, app: APP, label: 'Laptop' },
    ]);
  });

  it('does nothing for an app without an app id', async () => {
    const proxy = fakeProxy();
    const store = fakeStore(fakeResource(INSTALLATION, {}), [
      runtimeChild('did:ad:rt-a', NODE_A, 'Laptop'),
    ]);

    expect(
      await registerInstallationRuntimes(
        store,
        connectionsFor(proxy),
        INSTALLATION,
        ['did:ad:rt-a'],
      ),
    ).toEqual([]);
    expect(proxy.calls).toEqual([]);
  });
});
