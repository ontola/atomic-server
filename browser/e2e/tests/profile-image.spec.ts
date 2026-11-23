/**
 * The profile picture of an agent: upload it from the settings page, then see
 * it in the full edit form (file picker) without that form breaking.
 */
import { test, expect } from './fixtures';
import { before, openAgentPage } from './test-utils';

// 8x8 red PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEklEQVR4nGP8z8DAwMDEgAAAAAkUAQDvlr3XAAAAAElFTkSuQmCC',
  'base64',
);

test.describe('profile image', () => {
  test.beforeEach(before);

  test('an uploaded picture shows in the avatar and in the edit form', async ({
    page,
  }) => {
    test.slow();
    await openAgentPage(page);

    const chooser = page.waitForEvent('filechooser');
    await page.locator('[data-test="change-avatar"]').click();
    await (
      await chooser
    ).setFiles({ name: 'me.png', mimeType: 'image/png', buffer: PNG });
    await page.getByRole('button', { name: 'Save', exact: true }).click();

    // The avatar is now an image instead of the placeholder.
    await expect(page.locator('[data-test="change-avatar"] img')).toBeVisible({
      timeout: 30_000,
    });

    await page.reload();
    await expect(page.locator('[data-test="change-avatar"] img')).toBeVisible({
      timeout: 30_000,
    });

    await page.getByRole('button', { name: 'More profile fields' }).click();
    await page.waitForURL(/\/app\/edit/);
    // The picker shows the uploaded file (the cropper re-encodes it).
    await expect(page.getByText(/^me\.\w+$/)).toBeVisible();
    await expect(page.getByLabel(/^me\.\w+ preview$/)).toBeAttached();
    await expect(page.getByText('Could not display file preview.')).toHaveCount(
      0,
    );
  });
});
