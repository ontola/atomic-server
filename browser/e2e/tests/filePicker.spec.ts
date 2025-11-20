import { test, expect, Page } from '@playwright/test';

import {
  DIALOG_CLOSE_BUTTON,
  FRONTEND_URL,
  before,
  fillSearchBox,
  inDialog,
  newDrive,
  newResource,
  sideBarNewResourceTestId,
  signIn,
  testFilePath,
  waitForCommit,
  waitForSearchIndex,
} from './test-utils';

const ONTOLOGY_NAME = 'filepicker-test';

const uploadFile = async (page: Page, fileName: string) => {
  await page.getByTestId(sideBarNewResourceTestId).click();
  await expect(page).toHaveURL(`${FRONTEND_URL}/app/new`);

  const fileChooserPromise = page.waitForEvent('filechooser');

  await page
    .getByRole('button', { name: 'Drop files or click here to upload.' })
    .click();

  const fileChooser = await fileChooserPromise;

  await fileChooser.setFiles(testFilePath(fileName));

  await expect(page.getByText(fileName)).toBeVisible();
};

// Creates an ontology with a class we can use to test the file picker.
const createModel = async (page: Page) => {
  await newResource('ontology', page);

  await inDialog(page, async (dialog, closeDialogWith) => {
    await dialog.getByPlaceholder('my-ontology').fill(ONTOLOGY_NAME);
    await closeDialogWith('Create');
  });

  await expect(page.locator(`h1:has-text("${ONTOLOGY_NAME}")`)).toBeVisible();

  await page.getByRole('button', { name: 'Add class', exact: true }).click();

  await inDialog(page, async (dialog, closeDialogWith) => {
    await dialog.getByPlaceholder('shortname').fill('robot');
    await closeDialogWith('Save');
  });

  await expect(page.locator('input[value="robot"]')).toBeVisible();

  await page.getByRole('button', { name: 'add required property' }).click();
  await page
    .getByPlaceholder('Search for a property or enter a URL')
    .fill('programming');

  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');

  await page.getByRole('button', { name: 'Configure programming' }).click();

  await inDialog(page, async (dialog, closeDialogWith) => {
    await dialog
      .getByLabel('Datatype')
      .selectOption('https://atomicdata.dev/datatypes/atomicURL');

    await expect(dialog.getByLabel('Classtype')).not.toBeDisabled();

    await fillSearchBox(
      dialog,
      'Search for a class',
      'https://atomicdata.dev/classes/File',
      { label: 'Classtype' },
    );

    const commitPromise = waitForCommit(page);
    await page.keyboard.press('Enter');
    await commitPromise;
    await expect(dialog.getByLabel('Classtype')).toHaveText('file');

    await closeDialogWith(DIALOG_CLOSE_BUTTON);
  });
};

test.describe('File Picker', () => {
  test.beforeEach(before);

  test('select file and upload using the filepicker', async ({ page }) => {
    const SEARCH_BAR_PLACEHOLDER = 'Search or enter a URL...';

    await signIn(page);
    await newDrive(page);

    await uploadFile(page, 'testFile1.txt');
    await uploadFile(page, 'testFile2.md');

    await createModel(page);

    // The new resource page relies on the search API to show ontology class buttons. If the prossess of creating the ontology took less than 5 seconds it will not appear on the new resource page.
    await waitForSearchIndex(page);

    {
      // Test selecting an existing file.
      await newResource('robot', page);

      await expect(
        page.getByRole('heading', { name: 'new robot' }),
      ).toBeVisible();

      await expect(
        page.getByRole('button', { name: 'Select File' }),
      ).toBeVisible();

      await page.getByRole('button', { name: 'Select File' }).click();

      await inDialog(page, async dialog => {
        await expect(
          dialog.getByPlaceholder(SEARCH_BAR_PLACEHOLDER),
        ).toBeVisible();
        await expect(dialog.getByText('Contents of test file 1')).toBeVisible();
        await expect(dialog.getByText('testFile2.md')).toBeVisible();

        await dialog.getByPlaceholder(SEARCH_BAR_PLACEHOLDER).fill('.md');

        await expect(
          dialog.getByText('Contents of test file 1'),
        ).not.toBeVisible();

        await dialog.getByRole('button', { name: 'testFile2.md' }).click();

        await expect(
          dialog.getByRole('heading', {
            name: 'first step in understanding recursion?',
          }),
        ).not.toBeVisible();
      });

      await expect(
        page
          .getByRole('region', { name: 'testFile2.md preview' })
          .getByRole('heading', {
            name: 'first step in understanding recursion?',
          }),
      ).toBeVisible();

      await page.getByRole('button', { name: 'Save' }).click();
      await expect(page.getByText('New robot')).not.toBeVisible();
    }

    {
      // Test uploading a new file.
      await newResource('robot', page);

      await expect(
        page.getByRole('heading', { name: 'new robot' }),
      ).toBeVisible();

      await page.getByRole('button', { name: 'Select File' }).click();

      await inDialog(page, async dialog => {
        await expect(
          dialog.getByPlaceholder(SEARCH_BAR_PLACEHOLDER),
        ).toBeVisible();

        await dialog
          .getByLabel('Upload')
          .setInputFiles(testFilePath('testFile3.txt'));
      });

      await expect(
        page
          .getByRole('region', { name: 'testFile3.txt preview' })
          .getByText('File preview not available at this time'),
      ).toBeVisible();

      await page.getByRole('button', { name: 'Save' }).click();
      await expect(page.getByText('New robot')).not.toBeVisible();
      await expect(page.getByText('testFile3.txt').nth(0)).toBeVisible();
      await page.getByText('testFile3.txt').nth(0).click();

      // For some reason playwright will only find text with quotes in them when using a regex instead of string.
      await expect(page.getByText(/It's a secret to everybody/)).toBeVisible();
    }
  });
});
