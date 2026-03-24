import { test, expect } from '@playwright/test';
import {
  devDrive,
  before,
  addressBar,
  clickSidebarItem,
  editTitle,
  setTitle,
  sideBarNewResourceTestId,
  contextMenuClick,
  timestamp,
  newResource,
  waitForSearchIndex,
} from './test-utils';

test.describe('search', async () => {
  test.beforeEach(before);

  test('text search', async ({ page }) => {
    const navigateToSearchPromise = page.waitForURL(
      '**/app/search?query=welcome',
      {
        timeout: 10000,
      },
    );
    await addressBar(page).pressSequentially('welcome');
    await navigateToSearchPromise;
    await expect(page.locator('text=Welcome to your')).toBeVisible();
    await page.waitForURL(/app\/search/, { timeout: 5000 });
    await page.keyboard.press('Enter');
    await page.waitForURL(url => !url.pathname.includes('/app/search'), {
      timeout: 10000,
    });
    await expect(
      page.getByRole('heading', { name: 'Default Ontology' }),
    ).toBeVisible();
  });

  test('scoped search', async ({ page }) => {
    await devDrive(page);

    // Create folder called 'Salad folder'
    await newResource('folder', page);
    await setTitle(page, 'Salad folder');

    // Create document called 'Avocado Salad'
    await page.locator('button:has-text("New Resource")').click();
    await page.locator('button:has-text("document")').click();
    await editTitle('Avocado Salad', page);

    // Create folder called 'Cake folder' at root
    await page.getByTestId(sideBarNewResourceTestId).click();
    await page.locator('button:has-text("folder")').click();
    await setTitle(page, 'Cake Folder');

    // Create document called 'Avocado Cake'
    await page.locator('button:has-text("New Resource")').click();
    await page.locator('button:has-text("document")').click();
    await editTitle('Avocado Cake', page);

    await clickSidebarItem('Cake Folder', page);

    // Set search scope to 'Cake folder'
    await waitForSearchIndex(page);
    await page.reload();
    await contextMenuClick('scope', page);
    await addressBar(page).type('Avocado');
    await expect(page.locator('h2:text("Avocado Cake")').first()).toBeVisible();
    await expect(page.locator('h2:text("Avocado Salad")')).not.toBeVisible();

    // Remove scope
    await page.locator('button[title="Clear scope"]').click();
    await expect(page.locator('h2:text("Avocado Cake")').first()).toBeVisible();
    await expect(
      page.locator('h2:text("Avocado Salad")').first(),
    ).toBeVisible();
  });

  test('add tags and search for them', async ({ page }) => {
    await devDrive(page);

    const folderName = `TagTestFolder-${timestamp()}`;
    await page.getByTestId(sideBarNewResourceTestId).click();
    await page.locator('button:has-text("folder")').click();
    await setTitle(page, folderName);

    // Add tags via the TagBar
    const firstTagName = `first-tag`;
    await page.getByTitle('Add tags').click();
    await page.getByPlaceholder('New tag').fill(firstTagName);
    await page.getByRole('button', { name: 'Add tag', exact: true }).click();

    const secondTagName = `second-tag`;
    await expect(page.getByPlaceholder('New tag')).toHaveValue('');
    await page.getByPlaceholder('New tag').fill(secondTagName);
    await page.getByRole('button', { name: 'Add tag', exact: true }).click();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('link', { name: firstTagName })).toBeVisible();
    await expect(page.getByRole('link', { name: secondTagName })).toBeVisible();

    await waitForSearchIndex(page);

    // Search by first tag
    await addressBar(page).fill('tag:first');
    await expect(page.locator(`text=${firstTagName}`).first()).toBeVisible();
    await page.waitForTimeout(200);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: folderName })).toBeVisible();

    // Search by second tag
    await addressBar(page).fill(`tag:${secondTagName}`);
    await expect(page.locator(`text=${secondTagName}`).first()).toBeVisible();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: folderName })).toBeVisible();

    // Non-existent tag should not find the folder
    await addressBar(page).fill(`tag:nonexistent-tag`);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(
      page.getByRole('heading', { name: folderName }),
    ).not.toBeVisible();
  });
});
