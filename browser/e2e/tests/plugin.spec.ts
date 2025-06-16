import test, { expect } from '@playwright/test';
import {
  before,
  inDialog,
  newDrive,
  newResource,
  setTitle,
  sidebarDriveButtonId,
  signIn,
  testFilePath,
} from './test-utils';

test.describe('Plugins', () => {
  test.beforeEach(before);

  test('install a plugin', async ({ page }) => {
    await signIn(page);
    await newDrive(page);

    // Create a folder called 'Problem
    await newResource('folder', page);
    await setTitle(page, 'Problem');

    await page.getByTestId(sidebarDriveButtonId).click();

    // Upload a plugin
    const fileChooserPromise = page.waitForEvent('filechooser');
    await page.getByRole('main').getByText('Upload Plugin').click();
    const fileChooser = await fileChooserPromise;

    await fileChooser.setFiles(testFilePath('test-plugin.zip'));

    await inDialog(page, async (dialog, closeWith) => {
      await expect(
        dialog.getByRole('heading', { name: 'Add Plugin' }),
      ).toBeVisible();
      await expect(
        dialog.getByText('ontola/test-plugin', { exact: true }),
      ).toBeVisible();
      await expect(dialog.getByText('v1.0.0', { exact: true })).toBeVisible();
      await expect(dialog.getByText('Storage', { exact: true })).toBeVisible();

      // Check if the install button correctly disables when the config is invalid
      const installButton = dialog.getByRole('button', { name: 'Install' });
      await expect(installButton).toBeEnabled();

      await dialog.getByLabel('Config').fill('{"folderPrefix": 5}');

      await expect(installButton).toBeDisabled();

      await dialog.getByLabel('Config').fill('{"folderPrefix": "My"}');

      await expect(installButton).toBeEnabled();

      // Install the plugin
      await closeWith('Install');
    });

    await expect(
      page.getByRole('link', { name: 'ontola/test-plugin' }),
    ).toBeVisible();
    await page.reload();

    await expect(page.getByText('My Problem', { exact: true })).toBeVisible();

    await page.getByRole('link', { name: 'ontola/test-plugin' }).click();

    // Update the config
    await page.getByLabel('Config').fill('{"folderPrefix": "Not My"}');
    await page.getByRole('button', { name: 'Save' }).click();
    await page.reload();

    await expect(
      page.getByText('Not My Problem', { exact: true }),
      'Plugin did not react to config change',
    ).toBeVisible();

    // Uninstall the plugin
    await page.getByRole('button', { name: 'Uninstall' }).click();

    await inDialog(page, async (dialog, closeWith) => {
      await expect(
        dialog.getByRole('heading', { name: 'Uninstall Plugin' }),
      ).toBeVisible();
      await closeWith('Uninstall');
    });

    await expect(page.getByText('Plugin uninstalled')).toBeVisible();

    await page.reload();

    await expect(page.getByText('Problem', { exact: true })).toBeVisible();
    await expect(page.getByText('No plugins installed')).toBeVisible();
  });
});
