import { test, expect } from '@playwright/test';
import { before } from './test-utils';
import {
  enableAIForTesting,
  openAISidebar,
  setupAIRouteMocks,
  sendChatMessage,
} from './ai-mock';

test('mobile AI chat fills the width and keeps its composer above the keyboard', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setupAIRouteMocks(page);
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
  await page.screenshot({ path: 'test-results/ai-mobile-keyboard.png' });
  await panel
    .getByRole('button', { name: 'Chat options', exact: true })
    .click();
  await expect(page.getByRole('combobox')).toBeVisible();
  await expect(page.getByText(/Tokens used:.*input,.*output/)).toBeVisible();
  await page.keyboard.press('Escape');
  await panel.getByRole('button', { name: 'Close AI Sidebar' }).click();
  await expect(panel).not.toHaveAttribute('data-open', '');
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
