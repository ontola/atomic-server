/**
 * The demo workspace's scripted speech is written as chat log entries
 * authored as the personas (planning/chat-log.md), not as Message resources.
 */
import { test, expect } from './fixtures';
import { FRONTEND_URL } from './test-utils';

test('the demo team chat shows its seeded lines as entries', async ({
  page,
}) => {
  test.setTimeout(180000);
  await page.goto(`${FRONTEND_URL}/app/demo`);
  await expect(page.getByText('This workspace is a demo')).toBeVisible({
    timeout: 90000,
  });
  await page.getByText('Team chat', { exact: true }).first().click();
  const entry = page.locator('[data-entry-key]').filter({
    hasText: 'the onboarding board is all set up',
  });
  await expect(entry).toBeVisible({ timeout: 30000 });
  await expect(page.locator('[data-entry-key]').first()).toBeVisible();
});
