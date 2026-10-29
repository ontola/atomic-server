import {
  managedDriveTest,
  expect as managedExpect,
} from './deployment-fixtures';
import { FRONTEND_URL, nodeReachableServerUrl } from './test-utils';

managedDriveTest(
  'an unenrolled home can create a local drive',
  async ({ page }) => {
    await page.route('**/server', async route => {
      const response = await route.fetch({
        url: nodeReachableServerUrl(route.request().url()),
      });
      const body = await response.json();
      await route.fulfill({
        json: {
          ...body,
          'https://atomicdata.dev/properties/server/managed': true,
          'https://atomicdata.dev/properties/server/portalUrl': FRONTEND_URL,
        },
      });
    });
    await page.route('**/api/me', route =>
      route.fulfill({ json: { email: 'template@example.com' } }),
    );
    await page.route('**/api/sync-enrollments', route =>
      route.fulfill({ json: [] }),
    );

    await page.goto(`${FRONTEND_URL}/app/new-drive`);
    await managedExpect(page.getByLabel('Drive name')).toBeVisible();
    await page.getByRole('button', { name: 'Create drive' }).click();
    await managedExpect(page).not.toHaveURL(/new-drive/, { timeout: 60000 });
    const result = await page.evaluate(async () => {
      const store = window.store;
      const home = await store.getAgent()!.privateDriveSubject();

      return {
        homeLocal: store.isLocalOnlyDrive(home),
        createdLocal: store.isLocalOnlyDrive(store.getDrive()!),
      };
    });
    managedExpect(result).toEqual({ homeLocal: true, createdLocal: true });
    await managedExpect(
      page.getByRole('button', { name: 'Report this error' }),
    ).toHaveCount(0);
  },
);

managedDriveTest(
  'new drive errors can be reported with context',
  async ({ page }) => {
    await page.route('**/server', async route => {
      const response = await route.fetch({
        url: nodeReachableServerUrl(route.request().url()),
      });
      const body = await response.json();
      await route.fulfill({
        json: {
          ...body,
          'https://atomicdata.dev/properties/server/managed': true,
          'https://atomicdata.dev/properties/server/portalUrl': FRONTEND_URL,
        },
      });
    });
    await page.route('**/api/me', route =>
      route.fulfill({ json: { email: 'template@example.com' } }),
    );
    await page.route('**/api/sync-enrollments', route =>
      route.fulfill({ json: { invalid: true } }),
    );

    await page.goto(`${FRONTEND_URL}/app/new-drive`);
    await page.getByRole('button', { name: 'Create drive' }).click();
    await page.getByRole('button', { name: 'Report this error' }).click();
    const dialog = page.getByRole('dialog');
    await managedExpect(
      dialog.getByRole('heading', { name: 'Report this error' }),
    ).toBeVisible();
    await managedExpect(
      dialog.getByRole('textbox', { name: 'Feedback' }),
    ).toHaveValue(/Invalid Cloud Server hosting response/);
  },
);
