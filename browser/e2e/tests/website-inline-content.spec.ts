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
  const document = new URL(page.url()).searchParams.get('subject')!;
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
  }, document);
  await page.goto(
    `${new URL(page.url()).origin}/app/show?subject=${encodeURIComponent(fixture.subject)}`,
  );
  await page.getByRole('button', { name: 'Edit on page', exact: true }).click();
  const frame = page.frameLocator('iframe[title="Website preview"]');
  const price = frame.locator('dd [contenteditable]').nth(1);
  await expect(price).toHaveText('4.5');
  await price.fill('5.75');
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
  await expect(editor).toContainText('Fresh bread every morning.');
  await editor.fill('Fresh pastries every morning.');
  await page.getByText('Click an outlined field', { exact: false }).click();
  await waitForSynced(page);
  await page.getByRole('button', { name: 'Done editing', exact: true }).click();
  await expect(frame.getByText('Fresh pastries every morning.')).toBeVisible();
  await page.reload();
  await expect(frame.getByText('Fresh pastries every morning.')).toBeVisible();
  await expect(frame.locator('dd').nth(1)).toHaveText('5.75');
});
