import { expect, test } from './fixtures';
import { before, newResource } from './test-utils';

test.beforeEach(before);

test('views a document body as a read-only escaped HTML snapshot', async ({
  page,
}) => {
  await newResource('document', page);

  const editor = page.getByLabel('Rich Text Editor');
  const text = 'A <tag> & character check';
  await expect(editor).toBeVisible();
  await editor.fill(text);
  await expect(editor).toContainText(text);

  // The source inspector snapshots a fully committed Loro document. Waiting
  // for the outbox makes this a document-state readiness check, not a delay.
  await expect
    .poll(
      () =>
        page.evaluate(
          () => window.store?.getSyncStatus().pendingDirtyCount === 0,
        ),
      { timeout: 15_000 },
    )
    .toBe(true);

  await page.getByRole('button', { name: 'More' }).click();
  await page.getByTestId('menu-item-view-source').click();

  const dialog = page.getByRole('dialog');
  await expect(
    dialog.getByRole('heading', { name: 'Document HTML' }),
  ).toBeVisible();

  const source = dialog.locator('[data-code-content]');
  const expectedHtml = '<p>A &lt;tag&gt; &amp; character check</p>';
  await expect(source).toHaveAttribute('data-code-content', expectedHtml);
  await expect(source.locator('[data-code-text]')).toHaveText(expectedHtml);
  await expect(
    dialog.getByRole('button', { name: 'Copy to clipboard' }),
  ).toBeVisible();
  await expect(dialog.locator('[contenteditable="true"]')).toHaveCount(0);
  await expect(dialog.getByRole('textbox')).toHaveCount(0);

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(editor).toBeVisible();
  await expect(editor).toContainText(text);
});
