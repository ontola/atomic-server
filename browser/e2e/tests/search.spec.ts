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
    const folderSubject = await getCurrentSubject(page);

    // Don't rely on a fixed 6.5s sleep — under parallel load the index can
    // lag noticeably longer. Poll the real search endpoint until the new
    // folder appears. Pass `parents: drive` so we hit the same server path
    // the overlay uses (without it, `store.search` short-circuits to the
    // local MiniSearch index, which can be stale relative to the server).
    await page.waitForFunction(
      async (args: { query: string; subject: string; drive: string }) => {
        const store = (
          window as {
            store?: { search(q: string, o: object): Promise<string[]> };
          }
        ).store;

        if (!store) return false;

        try {
          // Match the overlay's exact params (include/limit) so the
          // server's response is built from the same Tantivy query —
          // a different URL serves a different cache key.
          const results = await store.search(args.query, {
            parents: args.drive,
            include: true,
            limit: 10,
          });

          return results.includes(args.subject);
        } catch {
          return false;
        }
      },
      { query: unique, subject: folderSubject, drive: driveSubject },
      { timeout: 30000, polling: 1000 },
    );

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
    const avocadoSaladSubject = await getCurrentSubject(page);

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
    const avocadoCakeSubject = await getCurrentSubject(page);

    await openSubject(page, cakeFolderSubject);

    // Wait until the server's scoped search index actually contains the
    // doc. A fixed sleep races the ~5s index-commit throttle; poll the
    // real scoped query (`parents` forces the server path) instead.
    await page.waitForFunction(
      async (args: { subject: string; parent: string }) => {
        const store = (
          window as {
            store?: { search(q: string, o: object): Promise<string[]> };
          }
        ).store;

        if (!store) return false;

        try {
          const results = await store.search('Avocado', {
            parents: args.parent,
          });

          return results.includes(args.subject);
        } catch {
          return false;
        }
      },
      { subject: avocadoCakeSubject, parent: cakeFolderSubject },
      { timeout: 30000, polling: 1000 },
    );

    // Set search scope to 'Cake folder'
    await page.reload();
    // Wait for the navbar's resource to actually be Cake Folder before
    // opening the context menu. The menu's `subject` prop comes from the
    // navbar resource, which falls back to the drive while the real one
    // is still loading — clicking `scope` then sets the scope to the drive
    // instead of Cake Folder and the assertion sees the wrong result set.
    await expect(
      page.locator(`main[about="${cakeFolderSubject}"]`).first(),
    ).toBeVisible({ timeout: 20000 });
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

    // Salad doc was indexed for an earlier scoped query (different `parents`)
    // so the un-scoped server index doesn't necessarily contain it yet.
    // Poll the drive-scoped search (matching the overlay's `parents: drive`
    // default) until both docs are returned — without this, a slow indexer
    // under parallel load races the assertion.
    await page.waitForFunction(
      async (args: {
        cakeSubject: string;
        saladSubject: string;
        drive: string;
      }) => {
        const store = (
          window as {
            store?: { search(q: string, o: object): Promise<string[]> };
          }
        ).store;

        if (!store) return false;

        try {
          const results = await store.search('Avocado', {
            parents: args.drive,
          });

          return (
            results.includes(args.cakeSubject) &&
            results.includes(args.saladSubject)
          );
        } catch {
          return false;
        }
      },
      {
        cakeSubject: avocadoCakeSubject,
        saladSubject: avocadoSaladSubject,
        drive: driveSubject,
      },
      { timeout: 30000, polling: 1000 },
    );

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
    await expect(page.getByTestId('sidebar').getByText(unique)).toBeVisible({
      timeout: 10000,
    });

    // Offline search reads the client-side MiniSearch index. The folder is
    // created (commit 1) and named via `setTitle` (commit 2); the local index
    // only picks up the *name* once that rename commit round-trips and
    // re-ingests — the sidebar shows the name optimistically well before. So
    // going offline on sidebar-visibility races the indexing (under load the
    // name reaches the local index hundreds of ms later, intermittently more).
    // Wait for the exact signal offline search depends on: the local index
    // returns the folder for its name. `store.search()` can't be used here —
    // online it falls back to the server when the local index misses, which
    // would mask the very gap we must close.
    const folderSubject = await getCurrentSubject(page);
    await expect
      .poll(
        () =>
          page.evaluate(
            ({ subj, q }) => {
              const store = window.store as unknown as {
                driveOf(s: string): string;
                localSearch: {
                  search(
                    q: string,
                    d: string,
                    n: number,
                  ): {
                    subjects: string[];
                  };
                };
              };

              try {
                const drive = store.driveOf(subj);

                return store.localSearch.search(q, drive, 30).subjects.length;
              } catch {
                return 0;
              }
            },
            { subj: folderSubject, q: unique },
          ),
        { timeout: 15000 },
      )
      .toBeGreaterThan(0);

    // Go offline: block the network and close the WebSocket.
    await context.setOffline(true);
    await page.evaluate(() => {
      (
        window as unknown as {
          store?: { getDefaultWebSocket(): { close(): void } | undefined };
        }
      ).store
        ?.getDefaultWebSocket()
        ?.close();
    });
    await page.waitForFunction(
      () => window.store.getSyncStatus().serverConnected === false,
      undefined,
      { timeout: 15000 },
    );

    // Search while offline — must surface the folder from the local index.
    // Exclude the "Start AI Chat with …" fallback row: it echoes the query
    // text, so a plain `hasText` match would pass even with zero real
    // results.
    await typeInSearch(page, unique);
    await expect(
      page
        .locator('[data-index]')
        .filter({ hasText: unique })
        .filter({ hasNotText: 'Start AI Chat' })
        .first(),
    ).toBeVisible({ timeout: 10000 });
  });
});
