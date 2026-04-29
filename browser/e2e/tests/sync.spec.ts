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
    () => window.store.getClientDb()?.isReady === true,
    undefined,
    { timeout: 30000 },
  );
}

/** Wait for the store to be connected to the server. */
async function waitForConnected(page: import('@playwright/test').Page) {
  await page.waitForFunction(
    () => window.store.getSyncStatus().serverConnected === true,
    undefined,
    { timeout: 30000 },
  );
}

/** Wait for all dirty resources to be synced (pendingDirtyCount === 0). */
async function waitForSynced(page: import('@playwright/test').Page) {
  try {
    await page.waitForFunction(
      () => {
        const status = window.store.getSyncStatus();

        return status.serverConnected && status.pendingDirtyCount === 0;
      },
      undefined,
      { timeout: 30000 },
    );
  } catch (e) {
    // Surface WHY sync didn't settle. A stuck `pendingDirtyCount` means
    // an outbox entry's post keeps throwing — `lastAttemptError` carries
    // the server's rejection reason, which is otherwise invisible.
    const diag = await page
      .evaluate(() => {
        const store = window.store;
        const status = store.getSyncStatus();
        const entries = store.outbox.pending().map(entry => ({
          subject: entry.subject,
          commitCount: entry.commits?.length,
          commits: (entry.commits ?? []).map(c => ({
            signature: c.signature,
            previousCommit: c.previousCommit,
            setKeys: c.set ? Object.keys(c.set) : undefined,
            destroy: c.destroy,
          })),
          lastAttemptError: entry.lastAttemptError,
        }));

        return { status, entries };
      })
      .catch(() => undefined);
    throw new Error(
      `waitForSynced timed out. Outbox diagnostics: ${JSON.stringify(diag)}`,
    );
  }
}

/** Wait for the server's search index to process a commit (polls search endpoint). */
async function waitForSearchable(
  page: import('@playwright/test').Page,
  query: string,
) {
  await page.waitForFunction(
    async (q: string) => {
      if (!window.store) return false;

      try {
        const results = await window.store.search(q);

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
      () => window.store.getSyncStatus().pendingDirtyCount === 0,
      undefined,
      { timeout: 10000 },
    );

    // 2. Reload and verify persistence
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(currentDriveTitle(page)).toBeVisible({ timeout: 15000 });

    // The document should be accessible (not unauthorized)
    await expect(page.getByTestId('sidebar').locator('a').first()).toBeVisible({
      timeout: 15000,
    });
  });

  // FLAKY (dagger CI + remote CI): the `Edited Offline` editable-title
  // doesn't appear within 15 s after the `setOffline(false)` reload.
  // Path: edit while offline → reload → wait for `serverConnected` →
  // expect title rendered with offline edit. Likely the WS reconnect +
  // dirty-queue drain doesn't finish in time on a contended runner.
  // Investigate: poll `store.getResourceLoading(subject).title === '...'`
  // directly (we already do this for the cross-context test below).
  test('edits made offline persist across reload', async ({ page }) => {
    test.slow();

    // 1. Create a document while online.
    //
    // CRITICAL: wait for the URL to flip off the drive page before
    // touching `editableTitle`. The drive page ALSO has an editable
    // title; if we proceed before the click→navigate window closes,
    // we end up renaming the DRIVE and the rest of the test
    // (offline edit, reload, expect) operates on a different
    // resource than intended. Confirmed via debug logging:
    // `main[about] === store.getDrive()` immediately after the
    // click, so `editableTitle` resolved to the drive's input.
    const driveUrl = page.url();
    await page
      .getByTestId('sidebar')
      .getByRole('button', { name: 'New Document' })
      .click();
    await page.waitForURL(url => url.toString() !== driveUrl, {
      timeout: 10000,
    });

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
      window.store.getDefaultWebSocket()?.close();
    });

    // Wait until the store notices the disconnect
    await page.waitForFunction(
      () => window.store.getSyncStatus().serverConnected === false,
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
      () => window.store.getSyncStatus().pendingDirtyCount > 0,
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

  // FLAKY (dagger CI + remote CI): on the second-context (page2) view of
  // the document, the `Synced From Offline` H1 doesn't render within
  // 30 s. Path is page1 edits offline → reconnect → page1
  // `waitForSearchable` → page2 navigates to the resource subject.
  // Already does a `waitForFunction` against `store.resources.get(...)`,
  // but under dagger CPU contention the Loro WASM init + WS
  // authenticate + GET round-trip exceeds the budget. Investigate:
  // pre-warm Loro on page2 before navigation, or split the deadline so
  // the WS GET budget is independent of the H1 render budget.
  test('offline edits sync to server when connection is restored', async ({
    page,
    context,
    browser,
  }) => {
    test.slow();

    // 1. Create a document while online.
    //
    // CRITICAL: wait for the URL to flip to the new doc's subject before
    // touching `editableTitle`. The drive page also has an editable
    // title; if the click→navigate window is wide enough (server under
    // load) we'd be targeting the drive's title input and end up
    // renaming the DRIVE to "Will Edit Offline" instead of the doc.
    // Later assertions (`sidebar.getByText('Will Edit Offline')`) would
    // still pass because the drive's title also shows in the sidebar,
    // masking the bug until the second context fails to find the doc.
    const driveUrl = page.url();
    await page
      .getByTestId('sidebar')
      .getByRole('button', { name: 'New Document' })
      .click();
    await page.waitForURL(url => url.toString() !== driveUrl, {
      timeout: 10000,
    });

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
      window.store.getDefaultWebSocket()?.close();
    });

    // Wait for the store to detect the disconnect
    await page.waitForFunction(
      () => window.store.getSyncStatus().serverConnected === false,
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
      () => window.store.getSyncStatus().pendingDirtyCount > 0,
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

    // KNOWN BUG: the offline rename to "Synced From Offline" does NOT
    // actually propagate to the server on reconnect — the test's prior
    // `waitForSearchable` passes only because `store.search` falls
    // back to the LOCAL Tantivy/minisearch index (which has the
    // offline edit) before consulting the server. On page2 (fresh
    // context, no local cache) the doc still has its pre-offline name
    // "Will Edit Offline". Needs a server-side investigation: why
    // doesn't the outbox-drain on reconnect actually push the offline
    // commit?
    //
    // Polling `page2.title()` reliably surfaces the symptom (page2
    // shows the server's title), so this is what fails when the bug
    // is present — vs `getByRole('heading', { level: 1 })` which has
    // its own accessibility-tree quirk that confuses the diagnosis.
    await expect
      .poll(async () => page2.title(), { timeout: 60000, intervals: [500] })
      .toBe('Synced From Offline');

    await context2.close();
  });

  test('sync page shows correct status', async ({ page }) => {
    await page.goto(`${FRONTEND_URL}/app/sync`);

    await expect(page.getByText('This device', { exact: true })).toBeVisible({
      timeout: 10000,
    });
    await expect(
      page.getByRole('heading', { name: 'Sync', exact: true }),
    ).toBeVisible({ timeout: 10000 });
    await expect(page.getByText('Details', { exact: true })).toBeVisible({
      timeout: 10000,
    });
  });
});
