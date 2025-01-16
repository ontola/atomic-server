import { test, expect } from '@playwright/test';
import {
  signIn,
  newDrive,
  waitForCommit,
  before,
  REBUILD_INDEX_TIME,
  addressBar,
  clickSidebarItem,
  editTitle,
  setTitle,
  sideBarNewResourceTestId,
  contextMenuClick,
  timestamp,
} from './test-utils';
test.describe('search', async () => {
  test.beforeEach(before);

  test('text search', async ({ page }) => {
    await addressBar(page).fill('welcome');
    await expect(page.locator('text=Welcome to your')).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(
      page.getByRole('heading', { name: 'Default Ontology' }),
    ).toBeVisible();
  });

  test('scoped search', async ({ page }) => {
    await signIn(page);
    await newDrive(page);

    // Create folder called 1
    await page.getByTestId(sideBarNewResourceTestId).click();
    await page.locator('button:has-text("folder")').click();
    await setTitle(page, 'Salad folder');

    // Create document called 'Avocado Salad'
    await page.locator('button:has-text("New Resource")').click();
    await page.locator('button:has-text("document")').click();
    await waitForCommit(page);
    // commit for initializing the first element (paragraph)
    await waitForCommit(page);
    await editTitle('Avocado Salad', page);

    await page.getByTestId(sideBarNewResourceTestId).click();

    // Create folder called 'Cake folder'
    await page.locator('button:has-text("folder")').click();
    await setTitle(page, 'Cake Folder');

    // Create document called 'Avocado Salad'
    await page.locator('button:has-text("New Resource")').click();
    await page.locator('button:has-text("document")').click();
    await waitForCommit(page);
    // commit for initializing the first element (paragraph)
    await waitForCommit(page);
    await editTitle('Avocado Cake', page);

    await clickSidebarItem('Cake Folder', page);

    // Set search scope to 'Cake folder'
    await page.waitForTimeout(REBUILD_INDEX_TIME);
    await page.reload();
    await contextMenuClick('scope', page);
    // Search for 'Avocado'
    await addressBar(page).type('Avocado');
    // I don't like the `.first` here, but for some reason there is one frame where
    // Multiple hits render, which fails the tests.
    await expect(page.locator('h2:text("Avocado Cake")').first()).toBeVisible();
    await expect(page.locator('h2:text("Avocado Salad")')).not.toBeVisible();

    // Remove scope
    await page.locator('button[title="Clear scope"]').click();

    await expect(page.locator('h2:text("Avocado Cake")').first()).toBeVisible();
    await expect(
      page.locator('h2:text("Avocado Salad")').first(),
    ).toBeVisible();
  });

  test('Add tags and search for them', async ({ page }) => {
    // Sign in
    await signIn(page);

    // Create a new drive
    const { driveTitle: _driveTitle } = await newDrive(page);

    // Create a folder
    const folderName = `TagTestFolder-${timestamp()}`;
    await page.getByTestId(sideBarNewResourceTestId).click();
    await page.locator('button:has-text("folder")').click();
    await setTitle(page, folderName);

    // Add tags to the folder using the TagBar
    // Click on the "+" button in the TagBar
    const firstTagName = `first-tag`;
    await page.getByTitle('Add tags').click();

    // Create a new tag
    await page.getByPlaceholder('New tag').fill(firstTagName);
    await page.getByRole('button', { name: 'Add tag', exact: true }).click();

    // Add a second tag
    const secondTagName = `second-tag`;
    await expect(page.getByPlaceholder('New tag')).toHaveValue('');

    await page.getByPlaceholder('New tag').fill(secondTagName);
    await page.getByRole('button', { name: 'Add tag', exact: true }).click();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('link', { name: firstTagName })).toBeVisible();
    await expect(page.getByRole('link', { name: secondTagName })).toBeVisible();

    // Wait for the index to be rebuilt
    await page.waitForTimeout(REBUILD_INDEX_TIME);

    // Search for the folder by the first tag
    await addressBar(page).fill('tag:first');
    await page.keyboard.press('Enter');

    // Verify the folder is found in search results
    await expect(page.getByRole('heading', { name: folderName })).toBeVisible();

    // Search for the folder by the second tag
    await addressBar(page).fill(`tag:${secondTagName}`);
    await page.keyboard.press('Enter');

    // Verify the folder is found in search results
    await expect(page.getByRole('heading', { name: folderName })).toBeVisible();

    // Verify that searching for a non-existent tag doesn't find the folder
    const nonExistentTag = `nonexistent-tag`;
    await addressBar(page).fill(`tag:${nonExistentTag}`);
    await page.keyboard.press('Enter');

    // Verify the folder is not found
    await expect(
      page.getByRole('heading', { name: folderName }),
    ).not.toBeVisible();
  });
});
