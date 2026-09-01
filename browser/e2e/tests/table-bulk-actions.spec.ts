import { test, expect, Page } from '@playwright/test';
import { before, timestamp } from './test-utils';

/**
 * Create a table via the drive's quick-create button, type `names` as rows
 * (fast entry), then reload so the rows are collection members. Row-selection
 * checkboxes only render on persisted members, not on this-session draft rows,
 * so the reload is what makes them selectable.
 */
async function createTableWithRows(
  page: Page,
  tableName: string,
  names: string[],
) {
  await page.getByTitle('New Table').first().click();
  await page.getByPlaceholder('New Table').fill(tableName);
  await page.locator('dialog[open] button:has-text("Create")').click();
  await page.waitForURL(url => url.pathname.startsWith('/app/show'), {
    timeout: 15000,
  });
  await expect(page.getByTestId('editable-title').first()).toBeVisible({
    timeout: 15000,
  });
  // Leave the auto-focused title editor so keyboard entry lands in the grid.
  await page.keyboard.press('Escape');

  const firstCell = page.getByRole('gridcell').first();
  await expect(firstCell).toBeVisible({ timeout: 15000 });
  await firstCell.click({ force: true });
  await page.waitForTimeout(300);

  for (const name of names) {
    await page.keyboard.press('Enter');
    await page.waitForTimeout(100);
    await page.keyboard.type(name, { delay: 30 });
    await page.waitForTimeout(100);
  }

  await page.keyboard.press('Escape');
  await page.waitForFunction(
    () => window.store.getSyncStatus().pendingDirtyCount === 0,
    undefined,
    { timeout: 10000 },
  );

  await page.reload();
  await expect(page.getByTestId('editable-title').first()).toBeVisible({
    timeout: 15000,
  });
  await expect(
    page.getByRole('gridcell', { name: names[0], exact: true }),
  ).toBeVisible({ timeout: 15000 });
}

/** Reveal (on hover) and click the selection checkbox of a data row. */
async function selectRow(page: Page, rowIndex: number) {
  const row = page.locator(`[aria-rowindex="${rowIndex}"]`);
  // Checkbox is hidden until the index cell is hovered (or the row is checked).
  await row.getByRole('rowheader').hover();
  const checkbox = row.getByTestId('row-select-checkbox');
  await expect(checkbox).toBeVisible();
  await checkbox.click();
  await expect(checkbox).toBeChecked();
}

test.describe('table bulk actions', () => {
  test.beforeEach(before);

  test('select individual rows and bulk delete', async ({ page }) => {
    test.slow();
    await createTableWithRows(page, `Bulk Delete ${timestamp()}`, [
      'alpha',
      'beta',
      'gamma',
    ]);

    // Select the first two data rows individually (rowindex 2 and 3).
    await selectRow(page, 2);
    await selectRow(page, 3);

    await expect(page.getByTestId('bulk-selected-count')).toContainText('2');

    // Delete them via the bulk bar + confirmation dialog.
    await page.getByTestId('bulk-delete-button').click();
    const dialog = page.locator('dialog[open]').last();
    await expect(dialog).toBeVisible();
    // The confirm button is the last footer action (Cancel is first).
    await dialog.locator('footer button').last().click();
    await expect(dialog).toBeHidden();

    // The two selected rows are gone; the third remains.
    await expect(
      page.getByRole('gridcell', { name: 'alpha', exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole('gridcell', { name: 'beta', exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole('gridcell', { name: 'gamma', exact: true }),
    ).toBeVisible();

    // Selection is emptied, so the bulk bar goes away.
    await expect(page.getByTestId('table-bulk-actions')).toHaveCount(0);
  });

  test('select all and bulk set a property', async ({ page }) => {
    test.slow();
    await createTableWithRows(page, `Bulk Set ${timestamp()}`, [
      'one',
      'two',
      'three',
    ]);

    // Select every row via the header checkbox.
    await page.getByTestId('select-all-checkbox').click();
    await expect(page.getByTestId('bulk-selected-count')).toContainText('3');

    // Open the set-property dialog; the "name" column is the default target.
    await page.getByTestId('bulk-set-property-button').click();
    const dialog = page.locator('dialog[open]').last();
    await expect(dialog).toBeVisible();
    await dialog.getByRole('textbox').fill('Done');
    // Apply is the last footer action.
    await dialog.locator('footer button').last().click();
    await expect(dialog).toBeHidden();

    // All three rows now show the new value.
    await expect(
      page.getByRole('gridcell', { name: 'Done', exact: true }),
    ).toHaveCount(3, { timeout: 15000 });
  });
});
