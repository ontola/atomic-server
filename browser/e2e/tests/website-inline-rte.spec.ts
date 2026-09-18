import { test, expect } from '@playwright/test';
import { before, waitForSynced } from './test-utils';
import { createBakery } from './website-inline-fixture';

/**
 * Rich-text controls inside the website preview iframe. The editor is
 * mounted through a React portal into a sandboxed iframe, so every menu,
 * popover and handle must live in the iframe's document, not the app's.
 *
 * Keys are typed with a small delay: Firefox mis-sequences 0ms synthetic
 * key bursts inside ProseMirror (characters land in a new paragraph), which
 * real typing never triggers.
 */

test('rich text menus, popovers and handles work inside the website preview', async ({
  page,
}) => {
  await before({ page });
  const { frame, editor, clear } = await createBakery(page);

  // Bubble menu: select text and toggle bold from the toolbar.
  await editor.fill('Bold me');
  await editor.press('ControlOrMeta+a');
  const bold = frame.getByTitle('Toggle bold');
  await expect(bold).toBeVisible();
  await bold.click();
  await expect(editor.locator('strong')).toHaveText('Bold me');

  // Node type select in the bubble menu.
  await editor.press('ControlOrMeta+a');
  await frame.locator('select').first().selectOption('heading-2');
  await expect(editor.locator('h2')).toContainText('Bold me');

  // Link popover must open inside the iframe and apply a link.
  await editor.press('ControlOrMeta+a');
  await frame.getByTitle('Set link').click();
  const linkInput = frame.getByPlaceholder('https://example.com');
  await expect(linkInput).toBeVisible();
  await linkInput.fill('https://example.com');
  const setLink = frame.getByRole('button', { name: 'Set', exact: true });
  await expect(setLink).toBeEnabled();
  // The popover's entry animation keeps the button moving briefly.
  await page.waitForTimeout(600);
  await setLink.click();
  await expect(editor.locator('a[href="https://example.com"]')).toContainText(
    'Bold me',
  );

  // Undo / redo through Loro history.
  await editor.press('ControlOrMeta+z');
  await expect(editor.locator('a')).toHaveCount(0);
  await editor.press('ControlOrMeta+Shift+z');
  await expect(editor.locator('a[href="https://example.com"]')).toHaveCount(1);

  // Mention: arrow navigation, escape, reopen and select.
  await clear();
  await editor.pressSequentially('@', { delay: 40 });
  await expect(frame.getByTestId('rte-command-list')).toBeVisible();
  await editor.pressSequentially('Sour', { delay: 40 });
  const mention = frame.locator('[id^="command-list-"]', {
    hasText: 'Sourdough',
  });
  await expect(mention).toBeVisible();
  await editor.press('Escape');
  await expect(mention).toBeHidden();
  await editor.press('Backspace');
  await editor.pressSequentially('r', { delay: 40 });
  await expect(mention).toBeVisible();
  await editor.press('ArrowDown');
  await editor.press('ArrowUp');
  await editor.press('Enter');
  await expect(editor.getByText('Sourdough', { exact: true })).toBeVisible();

  // Slash menu escapes and reopens too.
  await clear();
  await editor.pressSequentially('/quo', { delay: 40 });
  const quote = frame.locator('[id^="command-list-"]', { hasText: 'Quote' });
  await expect(quote).toBeVisible();
  await editor.press('Escape');
  await expect(quote).toBeHidden();
  await editor.press('Backspace');
  await editor.pressSequentially('o', { delay: 40 });
  await expect(quote).toBeVisible();
  await editor.press('Enter');
  await editor.pressSequentially('Quoted', { delay: 40 });
  await expect(editor.locator('blockquote')).toContainText('Quoted');

  // Image insertion shows the picker inside the iframe.
  await clear();
  await editor.pressSequentially('/image', { delay: 40 });
  // Confirm the slash menu shows the entry before accepting it, as the quote
  // step above does; Enter on a menu that has not (re)opened yet is a no-op.
  await expect(
    frame.locator('[id^="command-list-"]', { hasText: 'Image' }),
  ).toBeVisible();
  await editor.press('Enter');
  await expect(frame.getByPlaceholder('Enter a URL...')).toBeVisible();
  await editor.press('ControlOrMeta+z');
  await expect(frame.getByPlaceholder('Enter a URL...')).toBeHidden();

  // Drag handle appears next to the hovered block.
  await clear();
  await editor.pressSequentially('Drag me', { delay: 40 });
  await expect(editor).toHaveText('Drag me');
  await editor.locator('p').first().hover();
  await expect(frame.locator('.drag-handle')).toBeVisible();

  // The final content persists to the source document.
  await page.getByText('Click an outlined field', { exact: false }).click();
  await waitForSynced(page);
  await page.reload();
  await expect(frame.getByText('Drag me')).toBeVisible();
});
