// @vitest-environment jsdom
// @wc-ignore-file
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  hasExperimentalEntries,
  mergeCatalogs,
  parseCatalogEntries,
  useIntegrationCatalog,
  type CatalogEntry,
} from './pluginCatalog';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function Names() {
  const { entries, ready } = useIntegrationCatalog();

  return <p>{ready ? entries.map(e => e.shortname).join(',') : 'loading'}</p>;
}

it('fetches the catalog once and renders it on the first render after a remount', async () => {
  const fetch = vi.fn(async () =>
    Response.json([
      {
        'https://atomicdata.dev/properties/isA': [
          'https://atomicdata.dev/integrations/classes/PluginCatalogEntry',
        ],
        'https://atomicdata.dev/properties/shortname': 'fixture',
        'https://atomicdata.dev/integrations/properties/enabled': true,
      },
    ]),
  );
  vi.stubGlobal('fetch', fetch);
  // No stored override: the hook reads the build-time default catalog URL.
  vi.stubGlobal('localStorage', { getItem: () => null });

  const first = render(<Names />);
  expect(await screen.findByText('fixture')).toBeTruthy();
  first.unmount();

  render(<Names />);
  // Synchronously: a remount must not pass through an empty catalog.
  expect(screen.getByText('fixture')).toBeTruthy();
  expect(fetch).toHaveBeenCalledTimes(1);
});

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

  it('reads an installable app, resolving its module against the catalog', () => {
    const [entry] = parseCatalogEntries(
      [
        row({
          'https://atomicdata.dev/properties/name': 'Fixture',
          [`${P}version`]: '1.2.3',
          [`${P}app-module`]: 'fixture/app/ui.js',
          [`${P}app-module-integrity`]: 'sha384-AAAA',
        }),
        row({ [SHORTNAME]: 'no-app' }),
      ],
      'https://plugins.test/integrations/catalog.json',
    );
    expect(entry.app).toMatchObject({
      id: 'fixture-api',
      version: '1.2.3',
      module: 'https://plugins.test/integrations/fixture/app/ui.js',
      integrity: 'sha384-AAAA',
    });
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

describe('mergeCatalogs', () => {
  const e = (shortname: string, catalogUrl: string): CatalogEntry => ({
    shortname,
    experimental: false,
    enabled: true,
    requiresApiPlugins: false,
    catalogUrl,
  });

  it('lets the earlier marketplace win a duplicate shortname', () => {
    const { entries, errors } = mergeCatalogs([
      { url: 'a', entries: [e('shared', 'a'), e('only-a', 'a')] },
      { url: 'b', entries: [e('shared', 'b'), e('only-b', 'b')] },
    ]);
    expect(entries.map(x => [x.shortname, x.catalogUrl])).toEqual([
      ['shared', 'a'],
      ['only-a', 'a'],
      ['only-b', 'b'],
    ]);
    expect(errors).toEqual([]);
  });

  it('reports a failing marketplace and keeps the others', () => {
    const { entries, errors } = mergeCatalogs([
      { url: 'a', entries: [e('one', 'a')] },
      { url: 'b', error: 'Error: offline' },
      { url: 'c', entries: [e('two', 'c')] },
    ]);
    expect(entries.map(x => x.shortname)).toEqual(['one', 'two']);
    expect(errors).toEqual([{ url: 'b', error: 'Error: offline' }]);
  });
});

describe('useIntegrationCatalog with several marketplaces', () => {
  it('shows an unreachable extra marketplace as an error next to the rest', async () => {
    const entry = (shortname: string) => ({
      [IS_A]: [ENTRY_CLASS],
      [SHORTNAME]: shortname,
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('down.test')) throw new Error('offline');

        return Response.json([
          entry(url.includes('extra') ? 'extra-app' : 'main'),
        ]);
      }),
    );
    vi.stubGlobal('localStorage', {
      getItem: (key: string) =>
        key === 'plugin-marketplaces'
          ? JSON.stringify([
              'https://extra.test/catalog.json',
              'https://down.test/catalog.json',
            ])
          : null,
    });

    function Probe() {
      const { entries, ready, errors } = useIntegrationCatalog();

      return (
        <p>
          {ready ? entries.map(x => x.shortname).join(',') : 'loading'}|
          {errors.join(';')}
        </p>
      );
    }

    render(<Probe />);
    expect(
      await screen.findByText(/extra-app\|down\.test: Error: offline$/),
    ).toBeTruthy();
  });
});
