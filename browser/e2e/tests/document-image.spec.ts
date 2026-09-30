import { test, expect } from './fixtures';
import { before, openSubject, waitForClientDbFlush } from './test-utils';
import { core, dataBrowser } from '@tomic/lib';
import type { Page } from '@playwright/test';

/**
 * A PNG no earlier run can have put on the server. Blobs are content
 * addressed, so a fixed fixture file would be served by whichever test pushed
 * it first and hide an image that only exists locally.
 */
async function uniquePng(page: Page): Promise<Buffer> {
  const base64 = await page.evaluate(async () => {
    const canvas = new OffscreenCanvas(24, 16);
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = `hsl(${Math.floor(Math.random() * 360)} 70% 50%)`;
    ctx.fillRect(0, 0, 24, 16);
    ctx.fillText(crypto.randomUUID(), 0, 12);
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);

    return btoa(binary);
  });

  return Buffer.from(base64, 'base64');
}

test.describe('document images', () => {
  test.beforeEach(before);

  // A browser-only drive never sends its commits, or the bytes of its files,
  // to a server, so the `downloadURL` an upload is given points at bytes no
  // server has. The editor has to show the image from the local copy, the way
  // the file preview already does.
  test('an image uploaded in a browser-only drive renders in the document', async ({
    page,
  }) => {
    const documentSubject = await page.evaluate(
      async ({ documentClass, name }) => {
        const store = window.store;
        const drive = await store.createDrive('Browser-only workspace', {
          personal: false,
          localOnly: true,
        });
        const doc = await store.newResource({
          parent: drive.subject,
          isA: documentClass,
          propVals: { [name]: 'Document with an image' },
        });
        await doc.save();
        store.notifyResourceManuallyCreated(doc);

        return doc.subject;
      },
      {
        documentClass: dataBrowser.classes.document,
        name: core.properties.name,
      },
    );

    await openSubject(page, documentSubject);

    const editor = page.getByLabel('Rich Text Editor');
    await editor.click();
    await page.keyboard.type('/image');
    await expect(
      page
        .getByTestId('rte-command-list')
        .getByRole('button', { name: 'Image' }),
    ).toBeVisible();
    await page.keyboard.press('Enter');

    await page.getByRole('button', { name: 'Select File' }).click();
    await page.getByLabel('Upload', { exact: true }).setInputFiles({
      name: 'local-only.png',
      mimeType: 'image/png',
      buffer: await uniquePng(page),
    });
    await page.getByRole('button', { name: 'Save', exact: true }).click();

    const img = editor.locator('img');
    await expect(img).toBeVisible();
    await expect(page.getByText('Failed to load image.')).toHaveCount(0);
    await expect
      .poll(() => img.evaluate(el => (el as HTMLImageElement).naturalWidth))
      .toBeGreaterThan(0);
    // Rendered from the local bytes, not from a server that never got them.
    await expect(img).toHaveAttribute('src', /^blob:/);

    // And again after a reload, when the bytes come out of the local database.
    // The editor saves on a debounce; let that save land on disk first.
    await expect
      .poll(() =>
        page.evaluate(subject => {
          const store = window.store;
          const doc = store.resources.get(subject);

          return (
            !!doc &&
            !doc.hasUnsavedChanges() &&
            store.getSaveState(doc).scheduledCount === 0
          );
        }, documentSubject),
      )
      .toBe(true);
    await waitForClientDbFlush(page, { required: true });
    await page.reload();
    const reloaded = page.getByLabel('Rich Text Editor').locator('img');
    await expect(reloaded).toHaveAttribute('src', /^blob:/);
    await expect
      .poll(() =>
        reloaded.evaluate(el => (el as HTMLImageElement).naturalWidth),
      )
      .toBeGreaterThan(0);
    await expect(page.getByText('Failed to load image.')).toHaveCount(0);
  });
});
