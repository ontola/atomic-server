import { enableIntegrationDiscovery } from './integration-settings-utils';
import { test, expect } from '@playwright/test';
import { before, createFromCatalog } from './test-utils';

/**
 * The whole manual-run path, which is otherwise only ever verified by hand:
 * create a plugin, run it, review what it proposes, apply, and find the run in
 * the log. Everything below the UI has unit tests; this is the part that only
 * a browser can answer.
 */
test.describe('plugins', () => {
  test.beforeEach(before);
  test.beforeEach(async ({ page }) => {
    await enableIntegrationDiscovery(page);
  });

  test('a published release is discoverable and creates an independent draft', async ({
    page,
  }) => {
    await newPlugin(page);
    const source = `export const manifest = { schemaVersion: 1 };
export function run() { return { intents: [] }; }
// release fixture ${Date.now()}`;
    await setSource(page, source);
    const original = page.url();
    await page.getByRole('tab', { name: 'Code', exact: true }).click();
    const publication = page.waitForResponse(
      response =>
        response.url().endsWith('/plugin-release') &&
        response.request().method() === 'POST',
    );
    await page
      .getByRole('button', { name: 'Publish to integration store' })
      .click();
    const published = await publication;
    expect(published.ok()).toBe(true);
    const { id } = await published.json();
    await expect(
      page.getByRole('heading', { name: 'Integrations', exact: true }),
    ).toBeVisible();
    await page
      .getByRole('checkbox', { name: 'Show experimental plugins' })
      .check();
    const card = page
      .locator('[data-release]')
      .filter({
        has: page.getByRole('heading', { name: 'New plugin', exact: true }),
      })
      .filter({ hasText: id });
    await expect(card.getByText('Unverified', { exact: true })).toBeVisible();
    // Nothing happens to a published release before it has been reviewed, so
    // the card opens the installation review and the draft is one of the
    // choices there, beside installing it.
    await card.getByRole('button', { name: 'Open', exact: true }).click();
    await page
      .locator('dialog[open]')
      .getByRole('button', { name: 'Create draft', exact: true })
      .click();
    await expect(
      page
        .getByRole('main')
        .getByRole('heading', { name: 'New plugin', level: 1 }),
    ).toBeVisible();
    expect(page.url()).not.toBe(original);
    await page.goto(original);
    await page.getByRole('tab', { name: 'Code', exact: true }).click();
    await expect(
      page
        .getByRole('main')
        .getByText('export const manifest', { exact: false }),
    ).toBeVisible();
  });

  test('a plugin proposes changes, and nothing is written until you approve', async ({
    page,
  }) => {
    const main = page.getByRole('main');

    // The catalog starter creates the drive's plugin schema on first use.
    await newPlugin(page);

    // The starter source is what an author (or an LLM) reads first.
    await page.getByRole('tab', { name: 'Code', exact: true }).click();
    await expect(main.getByRole('code')).toContainText(
      'export function run(input)',
    );
    await page.getByRole('tab', { name: 'Activity', exact: true }).click();

    // Run appears once the drive's plugin class resolves — the menu subscribes
    // to the ontology, so no reload is needed after the schema is created.
    await page.getByRole('button', { name: 'More' }).click();

    const runItem = page.locator('[data-testid="menu-item-run-plugin"]');
    await expect(runItem).toBeVisible();
    await runItem.click();

    // The run has already happened: it holds no authority, so only writing
    // needs consent. The dialog is that boundary.
    const dialog = page.locator('dialog[open]');
    // The op is rendered lowercase and uppercased in CSS; `exact` keeps it
    // from also matching "created without a class…".
    await expect(dialog.getByText('create', { exact: true })).toBeVisible();
    await expect(dialog.getByText('Made by a plugin')).toBeVisible();

    const apply = dialog.getByRole('button', { name: /Apply 1 change/ });
    await expect(apply).toBeEnabled();

    // Running wrote nothing: the log behind the dialog still has no runs.
    await expect(main.getByText('This plugin has not run yet.')).toBeVisible();

    await apply.click();
    await expect(dialog).toBeHidden();

    // Now there is exactly one run, and it says what it did.
    await expect(main.getByRole('heading', { name: 'Runs' })).toBeVisible();
    // The status is rendered lowercase and uppercased in CSS; `exact` keeps it
    // from also matching the "1 applied" summary beside it.
    await expect(main.getByText('applied', { exact: true })).toBeVisible();
    await expect(main.getByText(/1 applied, 1 problem/)).toBeVisible();

    // Expanding it links to the resource the run actually created.
    await main.getByRole('button', { name: 'expand' }).first().click();
    await expect(main.getByRole('link', { name: 'example' })).toBeVisible();
  });

  test('a run whose target does not exist is blocked, and writes nothing', async ({
    page,
  }) => {
    const main = page.getByRole('main');

    await newPlugin(page);

    // Point the plugin at a resource that is not there. The source property is
    // drive-local, so it is found by its value rather than by a subject the
    // test would have to know — and only `window.store` is used, so this does
    // not couple the test to app module paths.
    await page.evaluate(async () => {
      const store = (
        window as unknown as {
          store: {
            getResource(s: string): Promise<{
              getPropVals(): Record<string, unknown>;
              set(p: string, v: unknown): Promise<void>;
              save(): Promise<unknown>;
            }>;
          };
        }
      ).store;

      const subject = decodeURIComponent(
        new URL(location.href).searchParams.get('subject')!,
      );
      const plugin = await store.getResource(subject);

      const sourceProp = Object.entries(plugin.getPropVals()).find(
        ([, value]) =>
          typeof value === 'string' && value.includes('export function run'),
      )?.[0];

      if (!sourceProp) throw new Error('plugin has no source property');

      await plugin.set(
        sourceProp,
        `export function run() {
          return {
            intents: [{ op: 'set', subject: 'https://example.com/ghost',
                        set: { 'https://atomicdata.dev/properties/name': 'nope' } }],
            problems: [],
          };
        }`,
      );
      await plugin.save();
    });

    await page.getByRole('button', { name: 'More' }).click();
    await page.locator('[data-testid="menu-item-run-plugin"]').click();

    const dialog = page.locator('dialog[open]');
    await expect(dialog.getByText(/does not exist/)).toBeVisible();
    // A blocked plan has nothing to apply, so Apply is not offered at all.
    await expect(dialog.getByRole('button', { name: /Apply/ })).toHaveCount(0);

    // Cancelling a blocked run still records it: a refusal that leaves no
    // trace reads the same as a plugin that never ran.
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(dialog).toBeHidden();

    await page.getByRole('tab', { name: 'Activity', exact: true }).click();
    await expect(main.getByText('blocked', { exact: true })).toBeVisible();
  });
  test('a plugin asks for the credentials it declares, and nothing else', async ({
    page,
  }) => {
    const main = page.getByRole('main');

    await newPlugin(page);

    await page.getByRole('tab', { name: 'Settings', exact: true }).click();

    // The starter needs no credentials, so it says so rather than showing an
    // empty heading with nowhere to type.
    await expect(main.getByText(/asks for no credentials/)).toBeVisible();

    await setSource(
      page,
      `export const manifest = {
         secrets: [{ name: 'provider', origin: 'https://api.provider.test',
                     description: 'Provider API token' }],
       };
       export function run(ctx) {
         ctx.http({ url: 'https://api.provider.test/v1/search',
                    headers: { Authorization: 'Bearer secret:provider' } });
         return { intents: [], problems: [] };
       }`,
    );

    // A declared secret is one labelled field: the name and origin come from
    // the plugin, so neither is retyped.
    await expect(main.getByText('Provider API token')).toBeVisible();
    await expect(
      main.getByPlaceholder(/Paste the value for provider/),
    ).toBeVisible();
  });

  test('a secret used but not declared still has somewhere to go', async ({
    page,
  }) => {
    const main = page.getByRole('main');

    await newPlugin(page);

    await setSource(
      page,
      `export function run(ctx) {
         ctx.http({ url: 'https://api.provider.test/v1/search',
                    headers: { Authorization: 'Bearer secret:tok' } });
         return { intents: [], problems: [] };
       }`,
    );

    await page.getByRole('tab', { name: 'Settings', exact: true }).click();

    // The author who forgot to declare is the one who cannot work out where to
    // enter it, so a slot appears anyway — with the origin read from the URL
    // rather than asked for.
    await expect(main.getByText(/sent only to/)).toBeVisible();
    await expect(main.getByText(/api\.provider\.test/).first()).toBeVisible();
    await expect(main.getByPlaceholder(/Value for tok/)).toBeVisible();
  });
});

/**
 * Asks for a new plugin and waits for its page.
 *
 * The first plugin on a drive materializes that drive's plugin schema before
 * anything can render: nineteen properties and classes, each its own resource.
 * The browser sends those writes together, but the server applies commits one
 * at a time, so the step costs what nineteen sequential writes cost. Measured
 * against a debug build: 5.2s on a fresh store, and 11s once the suite's
 * shared store holds a handful of drives, which is where this spec runs. The
 * suite's 10s default was never a budget this step could meet on CI hardware,
 * and it is what made these tests fail there while passing on a clean laptop.
 *
 * So the wait is widened here rather than for the whole suite, and the test
 * gets room for the part that comes after it. The wait is the symptom; making
 * the schema cheaper to create is its own change.
 */
async function newPlugin(page: import('@playwright/test').Page) {
  // `test.setTimeout` applies to the RUNNING TEST, not to the function it is
  // written in, so a bare call here overwrote whatever the caller asked for,
  // downward and without an error. The sidebar test above declares 240s three
  // lines before calling this, and had never once run on 240s: it ran on 120s
  // and died at a wall it had itself raised. Raise, never lower. Playwright uses 0 for "no timeout", so that case is
  // left alone rather than handed a ceiling it deliberately removed; a bare
  // `Math.max` here would be the same bug pointing the other way.
  const currentTimeout = test.info().timeout;

  if (currentTimeout !== 0 && currentTimeout < 120000) test.setTimeout(120000);
  await createFromCatalog(page, 'Plugin');
  await expect(
    page.getByRole('main').getByRole('heading', {
      name: 'New plugin',
      level: 1,
    }),
  ).toBeVisible({ timeout: 45000 });
}

/**
 * Replaces a plugin's source through `window.store`.
 *
 * The source property is drive-local and has no fixed subject, so it is found
 * by its value — which keeps the test off app module paths.
 */
async function setSource(
  page: import('@playwright/test').Page,
  source: string,
) {
  await page.evaluate(async (next: string) => {
    const store = (
      window as unknown as {
        store: {
          getResource(s: string): Promise<{
            getPropVals(): Record<string, unknown>;
            set(p: string, v: unknown): Promise<void>;
            save(): Promise<unknown>;
          }>;
        };
      }
    ).store;

    const subject = decodeURIComponent(
      new URL(location.href).searchParams.get('subject')!,
    );
    const plugin = await store.getResource(subject);

    const sourceProp = Object.entries(plugin.getPropVals()).find(
      ([, value]) =>
        typeof value === 'string' && value.includes('export function run'),
    )?.[0];

    if (!sourceProp) throw new Error('plugin has no source property');

    await plugin.set(sourceProp, next);
    await plugin.save();
  }, source);
}
