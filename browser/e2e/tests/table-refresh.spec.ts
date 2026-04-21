import { test, expect } from '@playwright/test';
import { before, editableTitle, newResource } from './test-utils';

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
    await page.waitForTimeout(1000);

    // Initial row count — with the new-row affordance always present, we
    // expect exactly 2 rows: the header + 1 empty "new row" placeholder.
    const rows = page.locator('[aria-rowindex]');
    const initialCount = await rows.count();
    expect(initialCount).toBeGreaterThanOrEqual(2);
    expect(initialCount).toBeLessThanOrEqual(3);

    // Reload many times and assert the count never grows.
    for (let i = 0; i < 10; i++) {
      await page.reload({ waitUntil: 'domcontentloaded' });
      await expect(editableTitle(page)).toBeVisible({ timeout: 15000 });
      await page.waitForTimeout(1500);

      const nowCount = await rows.count();
      console.log(`reload #${i + 1}: row count = ${nowCount}`);
      expect(
        nowCount,
        `reload #${i + 1} should still have ${initialCount} rows, got ${nowCount}`,
      ).toBe(initialCount);
    }
  });

  test('reloading after typing into a cell does not grow rows', async ({
    page,
  }) => {
    test.slow();

    // Confirm the WASM ClientDb actually initialized in this browser — the
    // user's bug is WASM-side, so a silent fallback would mask the issue.
    await page.goto(`http://localhost:5173/`, {
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
    await page.waitForTimeout(1000);

    // Type a value into row 2, column 2 (the first name cell).
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
    await page.waitForTimeout(2000);

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
    await page.waitForTimeout(1500);

    const rows = page.locator('[aria-rowindex]');
    const initialCount = await rows.count();
    console.log(`initial (no ClientDb): row count = ${initialCount}`);

    const counts: number[] = [initialCount];
    for (let i = 0; i < 8; i++) {
      await page.reload({ waitUntil: 'domcontentloaded' });
      await expect(editableTitle(page)).toBeVisible({ timeout: 15000 });
      await page.waitForTimeout(1500);

      const nowCount = await rows.count();
      console.log(`reload #${i + 1} (no ClientDb): row count = ${nowCount}`);
      counts.push(nowCount);
    }
    console.log('no-ClientDb counts:', counts);

    // Must not grow on each reload.
    const stableCount = counts[1] ?? counts[0];
    for (let i = 2; i < counts.length; i++) {
      expect(
        counts[i],
        `reload #${i} count (${counts[i]}) drifted from ${stableCount} — series: ${counts.join(', ')}`,
      ).toBe(stableCount);
    }
  });
});
