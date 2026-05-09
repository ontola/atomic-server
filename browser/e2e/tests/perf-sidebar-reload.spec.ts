/**
 * Probe for the dagger flake pattern "sidebar text/link not visible
 * within 15s after reload".
 *
 * Repro shape (matches `sync.spec.ts:64` and `e2e.spec.ts:441`):
 *   1. Create a resource online (gets a server-acked commit + OPFS persist).
 *   2. Reload the page.
 *   3. Assert the sidebar shows the new resource within 15s.
 *
 * Instead of just asserting, this spec dumps the perf trace so we can
 * see what `@tomic/lib` did between reload and the sidebar query: how
 * long auth took, how long VV-sync took, whether dirty resources
 * dragged the timeline. Run with:
 *   ATOMIC_TEST_CPU_THROTTLE=8 pnpm test-e2e perf-sidebar-reload.spec.ts
 *
 * The captured snapshot lands in the test's `outputDir` as
 * `perf-sidebar-after-reload.json` and a compact rollup is printed to
 * stdout for skimming.
 */

import { test, expect } from '@playwright/test';
import { before, editableTitle } from './test-utils';
import { attachPerfSnapshot, resetPerfTrace } from './perf-attach';

test.describe('perf: sidebar after reload', () => {
  test.beforeEach(before);

  test('create + reload: sidebar item visibility timing', async ({
    page,
  }, testInfo) => {
    // 1. Create the document so we know it's persisted server-side AND
    // in OPFS before we reload.
    await page
      .getByTestId('sidebar')
      .getByRole('button', { name: 'New Document' })
      .click();
    await expect(editableTitle(page)).toBeVisible({ timeout: 10000 });
    await editableTitle(page).click();
    await expect(editableTitle(page)).toHaveRole('textbox');
    await editableTitle(page).fill('Perf Probe Doc');
    await page.keyboard.press('Escape');

    // Sidebar shows the doc (this is normally fast — the drive's
    // children list updated locally).
    await expect(
      page.getByTestId('sidebar').getByText('Perf Probe Doc'),
    ).toBeVisible({ timeout: 10000 });

    // Wait for the commit to actually reach the server. Reloading
    // before this means the next session has nothing to sync.
    await page.waitForFunction(
      () =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (window as any).store?.getSyncStatus?.()?.pendingDirtyCount === 0,
      undefined,
      { timeout: 10000 },
    );

    // 2. Reset the perf trace right before reload — we only want the
    // reload→sidebar window in the snapshot.
    await resetPerfTrace(page);

    const reloadStart = Date.now();
    await page.reload({ waitUntil: 'domcontentloaded' });

    // Two distinct waits so we can attribute time:
    //   - serverConnected: WS handshake + auth roundtrip done
    //   - sidebar item visible: drive resource + child collection populated
    await page.waitForFunction(
      () =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (window as any).store?.getSyncStatus?.()?.serverConnected === true,
      undefined,
      { timeout: 15000 },
    );
    const wsConnectedMs = Date.now() - reloadStart;

    await expect(
      page.getByTestId('sidebar').getByText('Perf Probe Doc'),
    ).toBeVisible({ timeout: 15000 });
    const sidebarVisibleMs = Date.now() - reloadStart;

    // eslint-disable-next-line no-console
    console.log(
      `[perf] reload→serverConnected = ${wsConnectedMs}ms,` +
        ` reload→sidebar = ${sidebarVisibleMs}ms`,
    );

    await attachPerfSnapshot(page, testInfo, 'perf-sidebar-after-reload');

    // Smoke assertion so the test passes; the real value is in the
    // captured trace.
    expect(sidebarVisibleMs).toBeLessThan(15000);
  });
});
