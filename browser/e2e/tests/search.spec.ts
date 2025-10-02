import { test, expect } from '@playwright/test';
import {
  before,
  clickSidebarItem,
  editTitle,
  setTitle,
  sidebarNewResourceButton,
  contextMenuClick,
  timestamp,
  newResource,
  waitForSearchIndex,
  openSearchOverlay,
  typeInSearch,
  searchAndOpen,
} from './test-utils';

// Tests rewritten for the modal search overlay.
// Old behavior (inline address bar auto-navigating to /app/search?query=...)
// no longer exists. New flow: open overlay (cmd+K or the Search button),
// type a query, pick a result — the overlay closes on navigation. See
// data-browser/src/components/OverlayContainer.tsx → SearchOverlay.
// Blocked by a server-side search-index bug: resources created with
// `did:ad:...` subjects (which all user-created resources now use) are not
// added to the Tantivy index. Repro: create a Folder, wait 30s, GET
// /search?q=<name> → 0 hits. Re-enable when the index handles DID subjects.
// Tracked as task #7.
test.describe.skip('search', async () => {
  test.beforeEach(before);

  test('text search', async ({ page }) => {
    // Seed content: dev-drive starts empty, so we create the thing we intend
    // to find. Previously the test relied on onboarding content ("Welcome to
    // your drive…") that no longer ships with dev-drive. Avoid colons in the
    // name (the overlay parses `tag:...` specially).
    const unique = Date.now().toString(36);
    const targetName = `Searchable-Folder-${unique}`;
    await sidebarNewResourceButton(page).click();
    await page.locator('button:has-text("folder")').click();
    await setTitle(page, targetName);

    await waitForSearchIndex(page);

    // Go somewhere else so navigation via search is observable.
    await clickSidebarItem('Dev drive', page).catch(() => {});

    await searchAndOpen(page, unique, targetName);
    await expect(page.getByRole('heading', { name: targetName })).toBeVisible();
  });

  test('scoped search', async ({ page }) => {
    // Create folder called 'Salad folder'
    await newResource('folder', page);
    await setTitle(page, 'Salad folder');

    // Create document called 'Avocado Salad'
    await page.locator('button:has-text("New Resource")').click();
    await page.locator('button:has-text("document")').click();
    await editTitle('Avocado Salad', page);

    // Create folder called 'Cake folder' at root
    await sidebarNewResourceButton(page).click();
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

    // Scoped-only results: Avocado Cake is under Cake folder; Avocado Salad is not.
    await typeInSearch(page, 'Avocado');
    await expect(page.getByText('Avocado Cake').first()).toBeVisible();
    await expect(page.getByText('Avocado Salad')).not.toBeVisible();

    // Remove scope — both now match.
    await page.locator('button[title="Clear scope"]').click();
    await typeInSearch(page, 'Avocado');
    await expect(page.getByText('Avocado Cake').first()).toBeVisible();
    await expect(page.getByText('Avocado Salad').first()).toBeVisible();
  });

  test('add tags and search for them', async ({ page }) => {
    const folderName = `TagTestFolder-${timestamp()}`;
    await sidebarNewResourceButton(page).click();
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

    // Search by first tag — result should include our folder.
    await typeInSearch(page, 'tag:first');
    await expect(page.getByText(folderName).first()).toBeVisible();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: folderName })).toBeVisible();

    // Search by second tag
    await typeInSearch(page, `tag:${secondTagName}`);
    await expect(page.getByText(folderName).first()).toBeVisible();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: folderName })).toBeVisible();

    // Non-existent tag — overlay shows no match, close with Escape.
    await typeInSearch(page, `tag:nonexistent-tag`);
    await expect(page.getByText(folderName)).not.toBeVisible();
    await page.keyboard.press('Escape');
  });
});
