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
    // `installGitHub` is the app's own installer, which already holds the
    // provider bundle it installs. This used to reach for the module by
    // source path and read the bundled source out of the served text, which
    // only a Vite dev server can answer.
    const connection = await window.atomicE2E.githubInstaller.installGitHub(
      store,
      store.getDrive()!,
      'ontola/workspace-test',
      '',
    );
    // Existing installations retain their JSON binding, without a write-on-read migration.
    const { findSchema, pluginSchema } = window.atomicE2E.tomicLib;
    const schema = await findSchema(store, store.getDrive()!, pluginSchema());
    const legacy = await store.getResource(connection.plugin);
    await legacy.remove(schema.properties['plugin-workspace']);
    await legacy.save();
    const table = await store.getResource(connection.table);
    const views = table.get(
      'https://atomicdata.dev/properties/table-views',
    ) as string[];
    const original = await store.getResource(views[0]);
    const extra = await store.newResource({
      parent: connection.table,
      isA: original.get('https://atomicdata.dev/properties/isA'),
      propVals: {
        'https://atomicdata.dev/properties/name': 'All issues',
        'https://atomicdata.dev/properties/view-kind': 'table',
      },
    });
    await extra.save();
    await table.set('https://atomicdata.dev/properties/table-views', [
      ...views,
      extra.subject,
    ]);
    await table.save();

    return { plugin: connection.plugin, table: connection.table };
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
  // `...`. Reaching them is local-first: `fetchResourceWithLocalFallback`
  // waits on a client-database read in the WASM worker before it will ask the
  // server. Under four local Playwright workers that one worker round trip was
  // measured at 3965 ms, and the headings arrived 12 to 13 seconds after the
  // navigation in four runs out of four:
  //
  //     10 s   the assertion below, on its old default, with all four
  //            headings still showing `...`
  //     +2036 ms, +3099 ms, +3102 ms, +3234 ms until `Todo` appeared
  //
  // The server itself is not the slow part: asked directly for the same four
  // subjects through its `/path` proxy it answers in 1.5 to 2.1 ms, and a
  // hand-issued `fetchResourceFromServer` from the stalled page returns a
  // complete resource in 11 to 71 ms. So this is a budget, not a hang — but
  // the local read's lack of a deadline is a real product question, raised
  // separately.
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
