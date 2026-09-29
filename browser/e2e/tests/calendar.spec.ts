import { before } from './session-fixtures';
import { test, expect, type Page } from './session-fixtures';
import { createTableFromDialog, reloadReconnected } from './test-utils';

/** Local YYYY-MM-DD key, same derivation the CalendarDay cells use. */
function localDayKey(d: Date): string {
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');

  return `${d.getFullYear()}-${month}-${day}`;
}

/** Creates an Issue Tracker table (Board + All issues views, no date property). */
async function createIssueTracker(page: Page, name: string) {
  await createTableFromDialog(page, { template: /Issue Tracker/, name });
  await expect(page.getByTestId('kanban-board')).toBeVisible();
}

test.describe('calendar view', () => {
  test.beforeEach(before);

  test('create calendar view, add an item on a day, and it persists', async ({
    page,
  }) => {
    // The 60s default cannot hold this test's own declared budgets. The body
    // before the reload takes 14535 ms with nothing else running, and the two
    // waits after it are given 30s and 15s deliberately, for the contended CI
    // server the comment at the reload describes. 14.5 + 30 + 15 is 59.5s, so
    // the wall fires before the budget it is supposed to allow can be reached,
    // and it then names itself rather than the step that was late.
    //
    // Run 4686 is what that looks like: "Test timeout of 60000ms exceeded" with
    // the 30s wait in flight, on both attempts. Measured over eight
    // four-worker rounds on a 4-core box, the test itself:
    //
    //     29969  33229  34115  34445  34834  35090  37552  40693 ms
    test.setTimeout(120_000);
    await createIssueTracker(page, 'Roadmap');

    // Add a new Calendar view via the "+" tab. The Issue Tracker class has no
    // date property, so the view auto-creates a "Date" one before rendering.
    await page.getByRole('button', { name: 'Add view' }).click();
    await page.getByTestId('menu-item-calendar').click();

    const calendar = page.getByTestId('calendar-view');
    await expect(calendar).toBeVisible();

    // A month grid with today's cell highlighted.
    const todayKey = localDayKey(new Date());
    const todayCell = page.locator(
      `[data-testid="calendar-day"][data-date="${todayKey}"]`,
    );
    await expect(todayCell).toBeVisible();

    // The `+` on the day creates an item with its date preset to that day.
    await todayCell.hover();
    await todayCell.getByTestId('calendar-day-add').click();
    const input = todayCell.getByPlaceholder('New item…');
    await input.fill('Ship calendar');
    await input.press('Enter');

    const event = todayCell
      .getByTestId('calendar-event')
      .filter({ hasText: 'Ship calendar' });
    await expect(event).toBeVisible();

    // Month navigation: two months ahead never includes today (one month ahead
    // can, via the leading-pad days), Today brings it back.
    await page.getByRole('button', { name: 'Next month' }).click();
    await page.getByRole('button', { name: 'Next month' }).click();
    await expect(todayCell).toHaveCount(0);
    await page.getByRole('button', { name: 'Today' }).click();
    await expect(event).toBeVisible();

    // Persisted: the active view is in the URL (`?view=`), so a reload comes
    // back to the calendar rather than the table's default Board. While the
    // View resource is still loading, `normalizeViewKind(undefined)` falls
    // back to `table`, so `calendar-view` is absent until that fetch lands —
    // under a contended CI server that routinely exceeds the default 10s
    // expect budget.
    await reloadReconnected(page);
    await expect(page.getByTestId('calendar-view')).toBeVisible({
      timeout: 30000,
    });
    await expect(
      page
        .locator(`[data-testid="calendar-day"][data-date="${todayKey}"]`)
        .getByTestId('calendar-event')
        .filter({ hasText: 'Ship calendar' }),
    ).toBeVisible({ timeout: 15000 });

    // The auto-created Date property landed on the item: open it and check.
    await event.click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('Ship calendar');
    await expect(dialog).toContainText('Date');
  });
});

// #1798: a crowded day clipped its events with no hint, and clicking a day did
// nothing, so there was no way to read a busy day in full.
test.describe('calendar day list', () => {
  test.beforeEach(before);

  test('a crowded day shows "+N more", and its day list shows every event', async ({
    page,
  }) => {
    // Also too much for the 60s default. It builds an Issue Tracker from a
    // template, adds a calendar view, then creates five items one after
    // another, each a round trip, and drives about twenty assertions over the
    // day list and its dialogs. Every one of those carries the 10s action
    // default, inside a wall only six of them would fill.
    //
    // Measured over eight four-worker rounds, and 10445 ms alone:
    //
    //     28974  29608  29692  31366  31570  33086  34027  35395 ms
    //
    // Run 4686 exceeded the wall on both attempts, the second time during a
    // hover whose element had already resolved, was visible and stable, and
    // had finished scrolling. Nothing was missing; the test was out of time.
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1280, height: 800 });
    await createIssueTracker(page, 'Busy day');
    await page.getByRole('button', { name: 'Add view' }).click();
    await page.getByTestId('menu-item-calendar').click();
    await expect(page.getByTestId('calendar-view')).toBeVisible();

    const todayCell = page.locator(
      `[data-testid="calendar-day"][data-date="${localDayKey(new Date())}"]`,
    );
    const titles = ['Standup', 'Invoice due', 'Payday', 'Lunch', 'Dentist'];

    for (const title of titles) {
      await todayCell.hover();
      await todayCell.getByTestId('calendar-day-add').click();
      const input = todayCell.getByPlaceholder('New item…');
      await input.fill(title);
      await input.press('Enter');
      await expect(input).toHaveCount(0);
    }

    // Not every title fits: the rest are counted, not silently clipped.
    const more = todayCell.getByTestId('calendar-day-more');
    await expect(more).toBeVisible();
    const shown = await todayCell
      .locator('[data-testid="calendar-event"]:visible')
      .count();
    expect(shown).toBeLessThan(titles.length);
    await expect(more).toContainText(`+${titles.length - shown}`);
    // "+N more" itself sits inside the cell, not clipped below it.
    const cellBox = (await todayCell.boundingBox())!;
    const moreBox = (await more.boundingBox())!;
    expect(moreBox.y + moreBox.height).toBeLessThanOrEqual(
      cellBox.y + cellBox.height,
    );

    await more.click();
    const list = page.getByTestId('calendar-day-list');
    await expect(list).toBeVisible();

    for (const title of titles) {
      await expect(
        list.getByTestId('calendar-event').filter({ hasText: title }),
      ).toBeVisible();
    }

    // An event opens its row on top; closing the row returns to the list.
    await list
      .getByTestId('calendar-event')
      .filter({ hasText: 'Lunch' })
      .click();
    await expect(page.locator('dialog[open]')).toHaveCount(2);
    await page.keyboard.press('Escape');
    await expect(page.locator('dialog[open]')).toHaveCount(1);
    await expect(list).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('dialog[open]')).toHaveCount(0);
    // Focus returns to what opened the list.
    await expect(more).toBeFocused();

    // Keyboard: the day number is a button that opens the same list.
    const dayNumber = todayCell.getByTestId('calendar-day-open');
    await dayNumber.focus();
    await page.keyboard.press('Enter');
    await expect(list).toBeVisible();
    await expect(list.getByTestId('calendar-event')).toHaveCount(titles.length);
    await page.keyboard.press('Escape');
    await expect(page.locator('dialog[open]')).toHaveCount(0);
    await expect(dayNumber).toBeFocused();

    // A click on the day's empty space opens it too.
    const box = await todayCell.boundingBox();
    await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height - 4);
    await expect(list).toBeVisible();
  });
});

/** Left/right edges of each element a locator matches, in whole pixels. */
async function columnEdges(locator: ReturnType<Page['locator']>) {
  return locator.evaluateAll(els =>
    els.map(el => {
      const r = el.getBoundingClientRect();

      return [Math.round(r.left), Math.round(r.right)];
    }),
  );
}

// #1792: the weekday header row and the day grid sized their columns
// independently with `repeat(7, 1fr)`, whose minimum is the content's width,
// so a long title widened its column in the grid only. The headers then sat
// over the wrong days and the tester put two events on the wrong weekday.
test.describe('calendar grid alignment', () => {
  test.beforeEach(before);

  test('weekday headers stay over their columns with a long title, at desktop and phone width', async ({
    page,
  }) => {
    // Prevention rather than a fix: this one has not failed on CI. It shares
    // the template build and the calendar view with the two tests above, and
    // measures 25696 to 34609 ms over the same eight rounds against the 60s
    // default, which is the ratio that redded them. Raised with them so it
    // does not cost a later run to learn the same thing.
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1280, height: 800 });
    await createIssueTracker(page, 'Long titles');
    await page.getByRole('button', { name: 'Add view' }).click();
    await page.getByTestId('menu-item-calendar').click();
    await expect(page.getByTestId('calendar-view')).toBeVisible();

    const todayCell = page.locator(
      `[data-testid="calendar-day"][data-date="${localDayKey(new Date())}"]`,
    );
    const longTitle =
      'Quarterly planning retrospective with the Boston and Amsterdam teams';
    await todayCell.hover();
    await todayCell.getByTestId('calendar-day-add').click();
    const input = todayCell.getByPlaceholder('New item…');
    await input.fill(longTitle);
    await input.press('Enter');
    await expect(
      todayCell.getByTestId('calendar-event').filter({ hasText: longTitle }),
    ).toBeVisible();

    for (const width of [1280, 375]) {
      await page.setViewportSize({ width, height: 800 });

      await expect(async () => {
        const headers = await columnEdges(page.getByTestId('calendar-weekday'));
        // The first week's seven cells are one per column.
        const firstWeek = (
          await columnEdges(page.getByTestId('calendar-day'))
        ).slice(0, 7);

        expect(headers).toHaveLength(7);

        for (let i = 0; i < 7; i++) {
          expect(
            Math.abs(headers[i][0] - firstWeek[i][0]),
            `column ${i} left edge at ${width}px`,
          ).toBeLessThanOrEqual(2);
          expect(
            Math.abs(headers[i][1] - firstWeek[i][1]),
            `column ${i} right edge at ${width}px`,
          ).toBeLessThanOrEqual(2);
        }

        // All seven columns fit: Sunday ends inside the viewport, and the
        // page does not scroll sideways.
        expect(firstWeek[6][1], `Sunday at ${width}px`).toBeLessThanOrEqual(
          width,
        );
        const overflow = await page.evaluate(
          () =>
            document.documentElement.scrollWidth -
            document.documentElement.clientWidth,
        );
        expect(overflow, `horizontal overflow at ${width}px`).toBe(0);
      }).toPass({ timeout: 10000 });
    }
  });
});

/** The civil date `days` after a YYYY-MM-DD key. */
function addDays(dayKey: string, days: number): string {
  const date = new Date(`${dayKey}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);

  return date.toISOString().slice(0, 10);
}

// #1801: making an event repeat took hand-written JSON.
test.describe('calendar repeat', () => {
  test.beforeEach(before);

  test('a Repeat of weekly puts the event on the following weeks', async ({
    page,
  }) => {
    // Builds a table from a template, adds a view and an item, and the first
    // repeat adds a Recurrence column to the class: past the 60s wall on a
    // contended server, like the tests above.
    test.setTimeout(120_000);
    await createIssueTracker(page, 'Rituals');
    await page.getByRole('button', { name: 'Add view' }).click();
    await page.getByTestId('menu-item-calendar').click();
    await expect(page.getByTestId('calendar-view')).toBeVisible();

    // The grid's first day: at least three more weeks follow it in the grid.
    const first = (await page
      .getByTestId('calendar-day')
      .first()
      .getAttribute('data-date'))!;
    const cell = (dayKey: string) =>
      page.locator(`[data-testid="calendar-day"][data-date="${dayKey}"]`);
    const retro = (dayKey: string) =>
      cell(dayKey).getByTestId('calendar-event').filter({ hasText: 'Retro' });

    await cell(first).hover();
    await cell(first).getByTestId('calendar-day-add').click();
    const input = cell(first).getByPlaceholder('New item…');
    await input.fill('Retro');
    await input.press('Enter');
    await expect(retro(first)).toBeVisible();
    await expect(retro(addDays(first, 7))).toHaveCount(0);

    await retro(first).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Repeat').selectOption('weekly');
    await expect(dialog.getByTestId('repeat-summary')).toHaveText(
      /^Every \w+$/,
    );
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();

    for (const week of [0, 1, 2, 3]) {
      await expect(retro(addDays(first, 7 * week))).toBeVisible({
        timeout: 15000,
      });
    }

    // Only on its own weekday.
    await expect(retro(addDays(first, 1))).toHaveCount(0);
  });
});
