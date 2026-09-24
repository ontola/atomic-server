import { describe, it, expect } from 'vitest';
import { Datatype } from '@tomic/react';
import { getCategoryFromResource } from './categories';

/**
 * A property is looked up by subject wherever a category is asked for, so the
 * resource handed in can be one the store has not filled yet. Only `datatype`
 * and `hasClasses` are read here, which is all a stub needs to stand in for one.
 */
const propertyWith = (datatype?: string) =>
  ({
    props: { datatype },
    hasClasses: () => false,
  }) as unknown as Parameters<typeof getCategoryFromResource>[0];

describe('getCategoryFromResource', () => {
  it('reads a loaded property', () => {
    expect(getCategoryFromResource(propertyWith(Datatype.STRING))).toBe('text');
    expect(getCategoryFromResource(propertyWith(Datatype.ATOMIC_URL))).toBe(
      'relation',
    );
  });

  it('gives no category for a property that has not loaded', () => {
    // A table cell asks for this while its row renders. Throwing took the whole
    // page down through its error boundary, one unloaded column at a time.
    expect(getCategoryFromResource(propertyWith(undefined))).toBeUndefined();
  });

  it('still throws for a datatype it does not know', () => {
    // Absent is not unknown: a datatype that IS there and unrecognised means
    // the list in this module has a gap, and that should be loud.
    expect(() =>
      getCategoryFromResource(propertyWith('https://example.com/datatype/odd')),
    ).toThrow('Unknown datatype');
  });
});
