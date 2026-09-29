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
});
