import { test, expect } from '@playwright/test';
import {
  before,
  currentDialog,
  fillSearchBox,
  FRONTEND_URL,
  newResource,
  setTitle,
} from './test-utils';

/**
 * App keys (issued agents): mint a named extra identity, grant it workspace
 * rights, show the secret once, keep the signed-in session as you, then revoke.
 * See planning/issued-agents.md.
 */
test.describe('app keys', () => {
  test.beforeEach(before);

  test('create a named read-only key, see the secret once, then revoke it', async ({
    page,
  }) => {
    await page.goto(`${FRONTEND_URL}/app/agent`);
    await expect(
      page.getByRole('heading', { name: 'User Settings' }),
    ).toBeVisible();
    await expect(page.getByRole('heading', { name: 'App keys' })).toBeVisible();

    const create = page.getByTestId('create-app-key');
    // Folder get-or-create on the personal drive; the button stays disabled
    // until that pointer exists.
    await expect(create).toBeEnabled({ timeout: 30_000 });
    await create.click();

    const dialog = currentDialog(page);
    await expect(
      dialog.getByRole('heading', { name: 'Create an app key' }),
    ).toBeVisible();
    await dialog.getByTestId('app-key-name').fill('Raycast');
    await expect(dialog.getByRole('radio', { name: 'Read only' })).toBeChecked();
    await dialog.getByTestId('app-key-create-confirm').click();

    await expect(
      dialog.getByRole('heading', { name: 'Copy this secret now' }),
    ).toBeVisible({ timeout: 30_000 });
    await expect(dialog.getByText('You will not see this again.')).toBeVisible();

    const secret = await dialog.locator('[data-code-content]').getAttribute(
      'data-code-content',
    );
    expect(secret).toBeTruthy();
    expect(secret!.length).toBeGreaterThan(40);

    await dialog.getByTestId('app-key-secret-done').click();
    await expect(dialog).toBeHidden();

    // Still you — minting must not switch the signed-in agent.
    await expect(page).toHaveURL(/\/app\/agent/);
    await expect(
      page.getByRole('heading', { name: 'User Settings' }),
    ).toBeVisible();
    await expect(
      page.getByText('No app keys yet', { exact: false }),
    ).toHaveCount(0, { timeout: 15_000 });
    await expect(page.getByText('Raycast', { exact: true })).toBeVisible();
    await expect(page.getByText(/Read · /)).toBeVisible();

    await page.getByTestId('revoke-app-key').click();
    const confirm = currentDialog(page);
    await expect(
      confirm.getByRole('heading', { name: 'Revoke this key?' }),
    ).toBeVisible();
    await confirm.locator('footer button', { hasText: 'Revoke' }).click();

    await expect(page.getByText('Raycast (revoked)')).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByTestId('revoke-app-key')).toHaveCount(0);
  });

  test('grant a key on a folder, not the whole workspace', async ({ page }) => {
    await newResource('folder', page);
    const folderName = `Project notes ${Date.now()}`;
    await setTitle(page, folderName);

    await page.goto(`${FRONTEND_URL}/app/agent`);
    const create = page.getByTestId('create-app-key');
    await expect(create).toBeEnabled({ timeout: 30_000 });
    await create.click();

    const dialog = currentDialog(page);
    await dialog.getByTestId('app-key-name').fill('Folder reader');

    // Default is every workspace. Turn that off so the only grant is the folder.
    for (const box of await dialog.getByRole('checkbox').all()) {
      if (await box.isChecked()) {
        await box.uncheck();
      }
    }

    const pick = await fillSearchBox(
      dialog,
      'Add a folder, page, or other resource',
      folderName,
    );
    await pick(folderName);

    await dialog.getByTestId('app-key-create-confirm').click();
    await expect(
      dialog.getByRole('heading', { name: 'Copy this secret now' }),
    ).toBeVisible({ timeout: 30_000 });
    await dialog.getByTestId('app-key-secret-done').click();

    await expect(page.getByText('Folder reader', { exact: true })).toBeVisible();
    await expect(page.getByText(`Read · ${folderName}`)).toBeVisible();
    await expect(page.getByText(/Read · Dev drive/)).toHaveCount(0);
  });

  test('an app can request rights at /app/authorize', async ({ page }) => {
    await page.goto(`${FRONTEND_URL}/app/authorize?name=Raycast&write=0`);
    await expect(
      page.getByRole('heading', { name: 'Authorize an app' }),
    ).toBeVisible();
    await expect(page.getByText('Raycast wants')).toBeVisible();

    const allow = page.getByTestId('authorize-allow');
    await expect(allow).toBeEnabled({ timeout: 30_000 });
    await allow.click();

    await expect(
      page.getByText('You will not see it again', { exact: false }),
    ).toBeVisible({ timeout: 30_000 });
    const secret = await page
      .locator('[data-code-content]')
      .getAttribute('data-code-content');
    expect(secret).toBeTruthy();
    expect(secret!.length).toBeGreaterThan(40);

    await page.getByTestId('app-key-secret-done').click();
    await expect(page.getByRole('heading', { name: 'App keys' })).toBeVisible();
    await expect(page.getByText('Raycast', { exact: true })).toBeVisible();
    await expect(page).toHaveURL(/\/app\/agent/);
  });
});
