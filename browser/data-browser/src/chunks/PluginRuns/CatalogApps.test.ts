// @wc-ignore-file
import { expect, it } from 'vitest';
import { appShareLink } from './CatalogApps';

const PRIMARY = 'https://main.test/catalog.json';

it('links to the app alone for the primary marketplace', () => {
  expect(appShareLink('https://atomic.test', 'notes', PRIMARY, PRIMARY)).toBe(
    'https://atomic.test/app/apps?app=notes',
  );
});

it('names another marketplace so it can be added first', () => {
  expect(
    appShareLink(
      'https://atomic.test',
      'notes',
      'https://x.test/c.json',
      PRIMARY,
    ),
  ).toBe(
    'https://atomic.test/app/apps?app=notes&marketplace=https%3A%2F%2Fx.test%2Fc.json',
  );
});
