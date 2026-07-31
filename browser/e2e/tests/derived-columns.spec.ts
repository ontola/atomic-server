import { test, expect, type Page } from '@playwright/test';
import { before, inDialog, newResource } from './test-utils';

/** The grid row containing `text`. */
const row = (page: Page, text: string) =>
  page.getByRole('row').filter({ hasText: text });

/** Opens Add column → Computed and fills in the dialog. */
async function addComputedColumn(
  page: Page,
  spec: {
    kind: string;
    name: string;
    /** Argument name → the option label to pick. */
    args: Record<string, string>;
    /** Argument name → the number to type, for "A fixed number…" arguments. */
    literals?: Record<string, string>;
  },
) {
  await page.getByRole('button', { name: 'Add column' }).click();
  await page.getByTestId('menu-item-computed').click();

  await inDialog(page, async () => {
    await page.getByTestId('derived-kind').selectOption(spec.kind);
    await page.getByTestId('derived-label').fill(spec.name);

    for (const [arg, label] of Object.entries(spec.args)) {
      await page.getByTestId(`derived-arg-${arg}`).selectOption({ label });
    }

    for (const [arg, value] of Object.entries(spec.literals ?? {})) {
      await page.getByTestId(`derived-literal-${arg}`).fill(value);
    }

    // By test id, not by its label: the button's text is translated, so a
    // missing catalog entry would fail this as if the feature were broken.
    await page.getByTestId('derived-save').click();
  });
}

test.describe('computed columns', () => {
  test.beforeEach(before);

  test('a human can add, edit and remove one, in any table view', async ({
    page,
  }) => {
    // The Time tracker template gives two timestamp columns and a quick way to
    // fill them: start an entry and stop it.
    await newResource('table', page);
    await page.getByRole('button', { name: /Time tracker/ }).click();
    await page.getByPlaceholder('New Table').fill('Computed columns');
    await page.getByRole('button', { name: 'Create' }).click();

    await expect(page.getByTestId('timer-new-input')).toBeVisible();
    await expect(page.getByRole('grid')).toBeVisible();
    await page.waitForTimeout(500);

    await page.getByTestId('timer-new-input').fill('Write docs');
    await page.getByTestId('timer-start-new').click();
    const entry = row(page, 'Write docs');
    await expect(entry).toBeVisible();
    await entry.getByTestId('timer-stop').click();
    await expect(entry.getByTestId('timer-resume')).toBeVisible();

    // Everything below happens in the plain table view — computed columns are
    // not a timer feature.
    await page.getByRole('tab', { name: 'All entries' }).click();
    await expect(page.getByTestId('timer-new-input')).toHaveCount(0);
    await expect(page.getByRole('grid')).toBeVisible();

    // A column computed from two date columns.
    await addComputedColumn(page, {
      kind: 'difference',
      name: 'Logged',
      args: { from: 'Start', to: 'End' },
    });

    await expect(
      page.getByRole('button', { name: 'Edit computed column' }),
    ).toBeVisible();
    await expect(
      row(page, 'Write docs').getByTestId('derived-logged'),
    ).toHaveText(/^\d+:\d{2}:\d{2}$/);

    // And one whose second argument is a number typed into the dialog rather
    // than read off a column.
    await addComputedColumn(page, {
      kind: 'offset',
      name: 'Next due',
      args: { from: 'Start', days: 'A fixed number…' },
      literals: { days: '14' },
    });

    await expect(
      row(page, 'Write docs').getByTestId('derived-next-due'),
    ).toHaveText(/\d{2}\/\d{2}\/\d{4}/);

    // Renaming keeps the column (and its value): it is the same spec, edited.
    const logged = await row(page, 'Write docs')
      .getByTestId('derived-logged')
      .textContent();
    await page
      .getByRole('button', { name: 'Edit computed column' })
      .first()
      .click();
    await page.getByTestId('menu-item-edit').click();
    await inDialog(page, async () => {
      await page.getByTestId('derived-label').fill('Time spent');
      await page.getByTestId('derived-save').click();
    });

    await expect(page.getByText('Time spent')).toBeVisible();
    await expect(
      row(page, 'Write docs').getByTestId('derived-logged'),
    ).toHaveText(logged ?? '');

    // Both live on the View, so they survive a reload.
    await page.reload();
    await expect(page.getByRole('grid')).toBeVisible();
    await expect(page.getByText('Time spent')).toBeVisible();
    await expect(
      row(page, 'Write docs').getByTestId('derived-next-due'),
    ).toBeVisible();

    // Removing one leaves the other alone — and removes no data.
    await page
      .getByRole('button', { name: 'Edit computed column' })
      .first()
      .click();
    await page.getByTestId('menu-item-remove').click();
    await inDialog(page, async (_dialog, closeDialogWith) => {
      await closeDialogWith('Remove');
    });

    await expect(
      row(page, 'Write docs').getByTestId('derived-logged'),
    ).toHaveCount(0);
    await expect(
      row(page, 'Write docs').getByTestId('derived-next-due'),
    ).toBeVisible();
    await expect(
      page.getByRole('gridcell', { name: 'Write docs' }),
    ).toBeVisible();
  });

  test('a computed column can be resized, and the width sticks', async ({
    page,
  }) => {
    // The Time tracker template's timer view has both kinds of view-added
    // column: a configured Duration and the timer's own Start/Stop.
    await newResource('table', page);
    await page.getByRole('button', { name: /Time tracker/ }).click();
    await page.getByPlaceholder('New Table').fill('Resizable');
    await page.getByRole('button', { name: 'Create' }).click();

    await expect(page.getByTestId('timer-new-input')).toBeVisible();
    await expect(page.getByRole('grid')).toBeVisible();
    await page.waitForTimeout(500);

    // A timer view leads with its own columns: Duration (2) and the Start/Stop
    // button (3), then the stored ones.
    const duration = page.locator('[role="columnheader"][aria-colindex="2"]');
    const timer = page.locator('[role="columnheader"][aria-colindex="3"]');

    const widthOf = async (column: typeof duration) =>
      Math.round((await column.boundingBox())!.width);

    // Both start narrower than a text column — a duration and a button don't
    // need 300px.
    expect(await widthOf(duration)).toBeLessThan(200);
    expect(await widthOf(timer)).toBeLessThan(120);

    /** Drags a column's right edge by `by` pixels. */
    const resizeBy = async (column: typeof duration, by: number) => {
      const box = (await column.boundingBox())!;
      const x = box.x + box.width - 1;
      const y = box.y + box.height / 2;
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x + by, y, { steps: 10 });
      await page.mouse.up();
      await page.waitForTimeout(1500);
    };

    await resizeBy(duration, 90);
    const widened = await widthOf(duration);
    expect(widened).toBeGreaterThan(200);

    // The timer's own column is narrower than the grid's old 100px floor, which
    // used to snap it wider instead of resizing it.
    await resizeBy(timer, -25);
    const narrowed = await widthOf(timer);
    expect(narrowed).toBeLessThan(70);

    // Widths live on the table, so they survive a reload.
    await page.reload();
    await expect(page.getByRole('grid')).toBeVisible();
    await page.waitForTimeout(500);

    expect(await widthOf(duration)).toBe(widened);
    expect(await widthOf(timer)).toBe(narrowed);
  });

  test('columns can be reordered, including the ones a view adds', async ({
    page,
  }) => {
    await newResource('table', page);
    await page.getByRole('button', { name: /Time tracker/ }).click();
    await page.getByPlaceholder('New Table').fill('Reorderable');
    await page.getByRole('button', { name: 'Create' }).click();

    await expect(page.getByTestId('timer-new-input')).toBeVisible();
    await expect(page.getByRole('grid')).toBeVisible();
    await page.waitForTimeout(500);

    const headings = () =>
      page.evaluate(() =>
        Array.from(document.querySelectorAll('[role="columnheader"]'))
          .slice(1)
          .map(el => (el.textContent ?? '').replace('Drag column', '').trim()),
      );

    // A timer view leads with its own columns.
    expect((await headings()).slice(0, 3)).toEqual([
      'Duration',
      'Timer',
      'name',
    ]);

    // Drag the Duration heading past `name` by its handle.
    const handle = page
      .locator('[role="columnheader"][aria-colindex="2"]')
      .getByRole('button', { name: 'Drag column' });
    const name = page.locator('[role="columnheader"][aria-colindex="4"]');
    const from = (await handle.boundingBox())!;
    const to = (await name.boundingBox())!;

    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(to.x + to.width - 5, to.y + to.height / 2, {
      steps: 15,
    });
    await page.mouse.up();
    await page.waitForTimeout(1200);

    const reordered = await headings();
    expect(reordered.indexOf('Duration')).toBeGreaterThan(
      reordered.indexOf('name'),
    );

    // The order lives on the View, so it survives a reload.
    await page.reload();
    await expect(page.getByRole('grid')).toBeVisible();
    await page.waitForTimeout(500);

    expect(await headings()).toEqual(reordered);
  });
});
