import { describe, expect, it } from 'vitest';
import { parseListings } from './pluginListings';

const entry = {
  subject: 'https://example.com/listings/1',
  name: 'Example',
  emoji: null,
  description: 'An example',
  publisher: null,
  domains: ['education'],
  standards: ['https://example.com/standard'],
  release: 'https://example.com/releases/1',
  releaseId: 'blake3:1',
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

/** What the Apps page does with the parsed catalog before rendering it. */
function search(body: unknown, query: string) {
  return parseListings(body).filter(listing =>
    [
      listing.name,
      listing.description,
      ...listing.domains,
      ...listing.standards,
    ]
      .join(' ')
      .toLocaleLowerCase()
      .includes(query),
  );
}

const formats = [
  { name: 'legacy array', wrap: (entries: unknown[]) => entries },
  {
    name: 'catalog envelope with host features',
    wrap: (entries: unknown[]) => ({ entries, hostFeatures }),
  },
];

describe('parseListings', () => {
  describe.each(formats)('$name', ({ wrap }) => {
    it('keeps a list of listings for rendering and searching', () => {
      expect(parseListings(wrap([entry]))).toEqual([entry]);
      expect(search(wrap([entry]), 'educ')).toHaveLength(1);
      expect(search(wrap([entry]), 'nothing')).toHaveLength(0);
    });

    it('accepts an empty catalog', () => {
      expect(parseListings(wrap([]))).toEqual([]);
      expect(search(wrap([]), '')).toEqual([]);
    });

    it('normalises domains and standards that are not lists', () => {
      const [listing] = parseListings(
        wrap([
          {
            ...entry,
            domains: null,
            standards: 'https://example.com/standard',
          },
        ]),
      );

      expect(listing.domains).toEqual([]);
      expect(listing.standards).toEqual([]);
    });

    it('keeps only strings in domains and standards', () => {
      const [listing] = parseListings(
        wrap([
          {
            ...entry,
            domains: ['education', null, 1],
            standards: [false, 'https://example.com/standard'],
          },
        ]),
      );

      expect(listing.domains).toEqual(['education']);
      expect(listing.standards).toEqual(['https://example.com/standard']);
    });

    it('normalises name and description before rendering', () => {
      const listings = parseListings(
        wrap([
          { ...entry, name: null, description: undefined },
          { ...entry, name: 123, description: true },
        ]),
      );

      expect(
        listings.map(({ name, description }) => [name, description]),
      ).toEqual([
        ['', ''],
        ['123', 'true'],
      ]);
    });

    it('drops entries that are not objects', () => {
      expect(parseListings(wrap([entry, null, 'x', 1, true]))).toEqual([entry]);
    });
  });

  it.each([
    ['an object', { error: 'Not found' }],
    ['null', null],
    ['undefined', undefined],
    ['a string', 'ok'],
    ['a number', 1],
    ['a boolean', true],
    ['an empty object', {}],
    ['an envelope without entries', { hostFeatures }],
    ['null entries', { entries: null }],
    ['object entries', { entries: {} }],
    ['string entries', { entries: 'catalog' }],
    ['number entries', { entries: 1 }],
    ['boolean entries', { entries: false }],
  ])('rejects %s instead of letting the page filter it', (_, body) => {
    expect(() => search(body, '')).toThrow(
      'The plugin catalog did not return a list of plugins.',
    );
  });
});
