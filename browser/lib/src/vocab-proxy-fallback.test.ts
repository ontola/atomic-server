import { describe, expect, it, vi } from 'vitest';
import { Agent } from './agent.js';
import { JSCryptoProvider } from './CryptoProvider.js';
import { Client, proxyPathUrl } from './client.js';
import { core } from './ontologies/core.js';
import { Store } from './store.js';

/**
 * ontola/atomic-server#1838: a fetch through the own server's `/path` proxy
 * was signed over the external subject, not over the URL requested, so the
 * server refused it. And a browser that could not reach a vocabulary host
 * never asked its own server.
 */

const SERVER = 'https://app.atomic.place';
const TERM = 'https://ontola.github.io/atomic-plugins/ontology/classes/draft';
const PROXIED = proxyPathUrl(SERVER, TERM);

async function makeAgent(): Promise<Agent> {
  const keys = await Agent.generateKeyPair();

  return new Agent(
    new JSCryptoProvider(keys.privateKey),
    `did:ad:agent:${keys.publicKey}`,
  );
}

function termResponse(id = TERM): Response {
  return new Response(
    JSON.stringify({ '@id': id, [core.properties.name]: 'Draft' }),
  );
}

describe('signing a fetch through the /path proxy', () => {
  it('signs exactly the proxy URL it requests', async () => {
    const agent = await makeAgent();
    let requested = '';
    let headers: Headers | undefined;
    const client = new Client(async (input, init) => {
      requested = String(input);
      headers = new Headers(init?.headers);

      return termResponse(requested);
    });

    const { resource } = await client.fetchResourceHTTP(TERM, {
      from: SERVER,
      signInfo: { agent, serverURL: SERVER },
      serverURL: SERVER,
    });

    expect(resource.error).toBeUndefined();
    expect(resource.subject).toBe(TERM);
    expect(requested).toBe(PROXIED);
    expect(requested).toBe(
      `${SERVER}/path?path=${encodeURIComponent(TERM).replace(/%20/g, '+')}`,
    );
    // Ed25519 is deterministic: the same message gives the same signature.
    const timestamp = Number(headers!.get('x-atomic-timestamp'));
    expect(headers!.get('x-atomic-signature')).toBe(
      await agent.createSignature(PROXIED, timestamp),
    );
    expect(headers!.get('x-atomic-signature')).not.toBe(
      await agent.createSignature(TERM, timestamp),
    );
  });

  it('builds the proxy URL the same with or without a trailing slash', () => {
    expect(proxyPathUrl(`${SERVER}/`, TERM)).toBe(PROXIED);
  });
});

describe('falling back to the own server for foreign vocabulary', () => {
  function storeWith(fetch: (url: string) => Promise<Response>) {
    const store = new Store({ serverUrl: SERVER, connect: false });
    const calls: string[] = [];
    store.injectFetch(async input => {
      calls.push(String(input));

      return fetch(String(input));
    });

    return { store, calls };
  }

  it('asks the origin first and uses a direct answer', async () => {
    const { store, calls } = storeWith(async () => termResponse());
    const resource = await store.fetchResourceFromServer(TERM);

    expect(calls).toEqual([TERM]);
    expect(resource.get(core.properties.name)).toBe('Draft');
  });

  it.each([
    ['a network or CORS failure', () => Promise.reject(new TypeError('CORS'))],
    ['a 503', async () => new Response('down', { status: 503 })],
    ['a 500', async () => new Response('boom', { status: 500 })],
  ])('retries through the proxy after %s', async (_label, fail) => {
    const { store, calls } = storeWith(url =>
      url === TERM ? fail() : Promise.resolve(termResponse(PROXIED)),
    );
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const resource = await store.fetchResourceFromServer(TERM);

    expect(calls).toEqual([TERM, PROXIED]);
    expect(resource.error).toBeUndefined();
    expect(resource.subject).toBe(TERM);
    expect(resource.get(core.properties.name)).toBe('Draft');
    // Cached under its own subject, like a direct answer.
    expect(store.getResourceLoading(TERM).get(core.properties.name)).toBe(
      'Draft',
    );
  });

  it('does not retry an answer about the resource (404)', async () => {
    const { store, calls } = storeWith(async () =>
      Promise.resolve(new Response('nope', { status: 404 })),
    );
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const resource = await store.fetchResourceFromServer(TERM);

    expect(calls).toEqual([TERM]);
    expect(resource.error).toBeDefined();
  });

  it('stops after one proxy attempt when both routes fail', async () => {
    const { store, calls } = storeWith(() =>
      Promise.reject(new TypeError('offline')),
    );
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const resource = await store.fetchResourceFromServer(TERM);

    expect(calls).toEqual([TERM, PROXIED]);
    expect(resource.error).toBeDefined();
  });

  it('goes to the proxy first for an origin the proxy already served', async () => {
    const other =
      'https://ontola.github.io/atomic-plugins/ontology/properties/title';
    const { store, calls } = storeWith(url =>
      url.startsWith('https://ontola.github.io')
        ? Promise.reject(new TypeError('CORS'))
        : Promise.resolve(
            termResponse(
              url === PROXIED ? PROXIED : proxyPathUrl(SERVER, other),
            ),
          ),
    );
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await store.fetchResourceFromServer(TERM);
    const second = await store.fetchResourceFromServer(other);

    expect(calls).toEqual([TERM, PROXIED, proxyPathUrl(SERVER, other)]);
    expect(second.subject).toBe(other);
  });

  it('does not proxy a query or collection URL on another server', async () => {
    const query = 'https://legacy.example.com/query?property=x';
    const { store, calls } = storeWith(async () =>
      Promise.resolve(new Response('Invalid query param', { status: 500 })),
    );
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await store.fetchResourceFromServer(query);

    expect(calls).toEqual([query]);
  });

  it('never proxies the own server', async () => {
    const own = `${SERVER}/classes/thing`;
    const { store, calls } = storeWith(() =>
      Promise.reject(new TypeError('offline')),
    );
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await store.fetchResourceFromServer(own);

    expect(calls).toEqual([own]);
  });
});
