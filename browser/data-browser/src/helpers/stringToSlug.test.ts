import { describe, expect, it } from 'vitest';
import { stringToSlug } from './stringToSlug';

describe('stringToSlug re-export', () => {
  it('uses the @tomic/lib implementation', () => {
    expect(stringToSlug('Meat & fish')).toBe('meat-fish');
  });
});
