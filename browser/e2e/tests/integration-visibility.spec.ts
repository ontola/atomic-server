import { test, expect, type Page } from '@playwright/test';
import { createFromCatalog, before } from './test-utils';

test.beforeEach(before);

const ENABLED = 'https://atomicdata.dev/integrations/properties/enabled';
const SHORTNAME = 'https://atomicdata.dev/properties/shortname';

/** Serve the mock catalog (testdata/atomic-plugins-mock) with exactly these entries enabled. */
async function enableCatalogEntries(page: Page, shortnames: string[]) {
  await page.route('**/integrations/catalog.json', async route => {
    const response = await route.fetch();
    const entries = (await response.json()) as Record<string, unknown>[];

    for (const entry of entries) {
      if (ENABLED in entry)
        entry[ENABLED] = shortnames.includes(entry[SHORTNAME] as string);
    }

    await route.fulfill({ response, json: entries });
  });
}

test('experimental plugins default off and the preference survives reload', async ({
  page,
}) => {
  const catalogRequests: string[] = [];
  await enableCatalogEntries(page, ['fixture-experimental', 'fixture-api']);
  await page.route('**/plugin-catalog', async route => {
    catalogRequests.push(route.request().url());
    await route.fulfill({
      // The shape `/plugin-catalog` actually answers with: one flat object per
      // Listing, as `plugin_release::catalog` builds it. The nested
      // `{ metadata, verification }` this used to send is the *publish*
      // payload, and reading `entry.domains` off it threw
      // "domains is not iterable" out of the store's filter, which took the
      // whole page down with an error boundary instead of rendering anything.
      json: [
        {
          subject: 'https://example.com/listings/fixture',
          name: 'Community fixture',
          emoji: null,
          description: 'Test listing',
          publisher: 'test',
          domains: [],
          standards: [],
          release: 'https://example.com/releases/fixture',
          releaseId: 'fixture-release',
          runtime: null,
          world: null,
        },
      ],
    });
  });
  await page.goto(new URL('/app/integrations', page.url()).href);
  // Entries that need API plugins have nothing that can run them until the
  // host proxies their calls (#1624), so no toggle is offered for them.
  const apiToggle = page.getByRole('checkbox', { name: 'Show API plugins' });
  const experimentalToggle = page.getByRole('checkbox', {
    name: 'Show experimental plugins',
  });
  await expect(experimentalToggle).toBeVisible();
  await expect(apiToggle).toHaveCount(0);
  await expect(experimentalToggle).not.toBeChecked();
  expect(catalogRequests).toHaveLength(0);

  await experimentalToggle.check();
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

  await page.reload();
  await expect(page.locator('[data-release="fixture-release"]')).toBeVisible();
  await expect(experimentalToggle).toBeChecked();
  expect(catalogRequests.length).toBeGreaterThan(0);

  await page.goto(new URL('/app/settings', page.url()).href);
  await page.getByPlaceholder('Search settings...').fill('plugins');
  const settingsExperimental = page.getByRole('checkbox', {
    name: 'Show experimental plugins',
  });
  await expect(settingsExperimental).toBeChecked();
  await expect(
    page.getByRole('checkbox', { name: 'Show API plugins' }),
  ).toHaveCount(0);

  await settingsExperimental.uncheck();
  await expect(settingsExperimental).toBeEnabled();
  await page.reload();
  await page.getByPlaceholder('Search settings...').fill('plugins');
  await expect(settingsExperimental).not.toBeChecked();

  await page.goto(new URL('/app/integrations', page.url()).href);
  await expect(experimentalToggle).not.toBeChecked();
  await expect(page.locator('[data-release]')).toHaveCount(0);
});

test('existing connections remain visible while both discovery categories are hidden', async ({
  page,
}) => {
  // The Plugin starter awaits `createPlugin` before navigating,
  // whose first line is `pluginClassesFor`, which creates the drive's whole
  // plugin schema: every property and class saved before a subject exists to
  // navigate to. Measured here at 3.6s idle and 6.8s under four local workers,
  // an 89% inflation matching what a since-removed sync spec showed, and Mancave
  // carries far more than four workers. The save and the render come after it,
  // inside the same budget.
  test.setTimeout(90_000);
  const SCHEMA_CREATED = { timeout: 30_000 };
  await createFromCatalog(page, 'Plugin');
  await expect(
    page
      .getByRole('main')
      .getByRole('heading', { name: 'New plugin', level: 1 }),
  ).toBeVisible(SCHEMA_CREATED);
  await page.goto(new URL('/app/integrations', page.url()).href);
  await expect(
    page
      .getByRole('region', { name: 'Your integrations' })
      .getByRole('link', { name: 'New plugin', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('checkbox', { name: 'Show experimental plugins' }),
  ).toBeVisible();
});

test('visibility toggles are hidden when the catalog enables nothing behind them', async ({
  page,
}) => {
  // An enabled entry that needs API plugins still has nothing to run it.
  await enableCatalogEntries(page, ['fixture-api']);
  await page.goto(new URL('/app/integrations', page.url()).href);
  await expect(page.getByText('No plugins to show here.')).toBeVisible();
  await expect(
    page.getByRole('checkbox', { name: 'Show API plugins' }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('checkbox', { name: 'Show experimental plugins' }),
  ).toHaveCount(0);
});
