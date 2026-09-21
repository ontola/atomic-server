import { test, expect } from '@playwright/test';
import { before, waitForSynced } from './test-utils';
import { createBakery } from './website-inline-fixture';

test('inline website editing saves rich documents and typed prices to Atomic', async ({
  page,
}) => {
  await before({ page });
  const fixture = await createBakery(page);
  const { frame, editor, clear } = fixture;
  const priceField = frame.locator('dd [contenteditable]').nth(1);
  await expect(priceField).toHaveText('4.5');
  await priceField.fill('5.75');
  await page.getByText('Click an outlined field', { exact: false }).click();
  await expect
    .poll(() =>
      page.evaluate(
        async ({ row, price }) =>
          (await window.store.getResource(row)).get(price),
        { row: fixture.row, price: fixture.price },
      ),
    )
    .toBe(5.75);
  await expect(editor).toContainText('Fresh bread every morning.');
  await expect(editor.locator('..').locator('..')).toHaveCSS(
    'background-color',
    'rgba(0, 0, 0, 0)',
  );
  await clear();
  await editor.pressSequentially('/heading');
  await expect(frame.getByText('Heading 1', { exact: true })).toBeVisible();
  await editor.press('Enter');
  await editor.pressSequentially('A heading');
  await expect(editor.locator('h1')).toHaveText('A heading');
  await clear();
  await editor.press('ControlOrMeta+Alt+0');
  await editor.pressSequentially('# ');
  await editor.pressSequentially('Markdown heading');
  await expect(editor.locator('h1')).toHaveText('Markdown heading');
  await clear();
  await editor.pressSequentially('@');
  await expect(
    frame.getByText('Products', { exact: true }).last(),
  ).toBeVisible();
  await editor.press('Escape');
  await editor.fill('Fresh pastries every morning.');
  await page.getByText('Click an outlined field', { exact: false }).click();
  await waitForSynced(page);
  await page.getByRole('button', { name: 'Done editing', exact: true }).click();
  await expect(frame.getByText('Fresh pastries every morning.')).toBeVisible();
  await page.reload();
  await expect(frame.getByText('Fresh pastries every morning.')).toBeVisible();
  await expect(frame.locator('dd').nth(1)).toHaveText('5.75');
});
