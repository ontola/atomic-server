import { test, expect } from '@playwright/test';
import { before } from './test-utils';
import {
  enableAIForTesting,
  openAISidebar,
  setupAIRouteMocks,
  setupScriptedToolCallMocks,
  sendChatMessage,
} from './ai-mock';

test('mobile AI chat fills the width and keeps its composer above the keyboard', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setupAIRouteMocks(page);
  // A long saved title must leave room for both header action buttons.
  await page.route('https://openrouter.ai/api/v1/chat/completions**', route => {
    if (route.request().postDataJSON().stream) return route.fallback();

    return route.fulfill({
      json: {
        id: 'chat-title-test',
        object: 'chat.completion',
        created: 1234567890,
        model: '~google/gemini-flash-latest',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: 'Planning a detailed project with AI chat',
            },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      },
    });
  });

  await enableAIForTesting(page);
  await before({ page });
  await openAISidebar(page);
  const panel = page.getByTestId('ai-sidebar');
  const composer = panel.getByTestId('assistant-file-dropzone');
  await expect(composer.locator('[contenteditable="true"]')).toBeVisible();
  await expect(
    panel.getByRole('heading', { name: 'AI chat', exact: true }),
  ).toBeVisible();
  await expect
    .poll(async () => Math.round((await panel.boundingBox())!.width))
    .toBe(390);
  await expect
    .poll(async () => Math.round((await panel.boundingBox())!.x))
    .toBe(0);
  await expect(panel.getByRole('combobox')).toHaveCount(0);
  await panel
    .getByRole('button', { name: 'Chat options', exact: true })
    .click();
  await expect(page.getByRole('combobox')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('combobox')).toHaveCount(0);
  await sendChatMessage(page, 'Hello');
  await expect(
    panel.getByText('This is a mock AI response.', { exact: true }),
  ).toBeVisible();

  for (const testId of ['ai-message-text', 'ai-user-message']) {
    await expect
      .poll(async () =>
        panel.getByTestId(testId).evaluate(element => {
          const parentWidth =
            element.parentElement!.getBoundingClientRect().width;

          return Math.abs(parentWidth - element.getBoundingClientRect().width);
        }),
      )
      .toBeLessThanOrEqual(1);
  }

  await expect(panel.getByText('Tokens used:', { exact: false })).toHaveCount(
    0,
  );
  // The app's keyboard hook publishes this inset when Android covers the
  // layout viewport. Exercise that layout without requiring a real keyboard.
  await page.evaluate(() =>
    document.documentElement.style.setProperty('--keyboard-inset', '320px'),
  );
  await expect
    .poll(async () => {
      const box = (await composer.boundingBox())!;

      return box.y + box.height;
    })
    .toBeLessThanOrEqual(524);
  await expect
    .poll(async () => (await composer.boundingBox())!.height)
    .toBeLessThan(140);
  const resourceMenu = panel.getByRole('button', {
    name: 'Chat resource actions',
    exact: true,
  });
  await expect(resourceMenu).toBeInViewport();
  await expect
    .poll(async () => {
      const button = (await resourceMenu.boundingBox())!;

      return button.x + button.width;
    })
    .toBeLessThanOrEqual(390);
  await expect
    .poll(() =>
      panel.evaluate(element => element.scrollWidth - element.clientWidth),
    )
    .toBeLessThanOrEqual(1);
  await page.screenshot({ path: 'test-results/ai-chat-header-menu.png' });
  await panel
    .getByRole('button', { name: 'Chat options', exact: true })
    .click();
  await expect(page.getByRole('combobox')).toBeVisible();
  await expect(page.getByText(/Tokens used:.*input,.*output/)).toBeVisible();
  await page.keyboard.press('Escape');
  await panel
    .getByRole('button', { name: 'Chat resource actions', exact: true })
    .click();
  await expect(page.getByRole('menuitem', { name: /Data View/ })).toBeVisible();
  await page.screenshot({
    path: 'test-results/ai-chat-resource-menu-open.png',
    animations: 'disabled',
  });
  // Navigate through the chat menu, not the underlying drive's menu.
  await page.getByRole('menuitem', { name: /Normal View/ }).click();
  await panel.getByRole('button', { name: 'Close AI Sidebar' }).click();
  await expect(panel).not.toHaveAttribute('data-open', '');
  await expect(
    page
      .getByRole('main')
      .getByText('This is a mock AI response.', { exact: true }),
  ).toBeVisible();
  await expect(
    page
      .getByRole('main')
      .getByRole('button', { name: 'Chat resource actions', exact: true }),
  ).toBeVisible();
});

test('desktop AI chat keeps the composer inside the docked panel', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await setupAIRouteMocks(page);
  await page.route('https://openrouter.ai/api/v1/models**', route =>
    route.fulfill({
      json: {
        data: [
          {
            id: '~google/gemini-flash-latest',
            name: 'Gemini Flash',
            architecture: {
              input_modalities: ['text', 'image'],
              output_modalities: ['text'],
            },
            pricing: { prompt: 0, completion: 0 },
          },
          {
            id: 'test/alternate',
            name: 'Alternate model',
            architecture: {
              input_modalities: ['text'],
              output_modalities: ['text'],
            },
            pricing: { prompt: 0, completion: 0 },
          },
        ],
      },
    }),
  );
  await enableAIForTesting(page);
  await before({ page });
  await openAISidebar(page);
  const panel = page.getByTestId('ai-sidebar');
  const composer = panel.getByTestId('assistant-file-dropzone');
  await expect(composer).toBeVisible();
  await expect
    .poll(async () => {
      const box = (await composer.boundingBox())!;
      const panelBox = (await panel.boundingBox())!;

      return box.y + box.height - panelBox.y - panelBox.height;
    })
    .toBeLessThanOrEqual(0);
  await panel
    .getByRole('button', { name: 'Chat options', exact: true })
    .click();
  await expect(page.getByRole('combobox')).toBeVisible();
  await page.getByRole('combobox').click();
  await page.getByRole('option', { name: /Alternate model/ }).click();
  await expect(page.getByRole('combobox')).toHaveCount(0);
  await expect(composer.locator('[contenteditable="true"]')).toBeFocused();
  await panel
    .getByRole('button', { name: 'Chat options', exact: true })
    .click();
  await expect(page.getByRole('combobox')).toHaveValue('Alternate model');
});

test('keyboard resize keeps the final sentence visible without a spacer above the composer', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const ending = 'This final sentence must remain fully readable.';
  await setupScriptedToolCallMocks(
    page,
    [],
    Array(15)
      .fill(
        'A longer response fills the chat with useful information and several lines of text.',
      )
      .join('\n\n') +
      '\n\n' +
      ending,
  );
  await enableAIForTesting(page);
  await before({ page });
  await sendChatMessage(page, 'Give me a long answer');
  const panel = page.getByTestId('ai-sidebar');
  const lastLine = panel.getByText(ending, { exact: true });
  await expect(lastLine).toBeVisible();
  const viewport = panel.locator('[data-radix-scroll-area-viewport]');
  await viewport.evaluate(element => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(lastLine).toBeInViewport();
  await page.evaluate(() =>
    document.documentElement.style.setProperty('--keyboard-inset', '320px'),
  );
  await expect
    .poll(async () => {
      const text = (await lastLine.boundingBox())!;
      const bounds = (await viewport.boundingBox())!;

      return text.y + text.height - bounds.y - bounds.height;
    })
    .toBeLessThanOrEqual(0);
  const composer = panel.getByTestId('assistant-file-dropzone');
  const bounds = (await viewport.boundingBox())!;
  expect(
    (await composer.boundingBox())!.y - bounds.y - bounds.height,
  ).toBeLessThanOrEqual(8);
  const finalText = (await lastLine.boundingBox())!;
  expect(
    (await composer.boundingBox())!.y - finalText.y - finalText.height,
  ).toBeLessThanOrEqual(16);
  await page.screenshot({ path: 'test-results/ai-mobile-long-keyboard.png' });
  await viewport.evaluate(element => {
    element.scrollTop = 100;
  });
  await expect
    .poll(() => viewport.evaluate(element => element.scrollTop))
    .toBe(100);
  await page.evaluate(() =>
    document.documentElement.style.setProperty('--keyboard-inset', '240px'),
  );
  await expect
    .poll(() =>
      viewport.evaluate(
        element =>
          element.scrollHeight - element.clientHeight - element.scrollTop,
      ),
    )
    .toBeGreaterThan(100);
});
