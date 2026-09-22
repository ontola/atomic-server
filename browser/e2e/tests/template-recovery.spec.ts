import { test, expect } from './fixtures';
import {
  managedDriveTest,
  expect as managedExpect,
} from './deployment-fixtures';
import { FRONTEND_URL, nodeReachableServerUrl } from './test-utils';

managedDriveTest(
  'an unenrolled home can create a local template drive',
  async ({ page, browserDiagnostics }) => {
    browserDiagnostics.expect(
      'error',
      /Each child in a list should have a unique.*key.*DriveTemplateSetup/s,
      'Existing Wuchale React key warning in Vite template setup',
      1,
      undefined,
      { optional: true },
    );
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

    await page.goto(`${FRONTEND_URL}/app/new-drive?template=student`);
    await managedExpect(
      page.getByRole('heading', { name: 'Give your space a name' }),
    ).toBeVisible();
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
  'template setup errors can be reported with context',
  async ({ page, browserDiagnostics }) => {
    browserDiagnostics.expect(
      'error',
      /Each child in a list should have a unique.*key.*DriveTemplateSetup/s,
      'Existing Wuchale React key warning in Vite template setup',
      1,
      undefined,
      { optional: true },
    );
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

    await page.goto(`${FRONTEND_URL}/app/new-drive?template=student`);
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

test('guest returns from a template preview before cleanup finishes', async ({
  page,
}) => {
  test.setTimeout(120000);
  await page.goto(`${FRONTEND_URL}/app/new-drive?template_preview=1`);
  await expect(
    page.getByRole('button', { name: 'Preview template' }).first(),
  ).toBeVisible({ timeout: 60000 });
  await page.getByRole('button', { name: 'Preview template' }).first().click();
  await expect(
    page.getByRole('button', { name: 'Back to template selection' }),
  ).toBeVisible({ timeout: 60000 });

  await page.evaluate(() => {
    const store = window.store;
    const original = store.queryLocalDb.bind(store);
    const demo = JSON.parse(localStorage.getItem('atomic.templateDemo')!).drive;
    store.queryLocalDb = ((query: Parameters<typeof original>[0]) =>
      query.value === demo
        ? new Promise(() => {})
        : original(query)) as typeof original;
  });
  await page
    .getByRole('button', { name: 'Back to template selection' })
    .click();
  await expect(
    page.getByRole('button', { name: 'Preview template' }).first(),
  ).toBeVisible({ timeout: 2000 });
});
