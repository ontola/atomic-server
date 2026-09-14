import { test, expect, type Page } from './fixtures';
import {
  before,
  contextMenuClick,
  editTitle,
  newResource,
  timestamp,
  waitForSynced,
} from './test-utils';

const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
const undoShortcut = `${modifier}+z`;
const redoShortcut = `${modifier}+Shift+z`;

async function editorText(page: Page): Promise<string> {
  return page.getByLabel('Rich Text Editor').evaluate(el => {
    const clone = el.cloneNode(true) as HTMLElement;
    clone
      .querySelectorAll('.ProseMirror-loro-cursor')
      .forEach(cursor => cursor.remove());

    return (clone.innerText ?? clone.textContent ?? '')
      .replace(/\s+/g, ' ')
      .trim();
  });
}

async function createDocument(page: Page, name: string) {
  await newResource('document', page);
  await editTitle(name, page);

  const editor = page.getByLabel('Rich Text Editor');
  await expect(editor).toBeVisible({ timeout: 30_000 });
  await expect(editor.locator('p').first()).toBeVisible();
  // Keep setup transactions out of the first user undo entry.
  await page.waitForTimeout(1_200);
  await editor.focus();

  return editor;
}

async function typeSeparateEdits(page: Page, chunks: string[]) {
  for (const chunk of chunks) {
    await page.keyboard.type(`${chunk} `);
    await expect(page.getByLabel('Rich Text Editor')).toContainText(chunk);
    // Loro's default 1000ms merge interval makes each edit an undo step.
    await page.waitForTimeout(1_150);
  }

  // The RTE saves through a 500ms debounce. Exercise undo only after its
  // autosave has had time to persist the content used by the route transition.
  await page.waitForTimeout(1_500);
}

async function visitDataViewAndReturn(page: Page, documentTitle: string) {
  const editor = page.getByLabel('Rich Text Editor');
  await page.getByTestId('editable-title').click();
  await contextMenuClick('data', page);
  await expect(page).toHaveURL(/\/app\/data/);
  await expect(editor).toHaveCount(0);

  // The Normal View menu action is currently disabled from Data View. This
  // route's built-in Back button returns to the same subject without reloading.
  await page.keyboard.press('Escape');
  const backButtonName = new RegExp(
    `^Back to ${documentTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`,
  );
  await page
    .getByRole('button', {
      name: backButtonName,
    })
    .click();
  await expect(page).toHaveURL(/\/app\/show/);
  await expect(editor).toBeVisible({ timeout: 30_000 });
}

test.describe('document undo', () => {
  test.beforeEach(before);

  test('undo and redo work after Data View and return', async ({ page }) => {
    test.slow();
    const documentTitle = `Undo after Data View ${timestamp()}`;
    const chunks = ['[view-one]', '[view-two]', '[view-three]'];
    const editor = await createDocument(page, documentTitle);
    await typeSeparateEdits(page, chunks);
    const savedText = await editorText(page);

    await visitDataViewAndReturn(page, documentTitle);
    await expect(editor).toContainText('[view-three]', { timeout: 30_000 });
    await editor.focus();
    await page.keyboard.press(undoShortcut);
    await expect(editor).not.toContainText('[view-three]');
    await page.keyboard.press(redoShortcut);
    await expect(editor).toContainText('[view-three]');
    expect(await editorText(page)).toBe(savedText);
    await waitForSynced(page);

    await page.reload();
    await expect(editor).toBeVisible({ timeout: 30_000 });
    await expect(editor).toContainText('[view-three]', { timeout: 30_000 });
    expect(await editorText(page)).toBe(savedText);
  });

  test('redo works after undo, Data View, and return', async ({ page }) => {
    test.slow();
    const documentTitle = `Redo after Data View ${timestamp()}`;
    const chunks = ['[redo-one]', '[redo-two]', '[redo-three]'];
    const editor = await createDocument(page, documentTitle);
    await typeSeparateEdits(page, chunks);
    const savedText = await editorText(page);

    await page.keyboard.press(undoShortcut);
    await expect(editor).not.toContainText('[redo-three]');
    await visitDataViewAndReturn(page, documentTitle);
    await expect(editor).not.toContainText('[redo-three]', { timeout: 30_000 });
    await editor.focus();
    await page.keyboard.press(redoShortcut);
    await expect(editor).toContainText('[redo-three]');
    expect(await editorText(page)).toBe(savedText);
    await waitForSynced(page);

    await page.reload();
    await expect(editor).toBeVisible({ timeout: 30_000 });
    await expect(editor).toContainText('[redo-three]', { timeout: 30_000 });
    expect(await editorText(page)).toBe(savedText);
  });
});
