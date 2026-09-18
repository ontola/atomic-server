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

it('leaves out platforms a bundled catalog entry already connects through', () => {
  expect(
    localThoughtCatalogEntries(
      ['moneybird', 'google-calendar', 'pets'],
      ['moneybird', 'google-calendar'],
    ),
  ).toEqual(['pets']);
});
