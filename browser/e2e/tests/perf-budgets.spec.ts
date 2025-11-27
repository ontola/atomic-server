/**
 * Perf-budget probe: captures a `__atomicPerf` snapshot for several
 * representative flows and writes them as test attachments. Use to
 * compare local-vs-CI timings (and to find a CPU throttle rate that
 * matches dagger).
 *
 * Run flavors:
 *   - vanilla local:               `pnpm test-e2e perf-budgets.spec.ts`
 *   - throttled to dagger speed:   `ATOMIC_TEST_CPU_THROTTLE=4 pnpm test-e2e perf-budgets.spec.ts`
 *
 * The attached `perf-trace` JSON has both the raw events (timestamps +
 * durations relative to test start) and a sorted rollup. Skim the
 * rollup for any single span hitting double-digit ms — those are the
 * paths that turn into 10s+ flakes when CI runs them on a slower box.
 *
 * Probes:
 *   - cold-load: first paint after dev-drive bootstrap.
 *   - reconnect: disconnect → reconnect → drive sync.
 *   - genesis-creates: rapid-fire create of N folders to time the
 *     `pushCommits` round-trip distribution.
 */

import { test, expect } from '@playwright/test';
import { before, newResource } from './test-utils';
import { attachPerfSnapshot, resetPerfTrace } from './perf-attach';

test.describe('perf budgets', () => {
  test.beforeEach(before);

  test('cold load: dev-drive bootstrap + first paint', async ({
    page,
  }, testInfo) => {
    // `before` already navigated us; capture what happened.
    await page.waitForFunction(
      () => (window as any).store?.getSyncStatus?.()?.serverConnected === true,
      undefined,
      { timeout: 15000 },
    );
    await attachPerfSnapshot(page, testInfo, 'perf-cold-load');
  });

  test('reconnect: close WS + drive sync', async ({ page }, testInfo) => {
    await page.waitForFunction(
      () => (window as any).store?.getSyncStatus?.()?.serverConnected === true,
      undefined,
      { timeout: 15000 },
    );

    // Reset so the snapshot only contains the disconnect→reconnect window.
    await resetPerfTrace(page);

    // Use the store's `reconnect()` API directly — calling `close()` on
    // the underlying WS hits the `_closed=true` branch and the auto-
    // retry loop never re-fires, so the test would just hang waiting
    // for `serverConnected===true`.
    await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const store = (window as any).store;
      store?.reconnect();
    });
    await page.waitForFunction(
      () => (window as any).store?.getSyncStatus?.()?.serverConnected === true,
      undefined,
      { timeout: 15000 },
    );
    // Give VV sync a moment to land.
    await page.waitForTimeout(500);

    await attachPerfSnapshot(page, testInfo, 'perf-reconnect');
  });

  test('genesis-creates: 5 sequential new folders', async ({
    page,
  }, testInfo) => {
    await page.waitForFunction(
      () => (window as any).store?.getSyncStatus?.()?.serverConnected === true,
      undefined,
      { timeout: 15000 },
    );
    await resetPerfTrace(page);

    // Create N folders in a row via the same sidebar flow other specs
    // use, then wait for each commit to be acked before the next create.
    // Rapid-fire creates exercise the `postCommit` round-trip — and
    // they're a very close mirror of the failure shape we see in CI's
    // chatroom / tables / table-refresh tests.
    const N = 5;
    for (let i = 0; i < N; i++) {
      await newResource('folder', page);
      await page.waitForFunction(
        () =>
          (window as any).store?.getSyncStatus?.()?.pendingDirtyCount === 0,
        undefined,
        { timeout: 10000 },
      );
    }
    // Reference `expect` to avoid an unused-import warning when this
    // probe is later trimmed; actual assertion is implicit (must not
    // throw within timeouts).
    expect(N).toBe(5);

    await attachPerfSnapshot(page, testInfo, 'perf-genesis-creates');
  });
});
