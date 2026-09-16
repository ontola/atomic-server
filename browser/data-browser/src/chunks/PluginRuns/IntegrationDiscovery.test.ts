import { afterEach, expect, it, vi } from 'vitest';
import {
  bundledIntegrations,
  visibleBundledIntegrations,
} from './IntegrationDiscovery';
vi.mock('./IntegrationEvidence', () => ({ IntegrationEvidence: () => null }));
afterEach(() => vi.unstubAllGlobals());
it('keeps every bundled integration discoverable without a proxy catalog', () => {
  const fetch = vi.fn(() => Promise.reject(new Error('Proxy unavailable')));
  vi.stubGlobal('fetch', fetch);
  const entries = bundledIntegrations();
  expect(entries.map(entry => entry.id)).toEqual([
    'devonian-github-issues',
    'devonian-google-calendar',
    'mt940',
    'clockify',
    'notion',
  ]);
  expect(
    entries.find(entry => entry.id === 'devonian-github-issues')?.capabilities,
  ).toContain('comments');
  expect(
    entries.find(entry => entry.id === 'devonian-google-calendar')
      ?.capabilities,
  ).toContain('recurring');
  expect(fetch).not.toHaveBeenCalled();
});

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
  'gates proxy-backed bundled cards for experimental=%s api=%s',
  (experimental, api, expected) => {
    expect(
      visibleBundledIntegrations(experimental, api).map(entry => entry.id),
    ).toEqual(expected);
  },
);
