import { expect, it } from 'vitest';
import { localThoughtCatalogEntries } from './localThoughtCatalogEntries';

it('reflects the generated catalog without injecting bundled integrations', () => {
  expect(localThoughtCatalogEntries()).toEqual([]);
  expect(localThoughtCatalogEntries([])).toEqual([]);
});

it('deduplicates generated platforms while preserving their catalog order', () => {
  expect(
    localThoughtCatalogEntries(['github-issues', 'google-calendar', 'pets']),
  ).toEqual(['github-issues', 'google-calendar', 'pets']);
});
