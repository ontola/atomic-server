import { expect, test } from '@playwright/test';

// Serve the actual ZIP from website.spec.ts with any plain static HTTP server.
test('downloaded website navigates and filters with no Atomic connection', async ({
  page,
}) => {
  const url = process.env.WEBSITE_EXPORT_URL;
  test.skip(
    !url,
    'Requires the downloaded website ZIP on a plain static server.',
  );
  const origin = new URL(url!).origin;
  const requests: string[] = [];
  await page.route('**/*', route => {
    requests.push(route.request().url());
    return new URL(route.request().url()).origin === origin
      ? route.continue()
      : route.abort();
  });
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.goto(url!);
  await expect(
    page.getByRole('heading', { name: 'The garden notebook', exact: true }),
  ).toBeVisible();
  const view = page.frameLocator('iframe[title="Search Growing notes"]');
  await expect(view.getByText('2 results', { exact: true })).toBeVisible();
  await view.getByRole('searchbox').fill('rosemary');
  await expect(
    view.getByText('Grow rosemary on a sunny balcony'),
  ).toBeVisible();
  await expect(view.getByText('Sow spinach in September')).toHaveCount(0);
  await view.getByRole('searchbox').fill('unknown plant');
  await expect(view.getByText('No matching results')).toBeVisible();
  await view.getByRole('searchbox').fill('');
  await page.screenshot({
    path: test.info().outputPath('garden-desktop.png'),
    fullPage: true,
  });
  await page
    .getByRole('link', { name: 'About the garden', exact: true })
    .click();
  await expect(page).toHaveURL(/about\/index.html$/);
  await expect(
    page.getByRole('heading', { name: 'About the garden', exact: true }),
  ).toBeVisible();
  await page.getByRole('link', { name: 'Home', exact: true }).click();
  await expect(view.getByRole('searchbox')).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(() =>
      page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    )
    .toBe(true);
  await page.screenshot({
    path: test.info().outputPath('garden-mobile.png'),
    fullPage: true,
  });
  expect(requests.every(request => new URL(request).origin === origin)).toBe(
    true,
  );
});
