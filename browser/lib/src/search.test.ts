import { describe, it } from 'vitest';
import { buildSearchSubject, SearchOpts } from './search.js';

describe('search.ts', () => {
  it('Builds a good search URL', ({ expect }) => {
    const serverURL = 'https://test.com';
    const query = 'test';
    const searchOpts: SearchOpts = {
      include: true,
      limit: 30,
      parents: 'https://test.com/parent',
      filters: {
        age: '10',
      },
    };
    const built = buildSearchSubject(serverURL, query, searchOpts);
    expect(built).toBe(
      'https://test.com/search?q=test&include=true&limit=30&filters=age%3A%2210%22&parents=https%3A%2F%2Ftest.com%2Fparent',
    );
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
