// @wc-ignore-file
import { expect, it } from 'vitest';
import {
  commits,
  core,
  dataBrowser,
  GENESIS,
  server,
  type Resource,
} from '@tomic/lib';
import {
  syncableCollectionTabs,
  syncableEntityViewKind,
  retainHiddenSyncableViews,
} from './syncableCollectionCompatibility';

function view(
  subject: string,
  name: string,
  kind: string,
  settings: Record<string, unknown> = {},
) {
  const values: Record<string, unknown> = {
    [core.properties.name]: name,
    [core.properties.parent]: 'atomic:collection',
    [core.properties.isA]: [dataBrowser.classes.view],
    [dataBrowser.properties.viewKind]: kind,
    ...settings,
  };

  return {
    subject,
    loading: false,
    get: (property: string) => values[property],
    getEntries: () => Object.entries(values),
    getCreatedBy: () => values[server.properties.createdBy],
  } as Resource;
}

function tabs(entity: boolean, resources: Resource[], activeView?: string) {
  return syncableCollectionTabs({
    entity,
    views: resources.map(resource => resource.subject),
    activeView,
    rules: new Set(['atomic:rule']),
    getView: subject =>
      resources.find(resource => resource.subject === subject)!,
  });
}

it('uses native Table for canonical entity Collection links without changing any View settings', () => {
  const filters = [{ property: 'atomic:owner', value: 'atomic:org' }];
  const columns = ['atomic:title', 'atomic:owner'];
  const resource = view(
    'atomic:custom',
    'My organization',
    'syncable-collection',
    {
      [dataBrowser.properties.viewFilters]: filters,
      [dataBrowser.properties.viewColumns]: columns,
      [dataBrowser.properties.viewSortBy]: 'atomic:title',
    },
  );
  const before = resource.getEntries();

  expect(syncableEntityViewKind('syncable-collection', true)).toBe('table');
  expect(syncableEntityViewKind('syncable-collection', false)).toBe(
    'syncable-collection',
  );
  expect(syncableEntityViewKind('syncables', true)).toBe('syncables');
  expect(tabs(true, [resource], 'atomic:custom').activeView).toBe(
    'atomic:custom',
  );
  expect(resource.getEntries()).toEqual(before);
  expect(resource.get(dataBrowser.properties.viewFilters)).toBe(filters);
  expect(resource.get(dataBrowser.properties.viewColumns)).toBe(columns);
});

it.each(['Collection', 'Syncable Collections'])(
  'hides the unconfigured %s duplicate only for entities with a loaded ordinary Table',
  name => {
    const collection = view(
      'atomic:collection-view',
      name,
      'syncable-collection',
      {
        [commits.properties.createdAt]: 1_795_000_000,
        [server.properties.createdBy]: 'atomic:agent',
        [commits.properties.lastCommit]: 'atomic:commit',
        'https://atomicdata.dev/properties/drive': 'atomic:drive',
      },
    );
    const table = view('atomic:table', 'Table', 'table');
    const sync = view('atomic:sync', 'Sync', 'syncables');

    expect(tabs(true, [collection, table, sync], collection.subject)).toEqual({
      views: [table.subject, sync.subject],
      activeView: table.subject,
      hidden: new Set([collection.subject]),
    });
    expect(
      tabs(false, [collection, table, sync], collection.subject).views,
    ).toEqual([collection.subject, table.subject, sync.subject]);
    expect(tabs(true, [collection, sync], collection.subject).views).toEqual([
      collection.subject,
      sync.subject,
    ]);
    table.loading = true;
    expect(tabs(true, [collection, table], collection.subject).views).toContain(
      collection.subject,
    );
  },
);

it('hides generated owner-only permissions and genesis metadata without altering either View', () => {
  const collection = view(
    'atomic:generated',
    'Collection',
    'syncable-collection',
    {
      [GENESIS]: 'signed-genesis-certificate',
      [server.properties.createdBy]: 'did:ad:creator',
      [core.properties.write]: ['atomic:creator'],
    },
  );
  const table = view('atomic:table', 'Table', 'table');
  const before = collection.getEntries();
  expect(tabs(true, [collection, table], collection.subject)).toEqual({
    views: [table.subject],
    activeView: table.subject,
    hidden: new Set([collection.subject]),
  });
  expect(collection.getEntries()).toEqual(before);
});

it('preserves custom or unproven permissions and settings even with genesis metadata', () => {
  const metadata = {
    [GENESIS]: 'signed-genesis-certificate',
    [server.properties.createdBy]: 'atomic:creator',
    [core.properties.write]: ['atomic:creator'],
  };
  const settings = [
    { [core.properties.write]: ['atomic:someone-else'] },
    { [core.properties.write]: ['atomic:creator', 'atomic:collaborator'] },
    { [core.properties.write]: [] },
    { [core.properties.write]: 'atomic:creator' },
    { [core.properties.write]: [17] },
    { [server.properties.createdBy]: undefined },
    { [core.properties.read]: ['atomic:creator'] },
    { [dataBrowser.properties.viewFilters]: [] },
    { [dataBrowser.properties.viewColumns]: [] },
    { 'atomic:unknown-setting': true },
  ];
  const table = view('atomic:table', 'Table', 'table');

  for (const custom of settings) {
    const collection = view(
      'atomic:custom',
      'Collection',
      'syncable-collection',
      { ...metadata, ...custom },
    );
    expect(tabs(true, [collection, table], collection.subject).views).toContain(
      collection.subject,
    );
  }

  const renamed = view(
    'atomic:renamed',
    'My collection',
    'syncable-collection',
    metadata,
  );
  expect(tabs(true, [renamed, table], renamed.subject).views).toContain(
    renamed.subject,
  );
});

it('keeps renamed, configured and not-yet-proven Collection views visible', () => {
  const resources = [
    view('atomic:renamed', 'Organization overview', 'syncable-collection'),
    view('atomic:columns', 'Collection', 'syncable-collection', {
      [dataBrowser.properties.viewColumns]: [],
    }),
    view('atomic:filters', 'Browse', 'syncable-collection', {
      [dataBrowser.properties.viewFilters]: [
        { property: 'atomic:owner', value: 'org' },
      ],
    }),
    view('atomic:custom', 'Collection', 'syncable-collection', {
      'atomic:custom-setting': true,
    }),
    view('atomic:cold', 'Collection', 'syncable-collection'),
    view('atomic:table', 'Table', 'table'),
  ];
  resources[4].loading = true;
  expect(tabs(true, resources, 'atomic:filters').views).toEqual(
    resources.map(resource => resource.subject),
  );
  expect(tabs(true, resources, 'atomic:filters').activeView).toBe(
    'atomic:filters',
  );
});

it('selects Table for hidden saved rules while retaining hidden definitions on reorder', () => {
  const resources = [
    view('atomic:collection-view', 'Browse', 'syncable-collection'),
    view('atomic:table', 'Table', 'table'),
    view('atomic:rule', 'One organization', 'syncable-collection', {
      [dataBrowser.properties.viewFilters]: [
        { property: 'atomic:memberships', value: 'atomic:rule' },
      ],
    }),
    view('atomic:sync', 'Sync', 'syncables'),
  ];
  const result = tabs(true, resources, 'atomic:rule');
  expect(result.activeView).toBe('atomic:table');
  expect(result.views).toEqual(['atomic:table', 'atomic:sync']);
  expect(
    retainHiddenSyncableViews(
      ['atomic:sync', 'atomic:table'],
      resources.map(resource => resource.subject),
      result.hidden,
    ),
  ).toEqual([
    'atomic:sync',
    'atomic:table',
    'atomic:collection-view',
    'atomic:rule',
  ]);
  expect(tabs(false, resources, 'atomic:rule').activeView).toBe(
    'atomic:collection-view',
  );
});
