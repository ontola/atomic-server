import { enableIntegrationDiscovery } from './integration-settings-utils';
import { openLegacyGithubSetup } from './legacy-github-setup';
import { test, expect } from '@playwright/test';
import { before } from './test-utils';
test.beforeEach(before);
test.beforeEach(async ({ page }) => {
  await enableIntegrationDiscovery(page, true);
});

test('assistant discovers setup and opens the same form with known arguments', async ({
  page,
}) => {
  const { dialog, state } = await openLegacyGithubSetup(page, {
    repository: 'ontola/atomic-server',
  });
  await expect(dialog.getByLabel('Sync into')).toBeEnabled();
  await expect(dialog.getByLabel('Repository', { exact: true })).toHaveValue(
    'ontola/atomic-server',
  );
  await expect(
    dialog.getByRole('link', { name: 'Create GitHub token' }),
  ).toHaveAttribute('href', /target_name=ontola/);
  const credential = dialog.getByLabel('GitHub token', { exact: true });
  await expect(credential).toHaveAttribute('type', 'password');
  await dialog
    .getByLabel('Repository', { exact: true })
    .fill('https://github.com/ontola/atomic-server');
  await credential.fill('synthetic-not-a-credential');
  await dialog
    .getByRole('button', { name: 'Connect GitHub', exact: true })
    .click();
  await expect(dialog.getByRole('alert')).toContainText('owner/repository');
  await expect(
    dialog.getByRole('button', { name: 'Connect GitHub', exact: true }),
  ).toBeEnabled();
  await expect
    .poll(() => state.toolResults.join(' '))
    .toContain('needs_user_setup');
});

test('Notion manual setup validates before creating a connection', async ({
  page,
}) => {
  await page.goto(new URL('/app/integrations', page.url()).href);
  await page
    .locator('[data-integration="notion"]')
    .getByRole('button', { name: 'Set up connection' })
    .click();
  const dialog = page.locator('dialog[open]');
  await dialog
    .getByText('Advanced setup with a token', { exact: true })
    .click();
  await dialog
    .getByLabel('Data source ID', { exact: true })
    .fill('https://notion.so/database');
  const credential = dialog.getByLabel('Notion connection token', {
    exact: true,
  });
  await expect(credential).toHaveAttribute('type', 'password');
  await credential.fill('synthetic-not-a-credential');
  let installationRequests = 0;
  page.on('request', request => {
    if (request.url().endsWith('/plugin-secret') && request.method() === 'POST')
      installationRequests++;
  });
  await dialog
    .locator('form')
    .getByRole('button', { name: 'Connect Notion', exact: true })
    .click();
  await expect(dialog.locator('form').getByRole('alert')).toContainText('UUID');
  expect(installationRequests).toBe(0);
  await expect(
    dialog
      .locator('form')
      .getByRole('button', { name: 'Connect Notion', exact: true }),
  ).toBeEnabled();
});
