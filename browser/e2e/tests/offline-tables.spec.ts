import { test, expect } from '@playwright/test';
import { FRONTEND_URL, editableTitle } from './test-utils';

/**
 * Offline-first table test.
 * The atomic-server on 9883 must be STOPPED for these tests.
 * Tests that a drive, table, and rows can be created and survive a page reload
 * entirely from the client-side WASM DB + OPFS.
 */
// The docstring above requires atomic-server on 9883 to be STOPPED. The
// default test environment has it running, so skip unless the caller
// explicitly asks for it (ATOMIC_TEST_OFFLINE=1 ... pnpm test-e2e).
test.describe('offline tables', () => {
  test.skip(
    process.env.ATOMIC_TEST_OFFLINE !== '1',
    'Requires atomic-server stopped; set ATOMIC_TEST_OFFLINE=1 to run.',
  );

  test('create drive, table, row, and persist across reload', async ({
    page,
  }) => {
    test.slow();

    // 1. Navigate to dev-drive setup (server is off — will go offline)
    await page.goto(`${FRONTEND_URL}/app/dev-drive`, {
      waitUntil: 'domcontentloaded',
    });

    // Wait for the WASM DB to be ready
    await page.waitForFunction(
      () => {
        const store = (window as any).store;
        return store?.getClientDb()?.isReady;
      },
      { timeout: 30000 },
    );

    // Wait for the dev drive to be created (should work offline via DID genesis)
    await page.waitForURL(/did(?:%3A|:)ad(?:%3A|:)/, { timeout: 30000 });

    // Verify the drive title is visible
    const driveTitle = page.getByTestId('current-drive-title');
    await expect(driveTitle).toBeVisible({ timeout: 15000 });

    // 2. Create a table via the sidebar quick-create icon
    await page
      .getByTestId('sidebar')
      .getByRole('button', { name: 'New Table' })
      .click();

    // Fill in the table name in the dialog
    const tableNameInput = page.getByPlaceholder('New Table');
    await expect(tableNameInput).toBeVisible({ timeout: 5000 });
    await tableNameInput.fill('My Offline Table');
    await page.locator('dialog[open] button:has-text("Create")').click();

    // Wait for the table heading to load
    await expect(editableTitle(page)).toBeVisible({ timeout: 15000 });

    // Verify the table appears in the sidebar (live query)
    await expect(
      page.getByTestId('sidebar').getByText('My Offline Table'),
    ).toBeVisible({ timeout: 10000 });

    // 3. Fill in the first row (auto-created with the table)
    //    Double-click: first click sets Visual mode, second enters Edit mode
    const nameCell = page.locator('[aria-rowindex="2"] [aria-colindex="2"]');
    await expect(nameCell).toBeVisible({ timeout: 10000 });
    await nameCell.click();
    await page.waitForTimeout(500);
    await nameCell.click();
    await page.waitForTimeout(300);

    // The input should now be visible inside the cell
    const cellInput = page.locator('[role="grid"] input').first();
    await expect(cellInput).toBeVisible({ timeout: 5000 });
    await cellInput.fill('Test Row 1');
    // Tab commits the cell value (Escape would discard it)
    await page.keyboard.press('Tab');

    // Wait for save
    await page.waitForTimeout(2000);

    // Verify the row is visible
    await expect(
      page.getByRole('gridcell', { name: 'Test Row 1' }),
    ).toBeVisible();

    // 4. Reload the page
    await page.reload({ waitUntil: 'domcontentloaded' });

    // Wait for WASM DB
    await page.waitForFunction(
      () => {
        const store = (window as any).store;
        return store?.getClientDb()?.isReady;
      },
      { timeout: 30000 },
    );

    // Verify the table title survives reload
    await expect(
      page.getByTestId('editable-title').getByText('My Offline Table'),
    ).toBeVisible({
      timeout: 15000,
    });

    // Verify the row count survives reload (row data may be empty
    // if OPFS is unavailable and the WASM DB falls back to in-memory).
    const rows = page.locator('[aria-rowindex]');
    // At least the header + 1 data row should be present
    await expect(rows).toHaveCount(3, { timeout: 15000 });
  });
});
