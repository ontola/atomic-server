import { test, expect } from '@playwright/test';
import { before, waitForSynced } from './test-utils';

test('one-click website publishing, draft isolation and version recovery', async ({
  page,
  request,
}) => {
  test.skip(
    !process.env.WEBSITE_HOSTING_E2E,
    'Requires a website hosting node',
  );
  await before({ page });
  await page
    .getByRole('button', { name: 'New Document', exact: true })
    .first()
    .click();
  await page.locator('#document-editor').waitFor();
  await page.locator('#document-editor').fill('Bakery bread costs five euros.');
  await page.getByRole('button', { name: 'More', exact: true }).click();
  await page.getByPlaceholder(/filter actions/i).fill('website');
  await page.getByTestId('menu-item-new-website').click();
  const publish = page.getByRole('button', {
    name: 'Publish site',
    exact: true,
  });
  await expect(publish).toBeEnabled({ timeout: 30000 });
  const websiteURL = page.url();
  await expect(page.locator('[data-website-primary]')).toHaveCount(1);
  await expect(
    page.getByRole('button', { name: /refresh.*status/i }),
  ).toHaveCount(0);
  await page.screenshot({
    path: '/private/tmp/website-redesign-desktop.png',
    fullPage: true,
  });
  await publish.click();
  const link = page.getByRole('link', { name: 'View site', exact: true });
  await expect(link).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Update site', exact: true }),
  ).toBeEnabled();
  const headerActions = [
    page.getByRole('button', { name: 'Design with AI', exact: true }),
    link,
    page.getByRole('button', { name: 'Update site', exact: true }),
  ];
  const heights = await Promise.all(
    headerActions.map(action =>
      action.evaluate(element => element.getBoundingClientRect().height),
    ),
  );
  expect(Math.max(...heights) - Math.min(...heights)).toBeLessThan(1);
  await page.screenshot({ path: '/private/tmp/website-published-header.png' });
  const target = new URL((await link.getAttribute('href'))!);
  const getPublic = () =>
    request.get(`http://127.0.0.1:${target.port}/`, {
      headers: { Host: target.host },
    });
  const visitor = await page.context().browser()!.newContext();
  const publicPage = await visitor.newPage();
  await publicPage.goto(target.toString());
  await expect(
    publicPage.getByText('Bakery bread costs five euros.'),
  ).toBeVisible();
  await visitor.close();
  await page
    .locator('a')
    .filter({ has: page.getByText('Document', { exact: true }) })
    .filter({ has: page.locator('small') })
    .click();
  await page.locator('#document-editor').fill('Bakery bread costs six euros.');
  await page.getByRole('button', { name: 'More', exact: true }).click();
  await page.keyboard.press('Escape');
  await waitForSynced(page);
  await page.goto(websiteURL);
  await expect(
    page
      .frameLocator('iframe[title="Website preview"]')
      .getByText('Bakery bread costs six euros.'),
  ).toBeVisible();
  expect(await (await getPublic()).text()).toContain(
    'Bakery bread costs five euros.',
  );
  await page.getByRole('button', { name: 'Update site', exact: true }).click();
  await expect
    .poll(async () => (await getPublic()).text())
    .toContain('Bakery bread costs six euros.');
  await expect(page.locator('[data-website-primary]')).toHaveCount(1);
  await page.getByLabel('Publishing options').click();
  await page
    .getByLabel('Previous version', { exact: true })
    .selectOption({ label: 'Version 1' });
  await page
    .getByRole('button', { name: 'Restore version', exact: true })
    .click();
  await expect
    .poll(async () => (await getPublic()).text())
    .toContain('Bakery bread costs five euros.');
  await page
    .getByRole('button', { name: 'Unpublish website', exact: true })
    .click();
  await expect.poll(async () => (await getPublic()).status()).toBe(404);
  await expect(publish).toBeEnabled();
  await page.getByLabel('Publishing options').click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: /Show \/ hide sidebar/ }).click();
  await expect(page.locator('[data-website-primary]')).toHaveCount(1);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  expect(overflow).toBe(false);
  await page.screenshot({
    path: '/private/tmp/website-redesign-mobile.png',
    fullPage: true,
  });
  // A failed action must go through the Store's normal error event: toast + logging.
  const errors: string[] = [];
  page.on('console', message => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.route('**/website-hosting/deployments?*', route =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({
        'https://atomicdata.dev/properties/description':
          'Publishing is temporarily unavailable.',
      }),
    }),
  );
  await publish.click();
  await expect(
    page.getByText('Publishing is temporarily unavailable.', { exact: true }),
  ).toBeVisible();
  await expect
    .poll(() =>
      errors.some(text =>
        text.includes('Publishing is temporarily unavailable.'),
      ),
    )
    .toBe(true);
  expect(await (await getPublic()).status()).toBe(404);
});
