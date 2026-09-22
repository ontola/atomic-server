import { expect, type Page } from '@playwright/test';

/** Opt in through Settings so integration tests exercise Atomic persistence. */
export async function enableIntegrationDiscovery(page: Page, api = false) {
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

  if (api) {
    const apiCheckbox = page.getByRole('checkbox', {
      name: 'Show API plugins',
    });
    await apiCheckbox.check();
    await expect(apiCheckbox).toBeEnabled({ timeout: 30_000 });
  }

  await page.goto(previousUrl);
}
