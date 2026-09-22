import { enableIntegrationDiscovery } from './integration-settings-utils';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test, expect } from '@playwright/test';
import { before } from './test-utils';
const statementPath = resolve(
  __dirname,
  '../../../integrations/mt940/fixtures/synthetic.mt940',
);
const statement = readFileSync(statementPath, 'utf8');

test.beforeEach(before);
test.beforeEach(async ({ page }) => {
  await enableIntegrationDiscovery(page);
});
test('MT940 rejects unbalanced files, previews in sandbox and skips repeat imports', async ({
  page,
}) => {
  // The first preview installs the importer as well as running it. The drive
  // has no plugin schema yet, so `ensureSchema` creates sixteen properties and
  // their classes, then the installation resource, the Bank transactions table
  // and its view, each its own signed commit, before the statement is planned
  // in the sandbox. Timed under the four-worker load that reproduces the
  // failure: that step took 24.9s and 34.5s, while everything after it took
  // 2.1s and 0.4s. The whole test ran 51s and 66s against 24.5s alone, so the
  // suite's 60s default was losing on the test budget as well as on the
  // assertion below. `plugins.spec.ts` gives this install-and-run shape the
  // same treatment.
  test.setTimeout(240_000);
  await page.goto(new URL('/app/integrations', page.url()).href);
  const card = page.locator('[data-integration="mt940"]');
  await card.getByText('Repository test results', { exact: true }).click();
  await expect(card.getByText(/Offline checks passed:/)).toBeVisible();
  await page
    .locator('[data-integration="mt940"]')
    .getByRole('button', { name: 'Set up connection' })
    .click();
  const upload = page.locator('#mt940-file');
  await upload.setInputFiles({
    name: 'broken.mt940',
    mimeType: 'text/plain',
    buffer: Buffer.from(statement.replace('107,66', '107,67')),
  });
  await page
    .getByRole('button', { name: 'Preview import', exact: true })
    .click();
  await expect(page.getByRole('alert')).toContainText('does not reconcile');
  await upload.setInputFiles(statementPath);
  await page
    .getByRole('button', { name: 'Preview import', exact: true })
    .click();
  // Every one of those commits sits behind this one assertion, with the button
  // reading "Preparing preview…" for all of it, which is why this line is where
  // the test dies under load and the second preview is not. 25-35s is the
  // measured range and a busier box has taken it past 60s; treat anything
  // approaching this budget as a hang rather than as slowness.
  await expect(
    page.getByRole('button', { name: /Apply 2 changes/ }),
  ).toBeVisible({ timeout: 120000 });
  await page.getByRole('button', { name: /Apply 2 changes/ }).click();
  await expect(
    page.getByRole('link', { name: 'Open bank transactions' }),
  ).toBeVisible({ timeout: 30000 });
  await page.getByRole('link', { name: 'Open bank transactions' }).click();
  await expect(
    page.getByText('Fixture lunch', { exact: true }).first(),
  ).toBeVisible();
  await expect(page.getByText('-12.34', { exact: true }).first()).toBeVisible();
  await page.screenshot({ path: '/tmp/mt940-table.png', fullPage: true });
  // A full navigation must rediscover the importer after cold schema hydration.
  await page.goto(new URL('/app/integrations', page.url()).href);
  await expect(
    page.getByRole('region', { name: 'Your integrations' }),
  ).toBeVisible();
  await page
    .getByRole('region', { name: 'Your integrations' })
    .getByRole('link', { name: 'Bank statements' })
    .click();
  await page.getByRole('tab', { name: 'Run', exact: true }).click();
  await expect(page.locator('#mt940-file')).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Run', exact: true }),
  ).toHaveCount(0);
  await page.locator('#mt940-file').setInputFiles(statementPath);
  await page
    .getByRole('button', { name: 'Preview import', exact: true })
    .click();
  await expect(
    page.getByText(/2 previously imported transactions skipped/),
  ).toBeVisible({ timeout: 30000 });
  await expect(
    page.getByRole('button', { name: /^Apply \d+ changes$/ }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Close', exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: '/tmp/mt940-repeat-preview.png',
    fullPage: true,
  });
});
