import { test, expect, type Page, type TestInfo } from './fixtures';
import {
  before,
  FRONTEND_URL,
  waitForRowsMaterialized,
  waitForSynced,
} from './test-utils';

const propertyPrefix = 'https://atomicdata.dev/properties/';
const classPrefix = 'https://atomicdata.dev/classes/';

/** Seed data, not the interactions being reviewed. Every case owns one drive. */
async function seedTable(page: Page, withTimer = false) {
  await page.waitForFunction(
    () =>
      window.store?.getClientDb()?.isReady === true &&
      window.store.getSyncStatus().serverConnected,
  );
  const fixture = await page.evaluate(
    async ({ P, C, timer }) => {
      const store = window.store;
      const rowClass = await store.newResource({
        parent: store.getDrive(),
        isA: `${C}Class`,
        propVals: {
          [`${P}shortname`]: 'review-entry',
          [`${P}description`]: 'TablePage acceptance review entries',
        },
      });
      await rowClass.save();

      const property = async (shortname: string, datatype: string) => {
        const resource = await store.newResource({
          parent: rowClass.subject,
          isA: `${C}Property`,
          propVals: {
            [`${P}shortname`]: shortname,
            [`${P}description`]: `${shortname} review column`,
            [`${P}datatype`]: `https://atomicdata.dev/datatypes/${datatype}`,
          },
        });
        await resource.save();

        return resource.subject;
      };

      const age = await property('age', 'integer');
      const birthday = await property('birthday', 'date');
      const start = timer ? await property('start', 'timestamp') : undefined;
      const end = timer ? await property('end', 'timestamp') : undefined;
      await rowClass.set(`${P}recommends`, [
        `${P}name`,
        age,
        birthday,
        ...(start && end ? [start, end] : []),
      ]);
      await rowClass.save();
      const table = await store.newResource({
        parent: store.getDrive(),
        isA: `${C}Table`,
        propVals: {
          [`${P}name`]: 'TablePage review',
          [`${P}classtype`]: rowClass.subject,
        },
      });
      await table.save();
      const rows: string[] = [];

      for (const [name, years, hours] of [
        ['Alice', 30, 0.5],
        ['Bob', 25, 2],
        ['Charlie', 35, 3],
      ] as const) {
        const row = await store.newResource({
          parent: table.subject,
          isA: rowClass.subject,
          propVals: {
            [`${P}name`]: name,
            [age]: years,
            ...(start && end
              ? {
                  [start]: 1_700_000_000_000,
                  [end]: 1_700_000_000_000 + hours * 3_600_000,
                }
              : {}),
          },
        });
        await row.save();
        rows.push(row.subject);
      }

      return {
        table: table.subject,
        rowClass: rowClass.subject,
        age,
        birthday,
        rows,
      };
    },
    { P: propertyPrefix, C: classPrefix, timer: withTimer },
  );
  await waitForRowsMaterialized(page);

  return fixture;
}

async function open(page: Page, subject: string) {
  await page.goto(
    `${FRONTEND_URL}/app/show?subject=${encodeURIComponent(subject)}`,
  );
}

/** Attach actual rendered states, including the narrow layout, to the report. */
async function screenshots(page: Page, testInfo: TestInfo, name: string) {
  for (const [layout, width, height] of [
    ['desktop', 1440, 1000],
    ['mobile', 390, 844],
  ] as const) {
    await page.setViewportSize({ width, height });
    const path = testInfo.outputPath(`${name}-${layout}.png`);
    await page.screenshot({ path, fullPage: true });
    await testInfo.attach(`${name}-${layout}`, {
      path,
      contentType: 'image/png',
    });
  }

  await page.setViewportSize({ width: 1440, height: 1000 });
}

const chip = (page: Page) =>
  page
    .getByRole('toolbar', { name: 'Table filters' })
    .getByRole('button', { name: /^Age/ });

test.describe('TablePage integration acceptance review', () => {
  test.beforeEach(before);

  test('edits to the first saved filter survive reload', async ({
    page,
  }, testInfo) => {
    const fixture = await seedTable(page);
    await open(page, fixture.table);
    await expect(
      page.getByRole('gridcell', { name: 'Alice', exact: true }),
    ).toBeVisible();
    await page.getByTitle('Filter', { exact: true }).click();
    await page.getByRole('menuitem', { name: 'Age', exact: true }).click();
    await page.getByLabel('Filter operator').selectOption('gt');
    await page.getByRole('textbox', { name: 'Filter value' }).fill('10');
    await expect(chip(page)).toContainText('greater than');
    await page.getByRole('textbox', { name: 'Filter value' }).fill('30');
    await expect(chip(page)).toContainText('30');
    await page.keyboard.press('Escape');
    await expect(
      page.getByRole('gridcell', { name: 'Charlie', exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('gridcell', { name: 'Alice', exact: true }),
    ).toHaveCount(0);
    await page.waitForFunction(
      ({ table, age, P }) => {
        const store = window.store;
        const view = store.resources.get(table)?.get(`${P}table-default-view`);
        const filters =
          typeof view === 'string'
            ? store.resources.get(view)?.get(`${P}view-filters`)
            : undefined;

        return (
          Array.isArray(filters) &&
          filters.some(
            f =>
              typeof f === 'object' &&
              f !== null &&
              !Array.isArray(f) &&
              f.property === age &&
              f.operator === 'gt' &&
              f.value === '30',
          )
        );
      },
      { ...fixture, P: propertyPrefix },
    );
    await waitForRowsMaterialized(page);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(chip(page)).toContainText('30');
    await expect(
      page.getByRole('gridcell', { name: 'Charlie', exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('gridcell', { name: 'Alice', exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole('gridcell', { name: 'Bob', exact: true }),
    ).toHaveCount(0);
    await screenshots(page, testInfo, 'first-filter-after-reload');
  });

  test('removing a column with deletion unchecked preserves the property and row values', async ({
    page,
  }, testInfo) => {
    const fixture = await seedTable(page);
    await open(page, fixture.table);
    await page
      .getByRole('button', { name: 'Age', exact: true })
      .click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Remove', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Remove column' });
    const deletion = dialog.getByRole('checkbox', {
      name: 'Delete property and its children',
    });
    await expect(deletion).toBeEnabled();
    await expect(deletion).not.toBeChecked();
    await screenshots(page, testInfo, 'remove-column-unchecked');
    await dialog.getByRole('button', { name: 'Remove', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await waitForRowsMaterialized(page);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(
      page.getByRole('gridcell', { name: 'Alice', exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Age', exact: true }),
    ).toHaveCount(0);
    const saved = await page.evaluate(
      async ({ rowClass, age, rows, P }) => {
        const store = window.store;
        const property = await store.getResource(age);
        const schema = await store.getResource(rowClass);
        const row = await store.getResource(rows[0]);

        return {
          shortname: property.get(`${P}shortname`),
          columns: schema.get(`${P}recommends`),
          age: row.get(age),
        };
      },
      { ...fixture, P: propertyPrefix },
    );
    expect(saved.shortname).toBe('age');
    expect(saved.columns).not.toContain(fixture.age);
    expect(saved.age).toBe(30);
    await screenshots(page, testInfo, 'column-removed-property-kept');
  });

  test('a dashboard borrowing an inferred timer duration filter matches the source table', async ({
    page,
  }, testInfo) => {
    const fixture = await seedTable(page, true);
    const dashboardSubject = await page.evaluate(
      async ({ table, P, C }) => {
        const store = window.store;
        const view = await store.newResource({
          parent: table,
          isA: `${C}View`,
          propVals: {
            [`${P}name`]: 'Long sessions',
            [`${P}view-kind`]: 'timer',
            [`${P}view-filters`]: [
              { derived: 'duration', operator: 'gte', value: '1.5' },
            ],
          },
        });
        await view.save();
        const source = await store.getResource(table);
        await source.set(`${P}table-views`, [view.subject]);
        await source.set(`${P}table-default-view`, view.subject);
        await source.save();
        const dashboard = await store.newResource({
          parent: store.getDrive(),
          isA: `${C}Dashboard`,
          propVals: { [`${P}name`]: 'Timer review dashboard' },
        });
        await dashboard.save();
        const count = await store.newResource({
          parent: dashboard.subject,
          isA: `${C}Block`,
          propVals: {
            [`${P}name`]: 'Long sessions count',
            [`${P}block-kind`]: 'stat',
            [`${P}block-source`]: table,
            [`${P}block-view`]: view.subject,
            [`${P}block-aggregate`]: { function: 'count' },
          },
        });
        await count.save();
        const list = await store.newResource({
          parent: dashboard.subject,
          isA: `${C}Block`,
          propVals: {
            [`${P}name`]: 'Matching sessions',
            [`${P}block-kind`]: 'view',
            [`${P}block-source`]: table,
            [`${P}block-view`]: view.subject,
          },
        });
        await list.save();
        await dashboard.set(`${P}dashboard-blocks`, [
          count.subject,
          list.subject,
        ]);
        await dashboard.set(
          `${P}dashboard-layout`,
          [
            { subject: count.subject, x: 0, y: 0, w: 4, h: 1 },
            { subject: list.subject, x: 0, y: 1, w: 12, h: 3 },
          ],
          false,
        );
        await dashboard.save();

        return dashboard.subject;
      },
      { ...fixture, P: propertyPrefix, C: classPrefix },
    );
    await waitForRowsMaterialized(page);
    await open(page, fixture.table);
    await expect(page.getByTestId('timer-new-input')).toBeVisible();
    await expect(
      page.getByRole('gridcell', { name: 'Bob', exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('gridcell', { name: 'Charlie', exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('gridcell', { name: 'Alice', exact: true }),
    ).toHaveCount(0);
    await screenshots(page, testInfo, 'timer-filter-source');
    await open(page, dashboardSubject);
    const count = page.getByTestId('dashboard-block').filter({
      has: page.getByRole('heading', {
        name: 'Long sessions count',
        exact: true,
      }),
    });
    await expect(count.getByText('2', { exact: true })).toBeVisible();
    const list = page.getByTestId('dashboard-block').filter({
      has: page.getByRole('heading', {
        name: 'Matching sessions',
        exact: true,
      }),
    });
    await expect(
      list.getByRole('gridcell', { name: 'Bob', exact: true }),
    ).toBeVisible();
    await expect(
      list.getByRole('gridcell', { name: 'Charlie', exact: true }),
    ).toBeVisible();
    await expect(
      list.getByRole('gridcell', { name: 'Alice', exact: true }),
    ).toHaveCount(0);
    await screenshots(page, testInfo, 'timer-filter-dashboard');
  });

  test('an existing saved date format remains selected until explicitly changed', async ({
    page,
  }, testInfo) => {
    const fixture = await seedTable(page);
    const savedFormat = await page.evaluate(
      async ({ birthday, P, C }) => {
        const store = window.store;
        const format = await store.newResource({
          parent: store.getDrive(),
          isA: `${C}DateFormat`,
          propVals: {
            [`${P}name`]: 'Existing saved format',
            [`${P}shortname`]: 'existing-saved-format',
          },
        });
        await format.save();
        const property = await store.getResource(birthday);
        await property.set(`${P}dateFormat`, format.subject);
        await property.save();

        return format.subject;
      },
      { ...fixture, P: propertyPrefix, C: classPrefix },
    );
    await waitForRowsMaterialized(page);
    await open(page, fixture.table);

    const edit = async () => {
      await page
        .getByRole('button', { name: 'Birthday', exact: true })
        .click({ button: 'right' });
      await page.getByRole('menuitem', { name: 'Edit', exact: true }).click();

      const dialog = page.getByRole('dialog').filter({
        has: page.getByRole('heading', { name: 'Edit Column', exact: true }),
      });
      await expect(dialog).toBeVisible();

      return dialog;
    };

    let dialog = await edit();
    await expect(
      dialog.getByRole('radio', { name: 'Saved format', exact: true }),
    ).toBeChecked();
    await expect(
      dialog.getByRole('radio', { name: 'Numeric', exact: true }),
    ).not.toBeChecked();
    await screenshots(page, testInfo, 'existing-date-format');
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await waitForSynced(page);
    expect(
      await page.evaluate(
        ({ birthday, P }) =>
          window.store.resources.get(birthday)?.get(`${P}dateFormat`),
        { ...fixture, P: propertyPrefix },
      ),
    ).toBe(savedFormat);
    await page.reload({ waitUntil: 'domcontentloaded' });
    dialog = await edit();
    await expect(
      dialog.getByRole('radio', { name: 'Saved format', exact: true }),
    ).toBeChecked();
    await dialog.getByRole('radio', { name: 'Numeric', exact: true }).check();
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await page.waitForFunction(
      ({ birthday, P }) =>
        window.store.resources.get(birthday)?.get(`${P}dateFormat`) ===
        'https://atomicdata.dev/classes/DateFormat/localNumeric',
      { ...fixture, P: propertyPrefix },
    );
    await waitForRowsMaterialized(page);
    await page.reload({ waitUntil: 'domcontentloaded' });
    dialog = await edit();
    await expect(
      dialog.getByRole('radio', { name: 'Numeric', exact: true }),
    ).toBeChecked();
    await expect(
      dialog.getByRole('radio', { name: 'Saved format', exact: true }),
    ).toHaveCount(0);
    await screenshots(page, testInfo, 'date-format-explicitly-changed');
  });
});
