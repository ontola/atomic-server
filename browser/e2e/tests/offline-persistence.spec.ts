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
  // Record who writes an EMPTY resource into the store's map.
  //
  // This test's remaining failure is a drive that is present in OPFS while
  // the store holds a resource with zero properties and no error — deleting
  // that cached entry makes the very next read return all ten. So something
  // writes the empty entry, and knowing what does is the whole question. The
  // hook goes on `window.store`'s assignment so it is installed before the
  // app can populate anything, and it survives the reload because
  // `addInitScript` runs on every navigation.
  await page.addInitScript(() => {
    const writes: { subject: string; stack: string }[] = [];
    (window as unknown as Record<string, unknown>).__emptyWrites = writes;

    let current: unknown;
    Object.defineProperty(window, 'store', {
      configurable: true,
      get: () => current,
      set: value => {
        current = value;
        const store = value as {
          resources?: Map<string, { getEntries?(): unknown[] }>;
          __emptyWatch?: boolean;
        };

        if (!store?.resources?.set || store.__emptyWatch) return;

        store.__emptyWatch = true;
        const original = store.resources.set.bind(store.resources);

        store.resources.set = (key, resource) => {
          try {
            if ((resource?.getEntries?.()?.length ?? -1) === 0) {
              writes.push({
                subject: String(key),
                stack: String(new Error().stack).slice(0, 700),
              });
            }
          } catch {
            // Never let instrumentation break the thing it observes.
          }

          return original(key, resource);
        };
      },
    });
  });

  await before({ page }); // devDrive — creates + visits a drive online

  // Wait for ClientDb + the drive's OPFS write — a bare timeout races
  // WASM init under dagger (clientdb.init alone can exceed 2s). Mirror
  // `offline-reload.spec.ts`.
  // `window.store` is assigned during boot, so this has to tolerate it being
  // absent rather than throw: under a slow boot the unguarded form fails with
  // "Cannot read properties of undefined", which reports a TypeError instead
  // of whatever actually went wrong. Reproduced locally at
  // ATOMIC_TEST_CPU_THROTTLE=8.
  await page.waitForFunction(
    () => window.store?.getClientDb()?.isReady === true,
    undefined,
    { timeout: 30000 },
  );
  await page.waitForFunction(
    async () => {
      const drive = window.store?.getDrive();
      if (!drive) return false;
      const jsonAd = await window.store?.getClientDb()?.getResource?.(drive);

      return !!jsonAd;
    },
    undefined,
    { timeout: 15000 },
  );

  // The write landing is not the same as the write being durable: per-write
  // commits use `Durability::None` and are only persisted by a later Immediate
  // commit, which the worker otherwise schedules on a 1s tick. A reload before
  // that tick rolls the write back — which is the exact bug under test, so ask
  // for the flush and wait for it rather than racing the timer.
  await page.evaluate(async () => {
    const db = window.store.getClientDb();

    // Not optional-chained: `?.flush()` on an absent ClientDb is a silent
    // no-op, and the test would go on to reload and fail with the same
    // props=0 it was written to catch — blaming durability for a database
    // that was never there.
    if (!db) throw new Error('ClientDb missing when asking for a flush');

    await db.flush();
  });

  const drive = await page.evaluate(() => window.store.getDrive());

  // Go offline (what the Sync-page "disconnect" does) and reload.
  await page.evaluate(() => localStorage.setItem('ws-disconnected', '1'));
  await page.reload();

  await page.waitForFunction(
    () => window.store?.getClientDb()?.isReady === true,
    undefined,
    { timeout: 30000 },
  );

  const r = await page.evaluate(async d => {
    const s = window.store;
    let viaGet = -1; // -1 ⇒ threw "Offline: resource not available locally"

    try {
      const g = await s.getResource(d);
      viaGet = g?.getEntries ? g.getEntries().length : 0;
    } catch {
      viaGet = -1;
    }

    // Ask the ClientDb directly as well as through the store. These answer
    // different questions and the failure has been ambiguous between them:
    // whether the drive was persisted to OPFS at all, or whether it was
    // persisted and the store declines to read it while offline.
    let inClientDb = false;
    let storedProps = -1;
    let storedHasClass = false;

    try {
      const jsonAd = await s.getClientDb()?.getResource?.(d);
      inClientDb = !!jsonAd;

      if (jsonAd) {
        // What the store's "renderable" guard looks at when deciding whether
        // an OPFS hit counts: a resource with no class and nothing beyond the
        // server-managed skeleton is discarded as a miss, which offline means
        // failing rather than falling back.
        const parsed = JSON.parse(jsonAd) as Record<string, unknown>;
        storedProps = Object.keys(parsed).length;
        storedHasClass = 'https://atomicdata.dev/properties/isA' in parsed;
      }
    } catch {
      inClientDb = false;
    }

    // Ask again, from scratch, now that the ClientDb is definitely attached
    // and ready. If THIS succeeds while the first attempt failed, the drive
    // was readable all along and the failure is a resource failed during boot
    // — before the ClientDb was attached — that nothing ever retries.
    let viaRetry = -1;

    try {
      s.resources.delete(d);
      const again = await s.getResource(d);
      viaRetry = again?.getEntries ? again.getEntries().length : 0;
    } catch {
      viaRetry = -1;
    }

    const emptyWrites = (
      (window as unknown as Record<string, unknown>).__emptyWrites as
        | { subject: string; stack: string }[]
        | undefined
    )?.filter(w => w.subject === d);

    return {
      emptyWrites,
      viaRetry,
      serverConnected: s.getSyncStatus?.()?.serverConnected,
      viaGetProps: viaGet,
      inClientDb,
      storedProps,
      storedHasClass,
      error: s.resources.get(d)?.error?.message,
    };
  }, drive ?? '');

  // We must actually be offline (proves we're testing the local cache, not a
  // server re-fetch), and the drive must still resolve from the ClientDb.
  expect(r.serverConnected).toBe(false);
  expect(
    r.viaGetProps,
    `drive should load from OPFS offline; got props=${r.viaGetProps} ` +
      `inClientDb=${r.inClientDb} storedProps=${r.storedProps} ` +
      `storedHasClass=${r.storedHasClass} viaRetry=${r.viaRetry} ` +
      `error=${r.error}. ` +
      `Empty writes for this subject: ${JSON.stringify(r.emptyWrites)?.slice(0, 1500)}. ` +
      (r.viaRetry > 0
        ? 'A fresh request SUCCEEDS, so the drive was readable all along and ' +
          'the first attempt failed before the ClientDb was attached.'
        : 'A fresh request fails too, so the store genuinely cannot read it.') +
      ' ' +
      (r.inClientDb
        ? 'The drive IS in OPFS, so this is the store refusing to read it offline.'
        : 'The drive is NOT in OPFS, so the write did not survive the reload.'),
  ).toBeGreaterThan(0);
});
