import { test, expect } from '@playwright/test';
import { FRONTEND_URL } from './test-utils';

// The demo workspace lives only on this device. On app.atomic.place there is
// no node either, and asking one for this drive's connections got the app's
// HTML back and put "Connection query failed" on the page.
test('the demo workspace opens Integrations without asking a server', async ({
  page,
}) => {
  test.setTimeout(120000);
  await page.goto(`${FRONTEND_URL}/app/demo`);
  await expect(
    page.getByRole('button', { name: 'Back', exact: true }),
  ).toBeVisible({ timeout: 90000 });
  const queries: string[] = [];
  page.on('request', request => {
    if (new URL(request.url()).pathname === '/query')
      queries.push(request.url());
  });
  await page.goto(`${FRONTEND_URL}/app/integrations`);
  await expect(
    page.getByRole('heading', { name: 'Integrations', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('note').filter({ hasText: 'This is a new feature.' }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Your automations' }),
  ).toBeVisible();
  await expect(page.getByText('Connection query failed')).toHaveCount(0);
  expect(queries).toEqual([]);
});
