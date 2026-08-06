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
    () => window.store?.getClientDb()?.isReady === true,
    undefined,
    { timeout: 30000 },
  );
}

/** Wait for the store to be connected to the server. */
async function waitForConnected(page: import('@playwright/test').Page) {
  await page.waitForFunction(
    () => window.store?.getSyncStatus().serverConnected === true,
    undefined,
    { timeout: 30000 },
  );
}

/** Wait for all dirty resources to be synced (pendingDirtyCount === 0). */
async function waitForSynced(page: import('@playwright/test').Page) {
  try {
    await page.waitForFunction(
      () => {
        const status = window.store?.getSyncStatus();

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
        // The outbox is Loro-delta based now (a pre-signed genesis + a save
        // cursor), not a list of commits — surface those fields instead.
        const entries = store.outbox.pending().map(entry => ({
          subject: entry.subject,
          enqueuedAt: entry.enqueuedAt,
          hasSignedGenesis: !!entry.signedGenesis,
          baseVersion: entry.baseVersion,
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
      () => window.store?.getSyncStatus().pendingDirtyCount === 0,
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

    // Get the resource subject for the post-reload poll below.
    const resourceSubject = await page.evaluate(() => {
      const main = document.querySelector('main[about]');

      return main?.getAttribute('about');
    });
    expect(resourceSubject).toBeTruthy();

    // 2. Go offline
    await page.evaluate(() => {
      window.store.getDefaultWebSocket()?.close();
    });

    // Wait until the store notices the disconnect
    await page.waitForFunction(
      () => window.store?.getSyncStatus().serverConnected === false,
      undefined,
      { timeout: 10000 },
    );

    // 3. Edit the title while offline
    await editableTitle(page).click();
    await expect(editableTitle(page)).toHaveRole('textbox');
    await editableTitle(page).fill('Edited Offline');
    await page.keyboard.press('Escape');

    // Wait for the edit to be saved locally — and for OPFS to actually
    // hold the new title. `pendingDirtyCount > 0` alone is not enough
    // under dagger load: ClientDb init + the durable flush can lag the
    // dirty bit, and a reload before the snapshot lands lets a server
    // GET of "Before Offline" win the race.
    await page.waitForFunction(
      () => window.store?.getSyncStatus().pendingDirtyCount > 0,
      undefined,
      { timeout: 10000 },
    );
    await page.waitForFunction(
      async ({ subject }) => {
        const clientDb = window.store.getClientDb();
        if (!clientDb?.isReady) return false;
        const jsonAd = await clientDb.getResource?.(subject);
        if (!jsonAd) return false;

        try {
          const parsed = JSON.parse(jsonAd) as Record<string, unknown>;
          const name = parsed['https://atomicdata.dev/properties/name'];

          return name === 'Edited Offline';
        } catch {
          return false;
        }
      },
      { subject: resourceSubject! },
      { timeout: 15000 },
    );

    // Stay offline across the reload so this test asserts OPFS durability
    // rather than racing a reconnect GET of the pre-offline server title.
    await page.evaluate(() => localStorage.setItem('ws-disconnected', '1'));

    // 4. Reload the page
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForClientDb(page);

    // Wait for the resource itself to report the offline edit before
    // asserting on the DOM. `waitForClientDb` only confirms the worker/
    // OPFS bootstrap finished, not that THIS resource's local-first fetch
    // has resolved — under a contended runner that can outlast a bare
    // `toBeVisible` poll.
    await page.waitForFunction(
      ({ subject }) =>
        window.store.getResourceLoading(subject).title === 'Edited Offline',
      { subject: resourceSubject! },
      { timeout: 30000 },
    );

    // 5. Verify the offline edit survived the reload (the title appears in
    // the breadcrumb, sidebar tree, and main editable title — match the
    // main one to avoid strict-mode multi-match).
    await expect(
      page.getByTestId('editable-title').getByText('Edited Offline'),
    ).toBeVisible({ timeout: 15000 });
  });

  // FLAKY, two independent known causes:
  //
  // 1. (dagger CI + remote CI) on the second-context (page2) view of
  //    the document, the `Synced From Offline` H1 doesn't render within
  //    30 s. Path is page1 edits offline → reconnect → page1
  //    `waitForSearchable` → page2 navigates to the resource subject.
  //    Already does a `waitForFunction` against `store.resources.get(...)`,
  //    but under dagger CPU contention the Loro WASM init + WS
  //    authenticate + GET round-trip exceeds the budget. Investigate:
  //    pre-warm Loro on page2 before navigation, or split the deadline so
  //    the WS GET budget is independent of the H1 render budget.
  //
  // 2. (local, 2026-07-02) the EARLIER `serverConnected === false` wait
  //    (below, step 2) also times out intermittently — NOT a CI/dagger
  //    thing, reproduces locally with no other processes competing for
  //    CPU. Root-caused, not just relabeled "environmental": see the
  //    comment at that `waitForFunction` call for the actual race. Not
  //    fixed yet — tracked in planning/sync.md's Test coverage gaps.
  test('offline edits sync to server when connection is restored', async ({
    page,
    context,
    browser,
  }) => {
    test.slow();

    // TEMPORARY [sync266] diagnostics. The two green gates this test passes
    // before its red one both have blind spots: `waitForSynced` proves the
    // dirty bit cleared (which the empty-export drain path can do without
    // POSTing anything), and `waitForSearchable` merges page1's own LOCAL
    // index (which indexed the offline title without server involvement).
    // So collect the drain's own step-by-step log, and later ask the server
    // directly — those two answer whether the edit ever left this machine.
    const syncLog: string[] = [];
    const collect = (p: import('@playwright/test').Page, tag: string) =>
      p.on('console', message => {
        const text = message.text();

        if (/\[sync266\]|\[Outbox\]|COMMIT|\[ClientDb\].*fail/i.test(text)) {
          syncLog.push(`${tag} ${message.type()}: ${text.slice(0, 240)}`);
        }
      });
    collect(page, 'p1');

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

    // Wait for the store to detect the disconnect.
    //
    // FLAKY (2026-07-02, root-caused): this times out intermittently even
    // with zero other processes competing for CPU (ruled out: leftover
    // dev-server processes, parallel-worker contention — both were tried
    // and disproven; earlier attribution to "environmental" flakiness was
    // wrong). Trace evidence: on a failing run, a commit still in flight
    // from step 1 hits its own 10s internal timeout ("COMMIT timed out
    // after 10000ms... using HTTP") only AFTER `setOffline(true)` + the
    // manual `close()` above have already run — meaning the WS `close`
    // event (the only thing that calls `setServerConnected(false)`, see
    // `websockets.ts`) didn't fire promptly. Suspected cause: a race
    // between Playwright's CDP-level `setOffline(true)` network block and
    // the manual `ws.close()` call — Chromium may suppress or delay the
    // `close` event once the transport is already CDP-blocked. Not fixed
    // here — tracked in planning/sync.md's Test coverage gaps. Likely fix: don't rely
    // on the `close` event for local closes; have `WsClient.close()` call
    // `setServerConnected(false)` (and `rejectAllPending`) synchronously
    // itself, since the caller already knows it initiated the close.
    await page.waitForFunction(
      () => window.store?.getSyncStatus().serverConnected === false,
      undefined,
      { timeout: 15000 },
    );

    // 3. Edit title offline
    await editableTitle(page).click();
    await expect(editableTitle(page)).toHaveRole('textbox');
    await editableTitle(page).fill('Synced From Offline');
    await page.keyboard.press('Escape');

    // Wait for dirty count to increase AND for OPFS to hold the offline
    // title — otherwise a reload-before-flush races the reconnect drain
    // into an empty export that used to clear the dirty bit (see
    // `drainOutboxSubject` offline baseVersion recovery).
    await page.waitForFunction(
      () => window.store?.getSyncStatus().pendingDirtyCount > 0,
      undefined,
      { timeout: 10000 },
    );
    await page.waitForFunction(
      async ({ subject }) => {
        const clientDb = window.store.getClientDb();
        if (!clientDb?.isReady) return false;
        const jsonAd = await clientDb.getResource?.(subject);
        if (!jsonAd) return false;

        try {
          const parsed = JSON.parse(jsonAd) as Record<string, unknown>;

          return (
            parsed['https://atomicdata.dev/properties/name'] ===
            'Synced From Offline'
          );
        } catch {
          return false;
        }
      },
      { subject: resourceSubject! },
      { timeout: 15000 },
    );

    // The offline edit is in the ClientDb, but "written" is not "durable":
    // per-write commits use `Durability::None` and only survive a reload once
    // an Immediate commit lands, which the worker otherwise schedules on a 1s
    // tick. The reload below would roll the edit back, and the server would
    // never hear about it — which is exactly this test's failure mode, right
    // down to the fresh context reading the pre-offline title.
    await page.evaluate(async () => {
      const db = window.store.getClientDb();

      // Not optional-chained: `?.flush()` on an absent ClientDb is a silent
      // no-op, and this test would then fail exactly as it does without the
      // flush at all — blaming durability for a database that was never there.
      if (!db) throw new Error('ClientDb missing when asking for a flush');

      await db.flush();
    });

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

    // TEMPORARY [sync266]: the server's own copy, over HTTP, bypassing every
    // local cache. This is the fork in the diagnosis: old title here means
    // the reconnect drain never actually delivered the edit (and the two
    // waits above lied); new title means the failure is on the second
    // context's side.
    const serverTitle = await page.evaluate(
      async ({ subject }) => {
        const fresh = await window.store.fetchResourceFromServer(subject, {
          setLoading: true,
          noWebSocket: true,
        });

        return fresh?.title;
      },
      { subject: resourceSubject! },
    );
    syncLog.push(`SERVER TITLE after drain+search: "${serverTitle}"`);

    // 5. Open a fresh browser context (simulates another device)
    const context2 = await browser.newContext();
    const page2 = await context2.newPage();
    await page2.goto(`${FRONTEND_URL}/app/agent`);

    // Sign in with the same agent
    await page2.getByRole('button', { name: 'Sign in', exact: true }).click();
    // No confirm button: the flow signs in as soon as the secret parses.
    const secretField = page2.getByLabel('Agent secret');
    await secretField.fill(secret);
    // No blur: the field disables itself the moment the secret parses (it
    // shows "Signing in…"), and `blur()` on a disabled input waits for an
    // actionability that never comes. `waitForConnected` below is the real
    // signal that the sign-in took, so wait for that instead.

    // Wait for the second page to connect
    await waitForConnected(page2);

    // Navigate to the resource — the legacy `adress-bar` input is gone;
    // route directly via the SPA's /app/show entry.
    await page2.goto(
      `${FRONTEND_URL}/app/show?subject=${encodeURIComponent(resourceSubject!)}`,
    );

    collect(page2, 'p2');

    // Fresh context (no local cache) — title must come from the server,
    // proving the reconnect drain actually POSTed the offline delta.
    // (Previously an empty-export path cleared the outbox dirty bit
    // without POSTing; `waitForSearchable` hid that via the local index.)
    try {
      await expect
        .poll(async () => page2.title(), { timeout: 60000, intervals: [500] })
        .toBe('Synced From Offline');
    } catch (e) {
      // TEMPORARY [sync266]: page2's view of the resource at failure time,
      // plus everything the drain said. Read-only — gathered before anything
      // mutates either store.
      // The pre-page2 server check above can race drains that are still
      // running (it did in the first traced run) — re-ask at failure time,
      // when everything has long settled.
      const serverTitleAtFailure = await page
        .evaluate(
          async ({ subject }) => {
            const fresh = await window.store.fetchResourceFromServer(subject, {
              setLoading: true,
              noWebSocket: true,
            });

            return fresh?.title;
          },
          { subject: resourceSubject! },
        )
        .catch(() => 'p1 refetch failed');
      syncLog.push(`SERVER TITLE at failure: "${serverTitleAtFailure}"`);
      const p2state = await page2
        .evaluate(
          ({ subject }) => {
            const r = (
              window.store as unknown as {
                resources: Map<
                  string,
                  {
                    title?: string;
                    loading?: boolean;
                    error?: { message?: string };
                    get?: (p: string) => unknown;
                  }
                >;
              }
            ).resources.get(subject);

            return {
              title: r?.title,
              loading: r?.loading,
              error: r?.error?.message,
              lastCommit: String(
                r?.get?.('https://atomicdata.dev/properties/lastCommit') ?? '',
              ).slice(-8),
              serverConnected: window.store.getSyncStatus?.()?.serverConnected,
            };
          },
          { subject: resourceSubject! },
        )
        .catch(() => 'p2 evaluate failed');
      throw new Error(
        `${e}\n\npage2 resource state: ${JSON.stringify(p2state)}\n` +
          `sync log (${syncLog.length} lines, last 60):\n${syncLog
            .slice(-60)
            .join('\n')}`,
      );
    }

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
    await expect(page.getByText('Developer', { exact: true })).toBeVisible({
      timeout: 10000,
    });
  });
});
