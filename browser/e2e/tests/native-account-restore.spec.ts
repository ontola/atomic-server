import { test, expect } from './fixtures';
import { FRONTEND_URL, nodeReachableServerUrl, SERVER_URL } from './test-utils';

test('a fresh Mac install can start account recovery before it has an agent', async ({
  page,
}) => {
  const embeddedOrigin = 'http://localhost:9883';
  const realOrigin = nodeReachableServerUrl(SERVER_URL);

  if (realOrigin !== embeddedOrigin) {
    await page.route(`${embeddedOrigin}/**`, async route => {
      const url = route.request().url().replace(embeddedOrigin, realOrigin);
      const response = await route.fetch({ url });
      await route.fulfill({ response });
    });
  }

  await page.route('http://localhost:9885/**', async route => {
    const url = route
      .request()
      .url()
      .replace('http://localhost:9885', realOrigin);
    const response = await route.fetch({ url });
    await route.fulfill({ response });
  });

  await page.addInitScript(portalUrl => {
    (
      window as unknown as Window & {
        __TAURI_INTERNALS__: object;
        __ATOMIC_MANAGED__: { portalUrl: string };
      }
    ).__TAURI_INTERNALS__ = {};
    window.__ATOMIC_MANAGED__ = { portalUrl };
  }, FRONTEND_URL);
  await page.route('**/api/me', route => route.fulfill({ status: 204 }));

  await page.goto(`${FRONTEND_URL}/app/welcome`);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByLabel('Agent secret', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: /^Forgot it\? Restore from/ }).click();

  await expect(
    page.getByRole('heading', { name: 'Restore account' }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Connect existing account' }),
  ).toBeVisible();
});
