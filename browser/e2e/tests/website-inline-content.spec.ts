import { test, expect } from '@playwright/test';
import { before, waitForSynced } from './test-utils';

test('inline website editing saves rich documents and typed prices to Atomic', async ({
  page,
}) => {
  await before({ page });
  await page
    .getByRole('button', { name: 'New Document', exact: true })
    .first()
    .click();
  await page.locator('#document-editor').fill('Fresh bread every morning.');
  await page.getByRole('button', { name: 'More', exact: true }).click();
  await page.keyboard.press('Escape');
  await waitForSynced(page);
  const documentSubject = new URL(page.url()).searchParams.get('subject')!;
  const fixture = await page.evaluate(async document => {
    const store = window.store;
    const core = {
      classes: { property: 'https://atomicdata.dev/classes/Property' },
      properties: Object.fromEntries(
        ['name', 'shortname', 'datatype', 'description', 'classtype'].map(
          name => [name, 'https://atomicdata.dev/properties/' + name],
        ),
      ),
    };
    const Datatype = { FLOAT: 'https://atomicdata.dev/datatypes/float' };
    const { createWebsite, starterWebsite } =
      await import('/src/chunks/Website/websiteModel.ts');
    const price = await store.newResource({
      parent: store.getDrive(),
      isA: [core.classes.property],
      propVals: {
        [core.properties.name]: 'Price',
        [core.properties.shortname]: 'bread-price',
        [core.properties.datatype]: Datatype.FLOAT,
        [core.properties.description]: 'Bread price',
      },
    });
    await price.save();
    const table = await store.newResource({
      parent: store.getDrive(),
      isA: ['https://atomicdata.dev/classes/Table'],
      propVals: {
        [core.properties.name]: 'Products',
        [core.properties.classtype]: 'https://atomicdata.dev/classes/Resource',
      },
    });
    await table.save();
    const row = await store.newResource({
      parent: table.subject,
      propVals: { [core.properties.name]: 'Sourdough', [price.subject]: 4.5 },
    });
    await row.save();
    const config = starterWebsite('Inline bakery');
    config.pages[0].documents = [document];
    config.pages[0].tables = [
      {
        table: table.subject,
        title: 'Products',
        layout: 'grid',
        rows: [row.subject],
        columns: [
          { property: core.properties.name, label: 'Product' },
          { property: price.subject, label: 'Price' },
        ],
      },
    ];
    const site = await createWebsite(store, store.getDrive()!, config);

    return { subject: site.subject, row: row.subject, price: price.subject };
  }, documentSubject);
  await page.goto(
    `${new URL(page.url()).origin}/app/show?subject=${encodeURIComponent(fixture.subject)}`,
  );
  await page.getByRole('button', { name: 'Page edit', exact: true }).click();
  const frame = page.frameLocator('iframe[title="Website preview"]');
  const priceField = frame.locator('dd [contenteditable]').nth(1);
  await expect(priceField).toHaveText('4.5');
  await priceField.fill('5.75');
  await page.getByText('Click an outlined field', { exact: false }).click();
  await expect
    .poll(() =>
      page.evaluate(
        async ({ row, price }) =>
          (await window.store.getResource(row)).get(price),
        fixture,
      ),
    )
    .toBe(5.75);
  const editor = frame.getByLabel('Rich Text Editor', { exact: true });

  // Emptying the editor commits; the server echo of that commit rebuilds the
  // ProseMirror document and can swallow the keystrokes typed right after.
  const clear = async () => {
    await expect(async () => {
      // Not `fill('')`: Playwright's fill leaves atom nodes (mention cards)
      // and formatted blocks behind in ProseMirror. The editor's own keys
      // delete whatever the selection covers.
      await editor.press('ControlOrMeta+a');
      await editor.press('Backspace');
      await waitForSynced(page);
      // The echo can rebuild the document with the old text still in it;
      // only an editor that is empty after the sync is really cleared.
      await expect(editor).toHaveText('');
    }).toPass({ timeout: 20_000 });
  };

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
