import { expect, type Page } from '@playwright/test';

/**
 * Unlock the experimental toggle on this device the way a facilitator does in
 * a user-testing session: ordinary users are not offered it.
 */
export async function unlockPluginPreview(page: Page) {
  await page.goto(
    new URL('/app/integrations?preview=plugins', page.url()).href,
  );
  await expect
    .poll(() =>
      page.evaluate(() =>
        Object.keys(localStorage).some(
          key =>
            key.startsWith('integration-preview-unlocked:') &&
            localStorage.getItem(key) === 'true',
        ),
      ),
    )
    .toBe(true);
}

/** Opt in to experimental plugins through Settings. */
export async function enableIntegrationDiscovery(page: Page) {
  const previousUrl = page.url();
  await unlockPluginPreview(page);
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
