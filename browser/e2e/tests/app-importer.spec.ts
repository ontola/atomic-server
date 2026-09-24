import { test, expect, type Page } from '@playwright/test';
import { before, createFromCatalog } from './test-utils';

/**
 * A drive app runs its own importer (atomic-server#1739).
 *
 * Which importer an app may run, and the summary it gets, are unit-tested in
 * `hostStore.test.ts`. Only a browser can show the rest: a click inside the
 * sandboxed frame brings up the host's bar, the host's picker and the
 * importer's own review, and applying that review writes the rows.
 */

const IMPORTER = `export const manifest = {
  schemaVersion: 2,
  name: 'lines',
  namespace: 'example',
  version: '0.1.0',
  secrets: [],
  operations: [],
  config: {
    key: 'lines',
    properties: {
      table: { type: 'string' },
      rowClass: { type: 'string' },
      properties: { type: 'object' },
    },
    required: ['table', 'rowClass', 'properties'],
  },
  accepts: [{ extensions: ['.txt'], mediaTypes: ['text/plain'], as: 'text', maxBytes: 10000 }],
  destination: {
    schema: {
      properties: [{ shortname: 'line-text', name: 'Line', description: 'One line of the file.', datatype: 'https://atomicdata.dev/datatypes/string' }],
      classes: [{ shortname: 'imported-line', name: 'Imported line', description: 'One line of an imported file.', requires: ['line-text'] }],
    },
    table: { name: 'Imported lines', rowClass: 'imported-line', columns: ['line-text'] },
  },
};

export function run(ctx) {
  const { table, rowClass, properties } = ctx.config;
  const lines = ctx.upload.text.split('\\n').map(line => line.trim()).filter(Boolean);
  if (lines.includes('bad')) throw new Error('This file has a bad line.');

  return {
    intents: lines.map(line => ({
      op: 'create',
      localId: 'line-' + line,
      parent: table,
      isA: [rowClass],
      set: {
        'https://atomicdata.dev/properties/name': line,
        [properties['line-text']]: line,
      },
    })),
    problems: [],
  };
}
`;

const APP = `export async function view({ root, store }) {
  root.innerHTML = '';
  const heading = document.createElement('h1');
  heading.textContent = 'Lines';
  const out = document.createElement('output');
  out.setAttribute('aria-label', 'Import result');
  const show = async running => {
    out.textContent = 'Importing…';
    try {
      const r = await running;
      out.textContent = r.status === 'applied'
        ? 'Imported: ' + r.created + ' created, ' + r.updated + ' updated, ' + r.failed + ' failed'
        : r.status + (r.errors ? ': ' + r.errors.join(' ') : '');
    } catch (e) {
      out.textContent = 'Refused: ' + e.message;
    }
  };
  const button = (label, onClick) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.onclick = onClick;
    return b;
  };
  root.append(
    heading,
    button('Import lines', () => show(store.importer.run({
      file: { name: 'lines.txt', mediaType: 'text/plain', text: 'alpha\\nbeta\\n' },
    }))),
    button('Import a file', () => show(store.importer.run())),
    button('Run another importer', () => show(store.importer.run({ importer: 'did:ad:someone-else' }))),
    out,
  );
}
`;

test.describe('an app runs its own importer', () => {
  test.beforeEach(before);

  test('the person reviews and applies, and the app gets a summary', async ({
    page,
  }) => {
    test.setTimeout(300_000);
    const main = page.getByRole('main');
    const table = await setUpImporter(page);
    await addAppAsView(page, table);
    const app = page.frameLocator('iframe[title="App"]');

    // Screenshots for review at phone width: APP_IMPORT_SHOTS_MOBILE=1. Set
    // up above runs at desktop width, where the catalog is laid out for it.
    if (process.env.APP_IMPORT_SHOTS_MOBILE) {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.reload();
      const tab = main.getByRole('tab', { name: 'New app' });
      // Clicking the selected tab opens its menu instead.
      if ((await tab.getAttribute('aria-selected')) !== 'true')
        await tab.click();
      await expect(app.getByRole('heading', { name: 'Lines' })).toBeVisible({
        timeout: 45_000,
      });
    }

    const result = app.getByRole('status', { name: 'Import result' });
    const bar = main.getByRole('group', { name: 'Import with this app' });
    const dialog = page.locator('dialog[open]');

    // A file the app hands over: the host names it, and nothing runs until
    // the person says so.
    await app.getByRole('button', { name: 'Import lines' }).click();
    await expect(bar).toContainText('This app wants to import lines.txt');
    await expect(bar).toContainText('Line importer');
    await screenshot(page, 'app-import-1-ask');
    await bar.getByRole('button', { name: 'Preview import' }).click();

    // The importer's own review, unchanged.
    const apply = dialog.getByRole('button', { name: 'Apply 2 changes' });
    await expect(apply).toBeVisible({ timeout: 120_000 });
    await screenshot(page, 'app-import-3-review');
    await apply.click();
    await expect(dialog).toBeHidden({ timeout: 30_000 });
    await expect(result).toHaveText(
      'Imported: 2 created, 0 updated, 0 failed',
      { timeout: 30_000 },
    );
    await screenshot(page, 'app-import-4-summary');

    // Written: the rows are in the table.
    await main.getByRole('tab', { name: 'Imported lines' }).click();
    await expect(main.getByText('alpha').first()).toBeVisible({
      timeout: 30_000,
    });
    await expect(main.getByText('beta').first()).toBeVisible();
    await main.getByRole('tab', { name: 'New app' }).click();

    // No file from the app: the host's own picker. Closing the review
    // without applying writes nothing, and the app hears so.
    await app.getByRole('button', { name: 'Import a file' }).click();
    await expect(bar).toContainText('Choose the file here');
    await screenshot(page, 'app-import-2-picker');
    const chooser = page.waitForEvent('filechooser');
    await bar.getByRole('button', { name: 'Choose file' }).click();
    await (
      await chooser
    ).setFiles({
      name: 'more.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('gamma\n'),
    });
    await expect(
      dialog.getByRole('button', { name: 'Apply 1 changes' }),
    ).toBeVisible({ timeout: 120_000 });
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(result).toHaveText('cancelled', { timeout: 30_000 });

    // A file the importer refuses never reaches a review.
    await app.getByRole('button', { name: 'Import a file' }).click();
    const refused = page.waitForEvent('filechooser');
    await bar.getByRole('button', { name: 'Choose file' }).click();
    await (
      await refused
    ).setFiles({
      name: 'bad.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('bad\n'),
    });
    await expect(result).toContainText('This file has a bad line.', {
      timeout: 60_000,
    });
    await expect(dialog).toHaveCount(0);

    // Only its own importer.
    await app.getByRole('button', { name: 'Run another importer' }).click();
    await expect(result).toContainText(
      'Refused: This app may only run its own importer',
    );
    await expect(bar).toHaveCount(0);
  });
});

/** Creates the importer, runs its Set up, and returns the table it created. */
async function setUpImporter(page: Page): Promise<string> {
  const main = page.getByRole('main');
  await createFromCatalog(page, 'Plugin');
  await expect(
    main.getByRole('heading', { name: 'New plugin', level: 1 }),
  ).toBeVisible({ timeout: 45_000 });
  await page.evaluate(async source => {
    const store = window.store!;
    const subject = new URL(location.href).searchParams.get('subject')!;
    const plugin = await store.getResource(subject);
    const sourceProp = Object.entries(plugin.getPropVals()).find(
      ([, value]) =>
        typeof value === 'string' && value.includes('export function run'),
    )?.[0];
    if (!sourceProp) throw new Error('plugin has no source property');
    await plugin.set(sourceProp, source);
    await plugin.set('https://atomicdata.dev/properties/name', 'Line importer');
    await plugin.save();
  }, IMPORTER);
  await expect(
    main.getByRole('heading', { name: 'Line importer', level: 1 }),
  ).toBeVisible();
  await page.getByRole('tab', { name: 'Import', exact: true }).click();
  await main.getByRole('button', { name: 'Set up', exact: true }).click();
  await expect(main.getByLabel('File to import')).toBeVisible({
    timeout: 120_000,
  });
  // The config Set up stored, under the manifest's key: `{ lines: { table } }`.
  const table = await page.evaluate(async () => {
    const subject = new URL(location.href).searchParams.get('subject')!;
    const plugin = await window.store!.getResource(subject);

    for (const value of Object.values(plugin.getPropVals())) {
      const config = (value as { lines?: { table?: unknown } } | null)?.lines;
      if (typeof config?.table === 'string') return config.table;
    }

    throw new Error('Set up stored no table');
  });
  await page.goto(showUrl(page, table));
  await expect(main.getByRole('tablist')).toBeVisible({ timeout: 30_000 });

  return table;
}

/** A new app running {@link APP}, added as a view of `table`. */
async function addAppAsView(page: Page, table: string) {
  const rowClass = await page.evaluate(
    async subject =>
      (await window.store!.getResource(subject)).get(
        'https://atomicdata.dev/properties/classtype',
      ) as string,
    table,
  );
  await createFromCatalog(page, 'App');
  await expect(
    page.getByRole('main').locator('iframe[title="App"]'),
  ).toBeVisible({ timeout: 45_000 });
  await page.evaluate(
    async args => {
      const store = window.store!;
      const subject = new URL(location.href).searchParams.get('subject')!;
      const app = await store.getResource(subject);
      let loaded = false;

      for (const [property, value] of Object.entries(app.getPropVals())) {
        if (Array.isArray(value)) {
          // `renders`: the drive's own property listing the classes this app
          // can show.
          if (property.startsWith('https://atomicdata.dev/')) continue;
          const first = await store
            .getResource(String(value[0]))
            .catch(() => undefined);
          const isA = first?.get('https://atomicdata.dev/properties/isA');
          if (
            Array.isArray(isA) &&
            isA.includes('https://atomicdata.dev/classes/Class')
          )
            await app.set(property, [...value, args.rowClass]);
          continue;
        }

        if (typeof value !== 'string' || !value.includes(':')) continue;
        const child = await store.getResource(value).catch(() => undefined);
        const sourceProp =
          child &&
          Object.entries(child.getPropVals()).find(
            ([, v]) =>
              typeof v === 'string' && v.includes('export async function view'),
          )?.[0];
        if (!child || !sourceProp) continue;
        await child.set(sourceProp, args.source);
        await child.save();
        loaded = true;
      }

      await app.save();
      if (!loaded) throw new Error('could not find the app’s entry point');
    },
    { source: APP, rowClass },
  );

  await page.goto(showUrl(page, table));
  const main = page.getByRole('main');
  await main.getByRole('button', { name: 'Add view' }).click();
  await page.getByRole('menuitem', { name: 'New app' }).click();
  await expect(
    page.frameLocator('iframe[title="App"]').getByRole('heading', {
      name: 'Lines',
    }),
  ).toBeVisible({ timeout: 45_000 });
}

function showUrl(page: Page, subject: string): string {
  return `${new URL(page.url()).origin}/app/show?subject=${encodeURIComponent(subject)}`;
}

/** Saved for the PR when `APP_IMPORT_SHOTS` names a directory. */
async function screenshot(page: Page, name: string) {
  const dir = process.env.APP_IMPORT_SHOTS;
  if (!dir) return;
  const width = page.viewportSize()?.width ?? 0;
  await page.screenshot({
    animations: 'disabled',
    path: `${dir}/${name}-${width < 768 ? 'mobile' : 'desktop'}.png`,
  });
}
