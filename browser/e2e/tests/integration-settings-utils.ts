import { expect, type Page } from '@playwright/test';

/** Opt in to experimental plugins through Settings. */
export async function enableIntegrationDiscovery(page: Page) {
  const previousUrl = page.url();
  await page.goto(new URL('/app/settings', previousUrl).href);
  await page.getByPlaceholder('Search settings...').fill('plugins');
  const experimental = page.getByRole('checkbox', {
    name: 'Show experimental plugins',
  });
  await experimental.check();
  // Disabled means the Atomic setting is still saving. Under full-suite load
  // the acknowledgement can exceed the ordinary 10s interaction budget.
  await expect(experimental).toBeEnabled({ timeout: 30_000 });

  await page.goto(previousUrl);
}
