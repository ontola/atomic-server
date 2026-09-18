import { test, expect } from '@playwright/test';
import { before } from './test-utils';
import {
  enableAIForTesting,
  openAISidebar,
  setupAIRouteMocks,
} from './ai-mock';

test('dropping files on the Assistant preserves text and attaches each file once', async ({
  page,
}) => {
  await setupAIRouteMocks(page);
  await enableAIForTesting(page);
  await before({ page });
  // The right panel is transient state and is never restored from storage
  // (#1475), so it has to be opened before the dropzone exists.
  await openAISidebar(page);
  const zone = page.getByTestId('assistant-file-dropzone');
  const input = zone.locator('[contenteditable="true"]');
  await expect(input).toBeVisible();
  await input.fill('Please inspect this screenshot');
  const transfer = await page.evaluateHandle(() => {
    const data = new DataTransfer();
    data.items.add(new File(['test'], 'screenshot.png', { type: 'image/png' }));
    data.items.add(
      new File(['second'], 'reference.png', { type: 'image/png' }),
    );

    return data;
  });
  await zone.dispatchEvent('dragenter', { dataTransfer: transfer });
  await expect(
    zone.getByText('Drop files to attach', { exact: true }),
  ).toBeVisible();
  // Drop on the editor itself: its existing drop handler must not add a duplicate.
  await input.dispatchEvent('drop', { dataTransfer: transfer });
  await expect(zone.getByText('screenshot.png', { exact: true })).toHaveCount(
    1,
  );
  await expect(zone.getByText('reference.png', { exact: true })).toHaveCount(1);
  await expect(
    zone.getByText('Drop files to attach', { exact: true }),
  ).toHaveCount(0);
  await expect(input).toHaveText('Please inspect this screenshot');
  await zone.getByRole('button', { name: 'Remove file' }).first().click();
  await expect(zone.getByText('screenshot.png', { exact: true })).toHaveCount(
    0,
  );
  await expect(zone.getByText('reference.png', { exact: true })).toBeVisible();
});
