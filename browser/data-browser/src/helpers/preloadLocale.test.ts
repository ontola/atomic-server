// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolve } from 'node:path';
import { getConfig } from 'wuchale';
import { getBrowserLocale, SUPPORTED_LOCALES } from './preloadLocale';

vi.mock('wuchale/load-utils', () => ({
  loadLocale: vi.fn().mockResolvedValue(undefined),
}));

afterEach(() => vi.restoreAllMocks());

describe('browser interface language', () => {
  it.each([
    ['nl-NL', 'nl'],
    ['nl_BE', 'nl'],
    ['id-ID', 'id'],
    ['id_ID', 'id'],
  ])('recognizes %s as %s', (language, expected) => {
    vi.spyOn(navigator, 'languages', 'get').mockReturnValue([language]);
    expect(getBrowserLocale()).toBe(expected);
  });

  it('uses the first supported browser preference', () => {
    vi.spyOn(navigator, 'languages', 'get').mockReturnValue([
      'ja-JP',
      'id-ID',
      'nl-NL',
      'en-GB',
    ]);
    expect(getBrowserLocale()).toBe('id');
  });

  it.each([{ languages: [] }, { languages: ['ja-JP', 'ko-KR'] }])(
    'falls back to English for $languages',
    ({ languages }) => {
      vi.spyOn(navigator, 'languages', 'get').mockReturnValue(languages);
      expect(getBrowserLocale()).toBe('en');
    },
  );

  it('offers exactly the locales compiled by Wuchale', async () => {
    const config = await getConfig(
      resolve(__dirname, '../../wuchale.config.js'),
    );
    expect(SUPPORTED_LOCALES).toEqual(config.locales);
  });
});
