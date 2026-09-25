import { test, expect } from '@playwright/test';
import { FRONTEND_URL } from './test-utils';

// The demo workspace lives only on this device. On app.atomic.place there is
// no node either: `/query` gets the app's HTML back, which put "Connection
// query failed" on the Integrations page. Answer it that way here too.
test('the demo workspace opens Integrations without asking a server', async ({
  page,
}) => {
  test.setTimeout(120000);
  const queries: string[] = [];
  await page.route(/\/query\?/, async route => {
    queries.push(route.request().url());
    await route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<!doctype html><html><body></body></html>',
    });
  });
  await page.goto(`${FRONTEND_URL}/app/demo`);
  await expect(page.getByText('This workspace is a demo')).toBeVisible({
    timeout: 90000,
  });
  await page.goto(`${FRONTEND_URL}/app/integrations`);
  await expect(
    page.getByRole('heading', { name: 'Your automations' }),
  ).toBeVisible();
  // Let any connection query the page would send come back before looking
  // for the error it caused.
  await page.waitForLoadState('networkidle');
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(queries).toEqual([]);
  await expect(
    page.getByRole('note').filter({
      hasText:
        'This is a new feature. Plugins will show up here soon for you to try out.',
    }),
  ).toBeVisible();
  // Ordinary users are not offered the experimental toggle.
  await expect(
    page.getByRole('checkbox', { name: 'Show experimental plugins' }),
  ).toHaveCount(0);
});
