import { test, expect } from '@playwright/test';
import { before } from './test-utils';

test.beforeEach(before);

test('integration categories default off and independent Atomic preferences survive reload', async ({
  page,
}) => {
  const catalogRequests: string[] = [];
  await page.route('**/catalog', route => route.fulfill({ json: ['pets'] }));
  await page.route('**/plugin-catalog', async route => {
    catalogRequests.push(route.request().url());
    await route.fulfill({
      json: [
        {
          metadata: {
            release: 'fixture-release',
            name: 'Community fixture',
            description: 'Test listing',
            publisher: 'test',
            domains: [],
            standards: [],
          },
          verification: 'unverified',
        },
      ],
    });
  });
  await page.goto(new URL('/app/integrations', page.url()).href);
  const apiToggle = page.getByRole('checkbox', { name: 'Show API plugins' });
  const experimentalToggle = page.getByRole('checkbox', {
    name: 'Show experimental plugins',
  });
  await expect(apiToggle).toBeVisible();
  await expect(experimentalToggle).toBeVisible();
  await expect(apiToggle).not.toBeChecked();
  await expect(experimentalToggle).not.toBeChecked();
  await expect(page.locator('[data-integration]')).toHaveCount(0);
  expect(catalogRequests).toHaveLength(0);

  // `check()` verifies the box is checked afterwards — but enabling the
  // category removes the inline toggle (asserted below), so the verification
  // has nothing to read and retries until it times out. Click it instead.
  await experimentalToggle.click();
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const store = window.store!;
        const subject = await store.getAgent()!.privateDriveSubject();
        const drive = await store.fetchResourceFromServer(subject, {
          noWebSocket: true,
        });
        const ontology = await store.getResource(
          drive.get(
            'https://atomicdata.dev/ontology/server/property/default-ontology',
          ) as string,
        );
        const terms = ontology.get(
          'https://atomicdata.dev/properties/properties',
        ) as string[];

        for (const term of terms) {
          const property = await store.getResource(term);
          if (
            property.get('https://atomicdata.dev/properties/shortname') ===
            'show-experimental-plugins'
          )
            return drive.get(term);
        }

        return undefined;
      }),
    )
    .toBe(true);
  // Once enabled, the inline toggle for that category is no longer shown.
  await expect(experimentalToggle).toHaveCount(0);

  await page.reload();
  await expect(page.locator('[data-integration="mt940"]')).toBeVisible();
  await expect(page.locator('[data-release="fixture-release"]')).toBeVisible();
  await expect(apiToggle).toBeVisible();
  await expect(
    page.getByRole('checkbox', {
      name: 'Show experimental plugins',
    }),
  ).toHaveCount(0);
  expect(catalogRequests.length).toBeGreaterThan(0);

  await page.goto(new URL('/app/settings', page.url()).href);
  await page.getByPlaceholder('Search settings...').fill('plugins');
  const settingsApi = page.getByRole('checkbox', { name: 'Show API plugins' });
  const settingsExperimental = page.getByRole('checkbox', {
    name: 'Show experimental plugins',
  });
  await expect(settingsExperimental).toBeChecked();
  await expect(settingsApi).not.toBeChecked();

  await settingsExperimental.uncheck();
  await expect(settingsExperimental).toBeEnabled();
  await settingsApi.check();
  await expect(settingsApi).toBeEnabled();
  await page.reload();
  await page.getByPlaceholder('Search settings...').fill('plugins');
  await expect(settingsApi).toBeChecked();
  await expect(settingsExperimental).not.toBeChecked();

  await page.goto(new URL('/app/integrations', page.url()).href);
  await expect(page.locator('[data-integration="proxy:pets"]')).toBeVisible();
  await expect(apiToggle).toHaveCount(0);
  await expect(
    page.getByRole('checkbox', {
      name: 'Show experimental plugins',
    }),
  ).toBeVisible();
  await expect(page.locator('[data-integration="mt940"]')).toHaveCount(0);
  await expect(page.locator('[data-release]')).toHaveCount(0);
});

test('existing connections remain visible while both discovery categories are hidden', async ({
  page,
}) => {
  await page.getByRole('button', { name: 'More' }).click();
  await page.getByPlaceholder(/filter/i).fill('plugin');
  await page.locator('[data-testid="menu-item-new-plugin"]').click();
  await expect(
    page
      .getByRole('main')
      .getByRole('heading', { name: 'New plugin', level: 1 }),
  ).toBeVisible();
  await page.goto(new URL('/app/integrations', page.url()).href);
  await expect(
    page
      .getByRole('region', { name: 'Your integrations' })
      .getByRole('link', { name: 'New plugin', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('checkbox', { name: 'Show API plugins' }),
  ).toBeVisible();
  await expect(
    page.getByRole('checkbox', { name: 'Show experimental plugins' }),
  ).toBeVisible();
  await expect(page.locator('[data-integration]')).toHaveCount(0);
});
