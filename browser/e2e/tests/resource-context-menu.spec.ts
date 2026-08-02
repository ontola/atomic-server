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
    // Right-click menus are searchable: filter is focused, typing narrows items.
    const rightClickFilter = page.getByPlaceholder(/Filter actions/);
    await expect(rightClickFilter).toBeFocused();
    await rightClickFilter.fill('histo');
    await expect(page.getByTestId('menu-item-history')).toBeVisible();
    await expect(page.getByTestId('menu-item-edit')).toHaveCount(0);
    await rightClickFilter.fill('');
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

  test('cmd+m opens searchable action menu; cmd+up goes to parent', async ({
    page,
  }: {
    page: Page;
  }) => {
    // The dev drive is the current resource; its did identifies it in URLs.
    const driveDid = decodeURIComponent(page.url()).match(
      /did:ad:[A-Za-z0-9_-]+/,
    )?.[0];
    expect(driveDid).toBeTruthy();

    await newResource('table', page);
    await page.getByRole('button', { name: /Blank/ }).click();
    await page.getByPlaceholder('New Table').fill('Widgets');
    await page.getByRole('button', { name: 'Create' }).click();
    await expect(page.getByRole('columnheader').nth(1)).toBeVisible();
    // Leave the table's cell editor — hotkeys are ignored while an input has
    // focus.
    await page.keyboard.press('Escape');

    // cmd+m opens the main resource menu with a focused filter input.
    await page.keyboard.press('ControlOrMeta+m');
    const menu = page.getByRole('menu');
    await expect(menu).toBeVisible();
    const filter = page.getByPlaceholder(/Filter actions/);
    await expect(filter).toBeFocused();

    // Typing narrows the items; Enter runs the selected action.
    await filter.fill('histo');
    await expect(page.getByTestId('menu-item-history')).toBeVisible();
    await expect(page.getByTestId('menu-item-edit')).toHaveCount(0);
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/history/);

    // Clicking the trigger while the menu is open closes it (no blur-then-
    // reopen race), and the menu must not cover its trigger.
    const moreButton = page.getByRole('button', { name: 'More' });
    await moreButton.click();
    await expect(menu).toBeVisible();
    const menuBox = await menu.boundingBox();
    const triggerBox = await moreButton.boundingBox();
    expect(menuBox!.y).toBeGreaterThanOrEqual(
      triggerBox!.y + triggerBox!.height,
    );
    await moreButton.click();
    await expect(menu).toHaveCount(0);

    // Back on the table, cmd+up navigates to the parent (the drive root).
    await page.goBack();
    await expect(page.getByRole('columnheader').nth(1)).toBeVisible();
    await page.keyboard.press('ControlOrMeta+ArrowUp');
    await page.waitForURL(url =>
      decodeURIComponent(url.toString()).includes(driveDid!),
    );
  });
});
