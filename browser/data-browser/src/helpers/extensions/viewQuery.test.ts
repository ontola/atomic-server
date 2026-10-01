import { describe, expect, it } from 'vitest';
import { parseViewQuery } from './viewQuery';
import { parseViewSearch } from './viewSearch';

const parent = 'https://atomicdata.dev/properties/parent';

describe('parseViewQuery', () => {
  it('keeps the CollectionBuilder names a view asks with', () => {
    expect(
      parseViewQuery({
        property: parent,
        value: 'https://x.dev/table',
        filters: [{ property: 'https://x.dev/done', value: 'false' }],
        sortBy: 'https://x.dev/due',
        sortDesc: true,
        pageSize: 25,
        page: 2,
      }),
    ).toEqual({
      property: parent,
      value: 'https://x.dev/table',
      filters: [{ property: 'https://x.dev/done', value: 'false' }],
      sortBy: 'https://x.dev/due',
      sortDesc: true,
      pageSize: 25,
      page: 2,
    });
  });

  it('still takes the property/value pair apps have always sent', () => {
    expect(parseViewQuery({ property: parent, value: 'x' })).toMatchObject({
      property: parent,
      value: 'x',
      filters: [],
      page: undefined,
    });
  });

  it('refuses a query for the whole drive and oversized pages', () => {
    expect(() => parseViewQuery({})).toThrow('property or a filter');
    expect(() => parseViewQuery({ property: parent, pageSize: 101 })).toThrow(
      'pageSize',
    );
    expect(() => parseViewQuery({ property: parent, page: -1 })).toThrow(
      'page',
    );
    expect(() => parseViewQuery({ property: 'parent' })).toThrow('subject');
    expect(() =>
      parseViewQuery({
        filters: Array.from({ length: 11 }, () => ({
          property: parent,
          value: 'x',
        })),
      }),
    ).toThrow('at most 10');
  });
});

describe('parseViewSearch', () => {
  it('bounds a search', () => {
    expect(parseViewSearch({ text: 'tea' })).toEqual({
      text: 'tea',
      isA: undefined,
      parents: [],
      limit: 20,
    });
    expect(() => parseViewSearch({ text: 'tea', limit: 51 })).toThrow('limit');
    expect(() => parseViewSearch({ text: 'tea', isA: 'x' })).toThrow('isA');
    expect(() => parseViewSearch({})).toThrow('text');
  });
});
