import { test, expect } from '@playwright/test';
import {
  before,
  editableTitle,
  currentDriveTitle,
  FRONTEND_URL,
  getDevDriveSecret,
} from './test-utils';

/** Wait for the WASM ClientDb to be initialized and seeded. */
async function waitForClientDb(page: import('@playwright/test').Page) {
  await page.waitForFunction(
    () => (window as any).store?.getClientDb()?.isReady === true,
    undefined,
    { timeout: 30000 },
  );
}

/** Wait for the store to be connected to the server. */
async function waitForConnected(page: import('@playwright/test').Page) {
  await page.waitForFunction(
    () => (window as any).store?.getSyncStatus()?.serverConnected === true,
    undefined,
    { timeout: 30000 },
  );
}

/** Wait for all dirty resources to be synced (pendingDirtyCount === 0). */
async function waitForSynced(page: import('@playwright/test').Page) {
  await page.waitForFunction(
    () => {
      const status = (window as any).store?.getSyncStatus();
      return status?.serverConnected && status?.pendingDirtyCount === 0;
    },
    undefined,
    { timeout: 30000 },
  );
}

/** Wait for the server's search index to process a commit (polls search endpoint). */
async function waitForSearchable(
  page: import('@playwright/test').Page,
  query: string,
) {
  await page.waitForFunction(
    async (q: string) => {
      const store = (window as any).store;
      if (!store) return false;
      try {
        const results = await store.search(q);
        return results.length > 0;
      } catch {
        return false;
      }
    },
    query,
    { timeout: 30000, polling: 1000 },
  );
}

test.describe('sync', () => {
  test.beforeEach(before);

  test('create resource online, edit title, verify it persists across reload', async ({
    page,
  }) => {
    // 1. Create a document in the drive (online)
    await page
      .getByTestId('sidebar')
      .getByRole('button', { name: 'New Document' })
      .click();

    await expect(editableTitle(page)).toBeVisible({ timeout: 10000 });

    // Set title
    await editableTitle(page).click();
    await expect(editableTitle(page)).toHaveRole('textbox');
    await editableTitle(page).fill('Sync Test Doc');
    await page.keyboard.press('Escape');

    // Wait for the title to be committed to the server
    await expect(
      page.getByTestId('sidebar').getByText('Sync Test Doc'),
    ).toBeVisible({ timeout: 10000 });

    // Wait for server to process the commit and rebuild index
    await page.waitForFunction(
      () => (window as any).store?.getSyncStatus()?.pendingDirtyCount === 0,
      undefined,
      { timeout: 10000 },
    );

    // 2. Reload and verify persistence
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(currentDriveTitle(page)).toBeVisible({ timeout: 15000 });

    // The document should be accessible (not unauthorized)
    await expect(
      page.getByTestId('sidebar').locator('a').first(),
    ).toBeVisible({ timeout: 15000 });
  });

  test('edits made offline persist across reload', async ({ page }) => {
    test.slow();

    // 1. Create a document while online
    await page
      .getByTestId('sidebar')
      .getByRole('button', { name: 'New Document' })
      .click();

    await expect(editableTitle(page)).toBeVisible({ timeout: 10000 });
    await editableTitle(page).click();
    await expect(editableTitle(page)).toHaveRole('textbox');
    await editableTitle(page).fill('Before Offline');
    await page.keyboard.press('Escape');

    // Wait for the title to be committed
    await expect(
      page.getByTestId('sidebar').getByText('Before Offline'),
    ).toBeVisible({ timeout: 10000 });

    // 2. Go offline
    await page.evaluate(() => {
      const store = (window as any).store;
      store?.getDefaultWebSocket()?.close();
    });

    // Wait until the store notices the disconnect
    await page.waitForFunction(
      () => (window as any).store?.getSyncStatus()?.serverConnected === false,
      undefined,
      { timeout: 10000 },
    );

    // 3. Edit the title while offline
    await editableTitle(page).click();
    await expect(editableTitle(page)).toHaveRole('textbox');
    await editableTitle(page).fill('Edited Offline');
    await page.keyboard.press('Escape');

    // Wait for the edit to be saved locally
    await page.waitForFunction(
      () => (window as any).store?.getSyncStatus()?.pendingDirtyCount > 0,
      undefined,
      { timeout: 10000 },
    );

    // 4. Reload the page
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForClientDb(page);

    // 5. Verify the offline edit survived the reload (the title appears in
    // the breadcrumb, sidebar tree, and main editable title — match the
    // main one to avoid strict-mode multi-match).
    await expect(
      page.getByTestId('editable-title').getByText('Edited Offline'),
    ).toBeVisible({ timeout: 15000 });
  });

  test('offline edits sync to server when connection is restored', async ({
    page,
    context,
    browser,
  }) => {
    test.slow();

    // 1. Create a document while online
    await page
      .getByTestId('sidebar')
      .getByRole('button', { name: 'New Document' })
      .click();

    await expect(editableTitle(page)).toBeVisible({ timeout: 10000 });
    await editableTitle(page).click();
    await expect(editableTitle(page)).toHaveRole('textbox');
    await editableTitle(page).fill('Will Edit Offline');
    await page.keyboard.press('Escape');

    // Wait for the title to be committed
    await expect(
      page.getByTestId('sidebar').getByText('Will Edit Offline'),
    ).toBeVisible({ timeout: 10000 });

    // Get the resource subject for later verification
    const resourceSubject = await page.evaluate(() => {
      const main = document.querySelector('main[about]');
      return main?.getAttribute('about');
    });

    expect(resourceSubject).toBeTruthy();

    // Get the secret so we can sign in from another context
    const secret = await getDevDriveSecret(page);

    // Make sure the lazy `CollaborativeEditor` chunk is loaded BEFORE going
    // offline, otherwise the document body falls into an ErrorBoundary and
    // the editable title disappears. Vite serves these chunks dynamically;
    // setOffline(true) blocks the fetch.
    await expect(page.getByLabel('Rich Text Editor')).toBeVisible({
      timeout: 15000,
    });

    // 2. Go offline using Playwright's network control + close the WS
    // directly. `setOffline(true)` blocks new connections but doesn't tear
    // down the open one, so the store's `serverConnected` flag won't flip
    // until something forces a close. Closing here also halts auto-retry
    // (close() sets `_closed=true`) so the backoff doesn't pile up.
    await context.setOffline(true);
    await page.evaluate(() => {
      const store = (window as any).store;
      store?.getDefaultWebSocket()?.close();
    });

    // Wait for the store to detect the disconnect
    await page.waitForFunction(
      () => (window as any).store?.getSyncStatus()?.serverConnected === false,
      undefined,
      { timeout: 15000 },
    );

    // 3. Edit title offline
    await editableTitle(page).click();
    await expect(editableTitle(page)).toHaveRole('textbox');
    await editableTitle(page).fill('Synced From Offline');
    await page.keyboard.press('Escape');

    // Wait for dirty count to increase
    await page.waitForFunction(
      () => (window as any).store?.getSyncStatus()?.pendingDirtyCount > 0,
      undefined,
      { timeout: 10000 },
    );

    // 4. Go back online — navigate to force fresh WS connection
    await context.setOffline(false);
    // Small delay to let the network stack come back up
    await page.waitForTimeout(500);
    // Reload establishes a fresh store + WS
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForConnected(page);

    // The dirty sync should push the offline edit to the server.
    // Wait for all pending resources to sync.
    await waitForSynced(page);

    // Wait for the search index to pick up the change
    await waitForSearchable(page, 'Synced From Offline');

    // 5. Open a fresh browser context (simulates another device)
    const context2 = await browser.newContext();
    const page2 = await context2.newPage();
    await page2.goto(`${FRONTEND_URL}/app/agent`);

    // Sign in with the same agent
    await page2.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page2.getByLabel('Agent secret').fill(secret);
    await page2.getByRole('button', { name: 'Continue' }).click();

    // Wait for the second page to connect
    await waitForConnected(page2);

    // Navigate to the resource — the legacy `adress-bar` input is gone;
    // route directly via the SPA's /app/show entry.
    await page2.goto(
      `${FRONTEND_URL}/app/show?subject=${encodeURIComponent(resourceSubject!)}`,
    );

    // Verify the offline edit is visible — first wait for the editor to
    // mount (signals page-load complete), then assert the title appears in
    // any of the rendered locations.
    await page2.waitForLoadState('networkidle').catch(() => undefined);
    await expect(
      page2.getByText('Synced From Offline').first(),
    ).toBeVisible({ timeout: 15000 });

    await context2.close();
  });

  test('sync page shows correct status', async ({ page }) => {
    await page.goto(`${FRONTEND_URL}/app/sync`);

    await expect(page.getByText('This device', { exact: true })).toBeVisible({ timeout: 10000 });
    await expect(page.getByRole('heading', { name: 'Sync', exact: true })).toBeVisible({ timeout: 10000 });
    await expect(page.getByText('Details', { exact: true })).toBeVisible({ timeout: 10000 });
  });
});
