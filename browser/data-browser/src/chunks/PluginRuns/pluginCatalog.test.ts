import { describe, expect, it } from 'vitest';
import {
  hasExperimentalEntries,
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
  it('reads the flags of a catalog entry', () => {
    expect(
      parseCatalogEntries([
        row({
          [`${P}experimental`]: false,
          [`${P}enabled`]: true,
          [`${P}requires-api-plugins`]: true,
        }),
      ]),
    ).toEqual([
      {
        shortname: 'fixture-api',
        experimental: false,
        enabled: true,
        requiresApiPlugins: true,
      },
    ]);
  });

  it('defaults to experimental and disabled', () => {
    expect(parseCatalogEntries([row()])).toEqual([
      {
        shortname: 'fixture-api',
        experimental: true,
        enabled: false,
        requiresApiPlugins: false,
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

describe('hasExperimentalEntries', () => {
  const entry = (flags: Partial<CatalogEntry>): CatalogEntry => ({
    shortname: 'x',
    experimental: true,
    enabled: true,
    requiresApiPlugins: false,
    ...flags,
  });

  it('counts an enabled experimental entry', () => {
    expect(hasExperimentalEntries([entry({})])).toBe(true);
  });

  it('ignores disabled, stable and API-plugin entries', () => {
    expect(
      hasExperimentalEntries([
        entry({ enabled: false }),
        entry({ experimental: false }),
        entry({ requiresApiPlugins: true }),
      ]),
    ).toBe(false);
  });
});
