import { afterEach, beforeEach, describe, it, vi } from 'vitest';
import { Client, resetUnreachableWarnings } from './client.js';
import { isTransportError } from './error.js';
import { noteOriginReachable, resetOriginBackoff } from './origin-backoff.js';

/**
 * A drive list on a server that is gone asked for every drive, and asked
 * again on each reconnect and list refresh. One network failure now pauses
 * that origin.
 */
describe('per-origin backoff of unreachable HTTP fetches', () => {
  let clock = 0;

  beforeEach(() => {
    clock = 1_000_000;
    resetOriginBackoff(() => clock);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    resetOriginBackoff();
    resetUnreachableWarnings();
    vi.restoreAllMocks();
  });

  function downClient(down: Set<string>) {
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));

      if (down.has(url.origin)) throw new TypeError('Failed to fetch');

      return new Response(JSON.stringify({ '@id': String(input) }), {
        status: 200,
      });
    });

    return { client: new Client(fetch as typeof globalThis.fetch), fetch };
  }

  it('tries once, then skips the origin with an explicit transport error', async ({
    expect,
  }) => {
    const { client, fetch } = downClient(new Set(['http://localhost:9999']));

    const first = await client.fetchResourceHTTP('http://localhost:9999/a');
    const rest = await Promise.all(
      ['b', 'c', 'd'].map(id =>
        client.fetchResourceHTTP(`http://localhost:9999/${id}`),
      ),
    );

    expect(fetch).toHaveBeenCalledTimes(1);

    for (const { resource } of [first, ...rest]) {
      expect(isTransportError(resource.error)).toBe(true);
      expect(resource.loading).toBe(false);
    }
  });

  it('keeps other origins untouched', async ({ expect }) => {
    const { client, fetch } = downClient(new Set(['http://localhost:9999']));

    await client.fetchResourceHTTP('http://localhost:9999/a');
    const up = await client.fetchResourceHTTP('https://up.example/a');

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(up.resource.error).toBeUndefined();
  });

  it('retries after 30 s, then doubles the wait', async ({ expect }) => {
    const { client, fetch } = downClient(new Set(['http://localhost:9999']));
    const get = () => client.fetchResourceHTTP('http://localhost:9999/a');

    await get();
    clock += 29_000;
    await get();
    expect(fetch).toHaveBeenCalledTimes(1);

    clock += 1_000;
    await get();
    expect(fetch).toHaveBeenCalledTimes(2);

    clock += 59_000;
    await get();
    expect(fetch).toHaveBeenCalledTimes(2);
    clock += 1_000;
    await get();
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('caps the wait at ten minutes', async ({ expect }) => {
    const { client, fetch } = downClient(new Set(['http://localhost:9999']));
    const get = () => client.fetchResourceHTTP('http://localhost:9999/a');

    for (let i = 0; i < 10; i++) {
      await get();
      clock += 10 * 60_000;
    }

    expect(fetch).toHaveBeenCalledTimes(10);
  });

  it('resets when the origin answers again', async ({ expect }) => {
    const down = new Set(['http://localhost:9999']);
    const { client, fetch } = downClient(down);
    const get = () => client.fetchResourceHTTP('http://localhost:9999/a');

    await get();
    clock += 30_000;
    down.clear();
    expect((await get()).resource.error).toBeUndefined();
    down.add('http://localhost:9999');
    await get();
    // The backoff started over at 30 s, not 60 s.
    clock += 30_000;
    await get();

    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it('resets when the store reconnects to the origin', async ({ expect }) => {
    const { client, fetch } = downClient(new Set(['http://localhost:9999']));

    await client.fetchResourceHTTP('http://localhost:9999/a');
    noteOriginReachable('http://localhost:9999');
    await client.fetchResourceHTTP('http://localhost:9999/a');

    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('resets when the browser goes online', async ({ expect }) => {
    // The listener is installed on import, so import against a `window`.
    vi.resetModules();
    const target = new EventTarget();
    vi.stubGlobal('window', target);
    const fresh = await import('./client.js');
    const fetch = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    const client = new fresh.Client(fetch as typeof globalThis.fetch);

    await client.fetchResourceHTTP('http://localhost:9999/a');
    await client.fetchResourceHTTP('http://localhost:9999/a');
    expect(fetch).toHaveBeenCalledTimes(1);
    target.dispatchEvent(new Event('online'));
    await client.fetchResourceHTTP('http://localhost:9999/a');

    expect(fetch).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
  });

  it('does not count an HTTP error status as unreachable', async ({
    expect,
  }) => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetch = vi.fn(async () => new Response('nope', { status: 500 }));
    const client = new Client(fetch as typeof globalThis.fetch);

    await client.fetchResourceHTTP('https://up.example/a');
    await client.fetchResourceHTTP('https://up.example/b');

    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
