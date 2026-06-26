import { test, expect } from '@playwright/test';
import { before } from './test-utils';

test.describe('draintime diag', () => {
  test.beforeEach(before);

  test('measure table burst drain time', async ({ page }) => {
    test.slow();
    let count401 = 0;
    page.on('console', m => {
      if (/No .*write right|Unauthorized/.test(m.text())) count401++;
    });
    await page.getByTitle('New Table').first().click();
    await page.getByPlaceholder('New Table').fill('Drain Timing');
    await page.locator('dialog[open] button:has-text("Create")').click();
    await page.waitForURL(url => url.pathname.startsWith('/app/show'), {
      timeout: 15000,
    });
    await expect(page.getByTestId('editable-title').first()).toBeVisible({
      timeout: 15000,
    });
    await page.keyboard.press('Escape');
    const firstCell = page.getByRole('gridcell').first();
    await expect(firstCell).toBeVisible({ timeout: 15000 });
    await firstCell.click({ force: true });
    await page.waitForTimeout(300);

    const values = Array.from({ length: 40 }, (_, i) => `row${i + 1}`);
    for (const value of values) {
      await page.keyboard.press('Enter');
      await page.waitForTimeout(100);
      await page.keyboard.type(value, { delay: 30 });
      await page.waitForTimeout(100);
    }
    await page.keyboard.press('Escape');

    const result = await page.evaluate(async () => {
      const store = (window as any).store;
      const t0 = Date.now();
      const samples: Array<{ t: number; pending: number; blocked: number }> = [];
      let lastPending = -1;
      while (Date.now() - t0 < 40000) {
        const s = store.getSyncStatus();
        if (s.pendingDirtyCount !== lastPending) {
          samples.push({
            t: Date.now() - t0,
            pending: s.pendingDirtyCount,
            blocked: s.blockedCount,
          });
          lastPending = s.pendingDirtyCount;
        }
        if (s.pendingDirtyCount === 0) break;
        await new Promise(r => setTimeout(r, 50));
      }
      return { elapsed: Date.now() - t0, samples };
    });

    console.log('DRAINTIME elapsed(ms) =', result.elapsed);
    console.log('DRAINTIME 401count =', count401);
    console.log('DRAINTIME trajectory =', JSON.stringify(result.samples));
  });
});
