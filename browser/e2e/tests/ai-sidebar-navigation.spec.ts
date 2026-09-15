import { test, expect } from '@playwright/test';
import { before } from './test-utils';
import { enableAIForTesting, setupAIRouteMocks } from './ai-mock';

test('AI chats default on, create beside toggle and reopen without page navigation', async ({
  page,
}) => {
  await setupAIRouteMocks(page, { chatResponse: 'Saved sidebar answer.' });
  await enableAIForTesting(page);
  // No stored preference: exercise the default rather than the mock's setting.
  await page.addInitScript(() =>
    localStorage.removeItem('atomic.sidebar-panels'),
  );
  await before({ page });
  const sidebar = page.getByTestId('sidebar');
  const toggle = sidebar.getByRole('button', {
    name: 'Collapse AI Chats',
    exact: true,
  });
  await expect(toggle).toBeVisible();
  const create = sidebar.getByRole('button', { name: 'New Chat', exact: true });
  await expect(create).toBeVisible();
  const location = page.url();
  await toggle.click();
  await create.click();
  expect(page.url()).toBe(location);
  const panel = page.getByTestId('ai-sidebar');
  const input = panel.locator('[contenteditable="true"]');
  await expect(input).toBeVisible();
  await input.fill('Keep my main page open');
  await input.press('Enter');
  await expect(
    panel.getByText('Saved sidebar answer.', { exact: true }),
  ).toBeVisible();
  await sidebar
    .getByRole('button', { name: 'Expand AI Chats', exact: true })
    .click();
  const saved = sidebar.getByTestId('ai-chats-panel').getByRole('link').first();
  await expect(saved).toBeVisible();
  await create.click();
  await expect(
    panel.getByText('Saved sidebar answer.', { exact: true }),
  ).toHaveCount(0);
  await saved.click();
  await expect(
    panel.getByText('Saved sidebar answer.', { exact: true }),
  ).toBeVisible();
  expect(page.url()).toBe(location);
  await expect(panel.getByRole('heading')).toHaveText(await saved.innerText());
});
