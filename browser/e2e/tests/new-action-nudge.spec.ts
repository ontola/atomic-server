import { test, expect } from '@playwright/test';
import { before, sideBarNewResourceTestId } from './test-utils';
test.beforeEach(before);

test('sidebar New stands out until the New page has been opened once', async ({
  page,
}) => {
  const newButton = page.getByTestId(sideBarNewResourceTestId);

  await expect(newButton).toBeVisible();
  await expect(newButton).toHaveAttribute('data-highlighted', 'true');
  await page.screenshot({
    path: test.info().outputPath('new-action-highlighted.png'),
    animations: 'disabled',
  });

  await newButton.click();
  await expect(
    page.getByRole('heading', { name: 'Create something new' }),
  ).toBeVisible();
  await expect(newButton).not.toHaveAttribute('data-highlighted');

  // Remembered across reloads: it's a first-visit nudge, not a per-session one.
  await page.reload();
  await expect(page.getByTestId(sideBarNewResourceTestId)).toBeVisible();
  await expect(page.getByTestId(sideBarNewResourceTestId)).not.toHaveAttribute(
    'data-highlighted',
  );
});
