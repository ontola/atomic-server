import { test, expect } from '@playwright/test';
import {
  before,
  editTitle,
  setTitle,
  sidebarNewResourceButton,
  contextMenuClick,
  timestamp,
  newResource,
  waitForSearchIndex,
  typeInSearch,
  searchAndOpen,
  getCurrentSubject,
  openSubject,
} from './test-utils';

// Tests rewritten for the modal search overlay. Old behavior (inline address
// bar auto-navigating to /app/search?query=...) no longer exists. New flow:
// open overlay (cmd+K or the Search button), type a query, pick a result.
test.describe('search', async () => {
  test.beforeEach(before);

  test('text search', async ({ page }) => {
    // Seed content: dev-drive starts empty, so we create the thing we intend
    // to find. Previously the test relied on onboarding content ("Welcome to
    // your drive…") that no longer ships with dev-drive. Avoid colons in the
    // name (the overlay parses `tag:...` specially).
    const driveSubject = await getCurrentSubject(page);
    const unique = Date.now().toString(36);
    const targetName = `Searchable-Folder-${unique}`;
    await sidebarNewResourceButton(page).click();
    await page.locator('button:has-text("folder")').click();
    await setTitle(page, targetName);

    await waitForSearchIndex(page);

    // Go somewhere else so navigation via search is observable.
    await openSubject(page, driveSubject);

    await searchAndOpen(page, unique, targetName);
    await expect(page.getByRole('heading', { name: targetName })).toBeVisible();
  });

  test('scoped search', async ({ page }) => {
    const driveSubject = await getCurrentSubject(page);

    // Create folder called 'Salad folder'
    await newResource('folder', page);
    await setTitle(page, 'Salad folder');

    // Create document called 'Avocado Salad'
    await page
      .getByRole('main')
      .getByRole('button', { name: 'New Document' })
      .click();
    await editTitle('Avocado Salad', page);

    // Create folder called 'Cake folder' at root
    await openSubject(page, driveSubject);
    await sidebarNewResourceButton(page).click();
    await page.locator('button:has-text("folder")').click();
    await setTitle(page, 'Cake Folder');
    await expect(
      page.getByRole('heading', { name: 'Cake Folder' }),
    ).toBeVisible();
    const cakeFolderSubject = await getCurrentSubject(page);

    // Create document called 'Avocado Cake'
    await page
      .getByRole('main')
      .getByRole('button', { name: 'New Document' })
      .click();
    await editTitle('Avocado Cake', page);

    await openSubject(page, cakeFolderSubject);

    // Set search scope to 'Cake folder'
    await waitForSearchIndex(page);
    await page.reload();
    await contextMenuClick('scope', page);

    // Scoped-only results: Avocado Cake is under Cake folder; Avocado Salad is not.
    await typeInSearch(page, 'Avocado');
    const searchResults = page.locator('[data-index]');
    await expect(
      searchResults.filter({ hasText: 'Avocado Cake' }).first(),
    ).toBeVisible();
    await expect(
      searchResults.filter({ hasText: 'Avocado Salad' }),
    ).toHaveCount(0);

    // Remove scope — the modal overlay does not render the old searchbar's
    // clear-scope chip, so reopen the current subject without `queryscope`.
    await page.keyboard.press('Escape');
    await openSubject(page, cakeFolderSubject);
    await typeInSearch(page, 'Avocado');
    await expect(
      searchResults.filter({ hasText: 'Avocado Cake' }).first(),
    ).toBeVisible();
    await expect(
      searchResults.filter({ hasText: 'Avocado Salad' }).first(),
    ).toBeVisible();
  });

  test('add tags and search for them', async ({ page }) => {
    const folderName = `TagTestFolder-${timestamp()}`;
    await sidebarNewResourceButton(page).click();
    await page.locator('button:has-text("folder")').click();
    await setTitle(page, folderName);

    // Add tags via the TagBar
    const firstTagName = `first-tag`;
    await page
      .locator('[aria-label="navigation"] button')
      .filter({ hasText: 'Tags' })
      .click();
    await page.getByPlaceholder('New tag').fill(firstTagName);
    await page.getByTitle('Add tag').click();
    await expect(
      page.locator('[aria-label="navigation"]').getByText(firstTagName),
    ).toBeVisible();

    const secondTagName = `second-tag`;
    await expect(page.getByPlaceholder('New tag')).toHaveValue('');
    await page.getByPlaceholder('New tag').fill(secondTagName);
    await page.getByTitle('Add tag').click();
    await expect(
      page.locator('[aria-label="navigation"]').getByText(secondTagName),
    ).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(
      page.getByTestId('sidebar').getByRole('button', { name: firstTagName }),
    ).toBeVisible();
    await expect(
      page.getByTestId('sidebar').getByRole('button', { name: secondTagName }),
    ).toBeVisible();

    await waitForSearchIndex(page);

    // Search by first tag — result should include our folder.
    await searchAndOpen(page, `tag:${firstTagName}`, folderName);
    await expect(page.getByRole('heading', { name: folderName })).toBeVisible();

    // Search by second tag
    await searchAndOpen(page, `tag:${secondTagName}`, folderName);
    await expect(page.getByRole('heading', { name: folderName })).toBeVisible();

    // Non-existent tag — overlay shows no match, close with Escape.
    await typeInSearch(page, `tag:nonexistent-tag`);
    await expect(
      page.locator('[data-index]').filter({ hasText: folderName }),
    ).toHaveCount(0);
    await page.keyboard.press('Escape');
  });

  // Offline search must resolve from the client-side MiniSearch index
  // (`LocalSearch`) — no server round-trip. A regression here makes search
  // silently return nothing while disconnected.
  test('search works offline against the local index', async ({
    page,
    context,
  }) => {
    test.slow();

    // Create a folder with a distinctive name while online.
    const unique = `OfflineFindable-${timestamp()}`;
    await sidebarNewResourceButton(page).click();
    await page.locator('button:has-text("folder")').click();
    await setTitle(page, unique);

    // It must be in the store (and therefore the local search index) before
    // we cut the connection.
    await expect(
      page.getByTestId('sidebar').getByText(unique),
    ).toBeVisible({ timeout: 10000 });

    // Go offline: block the network and close the WebSocket.
    await context.setOffline(true);
    await page.evaluate(() => {
      (window as unknown as { store?: { getDefaultWebSocket(): { close(): void } | undefined } })
        .store?.getDefaultWebSocket()
        ?.close();
    });
    await page.waitForFunction(
      () => (window as any).store?.getSyncStatus()?.serverConnected === false,
      undefined,
      { timeout: 15000 },
    );

    // Search while offline — must surface the folder from the local index.
    await typeInSearch(page, unique);
    await expect(
      page.locator('[data-index]').filter({ hasText: unique }).first(),
    ).toBeVisible({ timeout: 10000 });
  });
});
