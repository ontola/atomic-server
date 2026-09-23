import { expect, type Page } from '@playwright/test';

const SHORTNAME = 'https://atomicdata.dev/properties/shortname';
const ENABLED = 'https://atomicdata.dev/integrations/properties/enabled';
const EXPERIMENTAL =
  'https://atomicdata.dev/integrations/properties/experimental';
const REQUIRES_API =
  'https://atomicdata.dev/integrations/properties/requires-api-plugins';
const TEST_INTEGRATIONS = new Set([
  'devonian-github-issues',
  'devonian-google-calendar',
  'mt940',
  'clockify',
  'notion',
]);

/** Expose integrations that are deliberately unpublished in the catalog. */
export async function exposeTestIntegrations(page: Page) {
  await page.route('**/integrations/catalog.json', async route => {
    const response = await route.fetch();
    const catalog = (await response.json()) as Record<string, unknown>[];
    const enabledForTests = catalog.map(entry =>
      TEST_INTEGRATIONS.has(entry[SHORTNAME] as string)
        ? {
            ...entry,
            [ENABLED]: true,
            [EXPERIMENTAL]: false,
            [REQUIRES_API]: false,
          }
        : entry,
    );
    await route.fulfill({ response, json: enabledForTests });
  });
}

/** Opt in through Settings and expose disabled integrations for test coverage. */
export async function enableIntegrationDiscovery(page: Page, api = false) {
  await exposeTestIntegrations(page);
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
