// @vitest-environment jsdom
// @wc-ignore-file
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useIntegrationCatalog } from './pluginCatalog';

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
        'https://atomicdata.dev/properties/shortname': 'pets',
        'https://atomicdata.dev/integrations/properties/enabled': true,
      },
    ]),
  );
  vi.stubGlobal('fetch', fetch);
  // No stored override: the hook reads the build-time default catalog URL.
  vi.stubGlobal('localStorage', { getItem: () => null });

  const first = render(<Names />);
  expect(await screen.findByText('pets')).toBeTruthy();
  first.unmount();

  render(<Names />);
  // Synchronously: a remount must not pass through an empty catalog.
  expect(screen.getByText('pets')).toBeTruthy();
  expect(fetch).toHaveBeenCalledTimes(1);
});
