import { test, expect } from '@playwright/test';
import { before } from './test-utils';
import {
  enableAIForTesting,
  openAISidebar,
  setupAIRouteMocks,
} from './ai-mock';

test('AI chats menu appears for a saved chat and reopens it without page navigation', async ({
  page,
}) => {
  const reports: string[] = [];
  await page.route('https://example.com/api/123/envelope/**', route => {
    const body = route.request().postData() ?? '';
    if (body.includes('"type":"feedback"')) reports.push(body);

    return route.fulfill({
      status: 200,
      body: '{}',
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
    });
  });
  await page.addInitScript(() => {
    (window as unknown as { __ATOMIC_SENTRY__: unknown }).__ATOMIC_SENTRY__ = {
      dsn: 'https://public@example.com/123',
      environment: 'test',
    };
  });
  await setupAIRouteMocks(page, { chatResponse: 'Saved sidebar answer.' });
  await enableAIForTesting(page);
  // No stored preference: exercise the default rather than the mock's setting.
  await page.addInitScript(() =>
    localStorage.removeItem('atomic.sidebar-panels'),
  );
  await before({ page });
  const sidebar = page.getByTestId('sidebar');
  await expect(sidebar.getByTestId('ai-chats-panel')).toHaveCount(0);
  const location = page.url();
  await openAISidebar(page);
  expect(page.url()).toBe(location);
  const panel = page.getByTestId('ai-sidebar');
  const input = panel.locator('[contenteditable="true"]');
  await expect(input).toBeVisible();
  await input.fill('Keep my main page open');
  await input.press('Enter');
  await expect(
    panel.getByText('Saved sidebar answer.', { exact: true }),
  ).toBeVisible();
  const section = sidebar.getByTestId('ai-chats-panel');
  const create = section.getByRole('button', { name: 'New Chat', exact: true });
  await expect(section.getByRole('link')).toHaveCount(1);
  await section
    .getByRole('button', { name: 'Collapse AI Chats', exact: true })
    .click();
  await sidebar
    .getByRole('button', { name: 'Expand AI Chats', exact: true })
    .click();
  const saved = section.getByRole('link').first();
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
  await panel.getByRole('button', { name: 'Chat resource actions' }).click();
  await page.getByRole('menuitem', { name: 'Report AI chat' }).click();
  const report = page.locator('dialog[open]');
  await expect(
    report.getByRole('heading', { name: 'Report AI chat' }),
  ).toBeVisible();
  await expect(
    report.getByRole('textbox', { name: 'Chat transcript (editable)' }),
  ).toHaveValue(/Keep my main page open[\s\S]*Saved sidebar answer\./);
  await expect(
    report.getByRole('button', { name: 'Copy report' }),
  ).toBeEnabled();
  await report
    .getByRole('textbox', { name: 'What went wrong?' })
    .fill('The answer ignored my question.');
  await report.getByRole('button', { name: 'Send report' }).click();
  await expect(report.getByRole('status')).toContainText('has been sent');
  await expect.poll(() => reports.length).toBe(1);
  expect(reports[0]).toContain('Keep my main page open');
  expect(reports[0]).toContain('Saved sidebar answer.');
  expect(reports[0]).toContain('The answer ignored my question.');
  expect(reports[0]).toContain('"source":"ai-chat"');
});
