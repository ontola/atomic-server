/**
 * Table-scale probe: bulk-create N rows through `window.store`, then time
 * the paths a real table open pays — OPFS/local query, JS hydration, grid
 * mount, scroll.
 *
 * Not a budget gate and not part of CI. The write path is one signed commit
 * per row, so 100k in the browser is hours; default N is 1000. Pair with the
 * Rust `table_scale` ignored test for the 100k store/query numbers.
 *
 *   TABLE_STRESS=1 npx playwright test tests/table-stress.spec.ts --workers=1 --reporter=line
 *   TABLE_STRESS=1 TABLE_STRESS_N=5000 npx playwright test tests/table-stress.spec.ts --workers=1 --reporter=line
 *
 * Read the `[TABLE-STRESS]` lines.
 */

import { test, expect } from './fixtures';
import {
  before,
  createTableFromDialog,
  FRONTEND_URL,
  waitForClientDbFlush,
  waitForGridMounted,
  waitForSynced,
} from './test-utils';
import { resetPerfTrace } from './perf-attach';

const PARENT = 'https://atomicdata.dev/properties/parent';
const IS_A = 'https://atomicdata.dev/properties/isA';
const NAME = 'https://atomicdata.dev/properties/name';
const CLASSTYPE = 'https://atomicdata.dev/properties/classtype';

const PREFIXES = [
  'table.',
  'resource.',
  'commit.',
  'store.postCommit',
  'clientdb.',
  'ws.',
];

function stressN(): number {
  const raw = process.env.TABLE_STRESS_N;

  if (!raw) return 1_000;

  const n = Number(raw);

  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 1_000;
}

async function rollup(page: import('@playwright/test').Page) {
  return page.evaluate(prefixes => {
    const snap = (
      window as unknown as {
        __atomicPerf?: {
          snapshot(): {
            windowMs: number;
            rollup: Array<{
              name: string;
              count: number;
              totalMs: number;
              maxMs: number;
              avgMs: number;
            }>;
          };
        };
      }
    ).__atomicPerf?.snapshot();

    if (!snap) return undefined;

    return snap.rollup
      .filter(r => prefixes.some(p => r.name.startsWith(p)))
      .sort((a, b) => b.totalMs - a.totalMs)
      .slice(0, 20)
      .map(r => ({
        name: r.name,
        n: r.count,
        total: Math.round(r.totalMs),
        avg: Math.round(r.avgMs * 10) / 10,
        max: Math.round(r.maxMs),
      }));
  }, PREFIXES);
}

function printRollup(label: string, rows: Awaited<ReturnType<typeof rollup>>) {
  // eslint-disable-next-line no-console
  console.log(
    `[TABLE-STRESS] ${label}\n` +
      (rows ?? [])
        .map(
          r =>
            `  ${r.name.padEnd(36)} n=${String(r.n).padStart(4)} total=${String(r.total).padStart(7)}ms avg=${r.avg}ms max=${r.max}ms`,
        )
        .join('\n'),
  );
}

test.describe('table stress', () => {
  test.skip(
    !process.env.TABLE_STRESS,
    'set TABLE_STRESS=1 to run the table scale probe',
  );
  test.beforeEach(before);
  test.slow();

  test('bulk-insert then open, query, and scroll', async ({ page }) => {
    const n = stressN();
    test.setTimeout(Math.max(180_000, n * 250 + 120_000));

    await createTableFromDialog(page, { name: `Stress ${n}` });
    await page.keyboard.press('Escape');
    await waitForGridMounted(page);

    const tableSubject = await page.evaluate(() => {
      const url = new URL(window.location.href);

      return url.searchParams.get('subject') ?? '';
    });
    expect(tableSubject).toBeTruthy();

    const drive = await page.evaluate(() => window.store.getDrive());
    expect(drive).toBeTruthy();

    // Leave the grid so each save does not also refresh a live collection.
    await page.goto(
      `${FRONTEND_URL}/app/show?subject=${encodeURIComponent(drive!)}`,
    );
    await page.waitForFunction(
      () =>
        window.store?.getClientDb()?.isReady === true &&
        window.store?.getSyncStatus().serverConnected === true,
      undefined,
      { timeout: 30_000 },
    );

    await resetPerfTrace(page);
    const insert = await page.evaluate(
      async ({ table, count, name, classtype }) => {
        const store = window.store;
        const tableResource = await store.getResource(table);
        const rowClass = tableResource.get(classtype) as string;
        const started = performance.now();
        let lastYield = started;

        for (let i = 0; i < count; i++) {
          const row = await store.newResource({
            parent: table,
            isA: rowClass,
            propVals: { [name]: `Row ${String(i).padStart(6, '0')}` },
          });
          await row.save();

          if (i > 0 && i % 50 === 0) {
            await new Promise<void>(resolve => setTimeout(resolve, 0));
            const now = performance.now();

            if (now - lastYield > 2_000) {
              // eslint-disable-next-line no-console
              console.log(`[TABLE-STRESS] inserted ${i}/${count}`);
              lastYield = now;
            }
          }
        }

        return {
          ms: performance.now() - started,
          rowClass,
          pending: store.getSyncStatus().pendingDirtyCount,
        };
      },
      {
        table: tableSubject,
        count: n,
        name: NAME,
        classtype: CLASSTYPE,
      },
    );

    // eslint-disable-next-line no-console
    console.log(
      `[TABLE-STRESS] insert ${n} rows: ${Math.round(insert.ms)}ms (${(insert.ms / n).toFixed(1)} ms/row)`,
    );
    printRollup(`insert ${n}`, await rollup(page));

    await waitForSynced(page, Math.max(60_000, n * 50));
    await waitForClientDbFlush(page, { required: true });

    const queryTimings = await page.evaluate(
      async ({ table, parent, isA, rowClass, drive: driveSubject }) => {
        const store = window.store;

        const time = async (
          label: string,
          opts: Parameters<typeof store.queryLocalDb>[0],
        ) => {
          const t0 = performance.now();
          const result = await store.queryLocalDb(opts);

          return {
            label,
            ms: Math.round(performance.now() - t0),
            count: result?.count ?? 0,
            subjects: result?.subjects.length ?? 0,
            resources: result?.resources?.length ?? 0,
            jsonAdBytes: (result?.resources ?? []).reduce(
              (sum, json) => sum + json.length,
              0,
            ),
          };
        };

        const base = {
          property: parent,
          value: table,
          filters: [{ property: isA, value: rowClass }],
          drive: driveSubject,
        };

        return {
          currentOpen: await time(
            'collection-open current (no limit, bodies)',
            {
              ...base,
              includeResources: true,
            },
          ),
          pagedBodies: await time('nested page of 30', {
            ...base,
            includeResources: true,
            limit: 30,
          }),
          subjectsAll: await time('subjects-only unpaged', {
            ...base,
            includeResources: false,
          }),
          subjectsPage: await time('subjects-only page of 30', {
            ...base,
            includeResources: false,
            limit: 30,
          }),
          jsStoreSize: store.resources.size,
        };
      },
      {
        table: tableSubject,
        parent: PARENT,
        isA: IS_A,
        rowClass: insert.rowClass,
        drive,
      },
    );

    // eslint-disable-next-line no-console
    console.log(
      `[TABLE-STRESS] local queries (js store was ${queryTimings.jsStoreSize} resources)\n` +
        [
          queryTimings.currentOpen,
          queryTimings.pagedBodies,
          queryTimings.subjectsAll,
          queryTimings.subjectsPage,
        ]
          .map(
            r =>
              `  ${r.label.padEnd(44)} ${String(r.ms).padStart(6)}ms count=${r.count} subjects=${r.subjects} bodies=${r.resources} jsonAd=${r.jsonAdBytes}b`,
          )
          .join('\n'),
    );

    await resetPerfTrace(page);
    const openStarted = Date.now();
    await page.goto(
      `${FRONTEND_URL}/app/show?subject=${encodeURIComponent(tableSubject)}`,
    );
    // Full remount: wait until the same OPFS worker the collection will ask
    // is actually up. The empty entry row still paints before members land,
    // so `aria-rowcount` is the signal that the collection answered.
    await page.waitForFunction(
      () => window.store?.getClientDb()?.isReady === true,
      undefined,
      { timeout: 30_000 },
    );

    const remountQuery = await page.evaluate(
      async ({ table, parent, isA, rowClass, drive: driveSubject }) => {
        const t0 = performance.now();
        const result = await window.store.queryLocalDb({
          property: parent,
          value: table,
          filters: [{ property: isA, value: rowClass }],
          drive: driveSubject,
          includeResources: true,
        });

        return {
          ms: Math.round(performance.now() - t0),
          count: result?.count ?? 0,
          subjects: result?.subjects.length ?? 0,
          resources: result?.resources?.length ?? 0,
          jsonAdBytes: (result?.resources ?? []).reduce(
            (sum, json) => sum + json.length,
            0,
          ),
          jsStoreSize: window.store.resources.size,
        };
      },
      {
        table: tableSubject,
        parent: PARENT,
        isA: IS_A,
        rowClass: insert.rowClass,
        drive,
      },
    );

    // eslint-disable-next-line no-console
    console.log(
      `[TABLE-STRESS] remount queryLocalDb (bodies, no limit): ${remountQuery.ms}ms count=${remountQuery.count} bodies=${remountQuery.resources} jsonAd=${remountQuery.jsonAdBytes}b jsStore=${remountQuery.jsStoreSize}`,
    );

    await page.waitForFunction(
      expected =>
        Number(
          document
            .querySelector('[role="grid"]')
            ?.getAttribute('aria-rowcount') ?? 0,
        ) >= expected,
      n,
      { timeout: Math.max(60_000, n * 20) },
    );
    await waitForGridMounted(page, Math.max(60_000, n * 20));
    const openMs = Date.now() - openStarted;

    const gridInfo = await page.evaluate(() => {
      const grid = document.querySelector('[role="grid"]');
      const rows = document.querySelectorAll('[role="row"]').length;
      const cells = document.querySelectorAll('[role="gridcell"]').length;
      const setSize = grid?.getAttribute('aria-rowcount');
      const memory = (
        performance as Performance & {
          memory?: { usedJSHeapSize: number; totalJSHeapSize: number };
        }
      ).memory;
      const load = (
        window as unknown as {
          __e2eLoad?: {
            longTasks: Array<{ duration: number }>;
            maxTimerLagMs: number;
          };
        }
      ).__e2eLoad;

      return {
        rowCount: setSize,
        renderedRows: rows,
        renderedCells: cells,
        heapUsed: memory?.usedJSHeapSize,
        heapTotal: memory?.totalJSHeapSize,
        longTasks: load?.longTasks.length ?? 0,
        longTaskMax: Math.round(
          Math.max(0, ...(load?.longTasks.map(t => t.duration) ?? [0])),
        ),
        timerLag: Math.round(load?.maxTimerLagMs ?? 0),
        jsStoreSize: window.store.resources.size,
      };
    });

    // eslint-disable-next-line no-console
    console.log(
      `[TABLE-STRESS] open grid: ${openMs}ms aria-rowcount=${gridInfo.rowCount} renderedRows=${gridInfo.renderedRows} cells=${gridInfo.renderedCells} jsStore=${gridInfo.jsStoreSize} heap=${gridInfo.heapUsed ?? '?'} longTasks=${gridInfo.longTasks} max=${gridInfo.longTaskMax}ms lag=${gridInfo.timerLag}ms`,
    );
    printRollup(`open ${n}`, await rollup(page));

    const scroller = page
      .locator('[role="grid"]')
      .locator(
        'xpath=ancestor::*[contains(@style,"overflow") or @data-radix-scroll-area-viewport][1]',
      )
      .first();
    const scrollTarget = (await scroller.count())
      ? scroller
      : page.getByRole('grid');

    const scrollStarted = Date.now();
    await scrollTarget.evaluate(el => {
      el.scrollTop = el.scrollHeight;
    });
    await page.waitForTimeout(300);
    await scrollTarget.evaluate(el => {
      el.scrollTop = 0;
    });
    const scrollMs = Date.now() - scrollStarted;

    const afterScroll = await page.evaluate(() => {
      const rows = document.querySelectorAll('[role="row"]').length;
      const load = (
        window as unknown as {
          __e2eLoad?: { longTasks: Array<{ duration: number }> };
        }
      ).__e2eLoad;

      return {
        renderedRows: rows,
        longTasks: load?.longTasks.length ?? 0,
      };
    });

    // eslint-disable-next-line no-console
    console.log(
      `[TABLE-STRESS] scroll bottom→top: ${scrollMs}ms renderedRows=${afterScroll.renderedRows} longTasks=${afterScroll.longTasks}`,
    );

    expect(Number(gridInfo.rowCount ?? 0)).toBeGreaterThanOrEqual(n);
    expect(queryTimings.currentOpen.count).toBeGreaterThanOrEqual(n);
  });
});
