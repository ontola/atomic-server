import { describe, expect, it, vi } from 'vitest';
import { fetchProxyPlatforms, parseProxyPlatforms } from './proxyCatalog';

describe('parseProxyPlatforms', () => {
  it('parses the legacy catalog array and deduplicates platform IDs', () => {
    expect(parseProxyPlatforms(['github-issues', 'pets', 'github-issues'])).toEqual([
      'github-issues',
      'pets',
    ]);
  });

  it('rejects malformed or non-array proxy responses', () => {
    expect(() => parseProxyPlatforms({ platforms: ['pets'] })).toThrow(
      'expected an array',
    );
    expect(() => parseProxyPlatforms(['pets', '../bad'])).toThrow(
      'Invalid integration proxy catalog platform ID',
    );
  });
});

describe('fetchProxyPlatforms', () => {
  it('uses the configured proxy origin, without credentials', async () => {
    const transport = vi.fn(async () => ({
      ok: true,
      json: async () => ['github-issues', 'google-calendar'],
    })) as unknown as typeof fetch;

    expect(
      await fetchProxyPlatforms('https://proxy.example', { transport }),
    ).toEqual(['github-issues', 'google-calendar']);
    expect(transport).toHaveBeenCalledWith(
      'https://proxy.example/catalog',
      expect.objectContaining({ credentials: 'omit', redirect: 'error' }),
    );
  });

  it('reports failures rather than presenting an empty catalog', async () => {
    const transport = vi.fn(async () => ({
      ok: false,
      status: 503,
    })) as unknown as typeof fetch;

    await expect(
      fetchProxyPlatforms('https://proxy.example', { transport }),
    ).rejects.toThrow('HTTP 503');
  });
});
