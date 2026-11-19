import { describe, expect, it } from 'vitest';
import {
  core,
  dataBrowser,
  Datatype,
  findSchema,
  ensureSchema,
  pluginSchema,
} from '@tomic/lib';
import { fakeSchemaStore as createFakeSchemaStore } from '../../../../lib/src/test-schema-store.js';
import {
  ensureSyncablePlatform,
  findSyncablePlatform,
  platformLocalId,
  syncablePlatformSchema,
} from './syncablePlatform';
import { syncableHierarchySchema } from './syncableHierarchy';

function fakeSchemaStore() {
  const fixture = createFakeSchemaStore();
  fixture.resources.set(core.properties.name, {
    [core.properties.isA]: [core.classes.property],
    [core.properties.datatype]: Datatype.STRING,
    [core.properties.shortname]: 'name',
  });

  const get = fixture.store.getResource.bind(fixture.store);
  fixture.store.getResource = async subject => ({
    ...(await get(subject)),
    getChildrenCollection: async () => ({
      getAllMembers: async () =>
        [...fixture.resources]
          .filter(([, values]) => values[core.properties.parent] === subject)
          .map(([id]) => id),
    }),
    remove: (property: string) => {
      delete fixture.resources.get(subject)?.[property];
    },
  });

  return fixture;
}

describe('platformLocalId', () => {
  it('is scoped to the configured proxy and stable across display names', () => {
    expect(platformLocalId('https://proxy.example', 'github-issues')).toBe(
      platformLocalId('https://proxy.example', 'github-issues'),
    );
    expect(platformLocalId('https://proxy.example', 'github-issues')).not.toBe(
      platformLocalId('https://other.example', 'github-issues'),
    );
    expect(() =>
      platformLocalId('https://proxy.example/path', 'github-issues'),
    ).toThrow('must be an origin');
    expect(() => platformLocalId('https://proxy.example', '../unsafe')).toThrow(
      'Invalid integration platform ID',
    );
  });
});

describe('ensureSyncablePlatform', () => {
  it('creates one root App with an Accounts table and reuses both on reinstall', async () => {
    const { store, resources } = fakeSchemaStore();
    const options = {
      drive: 'drive',
      proxyOrigin: 'https://proxy.example',
      platform: 'github-issues',
      name: 'GitHub',
    };

    const first = await ensureSyncablePlatform(store, options);
    const appTerms = await findSchema(store, options.drive, pluginSchema());
    const accounts = resources.get(first)?.[
      appTerms.properties!['app-data']
    ] as string;
    const rowClass = await store.getResource(
      resources.get(accounts)?.[core.properties.classtype] as string,
    );
    expect(rowClass.get(core.properties.recommends)).toEqual([
      core.properties.name,
    ]);
    await rowClass.set(core.properties.recommends, []);
    await rowClass.save();
    const second = await ensureSyncablePlatform(store, {
      ...options,
      name: 'Renamed GitHub',
    });

    expect(second).toBe(first);
    expect(rowClass.get(core.properties.recommends)).toEqual([
      core.properties.name,
    ]);
    const props = resources.get(first);
    expect(props?.[core.properties.parent]).toBe('drive');
    expect(props?.[core.properties.name]).toBe('GitHub');
    expect(props?.[core.properties.isA]).toContain(appTerms.classes!.app);
    expect(props?.[core.properties.isA]).not.toContain(
      dataBrowser.classes.table,
    );
    expect(resources.get(accounts)?.[core.properties.parent]).toBe(first);
    expect(resources.get(accounts)?.[core.properties.isA]).toContain(
      dataBrowser.classes.table,
    );
    expect(resources.get(first)?.[appTerms.properties!['app-data']]).toBe(
      accounts,
    );
    expect(props?.[core.properties.localId]).toBe(
      platformLocalId(options.proxyOrigin, options.platform),
    );
  });

  it('still recognizes a table after the user moves it', async () => {
    const { store, resources } = fakeSchemaStore();
    const input = {
      drive: 'drive',
      proxyOrigin: 'https://proxy.example',
      platform: 'github-issues',
      name: 'GitHub',
    };
    const first = await ensureSyncablePlatform(store, input);
    resources.set('other-folder', { [core.properties.parent]: 'drive' });
    const table = await store.getResource(first);
    await table.set(core.properties.parent, 'other-folder');
    await table.save();

    expect(await findSyncablePlatform(store, input)).toBe(first);
    expect(await ensureSyncablePlatform(store, input)).toBe(first);
  });

  it('adds the missing Sync tab without changing existing tabs or their default', async () => {
    const { store, resources } = fakeSchemaStore();
    const input = {
      drive: 'drive',
      proxyOrigin: 'https://proxy.example',
      platform: 'github-issues',
      name: 'GitHub',
    };
    const subject = await ensureSyncablePlatform(store, input);
    const appTerms = await findSchema(store, input.drive, pluginSchema());
    const accounts = resources.get(subject)?.[
      appTerms.properties!['app-data']
    ] as string;
    const table = await store.getResource(accounts);
    const viewList = dataBrowser.properties.tableViews;
    const defaultView = dataBrowser.properties.tableDefaultView;
    const [standard, oldSync] = table.get(viewList) as string[];
    resources.delete(oldSync);
    resources.set('custom', {
      [core.properties.parent]: accounts,
      [core.properties.isA]: [dataBrowser.classes.view],
      [dataBrowser.properties.viewKind]: 'kanban',
    });
    await table.set(viewList, ['custom', standard]);
    await table.set(defaultView, 'custom');

    expect(await ensureSyncablePlatform(store, input)).toBe(subject);
    const nextViews = table.get(viewList) as string[];
    expect(nextViews).toEqual(['custom', standard, expect.any(String)]);
    expect(resources.get(nextViews[2])?.[dataBrowser.properties.viewKind]).toBe(
      'syncables',
    );
    expect(table.get(defaultView)).toBe('custom');

    await ensureSyncablePlatform(store, input);
    expect(table.get(viewList)).toEqual(nextViews);
  });

  it('does not adopt an unrelated resource with the platform local ID', async () => {
    const { store, resources } = fakeSchemaStore();
    const input = {
      drive: 'drive',
      proxyOrigin: 'https://proxy.example',
      platform: 'github-issues',
      name: 'GitHub',
    };
    const initial = await ensureSyncablePlatform(store, input);
    const schema = await findSchema(store, 'drive', syncablePlatformSchema());
    const property = schema.properties!['syncable-platform-index'];
    const root = await store.getResource('drive');
    await root.set(property, {});
    resources.delete(initial);
    resources.set('unrelated-resource', {
      [core.properties.parent]: 'drive',
      [core.properties.localId]: platformLocalId(
        input.proxyOrigin,
        input.platform,
      ),
    });

    expect(await findSyncablePlatform(store, input)).toBeUndefined();
  });

  it('keeps installations from different proxy origins distinct', async () => {
    const { store } = fakeSchemaStore();
    const input = {
      drive: 'drive',
      platform: 'github-issues',
      name: 'GitHub',
    };
    const a = await ensureSyncablePlatform(store, {
      ...input,
      proxyOrigin: 'https://a.example',
    });
    const b = await ensureSyncablePlatform(store, {
      ...input,
      proxyOrigin: 'https://b.example',
    });
    expect(a).not.toBe(b);
  });

  it('migrates direct account rows and Public without changing remote identities or moved rows', async () => {
    const { store, resources } = fakeSchemaStore();
    const input = {
      drive: 'drive',
      proxyOrigin: 'https://proxy.example',
      platform: 'github-issues',
      name: 'GitHub',
    };
    const root = await ensureSyncablePlatform(store, input);
    const appTerms = await findSchema(store, input.drive, pluginSchema());
    const platform = await findSchema(
      store,
      input.drive,
      syncablePlatformSchema(),
    );
    const hierarchy = await ensureSchema(
      store,
      input.drive,
      syncableHierarchySchema(),
    );
    const oldAccounts = resources.get(root)![
      appTerms.properties!['app-data']
    ] as string;
    const rootValues = resources.get(root)!;
    const oldViews = resources.get(oldAccounts)![
      dataBrowser.properties.tableViews
    ] as string[];
    rootValues[core.properties.isA] = [dataBrowser.classes.table];
    rootValues[core.properties.classtype] =
      platform.classes!['syncable-account'];
    rootValues[dataBrowser.properties.tableViews] = oldViews;
    rootValues[dataBrowser.properties.tableDefaultView] = oldViews[1];
    delete rootValues[appTerms.properties!['app-data']];
    delete rootValues[platform.properties!['builtin-app']];
    resources.delete(oldAccounts);
    for (const view of oldViews)
      resources.get(view)![core.properties.parent] = root;
    resources.set('account', {
      [core.properties.parent]: root,
      [core.properties.isA]: [platform.classes!['syncable-account']],
      [hierarchy.properties['syncable-source-key']]:
        'unchanged-remote-account-key',
    });
    resources.set('nested-owner', {
      [core.properties.parent]: 'account',
      [core.properties.name]: 'saved owner',
    });
    resources.set('public', {
      [core.properties.parent]: root,
      [core.properties.isA]: [dataBrowser.classes.table],
      [hierarchy.properties['syncable-node-kind']]: 'public',
    });
    resources.set('user-note', {
      [core.properties.parent]: root,
      [core.properties.name]: 'leave here',
    });
    resources.set('elsewhere', { [core.properties.parent]: 'drive' });
    resources.set('foreign-view', {
      [core.properties.parent]: 'elsewhere',
      [core.properties.isA]: [dataBrowser.classes.view],
    });
    rootValues[dataBrowser.properties.tableViews] = [
      ...oldViews,
      'foreign-view',
    ];
    resources.set('moved-account', {
      [core.properties.parent]: 'elsewhere',
      [core.properties.isA]: [platform.classes!['syncable-account']],
    });

    expect(await ensureSyncablePlatform(store, input)).toBe(root);
    const savedRoot = resources.get(root)!;
    const accounts = savedRoot[appTerms.properties!['app-data']] as string;
    expect(accounts).not.toBe(oldAccounts);
    expect(savedRoot[core.properties.isA]).toContain(appTerms.classes!.app);
    expect(savedRoot[core.properties.isA]).not.toContain(
      dataBrowser.classes.table,
    );
    expect(resources.get('account')?.[core.properties.parent]).toBe(accounts);
    expect(
      resources.get('account')?.[hierarchy.properties['syncable-source-key']],
    ).toBe('unchanged-remote-account-key');
    expect(resources.get('nested-owner')?.[core.properties.parent]).toBe(
      'account',
    );
    expect(resources.get('public')?.[core.properties.parent]).toBe(accounts);
    expect(resources.get('user-note')?.[core.properties.parent]).toBe(root);
    expect(resources.get('foreign-view')?.[core.properties.parent]).toBe(
      'elsewhere',
    );
    expect(resources.get('moved-account')?.[core.properties.parent]).toBe(
      'elsewhere',
    );
    expect(
      resources.get(accounts)?.[dataBrowser.properties.tableViews],
    ).toEqual(oldViews);
    expect(
      resources.get(accounts)?.[dataBrowser.properties.tableDefaultView],
    ).toBe(oldViews[1]);
    expect(await ensureSyncablePlatform(store, input)).toBe(root);
    expect(resources.get(root)![appTerms.properties!['app-data']]).toBe(
      accounts,
    );
  });

  it('recovers a partially provisioned App using the saved Accounts child', async () => {
    const { store, resources } = fakeSchemaStore();
    const input = {
      drive: 'drive',
      proxyOrigin: 'https://proxy.example',
      platform: 'github-issues',
      name: 'GitHub',
    };
    const root = await ensureSyncablePlatform(store, input);
    const app = await findSchema(store, input.drive, pluginSchema());
    const table = resources.get(root)![app.properties!['app-data']];
    delete resources.get(root)![app.properties!['app-data']];
    const before = resources.size;
    expect(await ensureSyncablePlatform(store, input)).toBe(root);
    expect(resources.get(root)![app.properties!['app-data']]).toBe(table);
    expect(resources.size).toBe(before);
  });

  it('recovers listed views already moved by an interrupted legacy migration', async () => {
    const { store, resources } = fakeSchemaStore();
    const input = {
      drive: 'drive',
      proxyOrigin: 'https://proxy.example',
      platform: 'github-issues',
      name: 'GitHub',
    };
    const root = await ensureSyncablePlatform(store, input);
    const app = await findSchema(store, input.drive, pluginSchema());
    const table = resources.get(root)![app.properties!['app-data']] as string;
    const views = resources.get(table)![
      dataBrowser.properties.tableViews
    ] as string[];
    resources.get(root)![core.properties.isA] = [dataBrowser.classes.table];
    resources.get(root)![dataBrowser.properties.tableViews] = views;
    resources.get(root)![dataBrowser.properties.tableDefaultView] = views[1];
    resources.get(table)![dataBrowser.properties.tableViews] = [];
    delete resources.get(table)![dataBrowser.properties.tableDefaultView];
    await ensureSyncablePlatform(store, input);
    expect(resources.get(table)![dataBrowser.properties.tableViews]).toEqual(
      views,
    );
    expect(resources.get(table)![dataBrowser.properties.tableDefaultView]).toBe(
      views[1],
    );
    expect(resources.get(root)![core.properties.isA]).toContain(
      app.classes!.app,
    );
  });
});
