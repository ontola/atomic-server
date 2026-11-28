import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import {
  before,
  clickAccountMenuItem,
  getCurrentSubject,
  waitForDriveSettled,
  waitForSynced,
} from './test-utils';
import { enableIntegrationDiscovery } from './integration-settings-utils';
import { mockIntegrationProxy } from './fixtures/syncablesProxy';

async function selectView(page: Page, name: string) {
  const tab = page.getByRole('tab', { name, exact: true });
  await expect(tab).toBeVisible({ timeout: 30_000 });
  if ((await tab.getAttribute('aria-selected')) !== 'true') await tab.click();
  await expect(tab).toHaveAttribute('aria-selected', 'true');
}

async function browse(page: Page) {
  await expect(
    page.getByRole('tab', { name: 'Table', exact: true }),
  ).toBeVisible();
  const directory = page.getByRole('tab', {
    name: 'Syncable Collections',
    exact: true,
  });
  await selectView(
    page,
    (await directory.count()) ? 'Syncable Collections' : 'Table',
  );
  await expect(page.locator('iframe[title="App"]:visible')).toHaveCount(0);

  return page
    .getByRole('main')
    .getByRole('table')
    .or(page.getByRole('main').getByRole('grid'));
}

async function sync(page: Page) {
  await selectView(page, 'Sync');
  const iframe = page.locator('iframe[title="App"]:visible').contentFrame();
  const lastSync = iframe.getByText(
    /^(Last completed sync for this filter:|This filter has not completed a sync yet\.)/,
  );
  await expect(lastSync).toBeVisible({ timeout: 30_000 });
  const previousSync = await lastSync.textContent();
  const syncNow = iframe.getByRole('button', { name: 'Sync now', exact: true });
  await syncNow.click();
  // Starting a worker and updating this frame are asynchronous. The same
  // button can still be enabled before the worker enters its running state.
  await expect(lastSync).not.toHaveText(previousSync!, { timeout: 60_000 });
  await expect(lastSync).toHaveText(/^Last completed sync for this filter:/);
  await expect(syncNow).toBeEnabled({ timeout: 60_000 });
  await expect(iframe.getByRole('alert')).toHaveCount(0);

  return iframe;
}

async function publicForm(page: Page, collection = 'repositoryIssues') {
  await selectView(page, 'Sync');
  const iframe = page.locator('iframe[title="App"]:visible').contentFrame();
  await expect(
    iframe.getByLabel('Source collection', { exact: true }),
  ).toBeVisible({
    timeout: 30_000,
  });
  await iframe
    .getByLabel('Source collection', { exact: true })
    .selectOption(collection);

  return iframe;
}

test('imports a typed saved filter through the public catalog and applies sync idempotently', async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const upstream = 'https://notes-api.example/v3';
  const document = {
    openapi: '3.0.3',
    info: { title: 'Notebook', version: '1' },
    servers: [{ url: upstream }],
    components: {
      crudResources: {
        entryAddress: {
          identity: {
            urlTemplate: '/by-name/{workspace}',
            bindings: { workspace: { field: 'name' } },
          },
        },
        entry: {
          schema: {
            type: 'object',
            title: 'Entries',
            required: ['id', 'name'],
            properties: {
              id: { type: 'string' },
              name: { type: 'string', title: 'Entry' },
              updated_at: {
                type: 'string',
                format: 'date-time',
                title: 'Updated',
              },
              active: { type: 'boolean', title: 'Active' },
            },
          },
          identity: {
            urlTemplate: '/spaces/{space_id}/entries/{entry_id}',
            bindings: { entry_id: { field: 'id' } },
          },
          collections: {
            entries: { urlTemplate: '/spaces/{space_id}/entries' },
          },
        },
      },
      paginationSchemes: {
        pages: {
          type: 'nextLink',
          request: {},
          response: { headers: { Link: { role: 'nextLink' } } },
        },
      },
    },
    paths: {
      '/by-name/{workspace}': {
        get: {
          operationId: 'namedSpace',
          security: [],
          parameters: [
            {
              name: 'workspace',
              in: 'path',
              required: true,
              schema: { type: 'string', title: 'Workspace name' },
            },
          ],
          'x-crud': { action: 'read', resource: 'entryAddress' },
          responses: {
            '200': {
              description: 'Space',
              links: {
                entries: {
                  operationId: 'listEntries',
                  parameters: { space_id: '$response.body#/id' },
                },
              },
            },
          },
        },
      },
      '/spaces/{space_id}/entries': {
        get: {
          operationId: 'listEntries',
          security: [],
          parameters: [
            {
              name: 'space_id',
              in: 'path',
              required: true,
              schema: { type: 'integer', title: 'Workspace ID' },
            },
          ],
          'x-crud': {
            action: 'list',
            resource: 'entry',
            collection: 'entries',
          },
          'x-pagination': [{ scheme: 'pages' }],
          responses: {
            '200': {
              description: 'Entries',
              content: {
                'application/json': {
                  schema: { type: 'array', items: { type: 'object' } },
                },
              },
            },
          },
        },
      },
    },
  };
  const requests = await mockIntegrationProxy(page, {
    platform: 'notebook',
    name: 'Notebook',
    document,
    selection: { query_overrides: [] },
  });
  const reads: string[] = [];
  await page.route(upstream + '/**', async route => {
    const request = route.request();
    const headers = await request.allHeaders();
    for (const name of [
      'authorization',
      'cookie',
      'x-connection-key',
      'x-atomic-agent',
    ])
      expect(headers[name]).toBeUndefined();
    reads.push(request.url());
    await route.fulfill({
      headers: { 'access-control-allow-origin': '*' },
      json: request.url().endsWith('/by-name/research')
        ? { id: 44 }
        : [
            {
              id: 'entry-7',
              name: 'An unrelated typed record',
              updated_at: '2026-11-19T09:00:00Z',
              active: true,
            },
          ],
    });
  });
  await before({ page }, testInfo);
  // Finish signed setup writes before the settings helper deliberately reloads.
  await waitForSynced(page);
  await waitForDriveSettled(page);
  await clickAccountMenuItem(page, 'Apps');
  const discovery = page.getByRole('region', { name: 'Discover apps' });
  const addNotebook = discovery.getByRole('button', {
    name: 'Add Notebook to drive',
  });
  await expect(discovery).toBeVisible();
  await expect(addNotebook).toHaveCount(0);

  await enableIntegrationDiscovery(page);
  await expect(addNotebook).toBeVisible();
  const search = discovery.getByRole('textbox', { name: 'Search apps' });
  await search.fill('not a catalog entry');
  await expect(discovery.getByText('No matching services.')).toBeVisible();
  await expect(addNotebook).toHaveCount(0);
  await search.fill('Notebook');
  await expect(addNotebook).toBeVisible();
  await expect(
    discovery.getByText('No integrations match your search.'),
  ).toHaveCount(0);
  await testInfo.attach('apps-discovery-with-proxy', {
    body: await page.screenshot({ animations: 'disabled' }),
    contentType: 'image/png',
  });
  await addNotebook.click();
  const iframe = page.locator('iframe[title="App"]:visible').contentFrame();
  await expect(
    iframe.getByRole('button', { name: 'Public', exact: true }),
  ).toBeVisible({ timeout: 45_000 });
  const appBeforePublic = await getCurrentSubject(page);
  await iframe.getByRole('button', { name: 'Public', exact: true }).click();
  await expect.poll(() => getCurrentSubject(page)).not.toBe(appBeforePublic);
  const form = await publicForm(page, 'entries');
  await form.getByLabel('Workspace name', { exact: true }).fill('research');
  expect(reads).toEqual([]);
  await form.getByRole('button', { name: 'Save filter', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Entries', exact: true }),
  ).toBeVisible();
  await browse(page);
  expect(reads).toEqual([upstream + '/by-name/research']);
  await sync(page);
  await browse(page);
  await expect(
    page
      .getByRole('main')
      .getByText('An unrelated typed record', { exact: true }),
  ).toBeVisible();
  await sync(page);
  await expect(
    iframe.getByText('0 added · 0 changed · 1 unchanged', { exact: true }),
  ).toBeVisible();
  const grid = await browse(page);
  const row = grid
    .getByRole('row')
    .filter({ hasText: 'An unrelated typed record' });
  await expect(row).toHaveCount(1);
  await expect(row.getByRole('checkbox')).toBeChecked();

  await selectView(page, 'Sync');
  await iframe.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(
    iframe.getByRole('button', { name: 'Resume', exact: true }),
  ).toBeVisible();
  await expect(
    iframe.getByRole('button', { name: 'Sync now', exact: true }),
  ).toBeDisabled();

  expect(reads).toEqual([
    upstream + '/by-name/research',
    upstream + '/spaces/44/entries',
    upstream + '/spaces/44/entries',
  ]);
  expect(requests.providerRequests).toEqual([]);
  expect(requests.redeemed).toEqual([]);
  await testInfo.attach('unrelated-catalog-native-records', {
    body: await page.screenshot(),
    contentType: 'image/png',
  });
});
