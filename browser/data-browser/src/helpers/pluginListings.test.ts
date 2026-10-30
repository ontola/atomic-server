import { describe, expect, it } from 'vitest';
import { parsePluginListings, type Listing } from './pluginListings';

const listing: Listing = {
  subject: 'https://example.com/listings/fixture',
  name: 'Community fixture',
  emoji: null,
  description: 'Test listing',
  publisher: null,
  domains: ['example.com'],
  standards: ['https://example.com/standard'],
  release: 'https://example.com/releases/fixture',
  releaseId: 'blake3:fixture',
  runtime: null,
  world: null,
};

const hostFeatures = {
  pluginRoutes: {
    compiled: true,
    level: 'off',
    listeners: [],
    requestHost: true,
    routesOrigin: null,
    sidecars: [],
  },
};

describe('parsePluginListings', () => {
  it.each([
    { name: 'legacy array', response: [listing], expected: [listing] },
    { name: 'empty legacy array', response: [], expected: [] },
    {
      name: 'catalog envelope',
      response: { entries: [listing], hostFeatures },
      expected: [listing],
    },
    {
      name: 'empty catalog envelope',
      response: { entries: [], hostFeatures },
      expected: [],
    },
  ])('accepts $name for rendering and filtering', ({ response, expected }) => {
    const entries = parsePluginListings(response);
    expect(entries.filter(entry => entry.name.includes('fixture'))).toEqual(
      expected,
    );
  });

  it('accepts omitted optional metadata', () => {
    const {
      emoji: _emoji,
      publisher: _publisher,
      runtime: _runtime,
      world: _world,
      ...minimal
    } = listing;
    expect(parsePluginListings([minimal])).toEqual([minimal]);
  });

  it.each([
    null,
    undefined,
    true,
    1,
    'catalog',
    {},
    { hostFeatures },
    { entries: null },
    { entries: {} },
    { entries: 'catalog' },
  ])('rejects an invalid response: %j', response => {
    expect(() => parsePluginListings(response)).toThrow(
      /Invalid plugin catalog/,
    );
  });

  it.each([
    null,
    'listing',
    {},
    { ...listing, subject: null },
    { ...listing, name: {} },
    { ...listing, description: 1 },
    { ...listing, release: undefined },
    { ...listing, releaseId: [] },
    { ...listing, domains: undefined },
    { ...listing, domains: 'example.com' },
    { ...listing, domains: [1] },
    { ...listing, standards: null },
    { ...listing, standards: {} },
    { ...listing, standards: [null] },
    { ...listing, emoji: {} },
    { ...listing, publisher: [] },
    { ...listing, runtime: true },
    { ...listing, world: 1 },
  ])('rejects malformed listings before rendering: %j', entry => {
    expect(() => parsePluginListings([entry])).toThrow(
      /Invalid plugin catalog/,
    );
    expect(() =>
      parsePluginListings({ entries: [entry], hostFeatures }),
    ).toThrow(/Invalid plugin catalog/);
  });
});
