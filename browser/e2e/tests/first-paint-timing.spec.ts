import { test } from '@playwright/test';
import { SERVER_URL, devDrive, currentDriveTitle } from './test-utils';
import { applyCpuThrottle, envCpuThrottle } from './perf-attach';

/**
 * Measures the latency from `goto` to "the resource's title is visible".
 *
 * For the SSR meta-tag fast path to work, the test must hit atomic-server
 * directly (port 9883) — Vite's `index.html` (5173) doesn't carry the
 * `<meta property="json-ad-initial">` tag.
 *
 * Flow:
 *   1. `devDrive()` creates an agent + drive (writes secret to localStorage).
 *   2. Capture the drive subject URL from `window.location`.
 *   3. Reload that URL from atomic-server (so SSR emits the meta tag).
 *   4. Time until the drive title is in the DOM.
 *
 * The meta tag should flatten propvals into `_cache` synchronously during
 * `parseMetaTags()`, so the title appears WELL before Loro's WASM
 * download completes.
 */
test('first paint timing — meta-tag fast path', async ({ page }) => {
  const throttle = envCpuThrottle();
  if (throttle) await applyCpuThrottle(page, throttle);

  // Setup: create dev drive (agent + drive in localStorage).
  await devDrive(page);

  // Now grab the drive URL — devDrive ends on the drive page.
  const driveUrlInFrontend = page.url();
  // Swap the Vite host (5173) for atomic-server (9883) so SSR meta-tag
  // is emitted.
  const driveUrl = driveUrlInFrontend.replace(
    /^http:\/\/localhost:5173/,
    SERVER_URL,
  );

  // Cold-navigate to the drive directly on atomic-server.
  const t0 = Date.now();
  await page.goto(driveUrl);
  const gotoMs = Date.now() - t0;

  await currentDriveTitle(page).waitFor({ state: 'visible', timeout: 15000 });
  const titleVisibleMs = Date.now() - t0;

  const loroLoadedAt = await page.evaluate(async () => {
    const start = performance.now();
    while (performance.now() - start < 15000) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const loaded = (globalThis as any).LoroLoader?.isLoaded?.();
      if (loaded) return performance.now();
      await new Promise(r => setTimeout(r, 50));
    }
    return -1;
  });

  // eslint-disable-next-line no-console
  console.log(`[first-paint] throttle=${throttle ?? 1}x via ${driveUrl}`);
  // eslint-disable-next-line no-console
  console.log(`  goto returned:     ${gotoMs} ms`);
  // eslint-disable-next-line no-console
  console.log(`  title visible:     ${titleVisibleMs} ms`);
  // eslint-disable-next-line no-console
  console.log(
    `  Loro ready @page:  ${loroLoadedAt < 0 ? 'never' : Math.round(loroLoadedAt) + ' ms'}`,
  );
});
