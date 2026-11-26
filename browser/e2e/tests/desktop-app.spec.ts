import { test, expect } from './fixtures';
import {
  before,
  FRONTEND_URL,
  pretendToBeTheApp,
  sideBarDriveSwitcher,
} from './test-utils';

/**
 * The desktop app, as far as a browser can stand in for it.
 *
 * Under Tauri the browser database is off (the embedded node holds
 * everything), so any flow that insists on local browser storage fails there
 * and only there. Setting `window.__TAURI_INTERNALS__` reaches that platform
 * default; nothing here calls `invoke`.
 */
test.describe('desktop app without a browser database', () => {
  test.beforeEach(before);

  test('creating a new drive works', async ({ page }) => {
    await pretendToBeTheApp(page);
    await page.goto(`${FRONTEND_URL}/app/welcome`);
    await page.getByRole('button', { name: 'Get started' }).click();
    await expect(page.getByTestId('getting-started')).toHaveCount(1, {
      timeout: 60_000,
    });
    await page.keyboard.press('Escape');

    await sideBarDriveSwitcher(page).click();
    await page.getByTestId('menu-item-new-drive').click();
    await expect(page.getByTestId('current-drive-title')).toHaveText(
      'My drive',
      { timeout: 30_000 },
    );
    await expect(page.getByText('needs local storage')).toHaveCount(0);
  });
});
