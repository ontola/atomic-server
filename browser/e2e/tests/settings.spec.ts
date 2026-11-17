import { test, expect } from './fixtures';
import { before, FRONTEND_URL } from './test-utils';

test.describe('settings', () => {
  test.beforeEach(before);

  test('finds the page transition animation toggle with settings search', async ({
    page,
  }) => {
    await page.goto(`${FRONTEND_URL}/app/settings`);

    const settingsSearch = page.getByPlaceholder('Search settings...');
    // #1566 made the animations opt-in and renamed the toggle, which now
    // carries a parenthetical about Chromium. Matched on the words the
    // setting's own search keywords use, so the next wording change does not
    // break this again.
    const transitionToggle = page.getByRole('checkbox', {
      name: /page transition animations/i,
    });

    await settingsSearch.fill('transition');
    await expect(transitionToggle).toBeVisible();

    await settingsSearch.fill('animation');
    await expect(transitionToggle).toBeVisible();
  });

  test('search shows only the matching settings, not the whole section', async ({
    page,
  }) => {
    await page.goto(`${FRONTEND_URL}/app/settings`);
    await page.getByPlaceholder('Search settings...').fill('color');

    const main = page.getByRole('main');
    await expect(main.getByText('Main color', { exact: true })).toBeVisible();
    await expect(
      main.getByRole('checkbox', { name: 'Colorful mode', exact: true }),
    ).toBeVisible();
    await expect(main.getByText('Theme', { exact: true })).toHaveCount(0);
    await expect(main.getByLabel('Language', { exact: true })).toHaveCount(0);
  });

  test('opening a section closes the one that was open', async ({ page }) => {
    await page.goto(`${FRONTEND_URL}/app/settings`);
    const main = page.getByRole('main');

    await main.getByText('Appearance', { exact: true }).click();
    await expect(main.getByText('Main color', { exact: true })).toBeVisible();

    await main.getByText('Accessibility', { exact: true }).click();
    await expect(
      main.getByRole('checkbox', { name: /page transition animations/i }),
    ).toBeVisible();
    await expect(main.getByText('Main color', { exact: true })).toBeHidden();
  });
});
