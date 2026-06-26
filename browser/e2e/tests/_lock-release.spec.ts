import { test, expect } from '@playwright/test';
import { devDrive } from './test-utils';

// Verifies the fix: ClientDbWorker.destroy() releases the `atomic-db-leader`
// lock instead of leaking it (which previously left a ghost leader that
// Firefox/Safari couldn't reclaim — the "running without its local cache"
// state). Simulates the HMR dispose → recreate cycle.
test('destroy() releases the leader lock (no ghost)', async ({ page }) => {
  await devDrive(page);
  await page.waitForFunction(
    () => window.store?.getSyncStatus?.().clientDbAttached === true,
    undefined,
    { timeout: 20000 },
  );

  const result = await page.evaluate(async () => {
    const held = async () => {
      const q = await navigator.locks.query();
      return (q.held ?? []).some(l => l.name === 'atomic-db-leader');
    };
    const heldBefore = await held();

    // Tear down like HMR dispose does, then let the lock settle.
    window.store.getClientDb()?.destroy();
    await new Promise(r => setTimeout(r, 800));
    const heldAfter = await held();

    return { heldBefore, heldAfter };
  });

  // eslint-disable-next-line no-console
  console.log('LOCK', JSON.stringify(result));
  expect(result.heldBefore).toBe(true);
  expect(result.heldAfter).toBe(false);
});
