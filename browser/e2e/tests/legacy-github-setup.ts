import { expect, type Page } from '@playwright/test';
import { enableAIForTesting, setupScriptedToolCallMocks } from './ai-mock';

/** Open the legacy GitHub connection dialog through the assistant tool. */
export async function openLegacyGithubSetup(
  page: Page,
  args: Record<string, unknown>,
) {
  const state = await setupScriptedToolCallMocks(
    page,
    [
      { tool: 'list_app_setups', args: {} },
      {
        tool: 'setup_app',
        args: {
          app: 'github-issues',
          arguments: args,
        },
      },
    ],
    'Complete the connection in the setup form.',
  );
  await enableAIForTesting(page);
  await page.reload();

  const sidebar = page.locator('[data-open]');
  const input = sidebar.locator('[contenteditable="true"]');
  await expect(input).toBeVisible();
  await input.fill('Connect our GitHub repository');
  const send = sidebar.getByTitle('Send');
  await expect(send).toBeEnabled({ timeout: 30000 });
  await send.click();

  const dialog = page.locator('dialog[open]');
  await expect(dialog.getByLabel('Repository', { exact: true })).toBeVisible({
    timeout: 30000,
  });

  return { dialog, state };
}
