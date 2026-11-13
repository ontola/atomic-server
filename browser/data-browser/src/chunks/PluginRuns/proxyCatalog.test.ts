import { describe, expect, it, vi } from 'vitest';
import {
  fetchProxyAppIndex,
  fetchProxyPlatforms,
  parseProxyAppIndex,
  parseProxyPlatforms,
} from './proxyCatalog';

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

describe('structured proxy app index', () => {
  const entry = {
    version: 1,
    platforms: [
      {
        id: 'github-issues',
        name: 'GitHub',
        description: 'Sync repository issues',
        document: '/catalog/github-issues.yaml',
      },
    ],
  };

  it('parses service metadata without permitting arbitrary document URLs', () => {
    expect(parseProxyAppIndex(entry)).toEqual(entry.platforms);
    expect(() =>
      parseProxyAppIndex({
        ...entry,
        platforms: [{ ...entry.platforms[0], document: 'https://evil.example' }],
      }),
    ).toThrow('Invalid proxy platform document path');
  });

  it('uses the new endpoint when available', async () => {
    const transport = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => entry,
    })) as unknown as typeof fetch;
    expect(await fetchProxyAppIndex('https://proxy.example', { transport })).toEqual(
      entry.platforms,
    );
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport).toHaveBeenCalledWith(
      'https://proxy.example/catalog/apps',
      expect.objectContaining({ credentials: 'omit' }),
    );
  });

  it('falls back only on 404 from an older proxy', async () => {
    const transport = vi.fn(async (url: string) =>
      url.endsWith('/catalog/apps')
        ? { ok: false, status: 404 }
        : { ok: true, status: 200, json: async () => ['pets'] },
    ) as unknown as typeof fetch;
    expect(await fetchProxyAppIndex('https://proxy.example', { transport })).toEqual([
      { id: 'pets', name: 'pets' },
    ]);
  });

  it('surfaces transient failures instead of treating them as an empty catalog', async () => {
    const transport = vi.fn(async () => ({ ok: false, status: 503 })) as unknown as typeof fetch;
    await expect(
      fetchProxyAppIndex('https://proxy.example', { transport }),
    ).rejects.toThrow('HTTP 503');
    expect(transport).toHaveBeenCalledTimes(1);
  });
});
