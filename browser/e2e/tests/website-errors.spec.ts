import { test, expect } from '@playwright/test';
import { before } from './test-utils';

test('unreadable website content reports an error, stops loading and recovers', async ({
  page,
}) => {
  await before({ page });
  const errors: string[] = [];
  page.on('console', message => {
    if (message.type() === 'error') errors.push(message.text());
  });
  const subject = await page.evaluate(async () => {
    const { createWebsite, starterWebsite } =
      await import('/src/chunks/Website/websiteModel.ts');
    const store = window.store;
    const config = starterWebsite('Preview error recovery');
    config.pages[0].media = [
      {
        subject: `${store.getServerUrl()}/missing-website-image`,
        alt: 'Missing photo',
      },
    ];
    return (await createWebsite(store, store.getDrive()!, config)).subject;
  });
  await page.goto(
    `${new URL(page.url()).origin}/app/show?subject=${encodeURIComponent(subject)}`,
  );
  await expect(
    page.getByText(
      'Publishing is unavailable until the draft preview can be built. Check access to the selected content, then retry.',
    ),
  ).toBeVisible();
  await expect(page.getByText('Preparing preview…')).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Publish site', exact: true }),
  ).toBeDisabled();
  await expect
    .poll(() => errors.some(error => error.includes('Website preview failed:')))
    .toBe(true);
  await expect(
    page
      .locator('[role="status"]')
      .filter({ hasText: 'Website preview failed:' })
      .first(),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Retry preview', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: 'Retry preview', exact: true }),
  ).toBeVisible();
  await page.evaluate(async subject => {
    const { readWebsite, updateWebsite } =
      await import('/src/chunks/Website/websiteModel.ts');
    const store = window.store;
    const resource = await store.getResource(subject);
    const { config } = await readWebsite(store, store.getDrive()!, resource);
    config.pages[0].media = [];
    await updateWebsite(store, store.getDrive()!, resource, config);
  }, subject);
  await expect(
    page.getByRole('button', { name: 'Publish site', exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByRole('button', { name: 'Retry preview', exact: true }),
  ).toHaveCount(0);
  await expect(
    page
      .frameLocator('iframe[title="Website preview"]')
      .getByRole('heading', { name: 'Preview error recovery' })
      .first(),
  ).toBeVisible();
  expect(errors.filter(error => error.includes('unique "key"'))).toEqual([]);
});

test('hosting status failures are logged and clear after reconnecting', async ({
  page,
}) => {
  await before({ page });
  const errors: string[] = [];
  page.on('console', message => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.route('**/website-hosting?*', route =>
    route.fulfill({ status: 503, body: 'Hosting temporarily unavailable' }),
  );
  const subject = await page.evaluate(async () => {
    const { createWebsite, starterWebsite } =
      await import('/src/chunks/Website/websiteModel.ts');
    const store = window.store;
    return (
      await createWebsite(
        store,
        store.getDrive()!,
        starterWebsite('Hosting recovery'),
      )
    ).subject;
  });
  await page.goto(
    `${new URL(page.url()).origin}/app/show?subject=${encodeURIComponent(subject)}`,
  );
  await expect(
    page
      .getByRole('alert')
      .filter({ hasText: 'Could not load website hosting status:' }),
  ).toBeVisible();
  await expect
    .poll(() =>
      errors.some(error =>
        error.includes('Could not load website hosting status:'),
      ),
    )
    .toBe(true);
  await page.unroute('**/website-hosting?*');
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(
    page
      .getByRole('alert')
      .filter({ hasText: 'Could not load website hosting status:' }),
  ).toHaveCount(0);
});
