import { test, expect } from '@playwright/test';
import {
  newResource,
  waitForCommit,
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
      await expect(page.getByPlaceholder('filter tags')).toBeVisible();
      await page.keyboard.type(name);
      await page.keyboard.press('Enter');
      await page.keyboard.press('Escape');
      await expect(page.getByPlaceholder('filter tags')).not.toBeVisible();
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
      await waitForCommit(page);
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
      await waitForCommit(page);
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
      await waitForCommit(page);
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
      await waitForCommit(page);
    });

    await expect(
      page.getByRole('button', { name: selectColumnName }),
    ).toBeVisible();

    // Wait for all pending commits to be flushed before reload.
    // 'networkidle' is unreliable on SPAs with persistent WebSocket connections.
    await page.waitForTimeout(2000);
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
    await page.getByRole('gridcell').first().click({ force: true });
    await expect(page.getByRole('gridcell').first()).toBeFocused();
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

    // Wait for table to be ready
    await page.waitForTimeout(500);

    // Click first cell to focus the table
    await page.getByRole('gridcell').first().click({ force: true });
    await page.waitForTimeout(300);

    const values = ['alpha', 'bravo', 'charlie', 'delta', 'echo'];

    // Type each value and immediately press Enter to move to the next row
    for (const value of values) {
      await page.keyboard.press('Enter');
      await page.waitForTimeout(100);
      await page.keyboard.type(value, { delay: 30 });
      await page.waitForTimeout(100);
    }

    // Wait for last typed value to register before exiting edit mode
    await page.waitForTimeout(500);

    // Exit edit mode
    await page.keyboard.press('Escape');

    // Wait for all debounced saves to complete
    await page.waitForTimeout(2000);

    // Verify all values are displayed correctly before refresh
    for (const value of values) {
      await expect(
        page.getByRole('gridcell', { name: value }),
        `Row "${value}" should be visible before refresh`,
      ).toBeVisible();
    }

    // Refresh and wait for the page to reload
    await page.reload();
    await expect(page.getByTestId('editable-title').first()).toBeVisible();
    await page.waitForTimeout(REBUILD_INDEX_TIME);

    // Verify all values are still correct after refresh
    for (const value of values) {
      await expect(
        page.getByRole('gridcell', { name: value }),
        `Row "${value}" should be visible after refresh`,
      ).toBeVisible();
    }
  });
});
