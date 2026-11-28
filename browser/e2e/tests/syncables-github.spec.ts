import {
  errors,
  expect,
  test,
  type FrameLocator,
  type Page,
  type Route,
} from './fixtures';
import { enableIntegrationDiscovery } from './integration-settings-utils';
import {
  before,
  clickAccountMenuItem,
  contextMenuClick,
  currentDriveTitle,
  FRONTEND_URL,
  getCurrentSubject,
  newDrive,
  sideBarDriveSwitcher,
  waitForDriveSettled,
  waitForSynced,
} from './test-utils';
import {
  FIRST_ISSUE_TITLE,
  GITHUB_API,
  GITHUB_ICON,
  PLATFORM,
  PROXY,
  PUBLIC_ISSUES,
  PUBLIC_ISSUE_PAGE_COUNT,
  PUBLIC_REPOSITORY,
  PULL_REQUEST_TITLE,
  REPOSITORY,
  RETAINED_ISSUE_TITLE,
  UPDATED_ISSUE_TITLE,
  issue,
  mockIntegrationProxy,
  publicIssueUrl,
} from './fixtures/syncablesProxy';

const SYNCABLE_COLLECTIONS_TAB = 'Syncable Collections';

async function openConsent(
  page: Page,
  iframe: FrameLocator,
  buttonName: string,
) {
  await iframe.getByRole('button', { name: buttonName, exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Connect GitHub' });
  await dialog.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Authorize GitHub' }),
  ).toBeVisible();
}

async function finishConsent(page: Page, appName = 'GitHub · michiel') {
  await page.getByRole('link', { name: 'Authorize', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: appName, exact: true }),
  ).toBeVisible({ timeout: 45_000 });

  return getCurrentSubject(page);
}

async function sourceState(
  page: Page,
  subject: string,
  driveOverride?: string,
) {
  await waitForSynced(page);
  await waitForDriveSettled(page);

  const snapshotScope = { tableSubject: subject, drive: driveOverride };

  return page.evaluate(async scope => {
    const tableSubject = scope.tableSubject;
    const store = window.store;
    const base = 'https://atomicdata.dev/properties/';
    const drive = scope.drive ?? store.getDrive();
    if (!drive) throw new Error('Missing fixture drive');
    const root = await store.getResource(drive);
    const ontologySubject = root.get(
      'https://atomicdata.dev/ontology/server/property/default-ontology',
    );
    if (typeof ontologySubject !== 'string')
      throw new Error('The fixture drive has no default ontology');
    const ontology = await store.getResource(ontologySubject);
    const definitions = await Promise.all(
      [
        ...ontology.getSubjects(base + 'properties'),
        ...ontology.getSubjects(base + 'classes'),
      ].map(term => store.getResource(term)),
    );

    const property = (name: string) => {
      const found = definitions.find(
        resource => resource.get(base + 'shortname') === name,
      );
      if (!found) throw new Error('Missing fixture property ' + name);

      return found.subject;
    };

    const source = property('syncable-source-key');
    const nodeKind = property('syncable-node-kind');
    const config = property('syncable-source-config');
    const table = await store.getResource(tableSubject);
    const rowClass = table.get(base + 'classtype');
    // A cold navigation materializes only the selected filter's rows. Verify
    // canonical storage independently of that view and the JS resource cache.
    const subjects = new Set<string>();

    for (const field of [base + 'parent', property('syncable-entity-table')]) {
      const seen = new Set<string>();
      let total: number | undefined;

      for (let current = 0; ; current++) {
        const query = new URL('/query', store.getServerUrl());
        for (const [name, value] of Object.entries({
          drive,
          property: field,
          value: tableSubject,
          page_size: '100',
          current_page: String(current),
          include_nested: 'false',
        }))
          query.searchParams.set(name, value);
        const result = await store.fetchResourceFromServer(query.href, {
          noWebSocket: true,
          // Each virtual query is a new server snapshot, not shared CRDT state.
          forceOverride: true,
        });
        if (result.error) throw result.error;
        const count = result.get(base + 'collection/totalMembers');
        if (
          typeof count !== 'number' ||
          !Number.isSafeInteger(count) ||
          count < 0 ||
          count > 10_000 ||
          (total !== undefined && count !== total)
        )
          throw new Error('Invalid or changing canonical fixture row count');
        total = count;
        const members = result.getSubjects(base + 'collection/members');
        if (members.length !== Math.min(100, total - current * 100))
          throw new Error('Incomplete canonical fixture row page');

        for (const member of members) {
          if (seen.has(member))
            throw new Error('Duplicate canonical fixture row across pages');

          seen.add(member);
          subjects.add(member);
        }

        if (seen.size === total) break;
      }
    }

    const rows = (
      await Promise.all(
        [...subjects].map(rowSubject => store.getResource(rowSubject)),
      )
    ).filter(
      resource =>
        (resource.get(base + 'parent') === tableSubject ||
          resource.get(property('syncable-entity-table')) === tableSubject) &&
        resource.get(nodeKind) === 'record' &&
        typeof resource.get(source) === 'string' &&
        typeof rowClass === 'string' &&
        resource.getSubjects(base + 'isA').includes(rowClass),
    );

    return {
      subject: table.subject,
      name: table.get(base + 'name'),
      description: table.get(base + 'description'),
      parent: table.get(base + 'parent'),
      classes: table.getSubjects(base + 'isA'),
      views: table.getSubjects(base + 'table-views'),
      icon: table.get(base + 'icon'),
      localId: table.get(base + 'localId'),
      key: table.get(source) as string | undefined,
      config: table.get(config) as
        | {
            principal?: { kind: string };
            collection?: { collection: string };
            resource?: string;
            connectionId?: string;
          }
        | undefined,
      rows: await Promise.all(
        rows.map(async row => {
          const saved = row.get(config) as
            | {
                managedProperties?: string[];
                entityIdentity?: {
                  key: string;
                  values: Array<[string, string | number]>;
                };
                record?: Record<string, unknown>;
                read?: unknown;
              }
            | undefined;

          return {
            subject: row.subject,
            name: row.get(base + 'name'),
            localId: row.get(base + 'localId'),
            key: row.get(source) as string | undefined,
            note: row.get(base + 'description'),
            entityIdentity: saved?.entityIdentity,
            raw: saved?.record,
            hasOriginatingRead: saved?.read !== undefined,
            memberships: row.getSubjects(property('syncable-rule-memberships')),
            managed: await Promise.all(
              (saved?.managedProperties ?? []).map(async field => {
                const definition = await store.getResource(field);

                return {
                  name: definition.get(base + 'shortname'),
                  datatype: definition.get(base + 'datatype'),
                  value: row.get(field),
                };
              }),
            ),
          };
        }),
      ),
    };
  }, snapshotScope);
}

/** Read every installed principal App, not just resources loaded by the route. */
async function principalApps(page: Page, platform = PLATFORM) {
  await waitForSynced(page);
  await waitForDriveSettled(page);

  return page.evaluate(
    async ({ wantedPlatform, proxy }) => {
      const store = window.store;
      const base = 'https://atomicdata.dev/properties/';
      const drive = store.getDrive();
      if (!drive) throw new Error('The principal App fixture has no drive');
      const root = await store.getResource(drive);
      const ontologySubject = root.get(
        'https://atomicdata.dev/ontology/server/property/default-ontology',
      );
      if (typeof ontologySubject !== 'string')
        throw new Error('The principal App fixture has no default ontology');
      const ontology = await store.getResource(ontologySubject);
      const definitions = await Promise.all(
        [
          ...ontology.getSubjects(base + 'properties'),
          ...ontology.getSubjects(base + 'classes'),
        ].map(term => store.getResource(term)),
      );
      const terms = Object.fromEntries(
        definitions.map(resource => [
          resource.get(base + 'shortname'),
          resource.subject,
        ]),
      );
      const required = [
        'app',
        'app-data',
        'syncable-node-kind',
        'syncable-platform-id',
        'syncable-proxy-origin',
        'syncable-source-key',
        'syncable-source-config',
        'builtin-app',
      ];
      if (required.some(name => typeof terms[name] !== 'string'))
        throw new Error('The principal App fixture schema is incomplete');
      const query = new URL('/query', store.getServerUrl());
      for (const [name, value] of Object.entries({
        drive,
        property: terms['syncable-node-kind'],
        value: 'principal',
        page_size: '100',
        current_page: '0',
        include_nested: 'false',
        filters: JSON.stringify([
          { property: base + 'isA', value: terms.app },
          { property: terms['syncable-platform-id'], value: wantedPlatform },
          { property: terms['syncable-proxy-origin'], value: proxy },
        ]),
      }))
        query.searchParams.set(name, value);
      const result = await store.fetchResourceFromServer(query.href, {
        noWebSocket: true,
        forceOverride: true,
      });
      if (result.error) throw result.error;
      const count = result.get(base + 'collection/totalMembers');
      const members = result.getSubjects(base + 'collection/members');
      // These isolated fixtures create at most three Apps. Never mistake a
      // partial page or duplicate member for proof that installation is unique.
      if (
        typeof count !== 'number' ||
        !Number.isSafeInteger(count) ||
        count < 0 ||
        count > 100 ||
        members.length !== count ||
        new Set(members).size !== count
      )
        throw new Error('The principal App fixture query is incomplete');

      return Promise.all(
        members.map(async subject => {
          const app = await store.getResource(subject);
          if (app.error) throw app.error;
          const key = app.get(terms['syncable-source-key']);
          if (typeof key !== 'string' || JSON.parse(key).kind !== 'principal')
            throw new Error('The principal App fixture has an invalid source');

          return {
            subject,
            drive,
            name: app.get(base + 'name'),
            description: app.get(base + 'description'),
            parent: app.get(base + 'parent'),
            localId: app.get(base + 'localId'),
            key,
            config: app.get(terms['syncable-source-config']),
            classes: app.getSubjects(base + 'isA'),
            isApp: app.getSubjects(base + 'isA').includes(terms.app),
            appData: app.get(terms['app-data']),
            builtin: app.get(terms['builtin-app']),
            views: app.getSubjects(base + 'table-views'),
            icon: app.get(base + 'icon'),
          };
        }),
      );
    },
    { wantedPlatform: platform, proxy: PROXY },
  );
}

async function sourceSubject(page: Page, kind: string, collection?: string) {
  return page.evaluate(
    ({ kind: wanted, collection: name }) => {
      const store = window.store;
      const base = 'https://atomicdata.dev/properties/';
      const fields = Object.fromEntries(
        [...store.resources.values()].map(resource => [
          resource.get(base + 'shortname'),
          resource.subject,
        ]),
      );
      const found = [...store.resources.values()].find(resource => {
        if (resource.get(fields['syncable-node-kind']) !== wanted) return false;
        const config = resource.get(fields['syncable-source-config']) as
          | {
              resource?: string;
              collection?: { collection: string };
              navigation?: { collection: string };
              principal?: { kind: string };
            }
          | undefined;

        return name
          ? (config?.resource ??
              config?.collection?.collection ??
              config?.navigation?.collection) === name
          : config?.principal?.kind === 'authenticated';
      });
      if (!found)
        throw new Error(
          'Missing saved source ' + wanted + '/' + (name ?? 'principal'),
        );

      return found.subject;
    },
    { kind, collection },
  );
}

async function selectView(page: Page, name: string) {
  const tab = page.getByRole('tab', { name, exact: true });
  await expect(tab).toBeVisible({ timeout: 30_000 });
  if ((await tab.getAttribute('aria-selected')) !== 'true') await tab.click();
  await expect(tab).toHaveAttribute('aria-selected', 'true');
}

async function browse(page: Page) {
  await expect(
    page.getByRole('tab', { name: 'Table', exact: true }),
  ).toBeVisible();
  const directory = page.getByRole('tab', {
    name: SYNCABLE_COLLECTIONS_TAB,
    exact: true,
  });
  await selectView(
    page,
    (await directory.count()) ? SYNCABLE_COLLECTIONS_TAB : 'Table',
  );
  await expect(page.locator('iframe[title="App"]:visible')).toHaveCount(0);

  return page
    .getByRole('main')
    .getByRole('table')
    .or(page.getByRole('main').getByRole('grid'));
}

async function waitForInitialSync(page: Page, rowName: string) {
  const directory = await browse(page);
  await expect(directory.getByText(rowName, { exact: true })).toBeVisible({
    timeout: 60_000,
  });
  // A row can become visible while the worker is still committing the page.
  await expect(page.locator('iframe[title="App"]')).toHaveCount(0, {
    timeout: 60_000,
  });

  return directory;
}

async function openRow(page: Page, text: string) {
  const directory = await browse(page);
  const previous = await getCurrentSubject(page);
  await directory
    .getByRole('row')
    .filter({ hasText: text })
    .getByRole('button', { name: 'Open', exact: true })
    .click();
  await expect.poll(() => getCurrentSubject(page)).not.toBe(previous);
}

async function selectFilter(page: Page, value?: string) {
  const select = page.getByRole('combobox', {
    name: 'Saved filter',
    exact: true,
  });
  await expect(select).toBeVisible({ timeout: 30_000 });

  if (value !== undefined) {
    await select.selectOption(value);
    await expect
      .poll(() => new URL(page.url()).searchParams.get('syncFilter') ?? '')
      .toBe(value);
  } else if (!(await select.inputValue())) {
    const choices = await select.locator('option').evaluateAll(options =>
      options
        .map(option => ({
          value: (option as HTMLOptionElement).value,
          label: option.textContent,
        }))
        .filter(option => option.value),
    );
    expect(
      choices,
      'Choose the explicit saved scope when a table has multiple rules',
    ).toHaveLength(1);
    await select.selectOption(choices[0].value);
    await expect
      .poll(() => new URL(page.url()).searchParams.get('syncFilter'))
      .toBe(choices[0].value);
  }

  return select.inputValue();
}

async function sync(page: Page, rule?: string) {
  await selectFilter(page, rule);
  await selectView(page, 'Sync');
  const iframe = page.locator('iframe[title="App"]:visible').contentFrame();
  const lastSync = iframe.getByText(
    /^(Last completed sync for this filter:|This filter has not completed a sync yet\.)/,
  );
  await expect(lastSync).toBeVisible({ timeout: 30_000 });
  const previousSync = await lastSync.textContent();
  const syncNow = iframe.getByRole('button', { name: 'Sync now', exact: true });
  await syncNow.click();
  // Starting a worker and updating this frame are asynchronous. The same
  // button can still be enabled before the worker enters its running state.
  await expect(lastSync).not.toHaveText(previousSync!, { timeout: 60_000 });
  await expect(lastSync).toHaveText(/^Last completed sync for this filter:/);
  await expect(syncNow).toBeEnabled({ timeout: 60_000 });
  await expect(iframe.getByRole('alert')).toHaveCount(0);

  return iframe;
}

async function legacyPublicMirror(
  page: Page,
  parentSubject: string,
  tableSubject: string,
) {
  return page.evaluate(
    async ({ parent, targetTable, proxy, raw }) => {
      const store = window.store,
        base = 'https://atomicdata.dev/properties/';
      const terms = Object.fromEntries(
        [...store.resources.values()].map(resource => [
          resource.get(base + 'shortname'),
          resource.subject,
        ]),
      );
      const canonical = (value: unknown): unknown =>
        Array.isArray(value)
          ? value.map(canonical)
          : value && typeof value === 'object'
            ? Object.fromEntries(
                Object.keys(value)
                  .sort()
                  .map(key => [
                    key,
                    canonical((value as Record<string, unknown>)[key]),
                  ]),
              )
            : value;
      const bound = {
        collection: 'repositoryIssues',
        resource: 'issue',
        pathParams: { repository_id: '456' },
        path: '/repositories/456/issues',
        method: 'GET',
        query: { per_page: '100', state: 'all' },
        body: {},
      };
      const scope = {
        version: 2,
        proxyOrigin: proxy,
        platform: 'github-issues',
        principal: { kind: 'public' },
      };
      const oldKey = JSON.stringify(
        canonical({
          ...scope,
          kind: 'collection',
          collection: {
            name: 'repositoryIssues',
            resource: 'issue',
            context: { repository_id: '456' },
          },
        }),
      );
      const parentHash = Array.from(
        new Uint8Array(
          await crypto.subtle.digest(
            'SHA-256',
            new TextEncoder().encode(JSON.stringify(oldKey)),
          ),
        ),
      )
        .map(byte => byte.toString(16).padStart(2, '0'))
        .join('');
      const rowKey = JSON.stringify(
        canonical({
          ...scope,
          kind: 'record',
          collection: { name: 'repositoryIssues', resource: 'issue' },
          parentSourceKeyHash: parentHash,
          remoteId: 15,
        }),
      );
      const localId = 'syncables:node:' + encodeURIComponent(oldKey);
      const table = await store.getResource(targetTable);
      const rowClass = table.get(base + 'classtype') as string;
      await table.set(base + 'parent', parent);
      await table.set(base + 'localId', localId);
      await table.set(terms['syncable-source-key'], oldKey);
      await table.set(terms['syncable-node-kind'], 'collection');
      await table.set(terms['syncable-source-config'], {
        ...scope,
        collection: bound,
      });
      await table.save();
      const row = await store.newResource({
        parent: table.subject,
        isA: [rowClass, terms['syncable-record']],
        propVals: {
          [base + 'name']: 'Legacy imported issue',
          [base + 'localId']: 'syncables:github-issue:9001',
          [base + 'description']: 'Keep this user note',
          [terms['syncable-source-key']]: rowKey,
          [terms['syncable-node-kind']]: 'record',
          [terms['syncable-source-config']]: {
            ...scope,
            parentSourceKey: oldKey,
            record: raw,
            resource: 'issue',
            context: { repository_id: '456' },
            managedProperties: [],
          },
        },
      });
      await row.save();
      const driveSubject = store.getDrive();
      if (!driveSubject) throw new Error('The fixture has no current drive');
      const drive = await store.getResource(driveSubject);
      const previous = drive.get(terms['syncable-resource-index']) as
        | Record<string, string>
        | undefined;
      await drive.set(terms['syncable-resource-index'], {
        ...previous,
        [oldKey]: table.subject,
      });
      await drive.save();

      return { table: table.subject, row: row.subject, localId, oldKey };
    },
    {
      parent: parentSubject,
      targetTable: tableSubject,
      proxy: PROXY,
      raw: issue(9001, 15, 'Legacy imported issue'),
    },
  );
}

async function publicForm(page: Page, collection = 'repositoryIssues') {
  await selectView(page, 'Sync');
  const iframe = page.locator('iframe[title="App"]:visible').contentFrame();
  await expect(
    iframe.getByLabel('Source collection', { exact: true }),
  ).toBeVisible({
    timeout: 30_000,
  });
  await iframe
    .getByLabel('Source collection', { exact: true })
    .selectOption(collection);

  return iframe;
}

test.describe('catalog-driven built-in Syncables', () => {
  test('navigates and syncs from an embedded organization without inventing an origin read', async ({
    page,
  }, testInfo) => {
    test.setTimeout(150_000);
    const requests = await mockIntegrationProxy(page);
    await before({ page }, testInfo);
    await waitForSynced(page);
    await waitForDriveSettled(page);
    await enableIntegrationDiscovery(page);
    await clickAccountMenuItem(page, 'Apps');
    await page
      .locator(`[data-proxy-platform="${PLATFORM}"]`)
      .getByRole('button', { name: 'Add GitHub to drive' })
      .click();
    const iframe = page.locator('iframe[title="App"]:visible').contentFrame();
    await expect(
      iframe.getByRole('heading', { name: 'Connected principals' }),
    ).toBeVisible({ timeout: 45_000 });
    await openConsent(page, iframe, 'Connect account');
    await finishConsent(page);
    const principal = await browse(page);
    await expect(
      principal.getByText('Organizations', { exact: true }),
    ).toBeVisible();
    // Look up the empty table without opening its first-sync eligible Table.
    const organizationsSubject = await sourceSubject(
      page,
      'collection',
      'githubOrganization',
    );
    await openRow(page, 'Repositories');
    const repositoriesSubject = await getCurrentSubject(page);
    await waitForInitialSync(page, 'notes');
    const organization = (
      await sourceState(page, organizationsSubject)
    ).rows.find(row => row.raw?.id === 123)!;
    expect(organization).toBeDefined();
    expect(organization.hasOriginatingRead).toBe(false);
    expect(organization.memberships).toEqual([]);
    expect(requests.organizationRequests).toBe(0);
    const reads = requests.providerRequests.length;
    const documents = requests.documentRequests.length;
    const resourceUrl = new URL('/app/show', page.url());
    resourceUrl.searchParams.set('subject', organization.subject);
    await page.goto(resourceUrl.href);
    const related = page.getByRole('group', {
      name: 'Related collections',
      exact: true,
    });
    await expect(
      related.getByRole('button', {
        name: 'Issues and pull requests (via Repositories)',
        exact: true,
      }),
    ).toBeVisible();
    await related
      .getByRole('button', { name: 'Repositories', exact: true })
      .click();
    await expect(page.getByRole('main')).toHaveAttribute(
      'about',
      repositoriesSubject,
    );
    await expect(page.locator('iframe[title="App"]:visible')).toHaveCount(0);
    const selected = await selectFilter(page);
    expect(requests.providerRequests).toHaveLength(reads);
    expect(requests.documentRequests).toHaveLength(documents);
    await sync(page, selected);
    await browse(page);
    await expect(page.getByRole('grid')).toHaveAttribute('aria-rowcount', '3');
    expect(requests.providerRequests).toContain('/orgs/ontola');
    expect(requests.providerRequests).toContain('/orgs/ontola/repos');
    expect(requests.organizationRequests).toBe(0);
    const unchangedOrigin = (
      await sourceState(page, organizationsSubject)
    ).rows.find(row => row.subject === organization.subject)!;
    expect(unchangedOrigin.hasOriginatingRead).toBe(false);
    expect(unchangedOrigin.memberships).toEqual([]);
    expect(unchangedOrigin.key).toBe(organization.key);

    // Older installations still point their bare table URL at an unconfigured
    // Collection. A real saved View includes genesis and the creator's write ACL.
    const legacyView = await page.evaluate(async subject => {
      const store = window.store;
      const base = 'https://atomicdata.dev/properties/';
      const table = await store.getResource(subject);
      const views = table.getSubjects(base + 'table-views');
      const ordinary = (
        await Promise.all(views.map(view => store.getResource(view)))
      ).find(view => view.get(base + 'view-kind') === 'table');
      const owner = store.getAgent()?.subject;
      if (!ordinary || !owner) throw new Error('Missing signed table fixture');
      const old = await store.newResource({
        parent: subject,
        isA: ['https://atomicdata.dev/classes/View'],
        propVals: {
          [base + 'name']: 'Collection',
          [base + 'view-kind']: 'syncable-collection',
          [base + 'write']: [owner],
        },
      });
      await old.save();
      // The ordinary Table has a setting of its own so a selected tab label
      // cannot stand in for using the correct View on a bare URL.
      await ordinary.set(base + 'view-filters', [
        { property: base + 'name', operator: 'eq', value: 'atomic-server' },
      ]);
      await ordinary.save();
      await table.set(base + 'table-views', [old.subject, ...views]);
      await table.set(base + 'table-default-view', old.subject);
      await table.save();

      return old.subject;
    }, repositoriesSubject);
    await waitForSynced(page);
    const tableUrl = new URL('/app/show', page.url());
    tableUrl.searchParams.set('subject', repositoriesSubject);
    await page.goto(tableUrl.href);
    await expect(
      page.getByRole('tab', { name: 'Table', exact: true }),
    ).toHaveAttribute('aria-selected', 'true');
    await expect(
      page.getByRole('tab', { name: /^(Collection|Syncable Collections)$/ }),
    ).toHaveCount(0);
    await expect(page.getByRole('grid')).toHaveAttribute('aria-rowcount', '2');
    await testInfo.attach('repositories-table-without-duplicate-collection', {
      body: await page.screenshot({ animations: 'disabled' }),
      contentType: 'image/png',
    });
    tableUrl.searchParams.set('view', legacyView);
    await page.goto(tableUrl.href);
    await expect(
      page.getByRole('tab', { name: /^(Collection|Syncable Collections)$/ }),
    ).toHaveCount(0);
    await expect(page.getByRole('grid')).toHaveAttribute('aria-rowcount', '4');
    await expect(page.locator('iframe[title="App"]')).toHaveCount(0);
  });

  test('retains a saved principal and safely reconnects an expired orphan connection from the App', async ({
    page,
    browserDiagnostics,
  }, testInfo) => {
    test.setTimeout(150_000);
    const requests = await mockIntegrationProxy(page);
    await before({ page }, testInfo);
    // Finish signed setup writes before the settings helper deliberately reloads.
    await waitForSynced(page);
    await waitForDriveSettled(page);
    await enableIntegrationDiscovery(page);
    await clickAccountMenuItem(page, 'Apps');
    await page
      .locator(`[data-proxy-platform="${PLATFORM}"]`)
      .getByRole('button', { name: 'Add GitHub to drive' })
      .click();
    const iframe = page.locator('iframe[title="App"]:visible').contentFrame();
    await expect(
      iframe.getByRole('heading', { name: 'Connected principals' }),
    ).toBeVisible({ timeout: 45_000 });
    const appUrl = page.url();
    const appSubject = await getCurrentSubject(page);
    await openConsent(page, iframe, 'Connect account');
    const principalSubject = await finishConsent(page);
    const saved = await sourceState(page, principalSubject);
    const oldSlot = requests.redeemed[0];
    const principalButton = iframe.getByRole('button', {
      name: 'GitHub · michiel',
      exact: true,
    });

    // A newer slot verifies the same typed principal. The older owned slot is
    // retained by the proxy and can expire independently of the saved account.
    await page.goto(appUrl);
    await expect(principalButton).toBeVisible({ timeout: 45_000 });
    await openConsent(page, iframe, 'Connect account');
    expect(await finishConsent(page)).toBe(principalSubject);
    await expect.poll(() => requests.redeemed.length).toBe(2);
    await expect
      .poll(async () => (await sourceState(page, principalSubject)).config)
      .toMatchObject({ connectionId: requests.redeemed[1] });
    await waitForSynced(page);
    await waitForDriveSettled(page);
    browserDiagnostics.expect(
      'error',
      /Failed to load resource:.*401/,
      'The deliberately expired orphan slot rejects its principal read.',
      1,
      /^https:\/\/syncables-test\.example\/proxy\//,
      { optional: true },
    );
    requests.expiredPrincipalConnection = oldSlot;
    await page.goto(appUrl);
    const notice = iframe
      .getByRole('alert')
      .filter({ hasText: 'This connection has expired.' });
    await expect(notice).toBeVisible({ timeout: 45_000 });
    await expect(
      notice.getByRole('button', { name: 'Reconnect connection', exact: true }),
    ).toBeVisible();
    await expect(notice).toContainText(
      'Saved accounts and collections are retained.',
    );
    await expect(principalButton).toHaveCount(1);
    await expect(iframe.locator('body')).not.toContainText(
      'No accounts connected',
    );
    await expect(iframe.locator('body')).not.toContainText(
      'Authenticated principal returned HTTP 401',
    );
    expect((await sourceState(page, principalSubject)).key).toBe(saved.key);
    expect((await sourceState(page, principalSubject)).localId).toBe(
      saved.localId,
    );
    expect(requests.organizationRequests).toBe(0);
    expect(requests.repositoryRequests).toBe(0);
    await testInfo.attach('expired-orphan-connection-desktop', {
      body: await page.screenshot(),
      contentType: 'image/png',
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(
      notice.getByRole('button', { name: 'Reconnect connection', exact: true }),
    ).toBeVisible();
    await testInfo.attach('expired-orphan-connection-mobile', {
      body: await page.screenshot(),
      contentType: 'image/png',
    });
    await page.setViewportSize({ width: 1200, height: 800 });

    await openConsent(page, iframe, 'Reconnect connection');
    await page.getByRole('link', { name: 'Authorize', exact: true }).click();
    await expect(page).toHaveURL(appUrl, { timeout: 45_000 });
    await expect(principalButton).toBeVisible({ timeout: 45_000 });
    await expect(iframe.getByRole('alert')).toHaveCount(0);
    expect(requests.redeemed).toHaveLength(3);
    // Recovery replaces the credential behind the original logical slot.
    const activeId = await page.evaluate(
      ({ origin, slot }) => {
        const prefix = 'atomic-proxy-keyed-v1:';
        const key = Object.keys(localStorage).find(candidate => {
          if (!candidate.startsWith(prefix)) return false;
          const parts = JSON.parse(candidate.slice(prefix.length));

          return parts[0] === origin && parts[2] === slot;
        });

        return key
          ? JSON.parse(localStorage.getItem(key)!).activeId
          : undefined;
      },
      { origin: PROXY, slot: oldSlot },
    );
    expect(activeId).toBe(requests.redeemed[2]);
    expect(requests.principalConnections).toContain(activeId);
    expect(await sourceSubject(page, 'principal')).toBe(principalSubject);
    const restored = await sourceState(page, principalSubject);
    expect(restored.key).toBe(saved.key);
    expect(restored.localId).toBe(saved.localId);
    expect(restored.config).toMatchObject({
      connectionId: requests.redeemed[1],
    });
    await principalButton.click();
    await expect.poll(() => getCurrentSubject(page)).not.toBe(appSubject);
    expect(await getCurrentSubject(page)).toBe(principalSubject);
    const directory = await browse(page);
    const apps = await principalApps(page);
    expect(apps).toHaveLength(1);
    expect(apps[0]).toMatchObject({
      subject: principalSubject,
      parent: apps[0].drive,
      name: 'GitHub · michiel',
      isApp: true,
      appData: principalSubject,
      builtin: 'syncables',
      key: saved.key,
      localId: saved.localId,
      views: saved.views,
    });
    expect(apps[0].classes).toEqual(expect.arrayContaining(saved.classes));
    await expect(
      page.getByRole('heading', { name: 'GitHub · michiel', exact: true }),
    ).toBeVisible();
    await expect(
      directory.getByText('Organizations', { exact: true }),
    ).toBeVisible();
    await expect(
      directory.getByText('Repositories', { exact: true }),
    ).toBeVisible();
    expect(requests.organizationRequests).toBe(0);
    expect(requests.repositoryRequests).toBe(0);
  });

  test('connects a principal directly and syncs only selected declared collection instances', async ({
    page,
    browserDiagnostics,
  }, testInfo) => {
    test.setTimeout(240_000);
    const requests = await mockIntegrationProxy(page);
    await before({ page }, testInfo);
    // Finish signed setup writes before the settings helper deliberately reloads.
    await waitForSynced(page);
    await waitForDriveSettled(page);
    const driveUrl = page.url();
    await enableIntegrationDiscovery(page);
    await expect(page).toHaveURL(driveUrl);
    await expect(currentDriveTitle(page)).toBeVisible();
    await clickAccountMenuItem(page, 'Apps');
    const card = page.locator(`[data-proxy-platform="${PLATFORM}"]`);
    await card.getByRole('button', { name: 'Add GitHub to drive' }).click();
    const frame = page.locator('iframe[title="App"]:visible');
    const iframe = frame.contentFrame();
    await expect(
      iframe.getByRole('heading', { name: 'Connected principals' }),
    ).toBeVisible({ timeout: 45_000 });
    const appUrl = page.url();
    const appSubject = await getCurrentSubject(page);
    const manager = await sourceState(page, appSubject);
    await expect(frame).toHaveAttribute('sandbox', /\ballow-scripts\b/);
    await expect(frame).not.toHaveAttribute('sandbox', /\ballow-same-origin\b/);
    expect(await iframe.locator('html').evaluate(() => window.origin)).toBe(
      'null',
    );
    expect(requests.providerRequests).toEqual([]);
    expect(requests.iconRequests).toEqual([GITHUB_ICON]);
    const sidebar = page.getByTestId('sidebar');
    await expect(sidebar.getByText('Accounts', { exact: true })).toHaveCount(0);
    await expect(
      sidebar.getByRole('button', { name: 'GitHub', exact: true }),
    ).toHaveCount(0);
    await testInfo.attach('github-connection-manager', {
      body: await page.screenshot(),
      contentType: 'image/png',
    });

    await openConsent(page, iframe, 'Connect account');
    await page.getByRole('link', { name: 'Decline', exact: true }).click();
    await expect(page).toHaveURL(appUrl);
    expect(requests.redeemed).toEqual([]);
    await expect(
      sidebar.getByRole('button', { name: 'GitHub · michiel', exact: true }),
    ).toHaveCount(0);
    await openConsent(page, iframe, 'Connect account');
    const principalSubject = await finishConsent(page);
    await expect(
      sidebar.getByRole('button', { name: 'GitHub · michiel', exact: true }),
    ).toHaveCount(1);
    await testInfo.attach('github-principal-after-authorization', {
      body: await page.screenshot(),
      contentType: 'image/png',
    });
    expect(requests.organizationRequests).toBe(0);
    expect(requests.repositoryRequests).toBe(0);
    expect(requests.providerRequests.every(path => path === '/user')).toBe(
      true,
    );
    const setupReads = requests.providerRequests.length;
    const setupDocuments = requests.documentRequests.length;
    expect(await sourceSubject(page, 'principal')).toBe(principalSubject);
    await browse(page);
    const apps = await principalApps(page);
    expect(apps).toHaveLength(1);
    expect(apps[0]).toMatchObject({
      subject: principalSubject,
      parent: apps[0].drive,
      name: 'GitHub · michiel',
      isApp: true,
      appData: principalSubject,
      builtin: 'syncables',
      config: {
        principal: { kind: 'authenticated', subject: 321 },
        connectionId: requests.redeemed[0],
      },
      icon: manager.icon,
    });
    expect(typeof apps[0].icon).toBe('string');
    await expect(
      sidebar.getByRole('button', { name: 'GitHub · michiel', exact: true }),
    ).toHaveCount(1);
    await expect(
      sidebar.getByRole('button', { name: 'GitHub', exact: true }),
    ).toHaveCount(0);
    // Migration preserves this old localId; it must still form a navigable principal Table.
    await page.evaluate(
      async ({ subject, proxy, connection }) => {
        const principal = await window.store.getResource(subject);
        await principal.set(
          'https://atomicdata.dev/properties/localId',
          'syncables:node:' +
            encodeURIComponent(
              JSON.stringify([
                proxy,
                'github-issues',
                'account',
                connection,
                '',
              ]),
            ),
        );
        await principal.save();
      },
      {
        subject: principalSubject,
        proxy: PROXY,
        connection: requests.redeemed[0],
      },
    );
    const principalUrl = page.url();
    const principalTable = await browse(page);
    await expect(
      principalTable.getByText('Organizations', { exact: true }),
    ).toBeVisible();
    await expect(
      principalTable.getByText('Repositories', { exact: true }),
    ).toBeVisible();
    await expect(sidebar.getByText('Accounts', { exact: true })).toHaveCount(0);
    await expect(
      principalTable.getByText('Issues and pull requests', { exact: true }),
    ).toBeVisible();
    expect(requests.providerRequests).toHaveLength(setupReads);
    expect(requests.documentRequests).toHaveLength(setupDocuments);
    let releaseOrganizations: (() => void) | undefined;
    requests.organizationGate = new Promise(resolve => {
      releaseOrganizations = resolve;
    });

    // Related source workers publish shared identities and run in order.
    try {
      await openRow(page, 'Issues and pull requests');
      await browse(page);
      await expect
        .poll(() => requests.organizationRequests, { timeout: 60_000 })
        .toBe(1);
      expect(requests.repositoryRequests).toBe(0);
    } finally {
      releaseOrganizations?.();
      requests.organizationGate = undefined;
    }

    // The empty Table keeps preparing the next source in the background.
    await expect
      .poll(
        () => [requests.organizationRequests, requests.repositoryRequests],
        {
          timeout: 60_000,
        },
      )
      .toEqual([1, 1]);
    expect(requests.issueConnections).toEqual([]);
    await selectView(page, 'Sync');
    const organizations = iframe.getByRole('combobox', {
      name: 'Organizations',
      exact: true,
    });
    const repositories = iframe.getByRole('combobox', {
      name: 'Repositories',
      exact: true,
    });
    await expect(organizations).toBeVisible({ timeout: 30_000 });
    await expect(repositories).toBeVisible();
    await expect(
      iframe.getByLabel('Repository owner', { exact: true }),
    ).toHaveCount(0);
    await expect(
      iframe.getByLabel('Repository name', { exact: true }),
    ).toHaveCount(0);
    await expect(
      organizations.getByRole('option', { name: 'ontola', exact: true }),
    ).toHaveCount(1, { timeout: 60_000 });
    await expect(
      repositories.getByRole('option', { name: 'notes', exact: true }),
    ).toHaveCount(1, { timeout: 60_000 });
    await organizations.selectOption({ label: 'ontola' });
    await expect(
      repositories.getByRole('option', { name: 'notes', exact: true }),
    ).toHaveCount(0);
    await repositories.selectOption({ label: 'atomic-server' });
    await expect(
      iframe.getByRole('button', { name: 'Save filter', exact: true }),
    ).toBeEnabled();
    await expect(
      page.getByRole('combobox', { name: 'Saved filter', exact: true }),
    ).toHaveCount(0);
    expect(requests.issueConnections).toEqual([]);
    expect(requests.organizationRequests).toBe(1);
    expect(requests.repositoryRequests).toBe(1);
    await testInfo.attach('github-issues-sync-repository-scope', {
      body: await page.screenshot({ animations: 'disabled' }),
      contentType: 'image/png',
    });
    await page.goto(principalUrl);
    await openRow(page, 'Organizations');
    const organizationsSubject = await getCurrentSubject(page),
      organizationsUrl = page.url();
    const directory = await waitForInitialSync(page, 'ontola');
    await expect(
      page.getByRole('tab', { name: /^(Collection|Syncable Collections)$/ }),
    ).toHaveCount(0);
    expect(requests.organizationRequests).toBe(1);
    await selectView(page, 'Sync');
    const organizationsFilter = page.getByRole('combobox', {
      name: 'Saved filter',
      exact: true,
    });
    await expect(
      iframe.getByRole('button', { name: 'Sync now', exact: true }),
    ).toBeEnabled({ timeout: 60_000 });
    await expect(
      organizationsFilter.getByRole('option', { name: 'All cached rows' }),
    ).toHaveCount(0);
    const organizationsRule = await organizationsFilter.inputValue();
    expect(organizationsRule).toBeTruthy();
    await testInfo.attach('github-organizations-sync-default-rule', {
      body: await page.screenshot(),
      contentType: 'image/png',
    });
    await browse(page);
    await expect(
      directory.getByText('reporting', { exact: true }),
    ).toBeVisible();
    await expect(directory.getByText('michiel', { exact: true })).toHaveCount(
      0,
    );
    expect((await sourceState(page, organizationsSubject)).rows).toHaveLength(
      2,
    );
    expect(requests.organizationRequests).toBe(1);
    expect(requests.issueConnections).toEqual([]);

    // Root and organization reads share the same Repositories table and rows.
    await page.goto(principalUrl);
    await openRow(page, 'Repositories');
    const repositoriesSubject = await getCurrentSubject(page);
    await waitForInitialSync(page, 'notes');
    const rootRepositoriesRule = await selectFilter(page);
    const rootRepositoriesUrl = page.url();
    const rootState = await sourceState(page, repositoriesSubject);
    expect(rootState.rows).toHaveLength(3);
    const firstRepo = rootState.rows.find(row => row.name === 'atomic-server')!;
    const organization = (
      await sourceState(page, organizationsSubject)
    ).rows.find(row => row.raw?.id === 123)!;
    expect(firstRepo.managed).toContainEqual(
      expect.objectContaining({
        datatype: 'https://atomicdata.dev/datatypes/atomicURL',
        value: organization.subject,
      }),
    );
    const personalOwner = rootState.rows
      .find(row => row.name === 'notes')!
      .managed.find(
        field =>
          field.datatype === 'https://atomicdata.dev/datatypes/atomicURL',
      )!.value as string;
    const suppliedOwner = await page.evaluate(async subject => {
      const row = await window.store.getResource(subject);

      return {
        name: row.get('https://atomicdata.dev/properties/name'),
        subject: row.subject,
      };
    }, personalOwner);
    expect(suppliedOwner).toEqual({ name: 'michiel', subject: personalOwner });
    expect(
      requests.providerRequests.some(
        path =>
          path.startsWith('/user/') &&
          path !== '/user/orgs' &&
          path !== '/user/repos',
      ),
    ).toBe(false);
    expect(firstRepo.managed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          datatype: 'https://atomicdata.dev/datatypes/boolean',
          value: false,
        }),
        expect.objectContaining({
          datatype: 'https://atomicdata.dev/datatypes/integer',
          value: 7,
        }),
      ]),
    );
    expect(requests.providerRequests).toContain('/user/repos');
    const nativeReads = requests.providerRequests.length,
      nativeDocuments = requests.documentRequests.length;
    let attemptedNativeReads = 0;

    const offline = async (route: Route) => {
      attemptedNativeReads++;
      await route.abort('failed');
    };

    await page.route(PROXY + '/proxy/**', offline);
    const organizationResourceUrl = new URL('/app/show', page.url());
    organizationResourceUrl.searchParams.set('subject', organization.subject);
    await page.goto(organizationResourceUrl.href);
    await expect(
      page.getByRole('heading', { name: 'ontola', exact: true }),
    ).toBeVisible();
    const related = page.getByRole('group', {
      name: 'Related collections',
      exact: true,
    });
    await expect(
      related.getByRole('button', { name: 'Repositories', exact: true }),
    ).toBeVisible();
    await expect(
      related.getByRole('button', {
        name: 'Issues and pull requests (via Repositories)',
        exact: true,
      }),
    ).toBeVisible();
    await expect(page.locator('iframe[title="App"]')).toHaveCount(0);
    await testInfo.attach('github-organization-resource-actions-desktop', {
      body: await page.screenshot({ animations: 'disabled' }),
      contentType: 'image/png',
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await testInfo.attach('github-organization-resource-actions-mobile', {
      body: await page.screenshot({ animations: 'disabled' }),
      contentType: 'image/png',
    });
    await page.setViewportSize({ width: 1200, height: 800 });
    await related
      .getByRole('button', { name: 'Repositories', exact: true })
      .click();
    await expect(page.getByRole('main')).toHaveAttribute(
      'about',
      repositoriesSubject,
    );
    await expect(
      page.getByRole('tab', { name: 'Table', exact: true }),
    ).toHaveAttribute('aria-selected', 'true');
    const directOrganizationRule = await selectFilter(page);
    await expect(
      page.getByText('This filter has no completed sync yet.', {
        exact: false,
      }),
    ).toBeVisible();
    await expect(page.getByRole('grid')).toHaveAttribute('aria-rowcount', '1');
    expect((await sourceState(page, repositoriesSubject)).rows).toHaveLength(3);
    await page.goto(organizationResourceUrl.href);
    await related
      .getByRole('button', {
        name: 'Issues and pull requests (via Repositories)',
        exact: true,
      })
      .click();
    await expect(
      page.getByRole('heading', {
        name: 'Issues and pull requests',
        exact: true,
      }),
    ).toBeVisible();
    await expect(page.getByRole('grid')).toHaveAttribute('aria-rowcount', '1');
    const initialIssuesTable = await getCurrentSubject(page);
    const initialIssueScopeUrl = page.url();
    expect((await sourceState(page, initialIssuesTable)).config).toMatchObject({
      resource: 'issue',
    });
    await page.goto(organizationResourceUrl.href);
    await related
      .getByRole('button', { name: 'Repositories', exact: true })
      .click();
    expect(await selectFilter(page)).toBe(directOrganizationRule);
    expect(attemptedNativeReads).toBe(0);
    expect(requests.documentRequests).toHaveLength(nativeDocuments);
    await page.goto(organizationsUrl);
    await browse(page);
    await selectFilter(page, organizationsRule);
    await openRow(page, 'ontola');
    await expect(page.getByRole('main')).toHaveAttribute(
      'about',
      repositoriesSubject,
    );
    const repositoriesRule = await selectFilter(page);
    expect(repositoriesRule).not.toBe(rootRepositoriesRule);
    const repositoriesUrl = page.url();
    const emptyScope = await browse(page);
    await expect(
      emptyScope.getByText('atomic-server', { exact: true }),
    ).toHaveCount(0);
    expect((await sourceState(page, repositoriesSubject)).rows).toHaveLength(3);
    expect(attemptedNativeReads).toBe(0);
    expect(requests.providerRequests).toHaveLength(nativeReads);
    expect(requests.documentRequests).toHaveLength(nativeDocuments);
    await page.unroute(PROXY + '/proxy/**', offline);

    // A single saved issue scope normally reselects itself on Sync. Adding a
    // filter must keep the source picker open while preserving that scope.
    await page.goto(initialIssueScopeUrl);
    await selectView(page, 'Sync');
    const issueFilterBar = page.locator(
      '[aria-label="Saved collection filters"]',
    );
    const savedIssueFilters = issueFilterBar.getByRole('combobox', {
      name: 'Saved filter',
      exact: true,
    });
    await expect(savedIssueFilters.getByRole('option')).toHaveCount(1);
    await expect(
      iframe.getByRole('button', { name: 'Sync now', exact: true }),
    ).toBeVisible({ timeout: 30_000 });
    await issueFilterBar
      .getByRole('button', { name: 'Add filter', exact: true })
      .click();
    await expect(page.getByRole('main')).toHaveAttribute(
      'about',
      initialIssuesTable,
    );
    await expect(
      page.getByRole('tab', { name: 'Sync', exact: true }),
    ).toHaveAttribute('aria-selected', 'true');
    await expect(repositories).toBeVisible();
    await expect(
      repositories.getByRole('option', { name: 'atomic-server', exact: true }),
    ).toHaveCount(1);
    await expect(
      savedIssueFilters.locator('option[value]:not([value=""])'),
    ).toHaveCount(1);
    expect(requests.providerRequests).toHaveLength(nativeReads);

    await page.goto(repositoriesUrl);
    await sync(page, repositoriesRule);
    expect(requests.providerRequests).toContain('/orgs/ontola');
    expect(requests.providerRequests).toContain('/orgs/ontola/repos');
    const repos = await browse(page);
    await expect(
      repos.getByText('atomic-server', { exact: true }),
    ).toBeVisible();
    await expect(repos.getByText('notes', { exact: true })).toHaveCount(0);
    const shared = await sourceState(page, repositoriesSubject);
    expect(shared.rows).toHaveLength(3);
    expect(shared.rows.find(row => row.name === 'atomic-server')?.subject).toBe(
      firstRepo.subject,
    );
    expect(
      shared.rows.find(row => row.name === 'atomic-server')?.memberships,
    ).toEqual(expect.arrayContaining([rootRepositoriesRule, repositoriesRule]));
    expect(requests.issueConnections).toHaveLength(0);

    const beforeIssueOpen = requests.providerRequests.length;
    // Ordinary schema-driven Table now provides the same stored relationship
    // navigation; no custom Collection iframe or provider refresh is needed.
    await selectView(page, 'Table');
    const repositoryGrid = page.getByRole('grid');
    await expect(repositoryGrid).toBeVisible();
    await testInfo.attach('github-table-record-links-desktop', {
      body: await page.screenshot({ animations: 'disabled' }),
      contentType: 'image/png',
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await testInfo.attach('github-table-record-links-mobile', {
      body: await page.screenshot({ animations: 'disabled' }),
      contentType: 'image/png',
    });
    await page.setViewportSize({ width: 1200, height: 800 });
    await repositoryGrid
      .getByRole('row')
      .filter({ hasText: 'atomic-server' })
      .getByRole('button', { name: 'Open', exact: true })
      .click();
    await expect
      .poll(() => getCurrentSubject(page))
      .not.toBe(repositoriesSubject);
    const mirrorSubject = await getCurrentSubject(page);
    await expect(page.getByRole('grid')).toBeVisible();
    const issuesRule = await selectFilter(page);
    await browse(page);
    expect(requests.providerRequests).toHaveLength(beforeIssueOpen);
    expect((await sourceState(page, mirrorSubject)).config).toMatchObject({
      resource: 'issue',
    });
    // Entity tables are siblings. There is no organization/repository mirror tree.
    expect(
      await page.evaluate(
        async ({ subjects, parent }) =>
          Promise.all(
            subjects.map(
              async subject =>
                (await window.store.getResource(subject)).get(
                  'https://atomicdata.dev/properties/parent',
                ) === parent,
            ),
          ),
        {
          subjects: [organizationsSubject, repositoriesSubject, mirrorSubject],
          parent: principalSubject,
        },
      ),
    ).toEqual([true, true, true]);
    await selectView(page, 'Sync');
    const syncNow = iframe.getByRole('button', {
      name: 'Sync now',
      exact: true,
    });
    await expect(syncNow).toBeVisible({ timeout: 30_000 });
    let release: (() => void) | undefined;
    requests.issueGate = new Promise(resolve => {
      release = resolve;
    });
    await syncNow.click();
    await expect.poll(() => requests.issueConnections.length).toBe(1);
    // The two paged source reads also count toward this related sync.
    const pageProgress = iframe.getByRole('status').filter({
      hasText: /^Syncing page 3$/,
    });
    await expect(pageProgress).toBeVisible();
    await testInfo.attach('github-sync-page-progress', {
      body: await page.screenshot(),
      contentType: 'image/png',
    });
    await sidebar
      .getByRole('button', { name: 'Organizations', exact: true })
      .click();
    await expect(page.getByRole('main')).toHaveAttribute(
      'about',
      organizationsSubject,
    );
    await browse(page);
    await selectFilter(page, organizationsRule);
    await expect(directory.getByText('ontola', { exact: true })).toBeVisible();
    await expect(frame).toHaveCount(0);
    await expect(page.locator('iframe[title="App"]')).toHaveCount(1);
    await testInfo.attach('github-native-browse-during-rule-sync', {
      body: await page.screenshot(),
      contentType: 'image/png',
    });
    const backgroundReads = requests.providerRequests.length,
      backgroundDocuments = requests.documentRequests.length;
    await sidebar
      .getByRole('button', { name: 'Issues and pull requests', exact: true })
      .click();
    await expect(page.getByRole('main')).toHaveAttribute(
      'about',
      mirrorSubject,
    );
    await selectFilter(page, issuesRule);
    await selectView(page, 'Sync');
    await expect(
      iframe.getByRole('button', { name: 'Syncing', exact: true }),
    ).toBeDisabled();
    await expect(pageProgress).toBeVisible();
    expect(requests.providerRequests).toHaveLength(backgroundReads);
    // The native view did no provider/catalog reads. Reopening the Sync iframe
    // derives a fresh scoped host profile from the current document + selection,
    // while the existing background worker keeps running without another read.
    expect(requests.documentRequests.slice(backgroundDocuments)).toEqual([
      '/catalog/github-issues.yaml',
      '/catalog/github-issues.selection.json',
    ]);
    release?.();
    requests.issueGate = undefined;
    await expect(
      iframe.getByText('3 entries read in the last attempt for this filter', {
        exact: true,
      }),
    ).toBeVisible({ timeout: 60_000 });
    await expect(syncNow).toBeEnabled();
    await browse(page);
    const initial = await sourceState(page, mirrorSubject);
    expect(initial.rows).toHaveLength(3);
    // The catalog declares GitHub REST Issues, including its PR-shaped record.
    expect(initial.rows.find(row => row.raw?.number === 17)?.name).toBe(
      PULL_REQUEST_TITLE,
    );
    expect(initial.rows.find(row => row.raw?.number === 17)?.managed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          datatype: 'https://atomicdata.dev/datatypes/json',
          value: {},
        }),
      ]),
    );
    const imported = initial.rows.find(row => row.raw?.number === 15)!;
    expect(imported.managed).toContainEqual(
      expect.objectContaining({
        datatype: 'https://atomicdata.dev/datatypes/atomicURL',
        value: personalOwner,
      }),
    );
    expect(imported.name).toBe(FIRST_ISSUE_TITLE);
    expect(imported.managed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          datatype: 'https://atomicdata.dev/datatypes/integer',
          value: 15,
        }),
        expect.objectContaining({
          datatype: 'https://atomicdata.dev/datatypes/timestamp',
          value: Date.parse('2026-11-13T10:00:00Z'),
        }),
      ]),
    );
    await testInfo.attach('github-flat-principal-collections-desktop', {
      body: await page.screenshot({ animations: 'disabled' }),
      contentType: 'image/png',
    });

    // Pausing one saved rule does not freeze its shared entities for other rules.
    await selectView(page, 'Sync');
    await iframe.getByRole('button', { name: 'Pause', exact: true }).click();
    await expect(
      iframe.getByRole('button', { name: 'Resume', exact: true }),
    ).toBeVisible();
    await expect(syncNow).toBeDisabled();
    await page.reload();
    await expect(
      iframe.getByRole('button', { name: 'Resume', exact: true }),
    ).toBeVisible({ timeout: 30_000 });
    await expect(syncNow).toBeDisabled();
    await page.goto(repositoriesUrl);
    await browse(page);
    const noFanoutReads = requests.providerRequests.length;
    await page
      .getByRole('button', {
        name: 'Open Issues and pull requests',
        exact: true,
      })
      .click();
    await expect(page.getByRole('main')).toHaveAttribute(
      'about',
      mirrorSubject,
    );
    const allOrgIssuesRule = await selectFilter(page);
    expect(allOrgIssuesRule).not.toBe(issuesRule);
    expect(requests.providerRequests).toHaveLength(noFanoutReads);
    await sync(page, allOrgIssuesRule);
    expect(requests.providerRequests).toContain('/repositories/790/issues');
    const changed = await sourceState(page, mirrorSubject);
    expect(changed.rows).toHaveLength(3);
    expect(
      changed.rows.find(row => row.subject === imported.subject),
    ).toMatchObject({ name: UPDATED_ISSUE_TITLE, localId: imported.localId });
    await selectFilter(page, issuesRule);
    await selectView(page, 'Sync');
    await expect(
      iframe.getByRole('button', { name: 'Resume', exact: true }),
    ).toBeVisible();
    await iframe.getByRole('button', { name: 'Resume', exact: true }).click();
    await sync(page, issuesRule);
    await sync(page, issuesRule);
    await expect(
      iframe.getByText('0 added · 0 changed · 3 unchanged', { exact: true }),
    ).toBeVisible();

    const connection = requests.redeemed[0];
    browserDiagnostics.expect(
      'error',
      /Failed to load resource:.*401/,
      'The deliberately expired fixture credential is rejected.',
      1,
      /^https:\/\/syncables-test\.example\/proxy\//,
      { optional: true },
    );
    requests.expiredConnection = connection;
    await syncNow.click();
    await expect(iframe.getByRole('alert')).toContainText('401');
    const reconnectUrl = page.url();
    await openConsent(page, iframe, 'Reconnect');
    await page.getByRole('link', { name: 'Authorize', exact: true }).click();
    await expect(page).toHaveURL(reconnectUrl, { timeout: 45_000 });
    await sync(page, issuesRule);
    expect(requests.redeemed).toHaveLength(2);
    expect(requests.issueConnections.at(-1)).toBe(requests.redeemed[1]);
    expect(
      (await sourceState(page, mirrorSubject)).rows
        .map(row => row.subject)
        .sort(),
    ).toEqual(initial.rows.map(row => row.subject).sort());

    const completedRows = (await sourceState(page, mirrorSubject)).rows,
      pendingReads = requests.issueConnections.length;
    requests.issueGate = new Promise(resolve => {
      release = resolve;
    });
    await syncNow.click();
    await expect
      .poll(() => requests.issueConnections.length)
      .toBe(pendingReads + 1);
    await iframe.getByRole('button', { name: 'Pause', exact: true }).click();
    await expect(
      iframe.getByRole('button', { name: 'Resume', exact: true }),
    ).toBeVisible();
    await expect(syncNow).toBeDisabled();
    release?.();
    requests.issueGate = undefined;
    await browse(page);
    expect(
      (await sourceState(page, mirrorSubject)).rows
        .map(row => row.subject)
        .sort(),
    ).toEqual(completedRows.map(row => row.subject).sort());

    // Offline native navigation selects saved scopes without provider/catalog I/O.
    const offlineReads = requests.providerRequests.length,
      offlineDocuments = requests.documentRequests.length;
    await page.route(PROXY + '/proxy/**', offline);
    await page.goto(repositoriesUrl);
    await browse(page);
    await openRow(page, 'atomic-server');
    await browse(page);
    expect(await getCurrentSubject(page)).toBe(mirrorSubject);
    expect(requests.providerRequests).toHaveLength(offlineReads);
    expect(requests.documentRequests).toHaveLength(offlineDocuments);
    expect(attemptedNativeReads).toBe(0);
    await expect(
      page.getByRole('main').getByText(UPDATED_ISSUE_TITLE, { exact: true }),
    ).toBeVisible();
    await page.goto(organizationsUrl);
    await browse(page);
    await selectFilter(page, organizationsRule);
    const viewport = page.viewportSize()!;
    await page.setViewportSize({ width: 390, height: 844 });
    if (
      (await sidebar.isVisible()) &&
      (await sidebar.evaluate(node => getComputedStyle(node).opacity !== '0'))
    )
      await page.getByRole('button', { name: 'Show / hide sidebar' }).click();
    const open = directory
      .getByRole('row')
      .filter({ hasText: 'ontola' })
      .getByRole('button', { name: 'Open', exact: true });
    await expect(open).toBeInViewport();
    const bounds = await open.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
    await testInfo.attach('generic-flat-collections-mobile', {
      body: await page.screenshot({ animations: 'disabled' }),
      contentType: 'image/png',
    });
    await page.setViewportSize(viewport);
    await page.unroute(PROXY + '/proxy/**', offline);
    await page.goto(rootRepositoriesUrl);
    // A cold service worker navigation can abort an app chunk before Store exists.
    const waitForStore = () =>
      page.waitForFunction(() => Boolean(window.store), undefined, {
        timeout: 10_000,
      });

    try {
      await waitForStore();
    } catch (error) {
      if (!(error instanceof errors.TimeoutError)) throw error;
      await page.reload();
      await waitForStore();
    }

    await browse(page);
    await selectFilter(page, rootRepositoriesRule);
    await expect(
      page.getByRole('main').getByText('notes', { exact: true }),
    ).toBeVisible();
    await page.goto(principalUrl);
    await browse(page);
    expect(await sourceSubject(page, 'principal')).toBe(principalSubject);
  });

  test('reuses a renamed and moved principal App across OAuth slots and isolates another principal', async ({
    page,
  }, testInfo) => {
    test.setTimeout(240_000);
    const requests = await mockIntegrationProxy(page);
    await before({ page }, testInfo);
    await waitForSynced(page);
    await waitForDriveSettled(page);
    await enableIntegrationDiscovery(page);
    await clickAccountMenuItem(page, 'Apps');
    await page.getByRole('button', { name: 'Add GitHub to drive' }).click();
    const iframe = page.locator('iframe[title="App"]:visible').contentFrame();
    await expect(
      iframe.getByRole('heading', { name: 'Connected principals' }),
    ).toBeVisible({ timeout: 45_000 });
    const managerUrl = page.url();
    await openConsent(page, iframe, 'Connect account');
    const principalSubject = await finishConsent(page);
    await browse(page);
    const installed = await principalApps(page);
    expect(installed).toHaveLength(1);
    const originalApp = installed[0];
    expect(originalApp).toMatchObject({
      subject: principalSubject,
      parent: originalApp.drive,
      name: 'GitHub · michiel',
      isApp: true,
      appData: principalSubject,
      config: {
        principal: { kind: 'authenticated', subject: 321 },
        connectionId: requests.redeemed[0],
      },
    });
    await openRow(page, 'Repositories');
    const repositoriesSubject = await getCurrentSubject(page);
    await waitForInitialSync(page, 'notes');
    const first = await sourceState(page, repositoriesSubject);
    expect(first.rows).toHaveLength(3);
    expect(first.config?.connectionId).toBe(requests.redeemed[0]);
    const rowSubjects = first.rows.map(row => row.subject).sort();
    const movedParent = await page.evaluate(async appSubject => {
      const store = window.store;
      const base = 'https://atomicdata.dev/properties/';
      const folder = await store.newResource({
        parent: store.getDrive(),
        isA: ['https://atomicdata.dev/classes/Folder'],
        propVals: { [base + 'name']: 'My integration folder' },
      });
      await folder.save();
      const app = await store.getResource(appSubject);
      await app.set(base + 'name', 'My linked GitHub');
      await app.set(base + 'description', 'Keep my App note');
      await app.set(base + 'parent', folder.subject);
      await app.save();

      return folder.subject;
    }, principalSubject);
    await waitForSynced(page);
    await waitForDriveSettled(page);
    await page.goto(managerUrl);
    await expect(
      iframe.getByRole('button', { name: 'My linked GitHub', exact: true }),
    ).toBeVisible({ timeout: 45_000 });
    await openConsent(page, iframe, 'Connect account');
    expect(await finishConsent(page, 'My linked GitHub')).toBe(
      principalSubject,
    );
    await expect.poll(() => requests.redeemed.length).toBe(2);
    await expect(page.getByRole('main')).toHaveAttribute(
      'about',
      principalSubject,
    );
    await browse(page);
    const reused = await principalApps(page);
    expect(reused).toHaveLength(1);
    expect(reused[0]).toMatchObject({
      subject: principalSubject,
      parent: movedParent,
      name: 'My linked GitHub',
      description: 'Keep my App note',
      key: originalApp.key,
      localId: originalApp.localId,
      classes: originalApp.classes,
      views: originalApp.views,
      icon: originalApp.icon,
      config: { connectionId: requests.redeemed[1] },
    });
    const nativeReads = requests.providerRequests.length;
    const nativeDocuments = requests.documentRequests.length;
    await openRow(page, 'Repositories');
    await browse(page);
    expect(await getCurrentSubject(page)).toBe(repositoriesSubject);
    const retained = await sourceState(page, repositoriesSubject);
    expect(retained.key).toBe(first.key);
    expect(retained.localId).toBe(first.localId);
    expect(retained.rows.map(row => row.subject).sort()).toEqual(rowSubjects);
    expect(retained.config?.connectionId).toBe(requests.redeemed[0]);
    expect(requests.providerRequests).toHaveLength(nativeReads);
    expect(requests.documentRequests).toHaveLength(nativeDocuments);
    // The collection still stores its historical slot. The host must bind its
    // Sync worker to the principal App's freshly verified replacement instead.
    requests.expiredPrincipalConnection = requests.redeemed[0];
    await sync(page);
    requests.expiredPrincipalConnection = undefined;
    expect(requests.repositoryConnections.at(-1)).toBe(requests.redeemed[1]);
    await browse(page);
    expect(
      (await sourceState(page, repositoriesSubject)).rows
        .map(row => row.subject)
        .sort(),
    ).toEqual(rowSubjects);
    await testInfo.attach('principal-app-reused-after-new-slot', {
      body: await page.screenshot(),
      contentType: 'image/png',
    });
    // The old owned slot remains listed. Reopening the manager must not silently
    // downgrade this App back to that orphan instead of its current binding.
    await page.goto(managerUrl);
    await iframe
      .getByRole('button', { name: 'My linked GitHub', exact: true })
      .click();
    await expect(page.getByRole('main')).toHaveAttribute(
      'about',
      principalSubject,
    );
    await browse(page);
    expect((await principalApps(page))[0]).toMatchObject({
      subject: principalSubject,
      config: { connectionId: requests.redeemed[1] },
    });

    // Another verified typed principal gets its own App and canonical storage,
    // even when the provider returns repositories with the same remote IDs.
    requests.nextPrincipal = {
      id: 654,
      login: 'other',
      name: 'Other user',
      type: 'User',
    };
    await page.goto(managerUrl);
    await openConsent(page, iframe, 'Connect account');
    const otherSubject = await finishConsent(page, 'GitHub · Other user');
    await expect.poll(() => requests.redeemed.length).toBe(3);
    expect(otherSubject).not.toBe(principalSubject);
    await browse(page);
    const separate = await principalApps(page);
    expect(separate).toHaveLength(2);
    expect(separate.find(app => app.subject === otherSubject)).toMatchObject({
      parent: originalApp.drive,
      name: 'GitHub · Other user',
      isApp: true,
      appData: otherSubject,
      config: {
        principal: { kind: 'authenticated', subject: 654 },
        connectionId: requests.redeemed[2],
      },
    });
    expect(
      separate.find(app => app.subject === principalSubject),
    ).toMatchObject({
      parent: movedParent,
      name: 'My linked GitHub',
      description: 'Keep my App note',
      key: originalApp.key,
      localId: originalApp.localId,
      config: { connectionId: requests.redeemed[1] },
    });
    await openRow(page, 'Repositories');
    const otherRepositories = await getCurrentSubject(page);
    expect(otherRepositories).not.toBe(repositoriesSubject);
    await waitForInitialSync(page, 'notes');
    const other = await sourceState(page, otherRepositories);
    expect(other.rows).toHaveLength(3);
    expect(other.rows.every(row => !rowSubjects.includes(row.subject))).toBe(
      true,
    );
    expect(requests.repositoryConnections.at(-1)).toBe(requests.redeemed[2]);
    expect(
      (await sourceState(page, repositoriesSubject)).rows
        .map(row => row.subject)
        .sort(),
    ).toEqual(rowSubjects);
    await testInfo.attach('separate-principal-app-collections', {
      body: await page.screenshot(),
      contentType: 'image/png',
    });

    const chooserReads = requests.providerRequests.length;
    const chooserDocuments = requests.documentRequests.length;
    await clickAccountMenuItem(page, 'Apps');
    const connectedCard = page.locator(`[data-proxy-platform="${PLATFORM}"]`);
    await expect(
      connectedCard.getByText('Connected apps', { exact: true }),
    ).toHaveCount(1);
    const firstAppButton = connectedCard.getByRole('button', {
      name: 'My linked GitHub',
      exact: true,
    });
    const otherAppButton = connectedCard.getByRole('button', {
      name: 'GitHub · Other user',
      exact: true,
    });
    await expect(firstAppButton).toHaveCount(1);
    await expect(otherAppButton).toHaveCount(1);
    await connectedCard.scrollIntoViewIfNeeded();
    await expect(firstAppButton).toBeInViewport();
    await expect(otherAppButton).toBeInViewport();
    await testInfo.attach('connected-principal-apps-chooser-desktop', {
      body: await page.screenshot({ animations: 'disabled' }),
      contentType: 'image/png',
    });
    const viewport = page.viewportSize()!;
    await page.setViewportSize({ width: 390, height: 844 });
    const sidebar = page.getByTestId('sidebar');
    if (
      (await sidebar.isVisible()) &&
      (await sidebar.evaluate(node => getComputedStyle(node).opacity !== '0'))
    )
      await page.getByRole('button', { name: 'Show / hide sidebar' }).click();
    await connectedCard.scrollIntoViewIfNeeded();
    await expect(firstAppButton).toBeInViewport();
    await expect(otherAppButton).toBeInViewport();
    await testInfo.attach('connected-principal-apps-chooser-mobile', {
      body: await page.screenshot({ animations: 'disabled' }),
      contentType: 'image/png',
    });
    await page.setViewportSize(viewport);
    expect(requests.providerRequests).toHaveLength(chooserReads);
    expect(requests.documentRequests).toHaveLength(chooserDocuments);
    await firstAppButton.click();
    await expect(page.getByRole('main')).toHaveAttribute(
      'about',
      principalSubject,
    );
    const restoredDirectory = await browse(page);
    await expect(
      restoredDirectory.getByText('Repositories', { exact: true }),
    ).toBeVisible();
    await expect(page.locator('iframe[title="App"]:visible')).toHaveCount(0);
    expect(requests.providerRequests).toHaveLength(chooserReads);
    expect(requests.documentRequests).toHaveLength(chooserDocuments);
  });

  test('keeps the same principal and logical sources separate across two warm drives', async ({
    page,
  }, testInfo) => {
    test.setTimeout(240_000);
    const requests = await mockIntegrationProxy(page);
    await before({ page }, testInfo);
    await waitForSynced(page);
    await waitForDriveSettled(page);
    await enableIntegrationDiscovery(page);
    const driveA = await page.evaluate(() => window.store.getDrive()!);
    const actor = await page.evaluate(() => window.store.getAgent()!.subject);
    await clickAccountMenuItem(page, 'Apps');
    await page.getByRole('button', { name: 'Add GitHub to drive' }).click();
    const iframe = page.locator('iframe[title="App"]:visible').contentFrame();
    await expect(
      iframe.getByRole('heading', { name: 'Connected principals' }),
    ).toBeVisible({ timeout: 45_000 });
    const managerA = await getCurrentSubject(page);
    await openConsent(page, iframe, 'Connect account');
    await finishConsent(page);
    await browse(page);
    const appsA = await principalApps(page);
    expect(appsA).toHaveLength(1);
    const appA = appsA[0];
    expect(appA.parent).toBe(driveA);
    await openRow(page, 'Repositories');
    const tableA = await getCurrentSubject(page);
    await waitForInitialSync(page, 'notes');
    const firstA = await sourceState(page, tableA, driveA);
    expect(firstA.parent).toBe(appA.subject);
    expect(firstA.rows).toHaveLength(3);
    expect(
      firstA.rows.find(row => row.raw?.id === 456)?.raw?.open_issues_count,
    ).toBe(7);

    // The second drive belongs to this same agent and the same per-agent OPFS
    // database. Reusing the owned OAuth slot must not reuse the first App.
    await waitForSynced(page);
    await waitForDriveSettled(page);
    const { driveURL: driveB } = await newDrive(page);
    expect(driveB).not.toBe(driveA);
    await waitForDriveSettled(page);
    expect(await page.evaluate(() => window.store.getAgent()!.subject)).toBe(
      actor,
    );
    await clickAccountMenuItem(page, 'Apps');
    await page.getByRole('button', { name: 'Add GitHub to drive' }).click();
    await expect(
      iframe.getByRole('heading', { name: 'Connected principals' }),
    ).toBeVisible({ timeout: 45_000 });
    const managerB = await getCurrentSubject(page);
    expect(managerB).not.toBe(managerA);
    await iframe.getByRole('button', { name: 'michiel', exact: true }).click();
    await expect.poll(() => getCurrentSubject(page)).not.toBe(managerB);
    await browse(page);
    const appsB = await principalApps(page);
    expect(appsB).toHaveLength(1);
    const appB = appsB[0];
    expect(appB.subject).not.toBe(appA.subject);
    expect(appB.parent).toBe(driveB);
    expect(appB.key).toBe(appA.key);
    expect(appB.localId).toBe(appA.localId);
    expect(requests.redeemed).toHaveLength(1);
    requests.repositoryIssueCount = 17;
    await openRow(page, 'Repositories');
    const tableB = await getCurrentSubject(page);
    expect(tableB).not.toBe(tableA);
    await waitForInitialSync(page, 'notes');
    const firstB = await sourceState(page, tableB, driveB);
    expect(firstB.parent).toBe(appB.subject);
    expect(firstB.key).toBe(firstA.key);
    expect(firstB.localId).toBe(firstA.localId);
    expect(firstB.rows).toHaveLength(3);
    expect(firstB.rows.map(row => row.key).sort()).toEqual(
      firstA.rows.map(row => row.key).sort(),
    );
    expect(firstB.rows.map(row => row.localId).sort()).toEqual(
      firstA.rows.map(row => row.localId).sort(),
    );
    const rowSubjectsA = firstA.rows.map(row => row.subject);
    expect(firstB.rows.every(row => !rowSubjectsA.includes(row.subject))).toBe(
      true,
    );
    expect(
      firstB.rows.find(row => row.raw?.id === 456)?.raw?.open_issues_count,
    ).toBe(17);
    expect((await sourceState(page, tableA, driveA)).rows).toEqual(firstA.rows);

    const warm = await page.evaluate(
      async ({ apps, tables, localIds, drives }) => {
        const db = window.store.getClientDb();
        if (!db?.isReady)
          throw new Error('The two-drive OPFS fixture is not ready');
        const property = 'https://atomicdata.dev/properties/localId';
        const appHits = await db.query({
          property,
          value: localIds.app,
          limit: 100,
        });
        const tableHits = await db.query({
          property,
          value: localIds.table,
          limit: 100,
        });
        const scoped = await Promise.all(
          drives.map(async (drive, index) => ({
            app: (
              await db.query({
                property,
                value: localIds.app,
                drive,
                limit: 100,
              })
            ).subjects,
            table: (
              await db.query({
                property,
                value: localIds.table,
                drive,
                limit: 100,
              })
            ).subjects,
            expectedApp: apps[index],
            expectedTable: tables[index],
          })),
        );

        return {
          apps: appHits.subjects.sort(),
          appCount: appHits.count,
          tables: tableHits.subjects.sort(),
          tableCount: tableHits.count,
          scoped,
        };
      },
      {
        apps: [appA.subject, appB.subject],
        tables: [tableA, tableB],
        localIds: {
          app: appA.localId as string,
          table: firstA.localId as string,
        },
        drives: [driveA, driveB],
      },
    );
    expect(warm.appCount).toBe(2);
    expect(warm.apps).toEqual([appA.subject, appB.subject].sort());
    expect(warm.tableCount).toBe(2);
    expect(warm.tables).toEqual([tableA, tableB].sort());

    for (const scoped of warm.scoped) {
      expect(scoped.app).toEqual([scoped.expectedApp]);
      expect(scoped.table).toEqual([scoped.expectedTable]);
    }

    const switchTo = async (drive: string) => {
      await waitForSynced(page);
      await waitForDriveSettled(page);
      await sideBarDriveSwitcher(page).click();
      await page.getByTestId('menu-item-' + drive).click();
      await expect
        .poll(() => page.evaluate(() => window.store.getDrive()))
        .toBe(drive);
      await waitForDriveSettled(page);
      expect(await page.evaluate(() => window.store.getAgent()!.subject)).toBe(
        actor,
      );
    };

    await switchTo(driveA);
    const nativeReads = requests.providerRequests.length;
    const nativeDocuments = requests.documentRequests.length;
    await clickAccountMenuItem(page, 'Apps');
    const card = page.locator(`[data-proxy-platform="${PLATFORM}"]`);
    await expect(
      card.getByRole('button', { name: 'GitHub · michiel', exact: true }),
    ).toHaveCount(1);
    await card
      .getByRole('button', { name: 'GitHub · michiel', exact: true })
      .click();
    await expect(page.getByRole('main')).toHaveAttribute('about', appA.subject);
    await browse(page);
    expect((await principalApps(page)).map(app => app.subject)).toEqual([
      appA.subject,
    ]);
    await openRow(page, 'Repositories');
    expect(await getCurrentSubject(page)).toBe(tableA);
    await browse(page);
    expect(requests.providerRequests).toHaveLength(nativeReads);
    expect(requests.documentRequests).toHaveLength(nativeDocuments);
    requests.repositoryIssueCount = 27;
    await sync(page);
    await browse(page);
    const updatedA = await sourceState(page, tableA, driveA);
    expect(updatedA.rows.map(row => row.subject).sort()).toEqual(
      rowSubjectsA.sort(),
    );
    expect(
      updatedA.rows.find(row => row.raw?.id === 456)?.raw?.open_issues_count,
    ).toBe(27);
    expect((await sourceState(page, tableB, driveB)).rows).toEqual(firstB.rows);
    await testInfo.attach('drive-scoped-principal-app-after-resync', {
      body: await page.screenshot(),
      contentType: 'image/png',
    });
    await switchTo(driveB);
    await clickAccountMenuItem(page, 'Apps');
    await expect(
      card.getByRole('button', { name: 'GitHub · michiel', exact: true }),
    ).toHaveCount(1);
    await card
      .getByRole('button', { name: 'GitHub · michiel', exact: true })
      .click();
    await expect(page.getByRole('main')).toHaveAttribute('about', appB.subject);
    await browse(page);
    expect((await principalApps(page)).map(app => app.subject)).toEqual([
      appB.subject,
    ]);
    await openRow(page, 'Repositories');
    expect(await getCurrentSubject(page)).toBe(tableB);
    await browse(page);
    expect((await sourceState(page, tableB, driveB)).rows).toEqual(firstB.rows);
    expect(requests.redeemed).toHaveLength(1);
  });

  test('refuses Sync activation under a trashed integration without replacing its saved data', async ({
    page,
  }, testInfo) => {
    test.setTimeout(180_000);
    const writes: string[] = [];
    let observeActivation = false;
    let attachedFrames = 0;
    page.on('request', request => {
      if (
        request.method() === 'POST' &&
        new URL(request.url()).pathname === '/commit'
      )
        writes.push('HTTP commit');
    });
    page.on('websocket', socket => {
      if (new URL(socket.url()).host !== new URL(FRONTEND_URL).host) return;
      socket.on('framesent', frame => {
        const bytes = Buffer.isBuffer(frame.payload)
          ? frame.payload
          : Buffer.from(frame.payload);
        // The normal Atomic v2 COMMIT tag, also observed by before()'s watcher.
        if (bytes[0] === 0x13) writes.push('WebSocket commit');
      });
    });
    page.on('frameattached', frame => {
      if (observeActivation && frame.parentFrame()) attachedFrames++;
    });
    const requests = await mockIntegrationProxy(page);
    await before({ page }, testInfo);
    await waitForSynced(page);
    await waitForDriveSettled(page);
    await enableIntegrationDiscovery(page);
    const drive = await page.evaluate(() => window.store.getDrive()!);
    await clickAccountMenuItem(page, 'Apps');
    await page.getByRole('button', { name: 'Add GitHub to drive' }).click();
    const iframe = page.locator('iframe[title="App"]:visible').contentFrame();
    await expect(
      iframe.getByRole('heading', { name: 'Connected principals' }),
    ).toBeVisible({ timeout: 45_000 });
    const managerUrl = page.url();
    const managerSubject = await getCurrentSubject(page);
    const manager = await sourceState(page, managerSubject);
    await openConsent(page, iframe, 'Connect account');
    await finishConsent(page);
    await browse(page);
    const apps = await principalApps(page);
    expect(apps).toHaveLength(1);
    const app = apps[0];
    await openRow(page, 'Repositories');
    const tableSubject = await getCurrentSubject(page);
    await waitForInitialSync(page, 'notes');
    await selectFilter(page);
    await selectView(page, 'Sync');
    const syncUrl = page.url();
    await browse(page);
    const storedUrl = page.url();
    const saved = await sourceState(page, tableSubject);
    expect(saved.rows).toHaveLength(3);
    const retained = [
      { subject: managerSubject, localId: manager.localId },
      { subject: app.subject, localId: app.localId },
      { subject: tableSubject, localId: saved.localId },
      ...saved.rows.map(row => ({
        subject: row.subject,
        localId: row.localId,
      })),
    ].map(row => {
      if (typeof row.localId !== 'string')
        throw new Error(
          'The retained integration fixture has no native local ID',
        );

      return { subject: row.subject, localId: row.localId };
    });
    const rowSubjects = saved.rows.map(row => row.subject);
    const readStoredRows = () =>
      page.evaluate(async subjects => {
        const store = window.store;

        return Promise.all(
          subjects.map(async subject => {
            const row = await store.fetchResourceFromServer(subject, {
              noWebSocket: true,
            });
            if (row.error) throw row.error;

            return { subject: row.subject, values: row.getPropVals() };
          }),
        );
      }, rowSubjects);
    const originalRows = await readStoredRows();
    const trashed = await page.evaluate(
      async ({ principal, setup, ownDrive }) => {
        const store = window.store;
        // Reproduce retained legacy ancestry using an ordinary same-drive move.
        const principalApp = await store.getResource(principal);
        await principalApp.set(
          'https://atomicdata.dev/properties/parent',
          setup,
        );
        await principalApp.save();
        const moved = await store.trash(setup, ownDrive);

        return {
          moved,
          inTrash: store.isTrashed(principal, ownDrive, { deep: true }),
        };
      },
      { principal: app.subject, setup: managerSubject, ownDrive: drive },
    );
    expect(trashed).toEqual({ moved: true, inTrash: true });
    await waitForSynced(page);
    await waitForDriveSettled(page);
    await expect(page.locator('#boot-splash')).toHaveCSS('opacity', '0');
    expect(writes.length).toBeGreaterThan(0);
    const existingWrites = writes.length;
    const providerReads = requests.providerRequests.length;
    const documents = requests.documentRequests.length;
    observeActivation = true;

    const restoreNotice = page.getByRole('alert').filter({
      hasText:
        /This integration is in Trash\. Restore it before (?:connecting or )?syncing\./,
    });
    await page.goto(managerUrl);
    await expect(restoreNotice).toBeVisible({ timeout: 45_000 });
    await expect(page.locator('#boot-splash')).toHaveCSS('opacity', '0');
    await expect(page.locator('iframe[title="App"]:visible')).toHaveCount(0);
    await page.goto(syncUrl);
    await expect(page.getByRole('main')).toHaveAttribute('about', tableSubject);
    await expect(restoreNotice).toBeVisible({ timeout: 45_000 });
    await expect(page.locator('#boot-splash')).toHaveCSS('opacity', '0');
    await expect(page.locator('iframe[title="App"]:visible')).toHaveCount(0);
    await testInfo.attach('trashed-integration-sync-restoration-guidance', {
      body: await page.screenshot(),
      contentType: 'image/png',
    });
    // Cached views still render as ordinary Atomic views. Normal collection
    // queries exclude Trash; a direct stored-row GET retains the original data.
    await page.goto(storedUrl);
    await browse(page);
    const storedGrid = page.getByRole('main').getByRole('grid');
    await expect(storedGrid).toHaveAttribute('aria-busy', 'false');
    await expect(storedGrid).toHaveAttribute('aria-rowcount', '1');
    await expect(page.locator('#boot-splash')).toHaveCSS('opacity', '0');
    await expect(page.locator('iframe[title="App"]:visible')).toHaveCount(0);
    expect(await readStoredRows()).toEqual(originalRows);
    const identities = await page.evaluate(
      async ({ ownDrive, rows }) => {
        const store = window.store;

        return Promise.all(
          rows.map(async row => {
            const query = new URL('/query', store.getServerUrl());
            for (const [name, value] of Object.entries({
              drive: ownDrive,
              property: 'https://atomicdata.dev/properties/localId',
              value: row.localId,
              page_size: '100',
              current_page: '0',
              include_nested: 'false',
              include_trashed: 'true',
            }))
              query.searchParams.set(name, value);
            const result = await store.fetchResourceFromServer(query.href, {
              noWebSocket: true,
              forceOverride: true,
            });
            if (result.error) throw result.error;

            return {
              expected: row.subject,
              count: result.get(
                'https://atomicdata.dev/properties/collection/totalMembers',
              ),
              subjects: result.getSubjects(
                'https://atomicdata.dev/properties/collection/members',
              ),
            };
          }),
        );
      },
      { ownDrive: drive, rows: retained },
    );

    for (const identity of identities) {
      expect(identity.count).toBe(1);
      expect(identity.subjects).toEqual([identity.expected]);
    }

    await waitForSynced(page);
    expect(
      await page.evaluate(
        ({ subject, ownDrive }) =>
          window.store.isTrashed(subject, ownDrive, { deep: true }),
        { subject: managerSubject, ownDrive: drive },
      ),
    ).toBe(true);
    expect(requests.providerRequests).toHaveLength(providerReads);
    expect(requests.documentRequests).toHaveLength(documents);
    expect(attachedFrames).toBe(0);
    expect(writes).toHaveLength(existingWrites);
    await expect(storedGrid).toHaveAttribute('aria-busy', 'false');
    await expect(storedGrid).toHaveAttribute('aria-rowcount', '1');
  });

  test('reinstalls the Public App on the same drive after permanent deletion', async ({
    page,
    browserDiagnostics,
  }, testInfo) => {
    test.setTimeout(180_000);
    await mockIntegrationProxy(page);
    await before({ page }, testInfo);
    await waitForSynced(page);
    await waitForDriveSettled(page);
    await enableIntegrationDiscovery(page);
    await clickAccountMenuItem(page, 'Apps');
    await page.getByRole('button', { name: 'Add GitHub to drive' }).click();

    const iframe = page.locator('iframe[title="App"]:visible').contentFrame();
    const publicChoice = iframe.getByRole('button', {
      name: 'Public',
      exact: true,
    });
    await expect(publicChoice).toBeVisible({ timeout: 45_000 });
    const managerSubject = await getCurrentSubject(page);
    await publicChoice.click();
    await expect.poll(() => getCurrentSubject(page)).not.toBe(managerSubject);
    await browse(page);
    const original = await principalApps(page);
    expect(original).toHaveLength(1);
    expect(original[0].config).toMatchObject({ principal: { kind: 'public' } });

    await contextMenuClick('trash', page);
    await waitForSynced(page);
    await clickAccountMenuItem(page, 'Trash');
    const trashedAppName = { name: 'GitHub · Public', exact: true };
    const trashedRow = page
      .getByRole('main')
      .getByRole('row')
      .filter({ has: page.getByRole('link', trashedAppName) });
    await expect(
      trashedRow.getByRole('link', { name: /^table$/i }),
    ).toBeVisible();
    await trashedRow.getByRole('link', trashedAppName).click();
    await expect(page.getByRole('main')).toHaveAttribute(
      'about',
      original[0].subject,
    );
    await contextMenuClick('delete', page);
    const oldSubject = original[0].subject;
    browserDiagnostics.expect(
      'error',
      /Failed to load resource:.*404/,
      'The deleted App is absent from the server.',
      3,
      new RegExp(`/resource\\?subject=${encodeURIComponent(oldSubject)}$`),
      { optional: true },
    );
    browserDiagnostics.expect(
      'error',
      new RegExp(`^${oldSubject} .*Resource not found`),
      'The SDK reports the same signed read of the deleted App.',
      3,
      undefined,
      { optional: true },
    );
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Delete', exact: true })
      .click();
    await expect(page.getByRole('main')).not.toHaveAttribute(
      'about',
      oldSubject,
    );
    await expect
      .poll(() =>
        page.evaluate(
          subject => window.store.hasPendingDestroy(subject),
          oldSubject,
        ),
      )
      .toBe(false);
    await waitForSynced(page);
    await expect
      .poll(() =>
        page.evaluate(async subject => {
          try {
            await window.store.readServerSnapshot(subject);

            return 'present';
          } catch (error) {
            if (error instanceof Error && 'type' in error) return error.type;
            throw error;
          }
        }, oldSubject),
      )
      .toBe('NotFound');

    await clickAccountMenuItem(page, 'Apps');
    await page
      .getByRole('button', { name: 'Open GitHub', exact: true })
      .click();
    expect(await getCurrentSubject(page)).toBe(managerSubject);
    await expect(publicChoice).toBeVisible({ timeout: 45_000 });
    await publicChoice.click();
    await expect.poll(() => getCurrentSubject(page)).not.toBe(managerSubject);
    await browse(page);

    const replacement = await principalApps(page);
    expect(replacement).toHaveLength(1);
    expect(replacement[0].subject).not.toBe(original[0].subject);
    expect(replacement[0]).toMatchObject({
      drive: original[0].drive,
      parent: original[0].drive,
      config: { principal: { kind: 'public' } },
    });

    await clickAccountMenuItem(page, 'Apps');
    await page
      .getByRole('button', { name: 'Open GitHub', exact: true })
      .click();
    await iframe
      .getByRole('button', { name: 'GitHub · Public', exact: true })
      .click({ timeout: 45_000 });
    await expect(page.getByRole('main')).toHaveAttribute(
      'about',
      replacement[0].subject,
    );
    expect(await principalApps(page)).toEqual(replacement);
  });

  test('sets a repository scope directly in the Public Issues Sync tab', async ({
    page,
  }, testInfo) => {
    test.setTimeout(150_000);
    await mockIntegrationProxy(page);
    const providerReads: string[] = [];
    await page.route(GITHUB_API + '/**', async route => {
      const request = route.request();
      expect(request.method()).toBe('GET');
      expect(request.frame()).toBe(page.mainFrame());
      expect((await request.allHeaders()).authorization).toBeUndefined();
      const url = new URL(request.url());
      providerReads.push(url.origin + url.pathname);

      if (url.href === PUBLIC_REPOSITORY) {
        await route.fulfill({
          headers: { 'access-control-allow-origin': '*' },
          json: {
            id: 456,
            name: 'atomic-server',
            full_name: REPOSITORY,
            owner: { id: 123, login: 'ontola', type: 'Organization' },
            private: false,
            has_issues: true,
          },
        });

        return;
      }

      expect(url.pathname).toBe('/repositories/456/issues');
      expect(url.searchParams.get('state')).toBe('all');
      await route.fulfill({
        headers: { 'access-control-allow-origin': '*' },
        json: [issue(9001, 15, FIRST_ISSUE_TITLE)],
      });
    });
    await before({ page }, testInfo);
    await waitForSynced(page);
    await waitForDriveSettled(page);
    await enableIntegrationDiscovery(page);
    await clickAccountMenuItem(page, 'Apps');
    await page.getByRole('button', { name: 'Add GitHub to drive' }).click();
    const iframe = page.locator('iframe[title="App"]:visible').contentFrame();
    await iframe
      .getByRole('button', { name: 'Public', exact: true })
      .click({ timeout: 45_000 });
    await selectView(page, SYNCABLE_COLLECTIONS_TAB);
    await openRow(page, 'Issues and pull requests');
    const table = await getCurrentSubject(page);
    await selectView(page, 'Sync');
    const syncUrl = page.url();
    await expect(
      iframe.getByLabel('Repository owner', { exact: true }),
    ).toBeVisible({ timeout: 30_000 });
    await expect(page).toHaveURL(syncUrl);
    await expect(
      iframe.getByRole('button', { name: 'Choose source', exact: true }),
    ).toHaveCount(0);
    await expect(
      iframe.getByLabel('Source collection', { exact: true }),
    ).toBeHidden();
    await expect(
      page.getByRole('combobox', { name: 'Saved filter', exact: true }),
    ).toHaveCount(0);
    await iframe.getByLabel('Repository owner', { exact: true }).fill('ontola');
    await iframe
      .getByLabel('Repository name', { exact: true })
      .fill('atomic-server');
    await iframe
      .getByLabel('Filter name', { exact: true })
      .fill('Atomic Server');
    expect(providerReads).toEqual([]);
    await testInfo.attach('public-issues-sync-repository-scope', {
      body: await page.screenshot(),
      contentType: 'image/png',
    });
    const desktopViewport = page.viewportSize()!;
    await page.setViewportSize({ width: 390, height: 844 });
    const sidebar = page.getByTestId('sidebar');
    if (
      (await sidebar.isVisible()) &&
      (await sidebar.evaluate(node => getComputedStyle(node).opacity !== '0'))
    )
      await page.getByRole('button', { name: 'Show / hide sidebar' }).click();
    await expect(
      iframe.getByRole('button', { name: 'Save filter', exact: true }),
    ).toBeInViewport();
    await testInfo.attach('public-issues-sync-repository-scope-mobile', {
      body: await page.screenshot({ animations: 'disabled' }),
      contentType: 'image/png',
    });
    await page.setViewportSize(desktopViewport);
    await iframe
      .getByRole('button', { name: 'Save filter', exact: true })
      .click();
    await expect(page.getByRole('main')).toHaveAttribute('about', table);
    const filters = page.getByRole('combobox', { name: 'Saved filter' });
    await expect(filters.locator('option:checked')).toHaveText('Atomic Server');
    expect(providerReads).toEqual([PUBLIC_REPOSITORY]);
    await sync(page);
    const grid = await browse(page);
    await expect(
      grid.getByText(FIRST_ISSUE_TITLE, { exact: true }),
    ).toBeVisible();
    expect(await getCurrentSubject(page)).toBe(table);
    expect(providerReads).toEqual([PUBLIC_REPOSITORY, PUBLIC_ISSUES]);
  });

  test('resolves catalog Public inputs into a shared entity table and adopts proven saved source aliases', async ({
    page,
  }, testInfo) => {
    test.setTimeout(240_000);
    const requests = await mockIntegrationProxy(page);
    const metadataRequests: string[] = [];
    const publicIssuePages: string[] = [];
    await page.route(GITHUB_API + '/**', async route => {
      const request = route.request();
      expect(request.method()).toBe('GET');
      expect(request.frame()).toBe(page.mainFrame());
      const headers = await request.allHeaders();
      for (const name of [
        'authorization',
        'cookie',
        'x-connection-key',
        'x-atomic-agent',
      ])
        expect(headers[name]).toBeUndefined();

      if (request.url() === PUBLIC_REPOSITORY) {
        metadataRequests.push(request.url());
        await route.fulfill({
          headers: { 'access-control-allow-origin': '*' },
          json: {
            id: 456,
            name: 'atomic-server',
            full_name: REPOSITORY,
            owner: { id: 123, login: 'ontola', type: 'Organization' },
            private: false,
            has_issues: true,
          },
        });

        return;
      }

      const pageNumber = publicIssuePages.length + 1;
      const requested = new URL(request.url());
      const expected = new URL(publicIssueUrl(pageNumber));
      if (pageNumber === 1 && !requested.searchParams.has('page'))
        requested.searchParams.set('page', '1');
      requested.searchParams.sort();
      expected.searchParams.sort();
      expect(requested.href).toBe(expected.href);
      expect(pageNumber).toBeLessThanOrEqual(PUBLIC_ISSUE_PAGE_COUNT);
      publicIssuePages.push(request.url());
      await route.fulfill({
        headers: {
          'access-control-allow-origin': '*',
          'access-control-expose-headers': 'link',
          ...(pageNumber < PUBLIC_ISSUE_PAGE_COUNT
            ? { link: `<${publicIssueUrl(pageNumber + 1)}>; rel="next"` }
            : {}),
        },
        json:
          pageNumber === 1
            ? [issue(9001, 15, FIRST_ISSUE_TITLE)]
            : pageNumber === PUBLIC_ISSUE_PAGE_COUNT
              ? [issue(9002, 16, RETAINED_ISSUE_TITLE)]
              : [],
      });
    });
    await before({ page }, testInfo);
    // Finish signed setup writes before the settings helper deliberately reloads.
    await waitForSynced(page);
    await waitForDriveSettled(page);
    await enableIntegrationDiscovery(page);
    await clickAccountMenuItem(page, 'Apps');
    await page.getByRole('button', { name: 'Add GitHub to drive' }).click();
    const iframe = page.locator('iframe[title="App"]:visible').contentFrame();
    await expect(
      iframe.getByRole('button', { name: 'Public', exact: true }),
    ).toHaveCount(1, { timeout: 45_000 });
    const appUrl = page.url();
    const appBeforePublic = await getCurrentSubject(page);
    await iframe.getByRole('button', { name: 'Public', exact: true }).click();
    await expect.poll(() => getCurrentSubject(page)).not.toBe(appBeforePublic);
    await browse(page);
    const publicSubject = await getCurrentSubject(page);
    const publicUrl = page.url();
    const existingIssueTable = await sourceSubject(page, 'collection', 'issue');
    const publicApps = await principalApps(page);
    expect(publicApps).toHaveLength(1);
    expect(publicApps[0]).toMatchObject({
      subject: publicSubject,
      parent: publicApps[0].drive,
      name: 'GitHub · Public',
      isApp: true,
      appData: publicSubject,
      builtin: 'syncables',
      config: { principal: { kind: 'public' } },
    });
    expect(publicApps[0].classes).toContain(
      'https://atomicdata.dev/classes/Table',
    );
    // Returning through the connection manager, including a cold reload, must
    // reuse Public's App and its already provisioned canonical collections.
    await page.goto(appUrl);
    await expect(
      iframe.getByRole('button', { name: 'GitHub · Public', exact: true }),
    ).toHaveCount(1, { timeout: 45_000 });
    await waitForSynced(page);
    await waitForDriveSettled(page);
    await page.reload();
    await iframe
      .getByRole('button', { name: 'GitHub · Public', exact: true })
      .click();
    await expect(page.getByRole('main')).toHaveAttribute(
      'about',
      publicSubject,
    );
    await browse(page);
    expect(await principalApps(page)).toEqual(publicApps);
    expect(await sourceSubject(page, 'collection', 'issue')).toBe(
      existingIssueTable,
    );
    expect(metadataRequests).toEqual([]);
    expect(publicIssuePages).toEqual([]);
    const legacy = await legacyPublicMirror(
      page,
      publicSubject,
      existingIssueTable,
    );
    await waitForSynced(page);
    await waitForDriveSettled(page);
    await page.goto(appUrl);
    await expect(
      iframe.getByRole('button', { name: 'GitHub · Public', exact: true }),
    ).toBeVisible({ timeout: 45_000 });
    await expect(iframe.getByRole('alert')).toHaveCount(0);
    await page.goto(publicUrl);
    const form = await publicForm(page);
    await form
      .getByLabel('Source', { exact: true })
      .selectOption('/repos/{owner}/{repo}');
    await form.getByLabel('Repository owner', { exact: true }).fill('ontola');
    await form
      .getByLabel('Repository name', { exact: true })
      .fill('atomic-server');
    expect(metadataRequests).toEqual([]);
    expect(publicIssuePages).toEqual([]);
    await testInfo.attach('catalog-public-entrypoint', {
      body: await page.screenshot(),
      contentType: 'image/png',
    });
    await form
      .getByRole('button', { name: 'Save filter', exact: true })
      .click();
    await expect(page.getByRole('main')).toHaveAttribute('about', legacy.table);
    await browse(page);
    expect(metadataRequests).toEqual([PUBLIC_REPOSITORY]);
    expect(publicIssuePages).toEqual([]);
    const adopted = await sourceState(page, legacy.table);
    expect(adopted.localId).toBe(legacy.localId);
    expect(JSON.parse(adopted.key!)).toMatchObject({
      version: 3,
      principal: { kind: 'public' },
      resource: 'issue',
    });
    expect(adopted.config?.principal?.kind).toBe('public');
    await sync(page);
    await expect(
      iframe.getByText('1 added · 1 changed · 0 unchanged', { exact: true }),
    ).toBeVisible({ timeout: 45_000 });
    await browse(page);
    expect(publicIssuePages).toHaveLength(PUBLIC_ISSUE_PAGE_COUNT);
    const imported = await sourceState(page, legacy.table);
    expect(imported.rows).toHaveLength(2);
    expect(imported.rows.find(row => row.subject === legacy.row)).toMatchObject(
      {
        name: FIRST_ISSUE_TITLE,
        localId: 'syncables:github-issue:9001',
        note: 'Keep this user note',
      },
    );
    expect(
      await page.evaluate(({ oldKey, table }) => {
        const store = window.store;
        const property = [...store.resources.values()].find(
          resource =>
            resource.get('https://atomicdata.dev/properties/shortname') ===
            'syncable-resource-index',
        )!.subject;
        const index = store
          .getResourceLoading(store.getDrive())
          .get(property) as Record<string, string>;

        return index[oldKey] === table;
      }, legacy),
    ).toBe(true);
    const sidebar = page.getByTestId('sidebar');
    await expect(sidebar.getByText('Accounts', { exact: true })).toHaveCount(0);
    await expect(sidebar.getByText('ontola', { exact: true })).toHaveCount(0);
    await expect(
      sidebar.getByText(FIRST_ISSUE_TITLE, { exact: true }),
    ).toHaveCount(0);
    await testInfo.attach('public-canonical-issues-migrated', {
      body: await page.screenshot(),
      contentType: 'image/png',
    });
    const nativeReads = metadataRequests.length + publicIssuePages.length;
    const nativeDocuments = requests.documentRequests.length;
    await page.goto(publicUrl);
    await openRow(page, 'Issues and pull requests');
    await browse(page);
    expect(await getCurrentSubject(page)).toBe(legacy.table);
    expect(metadataRequests.length + publicIssuePages.length).toBe(nativeReads);
    expect(requests.documentRequests).toHaveLength(nativeDocuments);
    await page.goto(publicUrl);
    const repeat = await publicForm(page);
    await repeat
      .getByLabel('Source', { exact: true })
      .selectOption('/repos/{owner}/{repo}');
    await repeat.getByLabel('Repository owner', { exact: true }).fill('ontola');
    await repeat
      .getByLabel('Repository name', { exact: true })
      .fill('atomic-server');
    await repeat
      .getByRole('button', { name: 'Save filter', exact: true })
      .click();
    await expect(page.getByRole('main')).toHaveAttribute('about', legacy.table);
    expect(publicIssuePages).toHaveLength(PUBLIC_ISSUE_PAGE_COUNT);
    expect(metadataRequests).toHaveLength(2);
    expect(requests.redeemed).toEqual([]);
    expect(requests.issueConnections).toEqual([]);
    expect(requests.providerRequests).toEqual([]);
    await page.goto(publicUrl);
    const mobile = await publicForm(page);
    await page.setViewportSize({ width: 390, height: 844 });
    if (
      (await sidebar.isVisible()) &&
      (await sidebar.evaluate(node => getComputedStyle(node).opacity !== '0'))
    )
      await page.getByRole('button', { name: 'Show / hide sidebar' }).click();
    await expect(
      mobile.getByRole('button', { name: 'Save filter', exact: true }),
    ).toBeInViewport();
    await testInfo.attach('catalog-public-input-mobile', {
      body: await page.screenshot({ animations: 'disabled' }),
      contentType: 'image/png',
    });
  });

  test('installs an unrelated catalog and mirrors its typed records through the same native views', async ({
    page,
  }, testInfo) => {
    test.setTimeout(180_000);
    const upstream = 'https://notes-api.example/v3';
    const document = {
      openapi: '3.0.3',
      info: { title: 'Notebook', version: '1' },
      servers: [{ url: upstream }],
      components: {
        crudResources: {
          entryAddress: {
            identity: {
              urlTemplate: '/by-name/{workspace}',
              bindings: { workspace: { field: 'name' } },
            },
          },
          entry: {
            schema: {
              type: 'object',
              title: 'Entries',
              required: ['id', 'name'],
              properties: {
                id: { type: 'string' },
                name: { type: 'string', title: 'Entry' },
                updated_at: {
                  type: 'string',
                  format: 'date-time',
                  title: 'Updated',
                },
                active: { type: 'boolean', title: 'Active' },
              },
            },
            identity: {
              urlTemplate: '/spaces/{space_id}/entries/{entry_id}',
              bindings: { entry_id: { field: 'id' } },
            },
            collections: {
              entries: { urlTemplate: '/spaces/{space_id}/entries' },
            },
          },
        },
        paginationSchemes: {
          pages: {
            type: 'nextLink',
            request: {},
            response: { headers: { Link: { role: 'nextLink' } } },
          },
        },
      },
      paths: {
        '/by-name/{workspace}': {
          get: {
            operationId: 'namedSpace',
            security: [],
            parameters: [
              {
                name: 'workspace',
                in: 'path',
                required: true,
                schema: { type: 'string', title: 'Workspace name' },
              },
            ],
            'x-crud': { action: 'read', resource: 'entryAddress' },
            responses: {
              '200': {
                description: 'Space',
                links: {
                  entries: {
                    operationId: 'listEntries',
                    parameters: { space_id: '$response.body#/id' },
                  },
                },
              },
            },
          },
        },
        '/spaces/{space_id}/entries': {
          get: {
            operationId: 'listEntries',
            security: [],
            parameters: [
              {
                name: 'space_id',
                in: 'path',
                required: true,
                schema: { type: 'integer', title: 'Workspace ID' },
              },
            ],
            'x-crud': {
              action: 'list',
              resource: 'entry',
              collection: 'entries',
            },
            'x-pagination': [{ scheme: 'pages' }],
            responses: {
              '200': {
                description: 'Entries',
                content: {
                  'application/json': {
                    schema: { type: 'array', items: { type: 'object' } },
                  },
                },
              },
            },
          },
        },
      },
    };
    const requests = await mockIntegrationProxy(page, {
      platform: 'notebook',
      name: 'Notebook',
      document,
      selection: { query_overrides: [] },
    });
    const reads: string[] = [];
    await page.route(upstream + '/**', async route => {
      const request = route.request();
      const headers = await request.allHeaders();
      for (const name of [
        'authorization',
        'cookie',
        'x-connection-key',
        'x-atomic-agent',
      ])
        expect(headers[name]).toBeUndefined();
      reads.push(request.url());
      await route.fulfill({
        headers: { 'access-control-allow-origin': '*' },
        json: request.url().endsWith('/by-name/research')
          ? { id: 44 }
          : [
              {
                id: 'entry-7',
                name: 'An unrelated typed record',
                updated_at: '2026-11-19T09:00:00Z',
                active: true,
              },
            ],
      });
    });
    await before({ page }, testInfo);
    // Finish signed setup writes before the settings helper deliberately reloads.
    await waitForSynced(page);
    await waitForDriveSettled(page);
    await clickAccountMenuItem(page, 'Apps');
    const discovery = page.getByRole('region', { name: 'Discover apps' });
    const addNotebook = discovery.getByRole('button', {
      name: 'Add Notebook to drive',
    });
    await expect(discovery).toBeVisible();
    await expect(addNotebook).toHaveCount(0);

    await enableIntegrationDiscovery(page);
    await expect(addNotebook).toBeVisible();
    const search = discovery.getByRole('textbox', { name: 'Search apps' });
    await search.fill('not a catalog entry');
    await expect(discovery.getByText('No matching services.')).toBeVisible();
    await expect(addNotebook).toHaveCount(0);
    await search.fill('Notebook');
    await expect(addNotebook).toBeVisible();
    await expect(
      discovery.getByText('No integrations match your search.'),
    ).toHaveCount(0);
    await testInfo.attach('apps-discovery-with-proxy', {
      body: await page.screenshot({ animations: 'disabled' }),
      contentType: 'image/png',
    });
    await addNotebook.click();
    const iframe = page.locator('iframe[title="App"]:visible').contentFrame();
    await expect(
      iframe.getByRole('button', { name: 'Public', exact: true }),
    ).toBeVisible({ timeout: 45_000 });
    const appBeforePublic = await getCurrentSubject(page);
    await iframe.getByRole('button', { name: 'Public', exact: true }).click();
    await expect.poll(() => getCurrentSubject(page)).not.toBe(appBeforePublic);
    const notebookSubject = await getCurrentSubject(page);
    await browse(page);
    const notebookApps = await principalApps(page, 'notebook');
    expect(notebookApps).toHaveLength(1);
    expect(notebookApps[0]).toMatchObject({
      subject: notebookSubject,
      parent: notebookApps[0].drive,
      name: 'Notebook · Public',
      isApp: true,
      appData: notebookSubject,
      config: { principal: { kind: 'public' } },
    });
    expect(notebookApps[0].classes).toContain(
      'https://atomicdata.dev/classes/Table',
    );
    const form = await publicForm(page, 'entries');
    await form.getByLabel('Workspace name', { exact: true }).fill('research');
    expect(reads).toEqual([]);
    await form
      .getByRole('button', { name: 'Save filter', exact: true })
      .click();
    await expect(
      page.getByRole('heading', { name: 'Entries', exact: true }),
    ).toBeVisible();
    const subject = await getCurrentSubject(page);
    await browse(page);
    expect(reads).toEqual([upstream + '/by-name/research']);
    await sync(page);
    await browse(page);
    await expect(
      page
        .getByRole('main')
        .getByText('An unrelated typed record', { exact: true }),
    ).toBeVisible();
    const first = await sourceState(page, subject);
    expect(first.config?.principal?.kind).toBe('public');
    expect(first.rows).toHaveLength(1);
    expect(first.rows[0].managed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          datatype: 'https://atomicdata.dev/datatypes/boolean',
          value: true,
        }),
        expect.objectContaining({
          datatype: 'https://atomicdata.dev/datatypes/timestamp',
          value: Date.parse('2026-11-19T09:00:00Z'),
        }),
      ]),
    );
    await sync(page);
    await expect(
      iframe.getByText('0 added · 0 changed · 1 unchanged', { exact: true }),
    ).toBeVisible();
    await browse(page);
    expect((await sourceState(page, subject)).rows[0].subject).toBe(
      first.rows[0].subject,
    );
    expect(reads).toEqual([
      upstream + '/by-name/research',
      upstream + '/spaces/44/entries',
      upstream + '/spaces/44/entries',
    ]);
    expect(requests.providerRequests).toEqual([]);
    expect(requests.redeemed).toEqual([]);
    await testInfo.attach('unrelated-catalog-native-records', {
      body: await page.screenshot(),
      contentType: 'image/png',
    });
  });
});
