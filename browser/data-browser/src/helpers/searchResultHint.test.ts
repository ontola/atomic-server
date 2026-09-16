import { describe, expect, it } from 'vitest';
import { getSearchResultHint } from './searchResultHint';

describe('getSearchResultHint', () => {
  it('prefers an exact token over an earlier fuzzy token', () => {
    expect(
      getSearchResultHint('cat dog', {
        document: 'bat cat and dog',
      })?.match,
    ).toBe('cat');
  });

  it('preserves original offsets after Unicode lowercase expansion', () => {
    expect(
      getSearchResultHint('needle', {
        document: 'İ needle',
      }),
    ).toMatchObject({ before: 'İ ', match: 'needle', after: '' });
    expect(
      getSearchResultHint('i\u0307', {
        document: 'İstanbul',
      })?.match,
    ).toBe('İ');
  });

  it('does not treat a substring inside a word as an exact match', () => {
    expect(
      getSearchResultHint('needle', {
        document: 'hayneedle',
      }),
    ).toBeNull();
  });

  it('bounds the excerpt even when the matching phrase is very long', () => {
    const phrase = 'needle '.repeat(30).trim();
    const hint = getSearchResultHint(phrase, { document: phrase });
    expect(
      `${hint?.before}${hint?.match}${hint?.after}`.length,
    ).toBeLessThanOrEqual(122);
  });

  it('returns document context and preserves the matched spelling', () => {
    const hint = getSearchResultHint('needle phrase', {
      title: 'Notes',
      document: 'A sentence before the needle phrase and a sentence after it.',
    });

    expect(hint).toMatchObject({
      field: 'document',
      label: 'In document',
      match: 'needle phrase',
    });
    expect(`${hint?.before}${hint?.match}${hint?.after}`).toContain(
      'sentence before the needle phrase and a sentence after',
    );
  });

  it('prefers document context over a title match', () => {
    const hint = getSearchResultHint('avocado', {
      title: 'Avocado notes',
      document: 'Remember to buy an avocado tomorrow.',
    });

    expect(hint?.field).toBe('document');
  });

  it('finds prefix and one-edit fuzzy matches', () => {
    expect(
      getSearchResultHint('avo', { document: 'Ripe avocado toast' })?.match,
    ).toBe('avo');
    expect(
      getSearchResultHint('avacado', { document: 'Ripe avocado toast' })?.match,
    ).toBe('avocado');
  });

  it('bounds long excerpts and adds ellipses', () => {
    const hint = getSearchResultHint('needle', {
      document: `${'before '.repeat(30)}needle ${'after '.repeat(30)}`,
    });
    const excerpt = `${hint?.before}${hint?.match}${hint?.after}`;

    expect(excerpt.startsWith('…')).toBe(true);
    expect(excerpt.endsWith('…')).toBe(true);
    expect(excerpt.length).toBeLessThanOrEqual(122);
  });

  it('returns no hint when the query is empty or absent from every field', () => {
    expect(getSearchResultHint('', { document: 'Anything' })).toBeNull();
    expect(getSearchResultHint('pear', { title: 'Apple' })).toBeNull();
  });
});
