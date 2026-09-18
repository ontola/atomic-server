import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, vi } from 'vitest';
import {
  buildSearchSubject,
  removeCachedSearchResults,
  SearchOpts,
} from './search.js';
import { Store } from './store.js';
import { Resource } from './resource.js';

/**
 * Shared with `lib/src/client/search.rs`. Renaming an expected value here
 * without the Rust suite is how the two search-URL builders drift.
 */
const fixture = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL('../../../testdata/search-query.json', import.meta.url),
    ),
    'utf-8',
  ),
) as {
  searchSubject: {
    serverUrl: string;
    query: string;
    include: boolean;
    limit: number;
    parents: string;
    filters: Record<string, string>;
    expected: string;
  };
};

describe('search.ts', () => {
  it('Builds a good search URL', ({ expect }) => {
    const { serverUrl, query, include, limit, parents, filters, expected } =
      fixture.searchSubject;
    const searchOpts: SearchOpts = {
      include,
      limit,
      parents,
      filters,
    };
    expect(buildSearchSubject(serverUrl, query, searchOpts)).toBe(expected);
  });

  it('Puts property URLs in filters without escaping', ({ expect }) => {
    const built = buildSearchSubject('https://test.com', '', {
      filters: {
        'https://atomicdata.dev/properties/isA':
          'https://atomicdata.dev/classes/File',
      },
    });
    expect(built).toContain(
      'filters=https%3A%2F%2Fatomicdata.dev%2Fproperties%2FisA%3A%22https%3A%2F%2Fatomicdata.dev%2Fclasses%2FFile%22',
    );
  });
});

it('invalidating search projections does not delete persisted resources or leave sync pending', ({
  expect,
}) => {
  const store = new Store({ serverUrl: 'https://example.com' });
  const subject = buildSearchSubject(store.getServerUrl(), 'website');
  store.addResource(new Resource(subject));
  const removeResource = vi.fn(() => new Promise<void>(() => {}));
  store.setClientDb({ removeResource } as unknown as Parameters<
    Store['setClientDb']
  >[0]);

  removeCachedSearchResults(store);

  expect(store.resources.has(subject)).toBe(false);
  expect(removeResource).not.toHaveBeenCalled();
  expect(store.getSyncStatus().pendingDirtyCount).toBe(0);
});
