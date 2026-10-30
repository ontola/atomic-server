import { test, expect } from '@playwright/test';
import { before } from './test-utils';
import { enableIntegrationDiscovery } from './integration-settings-utils';

test.beforeEach(before);

/**
 * Opening a marketplace Listing shows the Installation review: what the
 * release asks for and why, its pinned id, and the draft alternative. The
 * catalog is mocked; installing a fixture release would fail on the server,
 * so the actual install commit is covered by `plugin.spec.ts` (zip upload)
 * and the unit tests around `installRelease`.
 */
for (const responseShape of ['array', 'envelope'] as const) {
  test(`a Listing from the ${responseShape} catalog opens the Installation review before anything is installed`, async ({
    page,
  }) => {
    const entries = [
      {
        subject: 'https://example.com/listings/fixture',
        name: 'Calendar sync',
        emoji: '📅',
        description: 'Keeps a calendar in sync',
        publisher: 'https://example.com/agents/test',
        domains: ['calendar'],
        standards: [],
        release: 'https://example.com/releases/fixture',
        releaseId: 'blake3:fixture',
        runtime: 'atomic-js/1',
        world: 'extension',
      },
    ];
    await page.route('**/plugin-catalog', route =>
      route.fulfill({
        json:
          responseShape === 'array'
            ? entries
            : {
                entries,
                hostFeatures: {
                  pluginRoutes: {
                    compiled: true,
                    level: 'off',
                    listeners: [],
                    requestHost: true,
                    routesOrigin: null,
                    sidecars: [],
                  },
                },
              },
      }),
    );
    await page.route('**/plugin-package/*', route =>
      route.fulfill({
        json: {
          runtime: 'atomic-js/1',
          source: 'export function run() { return {}; }',
          schemas: {},
          manifest: {
            schemaVersion: 2,
            capabilities: [{ name: 'storage', reason: 'Remembers the cursor' }],
            secrets: [
              {
                name: 'google',
                origin: 'https://www.googleapis.com',
                description: 'Calendar API key',
              },
            ],
          },
        },
      }),
    );
    await enableIntegrationDiscovery(page);
    await page.goto(new URL('/app/integrations', page.url()).href);
    await expect(page).toHaveURL(/\/app\/apps$/);

    const card = page.locator('[data-release="blake3:fixture"]');
    await expect(
      card.getByRole('heading', { name: 'Calendar sync' }),
    ).toBeVisible();
    const search = page.getByRole('textbox', { name: 'Search apps' });
    await search.fill('no matching listing');
    await expect(card).toHaveCount(0);
    await search.fill('CALENDAR');
    await expect(card).toBeVisible();
    await card.getByRole('button', { name: 'Open' }).click();

    const dialog = page.locator('dialog[open]');
    await expect(
      dialog.getByRole('heading', { name: 'Install plugin' }),
    ).toBeVisible();
    await expect(dialog.getByText('Storage', { exact: true })).toBeVisible();
    await expect(dialog.getByText('Remembers the cursor')).toBeVisible();
    await expect(dialog.getByText('Secret "google"')).toBeVisible();
    await dialog.getByText('Release', { exact: true }).click();
    await expect(dialog.getByText('blake3:fixture')).toBeVisible();
    await expect(
      dialog.getByRole('button', { name: 'Create draft' }),
    ).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Install' })).toBeEnabled();

    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.locator('[data-installation]')).toHaveCount(0);
  });
}

test('a malformed plugin catalog shows an alert while Apps remains usable', async ({
  page,
}) => {
  await enableIntegrationDiscovery(page);
  await page.route('**/plugin-catalog', route =>
    route.fulfill({ json: { entries: {} } }),
  );
  await page.goto(new URL('/app/apps', page.url()).href);

  await expect(
    page.getByRole('heading', { name: 'Apps', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('alert').filter({ hasText: /Invalid plugin catalog/i }),
  ).toBeVisible();
  await expect(
    page.getByRole('textbox', { name: 'Search apps' }),
  ).toBeVisible();
  await expect(page.locator('[data-release]')).toHaveCount(0);
});
