import { test, expect } from '@playwright/test';
import { before } from './test-utils';

/**
 * Regression for ClientDb OPFS durability. Per-write redb commits use
 * `Durability::None`; only a later `flush()` (Immediate commit) persists them.
 * The native server flushes on a periodic tick, but the browser worker never
 * did — so every local write was rolled back on the next reload. That was
 * invisible online (the server re-fetches and re-caches) but fatal offline:
 * after a disconnect + reload the drive read "Offline: resource not available
 * locally". The worker now flushes on a 1s tick after writes.
 */
test('cached drive survives reload while offline', async ({ page }) => {
  await before({ page }); // devDrive — creates + visits a drive online
  // Give the worker's 1s flush tick time to persist the drive to OPFS.
  await page.waitForTimeout(2000);
  const drive = await page.evaluate(() => window.store.getDrive());

  // Go offline (what the Sync-page "disconnect" does) and reload.
  await page.evaluate(() => localStorage.setItem('ws-disconnected', '1'));
  await page.reload();
  await page.waitForTimeout(2500);

  const r = await page.evaluate(async d => {
    const s = window.store;
    let viaGet = -1; // -1 ⇒ threw "Offline: resource not available locally"

    try {
      const g = await s.getResource(d);
      viaGet = g?.getEntries ? g.getEntries().length : 0;
    } catch {
      viaGet = -1;
    }

    return {
      serverConnected: s.getSyncStatus?.()?.serverConnected,
      viaGetProps: viaGet,
    };
  }, drive ?? '');

  // We must actually be offline (proves we're testing the local cache, not a
  // server re-fetch), and the drive must still resolve from the ClientDb.
  expect(r.serverConnected).toBe(false);
  expect(r.viaGetProps).toBeGreaterThan(0);
});
