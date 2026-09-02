import { describe, expect, it } from 'vitest';
import { stringToSlug } from './stringToSlug';

describe('stringToSlug', () => {
  it('lowercases and joins words with single dashes', () => {
    expect(stringToSlug('Last watered')).toBe('last-watered');
    expect(stringToSlug('SKU')).toBe('sku');
  });

  it('never leaves a doubled dash behind a dropped character', () => {
    // The shortname rule is letters, numbers and single dashes, so `meat--fish`
    // is rejected — which is what made the Grocery list template uncreatable.
    expect(stringToSlug('Meat & fish')).toBe('meat-fish');
    expect(stringToSlug('Quantity / unit')).toBe('quantity-unit');
    expect(stringToSlug('a  —  b')).toBe('a-b');
  });

  it('trims dashes off both ends', () => {
    expect(stringToSlug('(draft)')).toBe('draft');
    expect(stringToSlug('+1')).toBe('1');
  });

  it('keeps digits and existing dashes', () => {
    expect(stringToSlug('Plan B2 - final')).toBe('plan-b2-final');
  });
});
