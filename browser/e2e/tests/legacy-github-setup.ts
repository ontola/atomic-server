import { expect, type Page } from '@playwright/test';
import {
  enableAIForTesting,
  sendChatMessage,
  setupScriptedToolCallMocks,
} from './ai-mock';

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

  // The right panel is transient state and is never restored from storage
  // (#1475), so the panel has to be opened before the chat input exists.
  // `sendChatMessage` does that, and waits out vector indexing and toasts.
  await sendChatMessage(page, 'Connect our GitHub repository');

  const dialog = page.locator('dialog[open]');
  await expect(dialog.getByLabel('Repository', { exact: true })).toBeVisible({
    timeout: 30000,
  });

  return { dialog, state };
}
