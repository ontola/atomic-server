import { describe, expect, it } from 'vitest';
import {
  catalogByPlatform,
  isCatalogVisible,
  parseCatalogEntries,
  type CatalogEntry,
} from './pluginCatalog';

const IS_A = 'https://atomicdata.dev/properties/isA';
const SHORTNAME = 'https://atomicdata.dev/properties/shortname';
const ENTRY_CLASS =
  'https://atomicdata.dev/integrations/classes/PluginCatalogEntry';
const P = 'https://atomicdata.dev/integrations/properties/';

const row = (extra: Record<string, unknown> = {}) => ({
  [IS_A]: [ENTRY_CLASS],
  [SHORTNAME]: 'fixture-api',
  ...extra,
});

describe('parseCatalogEntries', () => {
  it('reads the flags and platform of a catalog entry', () => {
    expect(
      parseCatalogEntries([
        row({
          [`${P}experimental`]: false,
          [`${P}enabled`]: true,
          [`${P}requires-api-plugins`]: true,
          [`${P}platform`]: 'api',
        }),
      ]),
    ).toEqual([
      {
        shortname: 'fixture-api',
        experimental: false,
        enabled: true,
        requiresApiPlugins: true,
        platform: 'api',
      },
    ]);
  });

  it('defaults to experimental, disabled and no platform', () => {
    expect(parseCatalogEntries([row()])).toEqual([
      {
        shortname: 'fixture-api',
        experimental: true,
        enabled: false,
        requiresApiPlugins: false,
        platform: undefined,
      },
    ]);
  });

  it('skips malformed entries instead of rejecting the catalog', () => {
    expect(
      parseCatalogEntries([
        null,
        'nope',
        [],
        row({ [IS_A]: ENTRY_CLASS }),
        row({ [IS_A]: ['https://example.com/Other'] }),
        row({ [SHORTNAME]: 42 }),
        row({ [SHORTNAME]: undefined }),
        row({ [SHORTNAME]: 'kept' }),
      ]).map(entry => entry.shortname),
    ).toEqual(['kept']);
  });

  it('returns nothing for a non-array catalog', () => {
    expect(parseCatalogEntries({})).toEqual([]);
    expect(parseCatalogEntries(null)).toEqual([]);
  });
});

describe('catalogByPlatform', () => {
  it('keys an entry by its platform, falling back to its shortname', () => {
    const entries = parseCatalogEntries([
      row({ [SHORTNAME]: 'card', [`${P}platform`]: 'proxy-id' }),
      row({ [SHORTNAME]: 'plain' }),
    ]);
    const map = catalogByPlatform(entries);
    expect(map.get('proxy-id')?.shortname).toBe('card');
    expect(map.get('plain')?.shortname).toBe('plain');
    expect(map.has('card')).toBe(false);
  });
});

describe('isCatalogVisible', () => {
  const entry = (flags: Partial<CatalogEntry>): CatalogEntry => ({
    shortname: 'x',
    experimental: false,
    enabled: true,
    requiresApiPlugins: false,
    ...flags,
  });

  it('hides a missing or disabled entry', () => {
    expect(isCatalogVisible(undefined, true)).toBe(false);
    expect(isCatalogVisible(entry({ enabled: false }), true)).toBe(false);
  });

  it('shows a stable entry and gates an experimental one', () => {
    expect(isCatalogVisible(entry({}), false)).toBe(true);
    expect(isCatalogVisible(entry({ experimental: true }), false)).toBe(false);
    expect(isCatalogVisible(entry({ experimental: true }), true)).toBe(true);
  });
});
