import { test, expect } from '@playwright/test';
import {
  signIn,
  newDrive,
  newResource,
  waitForCommit,
  before,
  inDialog,
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
      // Flay newline
      await page.waitForTimeout(300);
      // Wait for the table to refresh by checking if the next row is visible
      await expect(
        page.getByRole('rowheader', { name: `${currentRowNumber + 1}` }),
      ).toBeAttached();

      await page.keyboard.type(date);
      await tab();
      // check if focus is on the next column
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
    await signIn(page);
    await newDrive(page);

    // Create new Table
    await newResource('table', page);

    // Name table
    const tableName = 'Made up music genres';
    await page.getByPlaceholder('New Table').fill(tableName);
    await page.locator('dialog[open] button:has-text("Create")').click();
    await expect(page.locator(`h1:has-text("${tableName}")`)).toBeVisible();

    const dateColumnName = 'Existed since';
    // Create Date column
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
    ).toBeVisible();

    // Create Number column
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

    // Create Checkbox column
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

    // Create Select column
    await newColumn('Select');
    const selectColumnName = 'Descriptive words';

    await inDialog(page, async (dialog, closeDialogWith) => {
      await expect(page.locator('text=New Select Column')).toBeVisible();
      await dialog.getByPlaceholder('New Column').fill(selectColumnName);

      await createTag('😤', 'wild');
      await createTag('😵‍💫', 'dreamy');
      await createTag('🤨', 'wtf');
      await closeDialogWith('Create');
      await waitForCommit(page, undefined, 15000);
    });

    await expect(
      page.getByRole('button', { name: selectColumnName }),
    ).toBeVisible();

    await page.waitForTimeout(1000);
    await page.reload();
    
    // Wait for page to load before checking visibility
    await page.waitForLoadState('networkidle', { timeout: 10000 });
    
    // Retry logic for column visibility
    let columnVisible = false;
    for (let i = 0; i < 10; i++) {
      try {
        await expect(
          page.getByRole('button', { name: selectColumnName }),
        ).toBeVisible({ timeout: 1000 });
        columnVisible = true;
        break;
      } catch {
        await page.waitForTimeout(200);
        // Reload page again if column is not visible
        if (i % 3 === 2) {
          await page.reload();
          await page.waitForLoadState('networkidle', { timeout: 5000 });
        }
      }
    }
    
    if (!columnVisible) {
      throw new Error(`Column "${selectColumnName}" not visible after multiple retries`);
    }

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
    // Start filling cells
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

    // Move to the first cell and change its content.
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

    // Move to the index cell on the second row and delete the row.
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('Backspace');

    await expect(
      page.getByRole('gridcell', { name: 'Drum or Bass' }),
    ).not.toBeVisible();
  });
});
