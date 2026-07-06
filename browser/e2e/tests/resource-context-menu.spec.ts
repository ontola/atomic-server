import { test, expect, type Page } from '@playwright/test';
import { before, newResource } from './test-utils';

test.describe('resource context menu', () => {
  test.beforeEach(before);

  test('sidebar link + table cell open the resource menu on right-click', async ({
    page,
  }: {
    page: Page;
  }) => {
    // A plain table with one row.
    await newResource('table', page);
    await page.getByRole('button', { name: /Blank/ }).click();
    await page.getByPlaceholder('New Table').fill('Widgets');
    await page.getByRole('button', { name: 'Create' }).click();

    // --- Sidebar link (AtomicLink seam) ---
    const sidebarLink = page
      .getByRole('navigation')
      .getByRole('button', { name: 'Widgets' })
      .first();
    await sidebarLink.click({ button: 'right' });
    await expect(page.getByRole('menu')).toBeVisible();
    await expect(page.getByTestId('menu-item-history')).toBeVisible();
    // Close it.
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu')).toHaveCount(0);

    // --- Table cell (Cell seam) ---
    // Type into the first cell, then Enter to advance off the row so it
    // materializes into a real (persisted) resource, and reload so it renders
    // as a collection member with a real subject.
    await page.getByRole('gridcell').nth(1).click();
    await page.keyboard.type('hello');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1000);
    await page.reload();

    const persistedCell = page
      .getByRole('gridcell')
      .filter({ hasText: 'hello' })
      .first();
    await expect(persistedCell).toBeVisible();
    // Right-click the persisted cell → resource menu.
    await persistedCell.click({ button: 'right' });
    await expect(page.getByRole('menu')).toBeVisible();
    await expect(page.getByTestId('menu-item-history')).toBeVisible();
    await page.keyboard.press('Escape');

    // --- Table header (column menu on right-click) ---
    // Right-clicking a column header opens the same menu as its kebab button.
    await page.getByRole('columnheader').nth(1).click({ button: 'right' });
    await expect(page.getByRole('menu')).toBeVisible();
    await expect(page.getByTestId('menu-item-hide')).toBeVisible();
    await expect(page.getByTestId('menu-item-remove')).toBeVisible();
  });
});
