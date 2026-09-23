import { test, expect } from './fixtures';
import { before } from './test-utils';
import path from 'node:path';

test('cover keeps dragging until the pointer is released', async ({ page }) => {
  await before({ page });
  await page.getByRole('button', { name: 'Add cover', exact: true }).click();
  await page
    .getByLabel('Upload', { exact: true })
    .setInputFiles(
      path.resolve(
        'tests/e2e.spec.ts-snapshots/data-browser-upload-download-1-chromium-linux.png',
      ),
    );
  const reposition = page.getByRole('button', {
    name: 'Reposition',
    exact: true,
  });
  await expect(reposition).toBeAttached();
  const wrapper = reposition.locator('../..');
  await wrapper.hover();
  await reposition.click();
  const img = page.locator('img[style*="object-position"]');
  const box = (await img.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height * 0.6, {
    steps: 5,
  });
  const first = await img.evaluate(el => el.style.objectPosition);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height * 0.8, {
    steps: 5,
  });
  await expect
    .poll(() => img.evaluate(el => el.style.objectPosition))
    .not.toBe(first);
  await expect(
    page.getByText('Drag to reposition · release to save'),
  ).toBeVisible();
  await page.mouse.up();
  await expect(
    page.getByText('Drag to reposition · release to save'),
  ).toHaveCount(0);
});
