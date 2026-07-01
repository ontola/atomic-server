/**
 * Playwright helpers for capturing the always-on `@tomic/lib` perf trace
 * and attaching it to a test. Use to compare local-vs-CI budgets when
 * chasing dagger-flaky tests:
 *
 *     test('my flaky thing', async ({ page }, testInfo) => {
 *       ...
 *       await attachPerfSnapshot(page, testInfo);
 *     });
 *
 * If `ATOMIC_TEST_CPU_THROTTLE` is set (numeric, default off), the helper
 * also installs a CDP CPU throttle on the page before the run — useful
 * for reproducing dagger's single-core slowdowns locally. Rate 4 means
 * "browser pretends the CPU is 4× slower"; 6 is closer to dagger's
 * actual measured budget.
 */

import type { Page, TestInfo } from '@playwright/test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

// Mirror of `PerfSnapshot` from `@tomic/lib` — duplicated so the e2e
// package doesn't need a dependency on `@tomic/lib`. Keep in sync with
// `browser/lib/src/perf-trace.ts`.
interface PerfEvent {
  name: string;
  t: number;
  d?: number;
  p?: unknown;
}

interface PerfSnapshot {
  windowMs: number;
  count: number;
  events: PerfEvent[];
  rollup: Array<{
    name: string;
    count: number;
    totalMs: number;
    maxMs: number;
    avgMs: number;
  }>;
}

/**
 * Pull the live `window.__atomicPerf.snapshot()` and attach it to the
 * current test. Safe to call multiple times — each call is a separate
 * attachment (named with `name`) so you can capture pre/post phases.
 *
 * Also prints a one-line headline + the top-N rollup rows to stdout
 * so the test runner output shows the relevant numbers directly. The
 * full JSON goes to a file under `<testInfo.outputDir>/<name>.json`
 * for offline analysis.
 */
export async function attachPerfSnapshot(
  page: Page,
  testInfo: TestInfo,
  name = 'perf-trace',
): Promise<PerfSnapshot | undefined> {
  const snap = (await page
    .evaluate(() => {
      const w = window as unknown as {
        __atomicPerf?: { snapshot: () => unknown };
      };

      return w.__atomicPerf?.snapshot();
    })
    .catch(() => undefined)) as PerfSnapshot | undefined;

  if (!snap) return undefined;

  // Compact stdout summary — the dagger CI logs and local runs both
  // surface this directly so you don't have to dig into the HTML report.
  const lines: string[] = [];
  lines.push(
    `[perf] ${name}: window=${snap.windowMs.toFixed(0)}ms events=${snap.count}`,
  );

  for (const row of snap.rollup.slice(0, 12)) {
    lines.push(
      `  ${row.name.padEnd(38)} n=${String(row.count).padStart(3)}  total=${String(row.totalMs.toFixed(1)).padStart(7)}ms  max=${String(row.maxMs.toFixed(1)).padStart(7)}ms  avg=${row.avgMs.toFixed(1)}ms`,
    );
  }

  // eslint-disable-next-line no-console
  console.log(lines.join('\n'));

  await testInfo.attach(name, {
    body: JSON.stringify(snap, null, 2),
    contentType: 'application/json',
  });

  // Also write to outputDir as a plain JSON file — survives in
  // test-results/<name> after the run, easy to grep across multiple
  // runs (vanilla vs throttled) without going through the HTML report.
  try {
    const outFile = path.join(testInfo.outputDir, `${name}.json`);
    await fs.mkdir(testInfo.outputDir, { recursive: true });
    await fs.writeFile(outFile, JSON.stringify(snap, null, 2));
  } catch {
    // best-effort
  }

  return snap;
}

/**
 * Best-effort: attach the perf snapshot of every page in the test
 * context, named after the page index. Use as an `afterEach` hook so
 * any test that fails at a `toBeVisible({timeout})` carries its own
 * timing trace for debugging — without each test having to remember
 * to call `attachPerfSnapshot` manually.
 *
 * The snapshot is queried before screenshot/trace teardown runs, so
 * it reflects the state at the moment the assertion failed.
 */
export async function attachPerfOnFailure(testInfo: TestInfo): Promise<void> {
  if (testInfo.status === testInfo.expectedStatus) return;
  // Lazily resolve the active page via Playwright's per-test fixture.
  // The fixture exposes `_browserContextImpl` only via internal hooks,
  // so we instead expect the test to register a page via `setPerfPage`
  // (typically from the `before` fixture) and read it back here.
  const active = (testInfo as unknown as { _perfPages?: Page[] })._perfPages;
  if (!active || active.length === 0) return;
  let i = 0;

  for (const page of active) {
    try {
      await attachPerfSnapshot(page, testInfo, `perf-trace-${i}`);
    } catch {
      // closed page / nav in flight — ignore
    }

    i++;
  }
}

/**
 * Register a page so `attachPerfOnFailure` can find it later. Call from
 * the `before` fixture for the primary page; tests that open extra
 * contexts (multi-window) can call again with the new page.
 */
export function registerPerfPage(testInfo: TestInfo, page: Page): void {
  const target = testInfo as unknown as { _perfPages?: Page[] };
  if (!target._perfPages) target._perfPages = [];
  target._perfPages.push(page);
}

/**
 * Reset the perf trace at a meaningful boundary (e.g. right before a
 * reload + reconnect flow you want to time in isolation).
 */
export async function resetPerfTrace(page: Page): Promise<void> {
  await page
    .evaluate(() => {
      const w = window as unknown as {
        __atomicPerf?: { reset: () => void };
      };
      w.__atomicPerf?.reset();
    })
    .catch(() => undefined);
}

/**
 * Read the CPU-throttle rate from env. 0/undefined → no throttle. The
 * dagger container is roughly equivalent to rate 4–6 on an M-series
 * laptop; tune up until your local timings match the CI ones.
 */
export function envCpuThrottle(): number {
  const raw = process.env.ATOMIC_TEST_CPU_THROTTLE;
  if (!raw) return 0;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 1) return 0;

  return n;
}

/**
 * Apply CDP CPU throttling to a Page. No-op if `rate <= 1`. Must be
 * called after the page is created but before the navigation you want
 * to slow down. Throws if the underlying browser isn't Chromium-based.
 */
export async function applyCpuThrottle(
  page: Page,
  rate: number,
): Promise<void> {
  if (!rate || rate <= 1) return;
  const session = await page.context().newCDPSession(page);
  await session.send('Emulation.setCPUThrottlingRate', { rate });
}
