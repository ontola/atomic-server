import { test, expect } from '@playwright/test';
import {
  newResource,
  before,
  inDialog,
  REBUILD_INDEX_TIME,
} from './test-utils';

type Row = {
  name: string;
  date: string;
  number: string;
  checkbox: boolean;
  select: string;
};

test.describe('tables', async () => {
  test.beforeEach(before);

  test('table dialog pre-fills name and focuses input', async ({ page }) => {
    await newResource('table', page);
    const input = page.getByPlaceholder('New Table');
    await expect(input).toHaveValue('Table');
    await expect(input).toBeFocused();
  });

  // FLAKY (dagger CI + remote CI): the long table-fill choreography has
  // many sub-steps (column dialogs, tag picker, sequential row fills)
  // and any of them can blow the action budget under dagger contention.
  // Most-frequent failure: the gridcell Visual→Edit-mode transition
  // races, leaving the cell-input not focused. Investigate: replace the
  // double-click pattern with a single-click + explicit Edit-mode
  // assertion, or use the keyboard-driven flow exclusively.
  test('create and fill', async ({ page }) => {
    test.slow();

    const newColumn = async (type: string) => {
      await page.getByRole('button', { name: 'Add column' }).click();
      await page.click(`text=${type}`);
    };

    const tab = async () => {
      await page.keyboard.press('Tab');
      await page.waitForTimeout(150);
    };

    const createTag = async (emote: string, name: string) => {
      await page.getByPlaceholder('New tag').last().fill(name);
      await page.getByTitle('Pick an emoji').last().click();
      await page.getByPlaceholder('Search', { exact: true }).fill(emote);
      await page.getByRole('button', { name: emote }).click();
      await page.getByTitle('Add tag').last().click();
      await expect(page.getByRole('button', { name })).toBeVisible();
    };

    const pickTag = async (name: string) => {
      // Cell focus on the tag column opens the tag picker, but under dagger
      // CPU contention the popup mount can lag past the default 5s actionTimeout.
      // Bump the wait, and press Enter as a fallback open trigger if it
      // hasn't appeared yet — both paths land on the same picker.
      const filter = page.getByPlaceholder('filter tags');

      if (!(await filter.isVisible({ timeout: 2000 }).catch(() => false))) {
        await page.keyboard.press('Enter');
      }

      await expect(filter).toBeVisible({ timeout: 15000 });
      await page.keyboard.type(name);
      await page.keyboard.press('Enter');
      await page.keyboard.press('Escape');
      await expect(filter).not.toBeVisible();
    };

    const fillRow = async (currentRowNumber: number, row: Row) => {
      const { name, date, number, checkbox, select } = row;
      const rowIndex = currentRowNumber + 1;
      await page.keyboard.press('Enter');
      await expect(
        page.locator(
          `[aria-rowindex="${rowIndex}"] > [aria-colindex="2"] > input`,
        ),
      ).toBeFocused();
      await page
        .locator(`[aria-rowindex="${rowIndex}"] > [aria-colindex="2"] > input`)
        .fill(name);
      await page.waitForTimeout(300);
      await tab();
      await page.waitForTimeout(300);
      await expect(
        page.getByRole('rowheader', { name: `${currentRowNumber + 1}` }),
      ).toBeAttached();

      await page.keyboard.type(date);
      await tab();
      await page.keyboard.type(number);
      await tab();

      if (checkbox) {
        await page.keyboard.press('Space');

        await expect(
          page.locator(`[aria-rowindex="${rowIndex}"]`).getByRole('checkbox'),
          "Checkbox isn't checked",
        ).toBeChecked();
      } else {
        await expect(
          page.locator(`[aria-rowindex="${rowIndex}"]`).getByRole('checkbox'),
          'Checkbox is checked but should not be',
        ).not.toBeChecked();
      }

      await tab();
      await pickTag(select);
      await tab();
      await expect(
        page.getByRole('gridcell', { name: row.name }),
        `${row.name} row not visible`,
      ).toBeVisible();
      await expect(
        page.locator(
          `[aria-rowindex="${rowIndex + 1}"] > [aria-colindex="2"] > input`,
        ),
        "Next row's first cell isn't focused",
      ).toBeFocused();
    };

    // --- Test Start ---
    await newResource('table', page);

    // Name table (pre-filled with "table", replace it)
    const tableName = 'Made up music genres';
    await page.getByPlaceholder('New Table').fill(tableName);
    await page.locator('dialog[open] button:has-text("Create")').click();
    // Newly-created resources auto-enter edit mode, so the title renders as
    // an input. Match either form.
    await expect(
      page
        .getByTestId('editable-title')
        .and(page.locator(`:text-is("${tableName}"), [value="${tableName}"]`))
        .first(),
    ).toBeVisible();
    // Exit edit mode so subsequent keyboard actions (Tab to move into the
    // grid) don't get swallowed by the title input.
    await page.keyboard.press('Escape');

    const dateColumnName = 'Existed since';
    await newColumn('Date');
    await inDialog(page, async (dialog, closeDialogWith) => {
      await expect(page.locator('text=New Date Column')).toBeVisible();
      await dialog.getByPlaceholder('New Column').fill(dateColumnName);
      await dialog.getByLabel('Long').click();
      await closeDialogWith('Create');
    });

    await expect(
      page.getByRole('button', { name: dateColumnName }),
    ).toBeVisible({ timeout: 15000 });

    await newColumn('Number');
    const numberColumnName = 'Number of tracks';

    await inDialog(page, async (dialog, closeDialogWith) => {
      await expect(page.locator('text=New Number Column')).toBeVisible();
      await dialog.getByPlaceholder('New Column').fill(numberColumnName);
      await closeDialogWith('Create');
    });

    await expect(
      page.getByRole('button', { name: numberColumnName }),
    ).toBeVisible();

    await newColumn('Checkbox');
    const checkboxColumnName = 'Approved by W3C';

    await inDialog(page, async (dialog, closeDialogWith) => {
      await expect(page.locator('text=New Checkbox Column')).toBeVisible();
      await dialog.getByPlaceholder('New Column').fill(checkboxColumnName);
      await closeDialogWith('Create');
    });

    await expect(
      page.getByRole('button', { name: checkboxColumnName }),
    ).toBeVisible();

    await newColumn('Select');
    const selectColumnName = 'Descriptive words';

    await inDialog(page, async (dialog, closeDialogWith) => {
      await expect(page.locator('text=New Select Column')).toBeVisible();
      await dialog.getByPlaceholder('New Column').fill(selectColumnName);

      await createTag('😤', 'wild');
      await createTag('😵‍💫', 'dreamy');
      await createTag('🤨', 'wtf');
      await closeDialogWith('Create');
    });

    await expect(
      page.getByRole('button', { name: selectColumnName }),
    ).toBeVisible();

    // Wait for all pending commits to drain into the server before reload.
    // 'networkidle' is unreliable on SPAs with persistent WebSocket
    // connections (commit subscriptions, the open WS, etc.). The dirty
    // queue is the actual saved-to-server signal.
    await page.waitForFunction(
      () => window.store.getSyncStatus().pendingDirtyCount === 0,
      undefined,
      { timeout: 10000 },
    );
    await page.reload();
    await expect(
      page.getByRole('button', { name: selectColumnName }),
    ).toBeVisible();

    const rows = [
      {
        name: 'Progressive Pizza House',
        date: '04032000',
        number: '10',
        checkbox: true,
        select: 'dreamy',
      },
      {
        name: 'Drum or Bass',
        date: '15051980',
        number: '3000035',
        checkbox: false,
        select: 'wild',
      },
      {
        name: 'Mumble Punk',
        date: '13051965',
        number: '60',
        checkbox: true,
        select: 'wtf',
      },
    ];
    // The cell click + focus combo races with TableEditor's React state
    // initialization (handlers bound after first render). Click without
    // `force` so playwright auto-waits for actionability — that ensures
    // the React handlers are bound by the time mousedown fires, which is
    // what sets `activeCell` and `CursorMode.Visual` (the precondition
    // for Enter → Edit mode in fillRow).
    const firstCell = page.locator(
      '[role="row"][aria-rowindex="2"] > [role="gridcell"][aria-colindex="2"]',
    );
    await firstCell.evaluate(element =>
      element.scrollIntoView({ block: 'nearest', inline: 'nearest' }),
    );
    await firstCell.click();
    await expect(firstCell).toBeFocused();
    await page.waitForTimeout(1000);

    for (const [index, row] of rows.entries()) {
      await fillRow(index + 1, row);
    }

    await expect(
      page.getByRole('gridcell', { name: '😵‍💫 dreamy' }),
    ).toBeVisible();
    await expect(page.getByRole('gridcell', { name: '😤 wild' })).toBeVisible();
    await expect(page.getByRole('gridcell', { name: '🤨 wtf' })).toBeVisible();

    // Edit first cell content
    await page.keyboard.press('Escape');
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('ArrowUp');
    const newName = 'Progressive Peperoni Pizza House';
    await page.keyboard.type(newName);
    await page.keyboard.press('Escape');

    await expect(
      page.getByRole('gridcell', { name: rows[0].name }),
      "Old cell name shouldn't be visible",
    ).not.toBeVisible();

    await expect(
      page.getByRole('gridcell', { name: newName }),
      'New cell name not visible',
    ).toBeVisible();

    // Delete second row
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('Backspace');

    await expect(
      page.getByRole('gridcell', { name: 'Drum or Bass' }),
    ).not.toBeVisible();
  });

  test('fast row entry - rapidly adding rows with Enter', async ({ page }) => {
    test.slow();
    // Use the quick-create "New Table" button on the drive page directly.
    await page.getByTitle('New Table').first().click();

    await page.getByPlaceholder('New Table').fill('Fast Entry Test');
    await page.locator('dialog[open] button:has-text("Create")').click();
    // Wait for navigation away from the drive page — the dialog's
    // createResourceAndNavigate is async and slower than the default 5s assert.
    await page.waitForURL(url => url.pathname.startsWith('/app/show'), {
      timeout: 15000,
    });
    // EditableTitle auto-enters edit mode on creation (renders an input);
    // when not editing it renders an h1. Match either form by test-id.
    await expect(page.getByTestId('editable-title').first()).toBeVisible({
      timeout: 15000,
    });
    // Exit edit mode so subsequent keyboard actions (Tab to move into the
    // grid) don't get swallowed by the title input.
    await page.keyboard.press('Escape');

    // Wait for the table grid to be ready before clicking. Under suite-wide
    // load the row-virtualizer mounts more slowly than the default 5s click
    // timeout, so wait for the first gridcell explicitly.
    const firstCell = page.getByRole('gridcell').first();
    await expect(firstCell).toBeVisible({ timeout: 15000 });

    // Click first cell to focus the table
    await firstCell.click({ force: true });
    await page.waitForTimeout(300);

    // Enough rows to overflow the viewport and exercise react-window
    // virtualization + auto-scroll as new rows are added past the fold.
    const values = Array.from({ length: 40 }, (_, i) => `row${i + 1}`);

    // Type each value and immediately press Enter to move to the next row
    for (const value of values) {
      await page.keyboard.press('Enter');
      await page.waitForTimeout(100);
      await page.keyboard.type(value, { delay: 30 });
      await page.waitForTimeout(100);
    }

    // Wait for last typed value to register before exiting edit mode
    await page.waitForTimeout(500);

    // Every Enter must have created a row. This is the regression guard for
    // the bug where, once rows overflowed the viewport, a list remount snapped
    // the scroll to the top, virtualized the active cell out, and silently
    // stopped adding rows. The grid is virtualized so we can't assert every
    // row is in the DOM — count the materialized resources in the store
    // instead. `+1` row in the grid is the trailing empty placeholder.
    const namedRowCount = () =>
      page.evaluate(() => {
        const NAME = 'https://atomicdata.dev/properties/name';
        return Array.from(window.store.resources?.values?.() ?? []).filter(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (r: any) => /^row\d+$/.test(r.get?.(NAME) ?? ''),
        ).length;
      });

    await expect.poll(namedRowCount).toBe(values.length);

    // Exit edit mode
    await page.keyboard.press('Escape');

    // Wait for all debounced saves to drain into the server.
    await page.waitForFunction(
      () => window.store.getSyncStatus().pendingDirtyCount === 0,
      undefined,
      { timeout: 10000 },
    );

    // Spot-check the bottom of the list is rendered (the active cell stayed in
    // view) — the last typed row must be visible right after entry.
    const last = values[values.length - 1];
    await expect(
      page.getByRole('gridcell', { name: last, exact: true }),
      `Last row "${last}" should be visible after entry`,
    ).toBeVisible();

    // Refresh and verify the rows persisted. The collection is virtualized, so
    // assert the loaded member count, then spot-check the first row (scroll to
    // top) and the last row (scroll to bottom).
    await page.reload();
    await expect(page.getByTestId('editable-title').first()).toBeVisible();
    await page.waitForTimeout(REBUILD_INDEX_TIME);

    await expect.poll(namedRowCount, { timeout: 15000 }).toBe(values.length);

    const grid = page.getByRole('grid');
    await grid.evaluate(g => g.scrollIntoView({ block: 'start' }));
    await page.mouse.move(600, 300);
    await page.mouse.wheel(0, -5000); // scroll to top
    await expect(
      page.getByRole('gridcell', { name: 'row1', exact: true }),
      'First row should be visible after refresh',
    ).toBeVisible();

    await page.mouse.wheel(0, 5000); // scroll to bottom
    await expect(
      page.getByRole('gridcell', { name: last, exact: true }),
      `Last row "${last}" should be visible after refresh`,
    ).toBeVisible();
  });

  test('sorting reorders freshly-entered (virtual) rows', async ({ page }) => {
    test.slow();
    await page.getByTitle('New Table').first().click();
    await page.getByPlaceholder('New Table').fill('Sort Test');
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

    // Enter rows whose names are NOT in alphabetical order.
    for (const name of ['gamma', 'alpha', 'beta']) {
      await page.keyboard.press('Enter');
      await page.waitForTimeout(100);
      await page.keyboard.type(name, { delay: 20 });
      await page.waitForTimeout(100);
    }
    await page.keyboard.press('Escape');
    await page.waitForFunction(
      () => window.store.getSyncStatus().pendingDirtyCount === 0,
      undefined,
      { timeout: 10000 },
    );

    // Default sort is by creation time → insertion order: gamma is row 1.
    await expect(
      page
        .locator('[aria-rowindex="2"]')
        .getByRole('gridcell', { name: 'gamma', exact: true }),
      'Before sort, first row should be the first-entered ("gamma")',
    ).toBeVisible();

    // Click the "name" column header to sort by name (ascending).
    await page.getByRole('button', { name: 'name', exact: true }).first().click();
    await page.waitForTimeout(500);

    // After sort, the freshly-entered virtual rows must reorder: "alpha" first.
    await expect(
      page
        .locator('[aria-rowindex="2"]')
        .getByRole('gridcell', { name: 'alpha', exact: true }),
      'After sorting by name, first row should be "alpha"',
    ).toBeVisible();
  });
});
