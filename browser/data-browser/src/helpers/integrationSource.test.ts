import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchIntegrationSource } from './integrationSource';

afterEach(() => vi.unstubAllGlobals());

describe('bundled integration source', () => {
  it('uses the connected server and keeps servers separate in the cache', async () => {
    const fetch = vi.fn(async (url: string) => new Response(url));
    vi.stubGlobal('fetch', fetch);

    expect(await fetchIntegrationSource('pets', 'https://one.example/')).toBe(
      'https://one.example/integrations/pets/plugin.js',
    );
    expect(await fetchIntegrationSource('pets', 'https://two.example')).toBe(
      'https://two.example/integrations/pets/plugin.js',
    );
    await fetchIntegrationSource('pets', 'https://one.example');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each(['network', 'http', 'body'] as const)(
    'retries after a %s failure',
    async failure => {
      const fetch = vi
        .fn()
        .mockImplementationOnce(() => {
          if (failure === 'network')
            return Promise.reject(new TypeError('offline'));
          if (failure === 'http')
            return Promise.resolve(new Response('', { status: 503 }));

          return Promise.resolve({
            ok: true,
            text: () => Promise.reject(new Error('interrupted')),
          });
        })
        .mockResolvedValue(new Response('recovered source'));
      vi.stubGlobal('fetch', fetch);
      const server = `https://${failure}.example`;

      await expect(
        fetchIntegrationSource(`notion-${failure}`, server),
      ).rejects.toThrow();
      await expect(
        fetchIntegrationSource(`notion-${failure}`, server),
      ).resolves.toBe('recovered source');
      expect(fetch).toHaveBeenCalledTimes(2);
    },
  );
});
