import { expect, test } from './fixtures';
import { before, newResource, reloadReconnected } from './test-utils';

declare global {
  interface Window {
    __loroToDeltaCalls?: number;
  }
}

test.describe('document typing', () => {
  test.beforeEach(before);

  // Full suite only: it verifies the production editor bundle, where a
  // minifier can change a ProseMirror step constructor name.
  test('types at a plain tail without materializing the LoroText', async ({
    page,
  }) => {
    await newResource('document', page);
    const editor = page.getByLabel('Rich Text Editor');
    await expect(editor).toBeVisible({ timeout: 30_000 });
    await editor.click();
    await page.keyboard.type('plain ');
    await page.keyboard.press('ControlOrMeta+b');
    await page.keyboard.type('bold');
    await page.keyboard.press('ControlOrMeta+b');
    await page.keyboard.type(' tail ');
    await expect(editor.locator('strong')).toHaveText('bold');

    // Use the LoroText constructor's prototype: individual wrappers may be
    // replaced as the editor synchronizes, whereas the actual hot-path method
    // remains on this prototype.
    await page.evaluate(() => {
      const subject = new URL(window.location.href).searchParams.get('subject');
      const resource = subject
        ? window.store?.resources.get(subject)
        : undefined;
      // `LoroMap.get` answers `{}`, so walking the tree needs a shape to walk.
      // Only `get` is used here; the node is handed to `getPrototypeOf` after.
      type LoroNode = { get(key: string | number): LoroNode | undefined };
      const root = resource?.getLoroDoc()?.getMap('doc') as
        | LoroNode
        | undefined;
      const paragraph = root?.get('children')?.get(0);
      const text = paragraph?.get('children')?.get(0);
      if (!text) throw new Error('Document LoroText did not initialize');

      const prototype = Object.getPrototypeOf(text) as {
        toDelta: (...args: unknown[]) => unknown;
      };
      const original = prototype.toDelta;
      window.__loroToDeltaCalls = 0;

      prototype.toDelta = function (...args: unknown[]) {
        window.__loroToDeltaCalls = (window.__loroToDeltaCalls ?? 0) + 1;

        return original.apply(this, args);
      };
    });

    const frameCosts: number[] = [];

    for (let index = 0; index < 10; index += 1) {
      const started = await page.evaluate(() => performance.now());
      await page.keyboard.type('x');
      const frame = await page.evaluate(
        () => new Promise<number>(resolve => requestAnimationFrame(resolve)),
      );
      frameCosts.push(frame - started);
    }

    expect(await page.evaluate(() => window.__loroToDeltaCalls)).toBe(0);
    // Retain per-key frame samples in the test report without a timing gate.
    test.info().annotations.push({
      type: 'typing-frame-ms',
      description: frameCosts.map(cost => cost.toFixed(1)).join(', '),
    });
    await expect(editor).toContainText('plain bold tail ' + 'x'.repeat(10));

    await reloadReconnected(page);
    await expect(page.getByLabel('Rich Text Editor')).toContainText(
      'plain bold tail ' + 'x'.repeat(10),
      { timeout: 30_000 },
    );
  });
});
