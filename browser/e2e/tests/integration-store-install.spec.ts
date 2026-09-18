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
test('a Listing opens the Installation review before anything is installed', async ({
  page,
}) => {
  await page.route('**/plugin-catalog', route =>
    route.fulfill({
      json: [
        {
          metadata: {
            release: 'blake3:fixture',
            name: 'Calendar sync',
            emoji: '📅',
            description: 'Keeps a calendar in sync',
            publisher: 'https://example.com/agents/test',
            domains: ['calendar'],
            standards: [],
          },
          verification: 'unverified',
        },
      ],
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

  const card = page.locator('[data-release="blake3:fixture"]');
  await expect(
    card.getByRole('heading', { name: 'Calendar sync' }),
  ).toBeVisible();
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
