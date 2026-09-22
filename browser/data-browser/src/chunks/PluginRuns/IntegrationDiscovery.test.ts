import { expect, it, vi } from 'vitest';
import { visibleBundledIntegrations } from './IntegrationDiscovery';
import type { CatalogEntry } from './pluginCatalog';

vi.mock('./IntegrationEvidence', () => ({ IntegrationEvidence: () => null }));

function entry(
  overrides: Partial<CatalogEntry> & { shortname: string },
): CatalogEntry {
  return {
    experimental: true,
    enabled: true,
    name: overrides.shortname,
    icon: '🔧',
    description: 'description',
    capabilities: 'capabilities',
    events: 'events',
    limitation: 'limitation',
    keywords: 'keywords',
    ...overrides,
  };
}

const FIXTURE: CatalogEntry[] = [
  entry({
    shortname: 'devonian-github-issues',
    requiresApiPlugins: true,
    capabilities: 'Sync issues and comments in both directions.',
  }),
  entry({
    shortname: 'devonian-google-calendar',
    requiresApiPlugins: true,
    platform: 'google-calendar',
    capabilities: 'Preserves recurring series.',
  }),
  entry({ shortname: 'mt940' }),
  entry({ shortname: 'clockify' }),
  entry({
    shortname: 'notion',
    requiresApiPlugins: true,
    callbackPlatform: 'notion',
  }),
];

it.each([
  [false, false, []],
  [false, true, []],
  [true, false, ['mt940', 'clockify']],
  [
    true,
    true,
    [
      'devonian-github-issues',
      'devonian-google-calendar',
      'mt940',
      'clockify',
      'notion',
    ],
  ],
])(
  'gates catalog-backed bundled cards for experimental=%s api=%s',
  (experimental, api, expected) => {
    expect(
      visibleBundledIntegrations(FIXTURE, experimental, api).map(
        card => card.id,
      ),
    ).toEqual(expected);
  },
);

it('keeps a disabled entry dark regardless of either toggle', () => {
  const disabled = FIXTURE.map(item => ({ ...item, enabled: false }));
  expect(visibleBundledIntegrations(disabled, true, true)).toEqual([]);
});

it('drops an enabled entry missing descriptive copy instead of rendering a broken card', () => {
  const incomplete: CatalogEntry[] = [
    { shortname: 'devonian-github-issues', experimental: true, enabled: true },
  ];
  expect(visibleBundledIntegrations(incomplete, true, true)).toEqual([]);
});
