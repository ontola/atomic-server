import type { Page } from '@playwright/test';
import { FRONTEND_URL, SERVER_URL, nodeReachableServerUrl } from './test-utils';

/** Explicitly opt into the hosted app; localhost by itself is standalone.
 * Endpoint-specific mocks registered afterwards override this empty account API.
 * Using the test origin also keeps the fixture independent of a local portal.
 */
export async function mockManagedPortal(page: Page): Promise<void> {
  await page.addInitScript(portalUrl => {
    (
      window as unknown as Window & {
        __ATOMIC_MANAGED__: { portalUrl: string };
      }
    ).__ATOMIC_MANAGED__ = { portalUrl };
  }, new URL(FRONTEND_URL).origin);
  await page.route('**/api/**', route => route.fulfill({ json: [] }));
}

/** Keep the node's real metadata while advertising the mocked portal on every navigation. */
export async function mockManagedNode(page: Page): Promise<void> {
  const url = nodeReachableServerUrl(new URL('/server', SERVER_URL).href);
  const response = await page.request.get(url, {
    headers: { Accept: 'application/ad+json' },
    failOnStatusCode: true,
    maxRetries: 2,
  });
  const body = await response.json();
  await response.dispose();
  await page.route('**/server', route =>
    route.fulfill({
      json: {
        ...body,
        'https://atomicdata.dev/properties/server/managed': true,
        'https://atomicdata.dev/properties/server/portalUrl': FRONTEND_URL,
      },
    }),
  );
}
