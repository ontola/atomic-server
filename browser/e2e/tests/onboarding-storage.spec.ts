import { test, expect } from './fixtures';
import { before, FRONTEND_URL } from './test-utils';

test.beforeEach(before);

test('onboarding checks storage before showing account controls and keeps feedback available', async ({
  page,
}) => {
  await page.evaluate(async () => {
    // Fail the onboarding probe while the signed-in drive can finish its writes.
    const store = window.store!;
    await store.waitForClientDb(20_000);
    const db = store.getClientDb();

    if (!db) throw new Error('The test drive has no client database.');

    db.waitForInit = async () => false;
    window.history.pushState({}, '', '/app/welcome');
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
  await expect(
    page.getByRole('heading', {
      name: 'This browser could not open local storage',
    }),
  ).toBeVisible();
  await expect(
    page.getByText('Open this link in a non-private browser window', {
      exact: false,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Create account', exact: true }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: 'Feedback', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Send feedback' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Reload and try again' }),
  ).toBeVisible();
});

test('malformed invites still offer feedback', async ({ page }) => {
  await page.goto(`${FRONTEND_URL}/app/invite`);
  await expect(page.getByText('No invite token provided.')).toBeVisible();
  await page.getByRole('button', { name: 'Feedback', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Send feedback' }),
  ).toBeVisible();
});
