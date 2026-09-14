import { expect, it } from 'vitest';
import { localThoughtCatalogEntries } from './localThoughtCatalogEntries';

it('keeps the Calendar lens installable before discovery and after a catalog failure', () => {
  expect(localThoughtCatalogEntries()).toEqual(['google-calendar']);
  expect(localThoughtCatalogEntries([])).toEqual(['google-calendar']);
});

it('deduplicates Calendar while preserving other discovered platforms', () => {
  expect(
    localThoughtCatalogEntries(['github-issues', 'google-calendar', 'pets']),
  ).toEqual(['google-calendar', 'github-issues', 'pets']);
});
