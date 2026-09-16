import { expect, type Page } from '@playwright/test';
import { waitForSynced } from './test-utils';

/**
 * A bakery website with one document and one product row, opened in
 * "Page edit" mode. Returns locators scoped to the preview iframe.
 */
export async function createBakery(page: Page) {
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
    const props = Object.fromEntries(
      ['name', 'shortname', 'datatype', 'description', 'classtype'].map(
        name => [name, 'https://atomicdata.dev/properties/' + name],
      ),
    );
    const { createWebsite, starterWebsite } =
      await import('/src/chunks/Website/websiteModel.ts');
    const price = await store.newResource({
      parent: store.getDrive(),
      isA: ['https://atomicdata.dev/classes/Property'],
      propVals: {
        [props.name]: 'Price',
        [props.shortname]: 'bread-price',
        [props.datatype]: 'https://atomicdata.dev/datatypes/float',
        [props.description]: 'Bread price',
      },
    });
    await price.save();
    const table = await store.newResource({
      parent: store.getDrive(),
      isA: ['https://atomicdata.dev/classes/Table'],
      propVals: {
        [props.name]: 'Products',
        [props.classtype]: 'https://atomicdata.dev/classes/Resource',
      },
    });
    await table.save();
    const row = await store.newResource({
      parent: table.subject,
      propVals: { [props.name]: 'Sourdough', [price.subject]: 4.5 },
    });
    await row.save();
    const config = starterWebsite('RTE bakery');
    config.pages[0].documents = [document];
    config.pages[0].tables = [
      {
        table: table.subject,
        title: 'Products',
        layout: 'grid',
        rows: [row.subject],
        columns: [
          { property: props.name, label: 'Product' },
          { property: price.subject, label: 'Price' },
        ],
      },
    ];
    const site = await createWebsite(store, store.getDrive()!, config);

    return { subject: site.subject, row: row.subject };
  }, documentSubject);
  // The @ menu searches the server index; wait until the row is findable so
  // the mention step does not race indexing.
  await expect
    .poll(
      () =>
        page.evaluate(async () =>
          window.store.search('sour', {
            limit: 5,
            include: false,
            parents: [window.store.getDrive()!],
          }),
        ),
      { timeout: 20_000 },
    )
    .toContain(fixture.row);
  await page.goto(
    `${new URL(page.url()).origin}/app/show?subject=${encodeURIComponent(fixture.subject)}`,
  );
  await page.getByRole('button', { name: 'Page edit', exact: true }).click();
  const frame = page.frameLocator('iframe[title="Website preview"]');
  const editor = frame.getByLabel('Rich Text Editor', { exact: true });
  await expect(editor).toContainText('Fresh bread every morning.');

  return { frame, editor };
}
