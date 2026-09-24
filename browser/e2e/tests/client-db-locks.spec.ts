/**
 * ClientDb Web Locks leadership — the basics.
 *
 * The ClientDb (WASM, single-writer) uses `navigator.locks` to elect ONE leader
 * tab per origin; other tabs are followers that proxy DB calls to the leader
 * over a BroadcastChannel. This verifies the election works and that a second
 * tab coexists without hard-failing. It also holds a forwarded call while the
 * leader tab closes and checks takeover in both Chromium and Firefox.
 */
import { test, expect, type Page } from './fixtures';
import { before, FRONTEND_URL } from './test-utils';

/** Poll until the tab's ClientDb is ready and reported no init error. */
async function expectClientDbReady(page: Page): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const s = window.store?.getSyncStatus();

          return {
            ready: s?.clientDbReady ?? false,
            error: s?.clientDbError ?? null,
          };
        }),
      { timeout: 15000 },
    )
    .toEqual({ ready: true, error: null });
}

test.describe('ClientDb Web Locks leadership', () => {
  test.beforeEach(before);

  test('a second tab coexists under the shared origin lock', async ({
    page,
    context,
  }) => {
    // `before()` left `page` as the elected leader for this origin.
    await expectClientDbReady(page);

    // A second tab shares the origin's Web Locks namespace. It must become a
    // follower (not hard-fail election) and stay usable — on Firefox too.
    const page2 = await context.newPage();
    await page2.goto(FRONTEND_URL);
    await expectClientDbReady(page2);
  });

  test('a pending follower call completes after the leader tab closes', async ({
    page,
    context,
  }) => {
    await expectClientDbReady(page);
    const page2 = await context.newPage();
    await page2.goto(FRONTEND_URL);
    await expectClientDbReady(page2);

    await page.evaluate(() => {
      const db = window.store!.getClientDb()! as unknown as {
        sendToWorker: (msg: { type: string }) => Promise<unknown>;
      };
      const original = db.sendToWorker.bind(db);

      db.sendToWorker = msg => {
        if (msg.type === 'flush') {
          (window as typeof window & { __dbBlocked?: boolean }).__dbBlocked =
            true;

          return new Promise(() => {});
        }

        return original(msg);
      };
    });
    await page2.evaluate(() => {
      const state = window as typeof window & { __dbHandoff?: string };
      state.__dbHandoff = 'pending';
      void window
        .store!.getClientDb()!
        .flush()
        .then(
          () => {
            state.__dbHandoff = 'resolved';
          },
          error => {
            state.__dbHandoff = `failed: ${error}`;
          },
        );
    });
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as typeof window & { __dbBlocked?: boolean }).__dbBlocked,
        ),
      )
      .toBe(true);

    await page.close();
    await page2.waitForFunction(
      () =>
        (window as typeof window & { __dbHandoff?: string }).__dbHandoff !==
        'pending',
      undefined,
      { timeout: 10_000 },
    );
    expect(
      await page2.evaluate(
        () => (window as typeof window & { __dbHandoff?: string }).__dbHandoff,
      ),
    ).toBe('resolved');
  });
});
