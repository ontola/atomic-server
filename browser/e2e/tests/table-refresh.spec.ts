import { test, expect } from '@playwright/test';
import { before, editableTitle, FRONTEND_URL, newResource } from './test-utils';

/**
 * Regression: refreshing a Table's page must not grow the child-row count.
 *
 * User-reported bug: each page reload added another empty row to the Table.
 * Root cause suspected in `TableNewRow`'s useEffect which calls
 * `store.newResource({parent, isA})` on every mount — if that placeholder is
 * persisted (to OPFS or committed), the child query picks it up and the
 * phantom row accumulates.
 */
test.describe('table refresh', () => {
  // 8-reload tests are I/O-heavy enough that running them concurrently with
  // other suites overloads the single shared atomic-server (drive-creation
  // races, search-index lag, etc.). Serializing this file's tests against
  // itself keeps that load predictable; the rest of the suite still runs
  // in parallel via the global `fullyParallel`.
  test.describe.configure({ mode: 'serial' });
  test.beforeEach(before);

  test('reloading a table does not add empty rows', async ({ page }) => {
    test.slow();

    // Create a Table via the dialog.
    await newResource('table', page);
    const nameInput = page.getByPlaceholder('New Table');
    await expect(nameInput).toBeVisible();
    await nameInput.fill('RefreshRegression');
    await page.locator('dialog[open] button:has-text("Create")').click();

    // Wait for the table to render.
    await expect(editableTitle(page)).toBeVisible({ timeout: 15000 });

    // Wait for the new-row placeholder to render (otherwise the count race
    // produces 1, 2 or 3 depending on render order). The bug being tested is
    // monotonic GROWTH — so we settle on the post-render baseline first.
    const rows = page.locator('[aria-rowindex]');
    await expect(rows).toHaveCount(2, { timeout: 15000 });
    const initialCount = await rows.count();

    // Reload many times and assert the count doesn't grow beyond baseline.
    for (let i = 0; i < 10; i++) {
      await page.reload({ waitUntil: 'domcontentloaded' });

      // Suite-wide load can flake the server's WS GET (it returns
      // intermittently as "Resource not found" or times out). Click Retry
      // up to 3× to recover before bailing — the regression we're testing
      // is monotonic ROW GROWTH, not transient fetch failures.
      for (let retry = 0; retry < 3; retry++) {
        const titleVisible = await editableTitle(page)
          .isVisible({ timeout: 15000 })
          .catch(() => false);
        if (titleVisible) break;
        const retryBtn = page.getByRole('button', { name: 'Retry' });
        if (await retryBtn.isVisible({ timeout: 500 }).catch(() => false)) {
          await retryBtn.click();
        } else {
          break;
        }
      }
      await expect(editableTitle(page)).toBeVisible({ timeout: 15000 });
      // The regression is monotonic ROW GROWTH; under-render mid-mount is a
      // separate concern. Wait for the count to land at-or-below the
      // baseline (it can briefly read 0 or 1 before the new-row placeholder
      // mounts), then assert no growth.
      await expect
        .poll(() => rows.count(), { timeout: 15000 })
        .toBeLessThanOrEqual(initialCount);
      const nowCount = await rows.count();
      console.log(`reload #${i + 1}: row count = ${nowCount}`);
      expect(
        nowCount,
        `reload #${i + 1} should not exceed ${initialCount} rows, got ${nowCount}`,
      ).toBeLessThanOrEqual(initialCount);
    }
  });

  test('reloading after typing into a cell does not grow rows', async ({
    page,
  }) => {
    test.slow();

    // Confirm the WASM ClientDb actually initialized in this browser — the
    // user's bug is WASM-side, so a silent fallback would mask the issue.
    await page.goto(`${FRONTEND_URL}/`, {
      waitUntil: 'domcontentloaded',
    });
    const clientDbState = await page.evaluate(
      () =>
        new Promise<string>(resolve => {
          const start = Date.now();
          const tick = () => {
            const store = (window as any).store;
            const db = store?.getClientDb?.();
            if (db?.isReady) {
              resolve('ready');
              return;
            }
            if (db?.initError) {
              resolve('error:' + db.initError.message);
              return;
            }
            if (Date.now() - start > 20000) {
              resolve(
                `timeout: db=${!!db} isReady=${db?.isReady}`,
              );
              return;
            }
            setTimeout(tick, 200);
          };
          tick();
        }),
    );
    console.log(`ClientDb state: ${clientDbState}`);
    expect(clientDbState, 'WASM ClientDb must be ready for this test to be meaningful').toBe('ready');

    await newResource('table', page);
    const nameInput = page.getByPlaceholder('New Table');
    await expect(nameInput).toBeVisible();
    await nameInput.fill('TypedRefresh');
    await page.locator('dialog[open] button:has-text("Create")').click();
    await expect(editableTitle(page)).toBeVisible({ timeout: 15000 });

    // Type a value into row 2, column 2 (the first name cell). The cell
    // visibility expectation below already polls for the row to mount —
    // no separate sleep needed.
    const nameCell = page.locator('[aria-rowindex="2"] [aria-colindex="2"]');
    await expect(nameCell).toBeVisible({ timeout: 10000 });
    await nameCell.click();
    await page.waitForTimeout(300);
    await nameCell.click();
    await page.waitForTimeout(300);
    const cellInput = page.locator('[role="grid"] input').first();
    await expect(cellInput).toBeVisible({ timeout: 5000 });
    await cellInput.fill('row-1');
    await page.keyboard.press('Tab');
    // Wait for the cell save to drain into the server. The dirty queue is
    // 0 once the commit has been ack'd — that's the actual saved-and-
    // visible-on-reload signal we want the row count to reflect.
    await page.waitForFunction(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      () => (window as any).store?.getSyncStatus?.().pendingDirtyCount === 0,
      undefined,
      { timeout: 10000 },
    );

    const rows = page.locator('[aria-rowindex]');
    const afterTypeCount = await rows.count();
    console.log(`after typing: row count = ${afterTypeCount}`);

    const counts: number[] = [afterTypeCount];
    for (let i = 0; i < 8; i++) {
      await page.reload({ waitUntil: 'domcontentloaded' });
      await expect(editableTitle(page)).toBeVisible({ timeout: 15000 });
      await page.waitForTimeout(1500);

      const nowCount = await rows.count();

      // Dump subjects of resources whose parent is the CURRENT table.
      const currentTableSubject = await page.evaluate(() => {
        const path = window.location.pathname + window.location.search;
        const m = /subject=([^&]+)/.exec(window.location.search);
        return m ? decodeURIComponent(m[1]) : path;
      });
      const dump = await page.evaluate(async (parentSubject) => {
        const store = (window as any).store;
        const clientDb = store?.getClientDb?.();
        if (!clientDb) return { count: 0, subjects: [] };
        const r = await clientDb.query({
          property: 'https://atomicdata.dev/properties/parent',
          value: parentSubject,
        });
        return { count: r?.count ?? 0, subjects: r?.subjects ?? [] };
      }, currentTableSubject);
      const domRows = await page.locator('[aria-rowindex]').count();
      console.log(
        `reload #${i + 1}: rowCount=${nowCount} domRows=${domRows} ` +
          `wasm-children-of-table=${dump.count} subjects=${dump.subjects
            .map((s: string) => s.slice(0, 50))
            .join(' | ')}`,
      );
      counts.push(nowCount);
    }
    console.log('all counts across reloads:', counts);

    // The count may legitimately settle 1 higher than `afterTypeCount` on
    // reload #1 (the new-row placeholder may render later than our
    // measurement). But it should STABILISE — no monotonic growth.
    const firstReloadCount = counts[1];
    for (let i = 2; i < counts.length; i++) {
      expect(
        counts[i],
        `reload #${i} count (${counts[i]}) should match first reload count (${firstReloadCount}) — series: ${counts.join(', ')}`,
      ).toBe(firstReloadCount);
    }
  });

  test('with ClientDb DISABLED: reloading does not grow rows', async ({
    page,
  }) => {
    test.slow();

    // Turn off the WASM ClientDb so every read goes to the server —
    // reproduces the user's "disable local DB" scenario.
    await page.addInitScript(() => {
      localStorage.setItem('atomic-disable-client-db', '1');
    });

    await newResource('table', page);
    const nameInput = page.getByPlaceholder('New Table');
    await expect(nameInput).toBeVisible();
    await nameInput.fill('NoClientDbRefresh');
    await page.locator('dialog[open] button:has-text("Create")').click();
    await expect(editableTitle(page)).toBeVisible({ timeout: 15000 });

    // Wait for the table to settle on its post-render baseline (header +
    // placeholder = 2). With ClientDb disabled the collection's first
    // `/query` GET takes longer than a fixed timeout, so a hard
    // `waitForTimeout(1500)` flakes between 1 (just header) and 2 (header +
    // placeholder rendered).
    const rows = page.locator('[aria-rowindex]');
    await expect(rows).toHaveCount(2, { timeout: 15000 });
    const initialCount = await rows.count();
    console.log(`initial (no ClientDb): row count = ${initialCount}`);

    // Each reload: wait for the row count to settle at the baseline before
    // sampling. The bug being regression-tested is monotonic GROWTH —
    // exact-equality on a hard timeout would catch transient under-render
    // (count=1 mid-mount), which isn't the bug and just reproduces flakes.
    // 4 reloads is enough to surface a leak-on-mount; with ClientDb disabled
    // every reload re-fetches via WS, so doing more just multiplies suite
    // contention without strengthening the assertion.
    for (let i = 0; i < 4; i++) {
      await page.reload({ waitUntil: 'domcontentloaded' });

      // Under suite-wide load the WS GET (5s lib-side timeout) sometimes
      // races and the page lands on the error view. Click Retry up to a
      // few times to recover before bailing.
      for (let retry = 0; retry < 3; retry++) {
        const titleVisible = await editableTitle(page)
          .isVisible({ timeout: 15000 })
          .catch(() => false);
        if (titleVisible) break;
        const retryBtn = page.getByRole('button', { name: 'Retry' });
        if (await retryBtn.isVisible({ timeout: 500 }).catch(() => false)) {
          await retryBtn.click();
        } else {
          break;
        }
      }
      await expect(editableTitle(page)).toBeVisible({ timeout: 15000 });
      await expect(rows).toHaveCount(initialCount, { timeout: 15000 });

      const nowCount = await rows.count();
      console.log(`reload #${i + 1} (no ClientDb): row count = ${nowCount}`);
      expect(
        nowCount,
        `reload #${i + 1} (no ClientDb) should still have ${initialCount} rows, got ${nowCount}`,
      ).toBe(initialCount);
    }
  });
});
