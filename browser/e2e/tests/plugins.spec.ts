import { enableIntegrationDiscovery } from './integration-settings-utils';
import { test, expect } from '@playwright/test';
import { before, getDevDriveSecret, SERVER_URL } from './test-utils';
import {
  Agent,
  getPluginSync,
  pluginSyncSchedule,
  signRequest,
} from '@tomic/lib';

/**
 * The whole manual-run path, which is otherwise only ever verified by hand:
 * create a plugin, run it, review what it proposes, apply, and find the run in
 * the log. Everything below the UI has unit tests; this is the part that only
 * a browser can answer.
 */
test.describe('plugins', () => {
  test.beforeEach(before);
  test.beforeEach(async ({ page }) => {
    await enableIntegrationDiscovery(page, true);
  });

  test('Pets imports in the background after account connection', async ({
    page,
  }) => {
    test.skip(
      !process.env.ATOMIC_MOCK_INTEGRATION_PROXY,
      'Run with the documented mock integration-proxy server configuration',
    );

    // CI's browser and server are in different containers. Forward the mock's
    // loopback address to the server container before catalog loading starts.
    if (process.env.ATOMIC_SERVICE_URL)
      await page.route('http://127.0.0.1:19090/**', async route => {
        const target = new URL(route.request().url());
        target.hostname = new URL(process.env.ATOMIC_SERVICE_URL!).hostname;
        const response = await route.fetch({
          url: target.href,
          maxRedirects: 0,
        });
        await route.fulfill({ response });
      });
    await page.getByRole('link', { name: 'Integrations', exact: true }).click();
    const pets = page.locator('[data-integration="proxy:pets"]');
    await expect(
      pets.getByRole('heading', { name: 'Pets', exact: true }),
    ).toBeVisible();
    await pets.getByRole('button', { name: 'Set up connection' }).click();

    const setup = page.locator('dialog[open]');
    await expect(
      setup.getByRole('button', { name: 'Install and connect', exact: true }),
    ).toBeVisible();
    await setup
      .getByRole('button', { name: 'Install and connect', exact: true })
      .click();

    await expect(
      page.getByRole('heading', { name: 'Mock integration proxy' }),
    ).toBeVisible();
    await page
      .getByRole('button', {
        name: 'Use LocalThought to sync Pets with your Atomic Data Hub',
        exact: true,
      })
      .click();
    await expect(page).not.toHaveURL(/connection_code=/);
    await page.getByRole('button', { name: 'Complete installation' }).click();
    await page.getByRole('link', { name: 'Open folder', exact: true }).click();
    await expect(
      page.getByRole('status').filter({ hasText: 'Last synced' }),
    ).toBeVisible({ timeout: 60000 });
    await page
      .locator('[data-test="folder-list"]')
      .getByRole('link', { name: 'Pets', exact: true })
      .click();
    const main = page.getByRole('main');
    await expect(
      main.getByRole('heading', { name: 'Pets', exact: true }),
    ).toBeVisible();
    for (const name of ['Rex', 'Whiskers', 'Tweety', 'Nibbles', 'Bubbles'])
      await expect(main.getByText(name, { exact: true }).first()).toBeVisible();
    // Numeric and boolean properties must retain their Atomic datatype, not become JSON blobs.
    const datatypes = await page.evaluate(async () => {
      const store = window.store!;
      const table = await store.getResource(
        new URL(location.href).searchParams.get('subject')!,
      );
      const klass = await store.getResource(
        table.get('https://atomicdata.dev/properties/classtype') as string,
      );
      const fields = klass.get(
        'https://atomicdata.dev/properties/recommends',
      ) as string[];
      const properties = await Promise.all(
        fields.map(s => store.getResource(s)),
      );

      return Object.fromEntries(
        properties.map(p => [
          p.get('https://atomicdata.dev/properties/name'),
          p.get('https://atomicdata.dev/properties/datatype'),
        ]),
      );
    });
    expect(datatypes).toMatchObject({
      age: 'https://atomicdata.dev/datatypes/integer',
      vaccinated: 'https://atomicdata.dev/datatypes/boolean',
      weight: 'https://atomicdata.dev/datatypes/float',
      'updated at': 'https://atomicdata.dev/datatypes/timestamp',
    });
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
    const card = page
      .locator('[data-release]')
      .filter({
        has: page.getByRole('heading', { name: 'New plugin', exact: true }),
      })
      .filter({ hasText: id });
    await expect(card.getByText('Unverified', { exact: true })).toBeVisible();
    await page.screenshot({
      path: '/tmp/atomic-integration-store.png',
      fullPage: true,
    });
    await card.getByRole('button', { name: 'Create draft' }).click();
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

  test('Notion discovers databases through the proxy and reports revoked access without server OAuth', async ({
    page,
  }) => {
    const actor = Agent.fromSecret(await getDevDriveSecret(page), 'js').subject;
    const drive = new URL(page.url()).searchParams.get('subject')!;
    const origin = 'https://notion-proxy.test';
    const connection = 'notion-fixture';
    const dataSource = '11111111-1111-4111-8111-111111111111';
    const notionPage = {
      object: 'page',
      id: '22222222-2222-4222-8222-222222222222',
      parent: { data_source_id: dataSource },
      properties: {
        Name: {
          id: 'title',
          type: 'title',
          title: [{ type: 'text', text: { content: 'Proxy task' } }],
        },
      },
    };
    await page.evaluate(
      ({
        actor: storedActor,
        drive: storedDrive,
        origin: storedOrigin,
        connection: storedConnection,
      }) => {
        localStorage.setItem('integration-proxy-url', storedOrigin);
        window.dispatchEvent(new Event('integration-proxy-change'));
        localStorage.setItem(
          `localthought-browser:${JSON.stringify([storedOrigin, storedDrive, storedActor, 'notion'])}`,
          JSON.stringify({
            actor: storedActor,
            drive: storedDrive,
            platform: 'notion',
            connection: storedConnection,
          }),
        );
        localStorage.setItem(
          `localthought-browser-v1:${storedConnection}`,
          JSON.stringify({
            actor: storedActor,
            drive: storedDrive,
            origin: storedOrigin,
            platform: 'notion',
            ready: true,
            expires: Date.now() + 600000,
            code: 'fixture-code',
          }),
        );
      },
      { actor, drive, origin, connection },
    );
    const forbidden: string[] = [];
    page.on('request', req => {
      if (
        req.url().includes('/integration-oauth/') ||
        req.url().includes('/plugin-secret')
      )
        forbidden.push(req.url());
    });
    await page.route(`${origin}/catalog`, route =>
      route.fulfill({
        json: ['notion'],
        headers: { 'Access-Control-Allow-Origin': '*' },
      }),
    );
    await page.route(`${origin}/proxy/notion/**`, async route => {
      const path = new URL(route.request().url()).pathname;
      if (route.request().method() === 'PATCH')
        notionPage.properties.Name.title = route
          .request()
          .postDataJSON().properties.title.title;
      await route.fulfill({
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Expose-Headers': 'X-Connection-Code',
          'X-Connection-Code': 'next-code',
        },
        json: path.endsWith('/query')
          ? { results: [notionPage], has_more: false, next_cursor: null }
          : path.includes('/pages/')
            ? notionPage
            : path.endsWith('/views')
              ? { results: [], has_more: false, next_cursor: null }
              : {
                  id: dataSource,
                  properties: {
                    Name: { id: 'title', name: 'Name', type: 'title' },
                  },
                },
      });
    });
    let revoked = false;
    await page.route(`${origin}/proxy/notion/v1/search`, async route => {
      expect(route.request().postDataJSON().query).toBe('Project');
      await route.fulfill({
        status: revoked ? 401 : 200,
        headers: {
          'X-Connection-Code': 'rotated-fixture-code',
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Expose-Headers': 'X-Connection-Code',
        },
        json: revoked
          ? { message: 'Unauthorized' }
          : {
              results: [
                {
                  object: 'data_source',
                  id: '11111111-1111-4111-8111-111111111111',
                  title: [{ plain_text: 'Project tasks' }],
                  icon: { emoji: '✅' },
                },
              ],
              has_more: false,
              next_cursor: null,
            },
      });
    });
    await page.getByRole('link', { name: 'Integrations', exact: true }).click();
    await page
      .locator('[data-integration=notion]')
      .getByRole('button', { name: 'Set up connection' })
      .click();
    await page.getByLabel('Find a database', { exact: true }).fill('Project');
    await page
      .getByRole('button', { name: 'Find databases', exact: true })
      .click();
    await page
      .getByLabel('Database', { exact: true })
      .selectOption({ label: '✅ Project tasks' });
    await expect(
      page.getByRole('button', { name: 'Preview sync', exact: true }),
    ).toBeEnabled();
    revoked = true;
    await page
      .getByRole('button', { name: 'Find databases', exact: true })
      .click();
    await expect(page.locator('dialog[open]').getByRole('alert')).toContainText(
      'Notion',
    );
    revoked = false;
    await page
      .getByRole('button', { name: 'Preview sync', exact: true })
      .click();
    await expect(
      page.getByRole('button', { name: 'Approve and sync', exact: true }),
    ).toBeEnabled({ timeout: 45000 });
    await expect(
      page
        .locator('dialog[open]')
        .getByText('Proxy task', { exact: true })
        .first(),
    ).toBeVisible();
    await page
      .getByRole('button', { name: 'Approve and sync', exact: true })
      .click();
    await expect(page.getByText('Sync complete.', { exact: true })).toBeVisible(
      { timeout: 45000 },
    );
    const rowSubject = await page.evaluate(
      async ({ dataSource: installationDataSource, drive: queryDrive }) => {
        const key = Object.keys(localStorage).find(k =>
          k.includes('notion-proxy-installations-v1'),
        )!;
        const config = JSON.parse(localStorage.getItem(key)!)[
          installationDataSource
        ];
        const result = await window.store!.queryLocalDb({
          drive: queryDrive,
          property: 'https://atomicdata.dev/properties/parent',
          value: config.table,
        });
        // Not `subjects[0]`: a table also holds draft placeholder rows, which
        // carry the same parent and can come back first. Editing one of those
        // left the imported row untouched, the sync had nothing to push, and
        // Notion still read "Proxy task" — about half the time.
        const NAME = 'https://atomicdata.dev/properties/name';
        let row:
          | Awaited<ReturnType<typeof window.store.getLocalResource>>
          | undefined;

        for (const subject of result!.subjects) {
          const candidate = await window.store!.getLocalResource(subject);

          if (candidate.get(NAME) === 'Proxy task') {
            row = candidate;
            break;
          }
        }

        if (!row) throw new Error('imported Notion row not found in the table');

        await row.set(NAME, 'Edited locally');
        await row.save();

        return row.subject;
      },
      { dataSource, drive },
    );
    await page
      .getByRole('button', { name: 'Sync this table', exact: true })
      .click();
    await page
      .getByRole('button', { name: 'Approve and sync', exact: true })
      .click();
    await expect(
      page.getByText('Sync complete.', { exact: true }),
    ).toBeVisible();
    expect(notionPage.properties.Name.title[0].text.content).toBe(
      'Edited locally',
    );
    notionPage.properties.Name.title[0].text.content = 'Edited in Notion';
    await page
      .getByRole('button', { name: 'Sync this table', exact: true })
      .click();
    await page
      .getByRole('button', { name: 'Approve and sync', exact: true })
      .click();
    await expect(
      page.getByText('Sync complete.', { exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        async subject => (await window.store!.getLocalResource(subject)).title,
        rowSubject,
      ),
    ).toBe('Edited in Notion');
    expect(forbidden).toEqual([]);
  });

  test('an integration opens from the sidebar and syncs through the server sandbox', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const pageErrors: string[] = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await newPlugin(page);
    await setSource(
      page,
      `export const manifest = { schemaVersion: 1, secrets: [], operations: [] };
export async function run(ctx) {
  if (ctx.phase === 'preview') return {kind:'preview',proposal:{changes:[]},problems:[]};
  if (ctx.cursor === 'done') return {kind:'complete'};
  return {kind:'effect',effect:{kind:'checkpoint',id:'checkpoint',records:[]},cursor:'done'};
}`,
    );
    const original = page.url();
    await page.getByRole('tab', { name: 'Code', exact: true }).click();
    const publication = page.waitForResponse(
      r =>
        r.url().endsWith('/plugin-release') && r.request().method() === 'POST',
    );
    await page
      .getByRole('button', { name: 'Publish to integration store' })
      .click();
    const { id } = await (await publication).json();
    await page.goto(original);
    await page.getByRole('tab', { name: 'Code', exact: true }).click();
    await expect(
      page
        .getByRole('main')
        .getByRole('heading', { name: 'New plugin', level: 1 }),
    ).toBeVisible();
    await page.evaluate(
      async ({ release }) => {
        const store = window.store;
        if (!(await store.waitForServerConnected(10000)))
          throw new Error('Test server did not connect');
        const plugin = await store.getResource(
          new URL(location.href).searchParams.get('subject')!,
        );
        const drive = await store.getResource(
          plugin.get('https://atomicdata.dev/properties/parent'),
        );
        const ontology = await store.getResource(
          drive.get(
            'https://atomicdata.dev/ontology/server/property/default-ontology',
          ),
        );
        const properties = await Promise.all(
          ontology
            .get('https://atomicdata.dev/properties/properties')!
            .map((p: string) => store.getResource(p)),
        );
        const property = properties.find(
          p =>
            p.get('https://atomicdata.dev/properties/shortname') ===
            'plugin-connection',
        );
        if (!property) throw new Error('Missing plugin-connection property');
        const room = await store.newResource({
          parent: drive.subject,
          isA: ['https://atomicdata.dev/classes/ChatRoom'],
          propVals: {
            'https://atomicdata.dev/properties/name': 'Issue notifications',
          },
        });
        await room.save();
        await plugin.set('https://atomicdata.dev/properties/emoji', '🐙');
        await plugin.set(property.subject, {
          release,
          config: {},
          events: [
            {
              id: 'added',
              name: 'Issue added to Atomic',
              description: 'Includes initial imports.',
              filters: [
                {
                  property: 'https://atomicdata.dev/properties/parent',
                  value: plugin.subject,
                },
              ],
            },
          ],
        });
        await plugin.save();
        const saved = await store.fetchResourceFromServer(plugin.subject, {
          noWebSocket: true,
        });
        if (!saved.get(property.subject))
          throw new Error('Connection configuration was not persisted');
      },
      { release: id },
    );
    await page.getByRole('tab', { name: 'Sync', exact: true }).click();
    await page.getByRole('button', { name: 'Preview sync' }).click();
    await expect(page.getByText('0 records')).toBeVisible();
    await page.getByRole('button', { name: 'Approve sync' }).click();
    await expect(
      page.getByText('Sync complete.', { exact: true }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Enable background sync' }).click();
    await page.reload();
    await expect(
      page.getByRole('button', { name: 'Pause background sync' }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Pause background sync' }).click();
    await expect(
      page.getByRole('button', { name: 'Enable background sync' }),
    ).toBeVisible();
    await page.screenshot({
      path: '/tmp/atomic-integration-connection.png',
      fullPage: true,
    });
    const target = await page.evaluate(async () => {
      const store = window.store;
      const plugin = await store.getResource(
        new URL(location.href).searchParams.get('subject')!,
      );

      return {
        plugin: plugin.subject,
        drive: plugin.get('https://atomicdata.dev/properties/parent') as string,
      };
    });
    const agent = await Agent.fromSecret(await getDevDriveSecret(page));
    const api = { getAgent: () => agent, getServerUrl: () => SERVER_URL };
    const reviewed = await getPluginSync(api, target);
    await page.getByRole('button', { name: 'Enable background sync' }).click();
    await expect(
      page.getByRole('button', { name: 'Pause background sync' }),
    ).toBeVisible();
    // New automation now starts a conversation. Its entry point is covered by
    // the assistant handoff test above; seed a draft here to exercise review, editing,
    // trigger permissions and persistence independently of a live model.
    const automationSubject = await page.evaluate(
      async ({ connection, drive }) => {
        const store = window.store;
        const owner = await store.getResource(drive);
        const ontology = await store.getResource(
          owner.get(
            'https://atomicdata.dev/ontology/server/property/default-ontology',
          ),
        );
        const properties = await Promise.all(
          ontology
            .get('https://atomicdata.dev/properties/properties')
            .map((subject: string) => store.getResource(subject)),
        );

        const property = (name: string) => {
          const found = properties.find(
            p => p.get('https://atomicdata.dev/properties/shortname') === name,
          );
          if (!found) throw new Error(`Missing fixture property ${name}`);

          return found.subject;
        };

        const integration = await store.getResource(connection);
        const draft = await store.newResource({
          parent: drive,
          isA: integration.get('https://atomicdata.dev/properties/isA'),
          propVals: {
            'https://atomicdata.dev/properties/name': 'Issue automation',
            [property('plugin-source')]:
              'export function run(ctx) { const subject = ctx.trigger.subject; return { intents: [], problems: [] }; }',
            [property('plugin-schemas')]: {},
            [property('trigger')]: 'manual',
            [property('automation-integrations')]: [connection],
            [property('automation-trigger')]: {
              integration: connection,
              event: 'added',
              name: 'Issue added to Atomic',
            },
          },
        });
        await draft.save();

        return draft.subject;
      },
      { connection: target.plugin, drive: target.drive },
    );
    const triggerURL = `${SERVER_URL}/plugin-trigger`;
    const triggerResponse = await page.request.post(triggerURL, {
      headers: await signRequest(triggerURL, agent, {}),
      data: {
        drive: target.drive,
        plugin: automationSubject,
        filters: [
          {
            property: 'https://atomicdata.dev/properties/parent',
            value: target.plugin,
          },
        ],
        onEnter: true,
        onLeave: false,
        autoApply: false,
      },
    });
    expect(triggerResponse.ok()).toBe(true);
    const draftURL = new URL(original);
    draftURL.searchParams.set('subject', automationSubject);
    await page.goto(draftURL.href);
    await page.getByText('View or edit JavaScript', { exact: true }).click();
    await expect(
      page.getByRole('textbox', { name: 'Automation JavaScript' }),
    ).toBeVisible();
    const relationship = await page.evaluate(async () => {
      const store = window.store;
      const script = await store.getResource(
        new URL(location.href).searchParams.get('subject')!,
      );
      const values = script.getPropVals();

      return {
        parent: script.get('https://atomicdata.dev/properties/parent'),
        values: JSON.stringify(values),
        source: Object.values(values).find(
          v => typeof v === 'string' && v.includes('export function run'),
        ),
      };
    });
    expect(relationship.values).toContain(
      new URL(original).searchParams.get('subject'),
    );
    expect(relationship.parent).not.toBe(
      new URL(original).searchParams.get('subject'),
    );
    expect(relationship.source).toContain('ctx.trigger.subject');
    expect(relationship.source).not.toContain('New issue:');
    const code = `export const manifest = { schemaVersion: 1 };
export function run() { return { intents: [{ op: 'create', localId: 'sample', parent: ${JSON.stringify(target.drive)}, set: { 'https://atomicdata.dev/properties/name': 'Automation sample result' } }], problems: [] }; }`;
    await page
      .getByRole('textbox', { name: 'Automation JavaScript' })
      .fill(code);
    await page.getByRole('button', { name: 'Save and test sample' }).click();
    const sampleDialog = page.locator('dialog[open]');
    await expect(
      sampleDialog.getByText('Automation sample result'),
    ).toBeVisible();
    await sampleDialog.getByRole('button', { name: /Apply 1 change/ }).click();
    await expect(sampleDialog).toBeHidden();
    await page
      .getByRole('button', { name: 'Enable automatic execution' })
      .click();
    await expect(
      page.getByRole('button', { name: 'Require review', exact: true }),
    ).toBeVisible();
    await page
      .getByRole('button', { name: 'Require review', exact: true })
      .click();
    await expect(
      page.getByRole('button', {
        name: 'Enable automatic execution',
        exact: true,
      }),
    ).toBeVisible();
    await page
      .getByRole('heading', {
        name: 'Build with the Atomic assistant',
        exact: true,
      })
      .scrollIntoViewIfNeeded();
    await page.screenshot({
      path: '/tmp/atomic-automation-workspace.png',
      fullPage: true,
    });
    const automationURL = new URL(original);
    automationURL.searchParams.set('subject', automationSubject);
    await page.goto(automationURL.toString());
    await expect(
      page.getByRole('button', { name: 'Enable automatic execution' }),
    ).toBeVisible();
    await page.getByRole('link', { name: 'Integrations', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: 'Your connections', exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('region', { name: 'Your integrations' }).getByText('🐙'),
    ).toBeVisible();
    await page.screenshot({
      path: '/tmp/atomic-integrations-sidebar.png',
      fullPage: true,
    });
    expect(pageErrors).toEqual([]);
    await page.context().close();

    try {
      await expect
        .poll(
          async () => {
            const session = await getPluginSync(api, target);

            return (
              session?.run !== reviewed?.run && session?.status === 'complete'
            );
          },
          { timeout: 90_000, intervals: [2000] },
        )
        .toBe(true);
    } finally {
      await pluginSyncSchedule(api, {
        ...target,
        run: '',
        interval_seconds: 0,
      });
    }
  });

  test('a plugin proposes changes, and nothing is written until you approve', async ({
    page,
  }) => {
    const main = page.getByRole('main');

    // `New plugin` is search-only: it creates the drive's plugin schema on
    // first use, so it stays out of the default listing.
    await page.getByRole('button', { name: 'More' }).click();
    await page.getByPlaceholder(/filter/i).fill('plugin');
    await page.locator('[data-testid="menu-item-new-plugin"]').click();

    await expect(
      main.getByRole('heading', { name: 'New plugin', level: 1 }),
    ).toBeVisible();

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

    await page.getByRole('button', { name: 'More' }).click();
    await page.getByPlaceholder(/filter/i).fill('plugin');
    await page.locator('[data-testid="menu-item-new-plugin"]').click();
    await expect(
      main.getByRole('heading', { name: 'New plugin', level: 1 }),
    ).toBeVisible();

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
    await expect(dialog.getByRole('button', { name: /Apply/ })).toBeDisabled();

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
         secrets: [{ name: 'notion', origin: 'https://api.notion.com',
                     description: 'Notion integration token' }],
       };
       export function run(ctx) {
         ctx.http({ url: 'https://api.notion.com/v1/search',
                    headers: { Authorization: 'Bearer secret:notion' } });
         return { intents: [], problems: [] };
       }`,
    );

    // A declared secret is one labelled field: the name and origin come from
    // the plugin, so neither is retyped.
    await expect(main.getByText('Notion integration token')).toBeVisible();
    await expect(
      main.getByPlaceholder(/Paste the value for notion/),
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
         ctx.http({ url: 'https://api.notion.com/v1/search',
                    headers: { Authorization: 'Bearer secret:tok' } });
         return { intents: [], problems: [] };
       }`,
    );

    await page.getByRole('tab', { name: 'Settings', exact: true }).click();

    // The author who forgot to declare is the one who cannot work out where to
    // enter it, so a slot appears anyway — with the origin read from the URL
    // rather than asked for.
    await expect(main.getByText(/sent only to/)).toBeVisible();
    await expect(main.getByText(/api\.notion\.com/).first()).toBeVisible();
    await expect(main.getByPlaceholder(/Value for tok/)).toBeVisible();
  });
});

async function newPlugin(page: import('@playwright/test').Page) {
  await page.getByRole('button', { name: 'More' }).click();
  await page.getByPlaceholder(/filter/i).fill('plugin');
  await page.locator('[data-testid="menu-item-new-plugin"]').click();
  await expect(
    page.getByRole('main').getByRole('heading', {
      name: 'New plugin',
      level: 1,
    }),
  ).toBeVisible();
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
