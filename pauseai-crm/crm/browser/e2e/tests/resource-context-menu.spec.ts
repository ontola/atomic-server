import { test, expect, type Locator, type Page } from '@playwright/test';
import { before, focusCell, newResource } from './test-utils';

/**
 * Right-clicks `target` until its context menu is open AND shows `items`.
 *
 * The menu mounts hidden and reveals a frame after positioning, and a
 * right-click landing while a previous menu is still closing is swallowed —
 * so the open has to be retried, not merely waited on. The expected items
 * are part of the retried unit, not asserted afterwards: a menu can open and
 * then close again before a follow-up assertion runs (a late re-render or a
 * focus steal under load unmounts it), and "some menu was briefly visible"
 * is not the thing any caller actually needs.
 */
async function openContextMenu(page: Page, target: Locator, items: Locator[]) {
  await expect(async () => {
    await target.click({ button: 'right' });
    await expect(
      page.getByRole('menu').filter({ visible: true }).first(),
    ).toBeVisible({ timeout: 2_000 });

    for (const item of items) {
      await expect(item).toBeVisible({ timeout: 2_000 });
    }
  }).toPass({ timeout: 20_000 });
}

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
    await openContextMenu(page, sidebarLink, [
      page.getByTestId('menu-item-history'),
    ]);
    // Close it.
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu')).toHaveCount(0);

    // --- Table cell (Cell seam) ---
    // Type into the first cell, then Enter to advance off the row so it
    // materializes into a real (persisted) resource, and reload so it renders
    // as a collection member with a real subject.
    // Drive the cell the way `tables.spec` does for a blank table's virtual
    // row — a forced click, then Enter to open the editor. The cell element
    // itself never takes focus here, so no focus assertion is possible; what
    // makes this honest is checking the row exists before going on. The CI
    // snapshot for this failure showed both gridcells empty and a row count of
    // 0: the keystrokes went nowhere, and no amount of waiting for saves
    // afterwards can recover a row that was never created.
    // Focus must be IN the grid before typing: after a table is created it is
    // on the title input, and keystrokes follow focus.
    await focusCell(page, page.getByRole('gridcell').first());
    await page.keyboard.press('Enter');
    await page.keyboard.type('hello');
    await page.keyboard.press('Enter');

    await expect(
      page.getByRole('gridcell', { name: 'hello', exact: true }),
    ).toBeVisible();

    // Only now is waiting for the outbox meaningful; reloading before the row
    // reaches the server throws it away.
    await page.waitForFunction(
      () => window.store?.getSyncStatus().pendingDirtyCount === 0,
      undefined,
      { timeout: 15_000 },
    );
    await page.reload();

    const persistedCell = page
      .getByRole('gridcell')
      .filter({ hasText: 'hello' })
      .first();
    await expect(persistedCell).toBeVisible();
    // Right-click the persisted cell → resource menu.
    await openContextMenu(page, persistedCell, [
      page.getByTestId('menu-item-history'),
    ]);
    await page.keyboard.press('Escape');

    // --- Table header (column menu on right-click) ---
    // Right-clicking a column header opens the same menu as its kebab button.
    await openContextMenu(page, page.getByRole('columnheader').nth(1), [
      page.getByTestId('menu-item-hide'),
      page.getByTestId('menu-item-remove'),
    ]);
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
