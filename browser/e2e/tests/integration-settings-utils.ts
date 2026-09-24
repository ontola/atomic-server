import { expect, type Page } from '@playwright/test';

/** Opt in to experimental plugins through Settings. */
export async function enableIntegrationDiscovery(page: Page) {
  const previousUrl = page.url();
  await page.goto(new URL('/app/settings', previousUrl).href);
  await page.getByPlaceholder('Search settings...').fill('plugins');
  const visibility = page.getByTestId('integration-visibility');
  await expect(visibility).toHaveAttribute('data-ready', 'true', {
    timeout: 30_000,
  });
  const experimental = page.getByRole('checkbox', {
    name: 'Show experimental plugins',
  });
  await experimental.check();
  await expect(visibility).toHaveAttribute('aria-busy', 'false', {
    timeout: 30_000,
  });
  await expect(visibility.getByRole('alert')).toHaveCount(0);

  await page.goto(previousUrl);
}
