import { afterEach, expect, it, vi } from 'vitest';
import { bundledIntegrations } from './IntegrationDiscovery';
vi.mock('./IntegrationEvidence', () => ({ IntegrationEvidence: () => null }));
afterEach(() => vi.unstubAllGlobals());
it('keeps every bundled integration discoverable without a proxy catalog', () => {
  const fetch = vi.fn(() => Promise.reject(new Error('Proxy unavailable')));
  vi.stubGlobal('fetch', fetch);
  const entries = bundledIntegrations();
  expect(entries.map(entry => entry.id)).toEqual([
    'devonian-github-issues',
    'mt940',
    'clockify',
    'github-issues',
    'notion',
  ]);
  expect(
    entries.find(entry => entry.id === 'github-issues')?.capabilities,
  ).toContain('both directions');
  expect(
    entries.find(entry => entry.id === 'devonian-github-issues')?.capabilities,
  ).toContain('comments');
  expect(fetch).not.toHaveBeenCalled();
});
