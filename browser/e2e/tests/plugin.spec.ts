import test, { expect } from '@playwright/test';
import {
  before,
  clickSidebarItem,
  currentDriveTitle,
  fillSearchBox,
  inDialog,
  newDrive,
  newResource,
  setTitle,
  sidebarDriveButtonId,
  signIn,
  testFilePath,
} from './test-utils';

const BIRD =
  'https://atomicdata.dev/01k10mtpp8fkkmsd6tkm9qrqyw/defaultontology/class/bird';

test.describe('Plugins', () => {
  test.beforeEach(before);

  test('install a plugin', async ({ page }) => {
    await signIn(page);
    await newDrive(page);

    // Create a folder called 'Problem
    await newResource('folder', page);
    await setTitle(page, 'Problem');

    await page.getByTestId(sidebarDriveButtonId).click();

    // Drive page now renders Tags / Default Ontology / Plugins as collapsible
    // sections. Expand the Plugins section so the Upload button is in the DOM.
    await page.getByRole('main').getByText('Plugins', { exact: true }).click();

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

    // Test the custom view
    await newResource(BIRD, page);

    await page.getByLabel('name').fill('Duck');

    await page.getByTestId('input-characteristics-add-resource').click();

    {
      const pickOption = await fillSearchBox(
        page,
        'Search for a resource or enter a URL',
        '',
      );
      await pickOption('water');
    }

    await page.getByRole('button', { name: 'Save' }).click();

    {
      const frame = page.frameLocator('#custom-view');

      expect(frame).not.toBeNull();
      if (!frame) throw new Error('Frame not found');

      await expect(frame.getByRole('heading', { name: 'Duck' })).toBeVisible();
      await expect(
        frame.getByText('This is a custom view for the Bird class.'),
      ).toBeVisible();
      await expect(frame.getByText('Water')).toBeVisible();

      await frame
        .getByRole('button', { name: 'Select favorite folder' })
        .click();

      await inDialog(page, async (dialog, closeWith) => {
        await expect(
          dialog.getByRole('heading', { name: 'Select a folder' }),
        ).toBeVisible();
        await expect(
          dialog.getByText("Pick the bird's favorite folder"),
        ).toBeVisible();
        const pickOption = await fillSearchBox(
          dialog,
          'Search for a folder',
          '',
        );
        await pickOption('Not My Problem');
        await closeWith('Confirm');
      });

      await expect(frame.getByText('Problem')).toBeVisible();
    }

    // Check if the view can commit by refreshing and checking the favorite folder.
    await page.reload();

    {
      const frame = page.frameLocator('#custom-view');

      expect(frame).not.toBeNull();
      if (!frame) throw new Error('Frame not found');

      expect(frame.getByText('Not My Problem')).toBeVisible();
    }

    // Navigate back to the plugin
    await currentDriveTitle(page).click();
    await page.getByRole('link', { name: 'ontola/test-plugin' }).click();

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

    // Check if the custom view is gone.
    await clickSidebarItem('Duck', page);
    await expect(page.getByText('No custom views found')).not.toBeVisible();
  });
});
