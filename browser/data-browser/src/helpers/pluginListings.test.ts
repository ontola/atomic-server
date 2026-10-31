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

describe('parseListings', () => {
  it('keeps a list of listings', () => {
    expect(search([entry], 'educ')).toHaveLength(1);
    expect(search([entry], 'nothing')).toHaveLength(0);
  });

  it.each([
    ['an object', { error: 'Not found' }],
    ['null', null],
    ['a string', 'ok'],
    ['a number', 1],
  ])('rejects %s instead of letting the page filter it', (_, body) => {
    expect(() => search(body, '')).toThrow(/did not return a list/);
  });

  it('normalises domains and standards that are not lists', () => {
    const [listing] = parseListings([
      { ...entry, domains: null, standards: 'https://example.com/standard' },
    ]);

    expect(listing.domains).toEqual([]);
    expect(listing.standards).toEqual([]);
  });

  it('drops entries that are not objects', () => {
    expect(parseListings([entry, null, 'x'])).toHaveLength(1);
  });
});
