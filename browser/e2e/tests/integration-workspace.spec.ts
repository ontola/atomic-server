import { test, expect } from '@playwright/test';
import { before, waitForSynced } from './test-utils';
test.beforeEach(before);

test('workspace owns its views and links to separate connection settings', async ({
  page,
}) => {
  // This test installs a connection, navigates, reloads twice and walks four
  // settings tabs, and two of its steps are now allowed 45s each because the
  // resources behind them are read local-first. It measured 25s alone and
  // failed the 60s default under four local workers with 20s still to run, so
  // fixing only the assertions would move the failure onto the test budget.
  test.setTimeout(240_000);

  const installed = await page.evaluate(async () => {
    const store = window.store!;
    const drive = store.getDrive()!;
    const {
      core,
      dataBrowser,
      ensureSchema,
      pinPluginRelease,
      pluginSchema,
      taskSchema,
    } = window.atomicE2E.tomicLib;

    // A connected integration, built here rather than by installing a real
    // provider. This test is about what the workspace page does with a
    // connection — its own views, and a link out to connection settings — so
    // the connection only has to exist and be shaped right. Plugins
    // themselves live in atomic-plugins; nothing in this repo installs one.
    const schema = await ensureSchema(store, drive, pluginSchema());
    const save = async (resource: { save(): Promise<string> }) => {
      if ((await resource.save()) === 'offline')
        throw new Error('AtomicServer disconnected while building the fixture');
    };

    const plugin = await store.newResource({
      parent: drive,
      isA: [schema.classes['plugin-script']],
      propVals: {
        [core.properties.name]: 'Workspace fixture',
        [dataBrowser.properties.emoji]: '🧪',
        [schema.properties['plugin-source']]:
          'export const manifest = { schemaVersion: 1, operations: [], secrets: [] };\n' +
          'export function run() { return { intents: [], problems: [] }; }',
      },
    });
    await save(plugin);

    // The kanban columns the assertions below read are the embedded task
    // vocabulary's Tag resources, so the table groups by task status.
    const status = await store.getResource(taskSchema.properties.status);
    const table = await store.newResource({
      parent: plugin.subject,
      isA: [dataBrowser.classes.table],
      propVals: {
        [core.properties.name]: 'Fixture workspace',
        [core.properties.classtype]: core.classes.class,
      },
    });
    await save(table);

    const view = await store.newResource({
      parent: table.subject,
      isA: [dataBrowser.classes.view],
      propVals: {
        [core.properties.name]: 'Kanban',
        [dataBrowser.properties.viewKind]: 'kanban',
        [dataBrowser.properties.viewGroupBy]: status.subject,
        [dataBrowser.properties.viewColumns]: [
          core.properties.name,
          status.subject,
        ],
      },
    });
    await save(view);
    await table.set(dataBrowser.properties.tableViews, [view.subject]);
    await table.set(dataBrowser.properties.tableDefaultView, view.subject);
    await save(table);

    const pinned = await pinPluginRelease(store, {
      drive,
      plugin: plugin.subject,
    });
    await plugin.set(schema.properties['plugin-connection'], {
      release: pinned.id,
      config: { drive, plugin: plugin.subject, table: table.subject },
      events: [],
    });
    await save(plugin);

    // A second view, so the assertions can tell the workspace's own views
    // apart from the one the fixture starts with.
    const views = table.get(
      'https://atomicdata.dev/properties/table-views',
    ) as string[];
    const extra = await store.newResource({
      parent: table.subject,
      isA: view.get('https://atomicdata.dev/properties/isA'),
      propVals: {
        'https://atomicdata.dev/properties/name': 'All rows',
        'https://atomicdata.dev/properties/view-kind': 'table',
      },
    });
    await save(extra);
    await table.set('https://atomicdata.dev/properties/table-views', [
      ...views,
      extra.subject,
    ]);
    await save(table);

    return { plugin: plugin.subject, table: table.subject };
  });
  // Everything above was written through the store in this page. Navigating
  // on top of an outbox that has not drained is the race `apps.spec.ts`
  // documents: the write the UI has already accepted is gone after the
  // navigation. Twenty-four other spec files wait here; this one did not.
  await waitForSynced(page);

  await page.goto(
    new URL(
      `/app/show?subject=${encodeURIComponent(installed.table)}`,
      page.url(),
    ).href,
  );
  await expect(
    page.getByRole('button', { name: 'Connections', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Secrets', exact: false }),
  ).not.toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Source', exact: true }),
  ).not.toBeVisible();
  // The kanban column headings are four Tag resources of the embedded task
  // vocabulary (`https://atomicdata.dev/task/v1/{todo,doing,blocked,done}`),
  // and until they load the header renders `useTitle`'s loading placeholder,
  // so the whole board reads `... 0`. That is what this used to fail on, and
  // the cause was not this test: reaching them was local-first, and
  // `fetchResourceWithLocalFallback` would not ask the server until a
  // client-database read in the WASM worker had answered. Measured under four
  // local Playwright workers, that one worker round trip cost 3965 ms while
  // the host answered the same four subjects in 1.5 to 2.1 ms, and raising
  // this assertion to 45 s was not enough — it failed at 45 s too.
  //
  // Fixed in `Store.fetchResourceWithLocalFallback`, which now asks the host
  // for embedded vocabulary directly. The budget stays because the rest of
  // this page is still read local-first, but it should no longer be near it.
  await expect(page.getByText('Todo', { exact: true }).first()).toBeVisible({
    timeout: 45_000,
  });
  await page.screenshot({
    path: '/tmp/atomic-integration-workspace.png',
    fullPage: true,
    animations: 'disabled',
  });
  await page.getByRole('button', { name: 'Connections', exact: true }).click();
  const allSettings = page.getByRole('link', {
    name: 'Connection settings',
    exact: true,
  });
  await expect(allSettings).toHaveCount(1);
  const settings = allSettings;
  await expect(settings).toHaveAttribute('href', installed.plugin);
  await settings.click();
  await expect(
    page.getByRole('link', { name: 'Open workspace', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('tab', { name: 'Workspace', exact: true }),
  ).toHaveCount(0);
  await page.getByRole('tab', { name: 'Settings', exact: true }).click();
  await expect(page.getByLabel('Opening view')).toBeVisible();
  await page.getByLabel('Opening view').selectOption({ label: 'All issues' });
  await expect(page.getByRole('heading', { name: /Secrets/ })).toBeVisible();
  await page.getByRole('tab', { name: 'Code', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Source', exact: true }),
  ).toBeVisible();
  await page.getByRole('tab', { name: 'Automations', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'New automation' }),
  ).toBeVisible();
  // The opening-view setting is a write; reloading before it has gone out is
  // the same race as the navigation above.
  await waitForSynced(page);
  await page.reload();
  await page.getByRole('tab', { name: 'Settings', exact: true }).click();
  // Each `<option>` is a view resource rendered by name, so this is the same
  // local-first read as the kanban headings and shows the same `...` until it
  // lands. Seen under four workers as
  //
  //     <option value="did:ad:_3wWljDq…">...</option>
  //
  // still unresolved sixteen polls in.
  await expect(
    page.getByLabel('Opening view').locator('option:checked'),
  ).toHaveText('All issues', { timeout: 45_000 });
  await page.getByRole('tab', { name: 'Sync', exact: true }).click();
  let releasePreview!: () => void;
  const previewGate = new Promise<void>(resolve => {
    releasePreview = resolve;
  });
  await page.route('**/plugin-sync-preview', async route => {
    await previewGate;
    await route.fulfill({
      status: 500,
      contentType: 'text/plain',
      body: 'Provider unavailable. Try again.',
    });
  });
  await page.getByRole('button', { name: 'Preview sync', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Preparing preview…' }),
  ).toHaveAttribute('aria-busy', 'true');
  await expect(
    page.getByRole('button', { name: 'Preparing preview…' }),
  ).toBeDisabled();
  releasePreview();
  await expect(
    page.getByRole('alert').filter({ hasText: 'Provider unavailable' }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Preview sync', exact: true }),
  ).toBeEnabled();

  for (const tab of ['Sync', 'Automations', 'Settings', 'Activity', 'Code']) {
    await page.getByRole('tab', { name: tab, exact: true }).click();
    await page.screenshot({
      path: `/tmp/atomic-tab-${tab}.png`,
      animations: 'disabled',
    });
  }

  await page.getByRole('button', { name: 'Edit with AI', exact: true }).click();
  await expect(
    page.getByText('Help me edit this integration.', { exact: false }).first(),
  ).toBeVisible();
});

test('workspace starts automation chat without requiring a connection', async ({
  page,
}) => {
  const table = await page.evaluate(async () => {
    const resource = await window.store!.newResource({
      parent: window.store!.getDrive(),
      isA: 'https://atomicdata.dev/classes/Table',
      propVals: {
        'https://atomicdata.dev/properties/name': 'Independent workspace',
        'https://atomicdata.dev/properties/classtype':
          'https://atomicdata.dev/classes/Folder',
      },
    });
    await resource.save();

    return resource.subject;
  });
  await page.goto(
    new URL(`/app/show?subject=${encodeURIComponent(table)}`, page.url()).href,
  );
  await page.getByRole('button', { name: 'Automations', exact: true }).click();
  await expect(
    page.getByText('No automations yet.', { exact: true }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'New automation', exact: true })
    .click();
  await expect(
    page
      .getByText('Help me create a new automation.', { exact: false })
      .first(),
  ).toBeVisible();
  // The workspace dialog must be gone — but not "no dialog at all": with no AI
  // provider configured, `askAI` legitimately raises the model-setup dialog
  // (`AISetupPanel`), and that is what this used to catch.
  await expect(
    page.getByRole('dialog').getByText('No automations yet.', { exact: true }),
  ).not.toBeVisible();
  const automation = await page.evaluate(async workspace => {
    const { createPlugin } = window.atomicE2E.runScript;

    return createPlugin(
      window.store!,
      {
        parent: window.store!.getDrive()!,
        drive: window.store!.getDrive()!,
        workspace,
        connections: [],
      },
      'Local reminder',
      'export function run() { return { intents: [], problems: [] }; }',
    );
  }, table);
  await page.goto(
    new URL(`/app/show?subject=${encodeURIComponent(automation)}`, page.url())
      .href,
  );
  await expect(
    page.getByRole('tab', { name: 'Automation', exact: true }),
  ).toBeVisible();
  await page.getByRole('link', { name: 'Open workspace', exact: true }).click();
  await page.getByRole('button', { name: 'Automations', exact: true }).click();
  await expect(
    page.getByRole('dialog').getByRole('link', { name: /Local reminder/ }),
  ).toBeVisible();
});
