import { test as setup, expect } from '@playwright/test';
import {
  before,
  DELETE_PREVIOUS_TEST_DRIVES,
  FRONTEND_URL,
  openAgentPage,
  signIn,
} from './test-utils';

setup('delete previous test data', async ({ page }) => {
  setup.slow();

  if (!DELETE_PREVIOUS_TEST_DRIVES) {
    expect(true).toBe(true);

    return;
  }

  await before({ page });
  await signIn(page);
  await page.goto(`${FRONTEND_URL}/app/prunetests`);
  await expect(page.getByText('Prune Test Data')).toBeVisible();
  await page.getByRole('button', { name: 'Prune' }).click();

  await expect(page.getByTestId('prune-result')).toBeVisible();

  // Remove old drives from the test agent.
  await openAgentPage(page);
  // Wait for the agent to be loaded
  await expect(
    page.getByRole('button', { name: 'Edit profile' }),
  ).toBeVisible();

  await page.getByRole('button', { name: 'Edit profile' }).click();

  try {
    const clearButton = page.getByRole('button', { name: 'Clear' });

    if (await clearButton.isVisible()) {
      await clearButton.click();
      await page.getByRole('button', { name: 'Save' }).click();
      await page.waitForNavigation();
    }
  } catch {
    // There were no drives to clear. Do nothing.
    await page.getByRole('button', { name: 'Back to Test User' }).click();
  }
});
