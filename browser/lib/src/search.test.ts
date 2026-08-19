import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'vitest';
import { escapeTantivyKey, buildSearchSubject, SearchOpts } from './search.js';

/**
 * Shared with `lib/src/client/search.rs` and the File-picker repro.
 * Renaming an expected value here without the Rust suite is how the two
 * escape helpers drift and File-picker filters stop matching.
 */
const fixture = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL('../../../testdata/search-query.json', import.meta.url),
    ),
    'utf-8',
  ),
) as {
  escape: { input: string; escaped: string }[];
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
  it('escapes Tantivy keys the same way as Rust', ({ expect }) => {
    for (const { input, escaped } of fixture.escape) {
      expect(escapeTantivyKey(input)).toBe(escaped);
    }
  });

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
});
