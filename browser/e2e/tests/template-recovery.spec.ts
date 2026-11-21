import {
  managedDriveTest,
  expect as managedExpect,
} from './deployment-fixtures';
import { FRONTEND_URL } from './test-utils';
import { mockManagedNode } from './managed-test-utils';

managedDriveTest(
  'an unenrolled home can create a local drive',
  async ({ page }) => {
    await mockManagedNode(page);
    await page.route('**/api/me', route =>
      route.fulfill({ json: { email: 'template@example.com' } }),
    );
    await page.route('**/api/sync-enrollments', route =>
      route.fulfill({ json: [] }),
    );

    await page.goto(`${FRONTEND_URL}/app/new-drive`);
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
      page.getByRole('button', { name: /^Report( this error)?$/ }),
    ).toHaveCount(0);
  },
);

managedDriveTest(
  'new drive errors can be reported with context',
  async ({ page }) => {
    await mockManagedNode(page);
    await page.route('**/api/me', route =>
      route.fulfill({ json: { email: 'template@example.com' } }),
    );
    await page.route('**/api/sync-enrollments', route =>
      route.fulfill({ json: { invalid: true } }),
    );

    await page.goto(`${FRONTEND_URL}/app/new-drive`);
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
