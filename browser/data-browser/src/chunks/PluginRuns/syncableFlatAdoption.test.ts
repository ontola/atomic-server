import { expect, it, vi } from 'vitest';
import { LoroDoc, LoroList } from 'loro-crdt';
vi.mock('loro-crdt', () => import('loro-crdt/nodejs'));
import { collections, core, type Store } from '@tomic/lib';
import {
  bindCollection,
  relatedCollectionReads,
  prepareDocument,
  resolveEntityIdentity,
} from 'syncables/browser';
import { collectSyncableFlatAdoption } from './syncableFlatAdoption';
import {
  collectionIdentity,
  entitySourceKey,
  entityTableKey,
  sourceConfigFingerprint,
  sourceKey,
} from './builtinSyncIdentity.js';

const p = Object.fromEntries(
  [
    'platform-id',
    'proxy-origin',
    'source-key',
    'source-config',
    'node-kind',
  ].map(name => ['syncable-' + name, 'atomic:' + name]),
);
const base = {
  version: 2 as const,
  proxyOrigin: 'https://proxy.example',
  platform: 'calendar-service',
  principal: {
    kind: 'authenticated' as const,
    namespace: 'https://identity.example',
    subject: 7,
  },
  connectionId: 's'.repeat(43),
};
const document = prepareDocument({
  openapi: '3.0.3',
  info: { title: 'Events', version: '1' },
  servers: [{ url: 'https://api.example' }],
  components: {
    crudResources: {
      event: {
        schema: {
          type: 'object',
          properties: { id: { type: 'integer' }, name: { type: 'string' } },
        },
        identity: {
          urlTemplate: '/events/{id}',
          bindings: { id: { field: 'id' } },
        },
        collections: { events: { urlTemplate: '/me/events' } },
      },
    },
  },
  paths: {
    '/me/events': {
      get: {
        operationId: 'events',
        'x-crud': { action: 'list', resource: 'event', collection: 'events' },
        responses: {
          '200': {
            description: 'Events',
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
});

function fixture() {
  const rows = new Map<string, Record<string, unknown>>([
    ['atomic:drive', {}],
    [
      'atomic:app',
      {
        [core.properties.parent]: 'atomic:drive',
        [p['syncable-platform-id']]: base.platform,
        [p['syncable-proxy-origin']]: base.proxyOrigin,
      },
    ],
  ]);
  const add = (subject: string, parent: string, key: string, config: unknown) =>
    rows.set(subject, {
      [core.properties.parent]: parent,
      [core.properties.localId]: 'syncables:node:' + encodeURIComponent(key),
      [p['syncable-node-kind']]: JSON.parse(key).kind,
      [p['syncable-source-key']]: key,
      [p['syncable-source-config']]: config,
    });
  const principalKey = sourceKey({ ...base, kind: 'principal' });
  add('atomic:principal', 'atomic:app', principalKey, base);
  const bound = bindCollection(document, { collection: 'events' });
  const tableConfig = { ...base, collection: bound };
  const tableKey = sourceKey({
    ...base,
    kind: 'collection',
    collection: collectionIdentity(bound),
  });
  add('atomic:table', 'atomic:principal', tableKey, tableConfig);
  const record = { id: 11, name: 'Remote title' };
  const rowConfig = {
    ...base,
    resource: 'event',
    record,
    context: {},
    parentSourceKey: tableKey,
    managedProperties: ['atomic:name'],
  };
  const rowKey = sourceKey({
    ...rowConfig,
    kind: 'record',
    collection: { name: 'events', resource: 'event' },
    remoteId: 11,
  });
  add('atomic:row', 'atomic:table', rowKey, rowConfig);
  rows.get('atomic:row')!['atomic:user-note'] = 'Keep my note';
  let pageOverride: { total: number; pages: string[][] } | undefined;

  const resource = (subject: string) => {
    if (!rows.has(subject)) throw new Error('Missing');

    return {
      subject,
      get: (property: string) => rows.get(subject)?.[property],
      getSubjects: (property: string) => rows.get(subject)?.[property] ?? [],
    };
  };

  const store = {
    normalizeSubject: (subject: string) => subject,
    getServerUrl: () => 'https://node.example',
    getResource: vi.fn(async (subject: string) => resource(subject)),
    getResources: vi.fn(async (subjects: string[]) => subjects.map(resource)),
    fetchResourceFromServer: vi.fn(async (subject: string) => {
      const url = new URL(subject);
      expect(url.origin + url.pathname).toBe('https://node.example/query');
      expect(url.searchParams.has('value')).toBe(false);
      const members = [...rows]
        .filter(
          ([, value]) => typeof value[p['syncable-source-key']] === 'string',
        )
        .map(([key]) => key);
      const number = Number(url.searchParams.get('current_page'));

      return {
        getLoroDoc: () => undefined,
        get: (property: string) =>
          property === collections.properties.totalMembers
            ? (pageOverride?.total ?? members.length)
            : undefined,
        getSubjects: () =>
          pageOverride?.pages[number] ??
          members.slice(number * 100, (number + 1) * 100),
      };
    }),
  } as unknown as Store;
  const options = {
    drive: 'atomic:drive',
    app: 'atomic:app',
    proxyOrigin: base.proxyOrigin,
    platform: base.platform,
    properties: p,
    document,
    assertCurrent: vi.fn(),
  };

  return {
    rows,
    add,
    store,
    options,
    tableKey,
    tableConfig,
    rowKey,
    rowConfig,
    override: (value: typeof pageOverride) => {
      pageOverride = value;
    },
  };
}

it('hydrates cold source pages through existing bulk reads instead of one worker round trip per row', async () => {
  const { rows, add, store, options, rowConfig } = fixture();

  for (let id = 12; id < 110; id++) {
    const config = { ...rowConfig, record: { id, name: 'Remote title' } };
    add(
      'atomic:row-' + id,
      'atomic:table',
      sourceKey({
        ...config,
        kind: 'record',
        collection: { name: 'events', resource: 'event' },
        remoteId: id,
      }),
      config,
    );
  }

  const snapshot = JSON.stringify([...rows]);
  const single = vi.mocked(store.getResource).getMockImplementation()!;
  vi.mocked(store.getResource).mockImplementation(async subject => {
    if (typeof rows.get(subject)?.[p['syncable-source-key']] === 'string')
      throw new Error('Unexpected single cold-source hydration');

    return single(subject);
  });
  const result = await collectSyncableFlatAdoption(store, options);
  expect(result.blocks).toEqual([]);
  expect(result.aliases).toHaveLength(100);
  expect(
    vi.mocked(store.getResources).mock.calls.map(([ids]) => ids.length),
  ).toEqual([100, 1]);
  expect(JSON.stringify([...rows])).toBe(snapshot);
});

it('never bulk-fetches foreign, credential-bearing or commit query subjects', async () => {
  const { store, options, override } = fixture();
  const members = [
    'atomic:principal',
    'https://foreign.example/source',
    'atomic:commit:' + 'a'.repeat(86),
    'https://user:secret@node.example/source',
    'atomic:table',
    'https://node.example/source#fragment',
    'atomic:row',
  ];
  override({ total: members.length, pages: [members] });
  const result = await collectSyncableFlatAdoption(store, options);
  expect(result.blocks).toEqual([]);
  expect(store.getResources).toHaveBeenCalledExactlyOnceWith([
    'atomic:principal',
    'atomic:table',
    'atomic:row',
  ]);
  expect(vi.mocked(store.getResource).mock.calls.map(([id]) => id)).toEqual([
    'atomic:app',
  ]);
});

it('refuses bulk read errors and the resource budget without accepting partial adoption', async () => {
  const { rows, store, options } = fixture();
  const before = JSON.stringify([...rows]);
  const bulk = vi.mocked(store.getResources).getMockImplementation()!;
  vi.mocked(store.getResources).mockImplementationOnce(async subjects => {
    const resources = await bulk(subjects);
    Object.assign(resources[1], { error: new Error('Source unreadable') });

    return resources;
  });
  await expect(collectSyncableFlatAdoption(store, options)).rejects.toThrow(
    'Source unreadable',
  );
  vi.mocked(store.getResources).mockClear();
  await expect(
    collectSyncableFlatAdoption(store, { ...options, maxResources: 3 }),
  ).rejects.toThrow('resource limit');
  expect(store.getResources).not.toHaveBeenCalled();
  expect(JSON.stringify([...rows])).toBe(before);
});

it('proves unique flat destinations without changing subjects, user fields, view data or saved metadata', async () => {
  const { rows, store, options, tableKey, rowKey, rowConfig } = fixture();
  const snapshot = JSON.stringify([...rows]);
  const result = await collectSyncableFlatAdoption(store, options);
  expect(result.blocks).toEqual([]);
  expect(result.aliases).toContainEqual(
    expect.objectContaining({
      subject: 'atomic:table',
      previousSourceKey: tableKey,
      canonicalSourceKey: entityTableKey({ ...base, resource: 'event' }),
    }),
  );
  expect(result.aliases).toContainEqual(
    expect.objectContaining({
      subject: 'atomic:row',
      previousSourceKey: rowKey,
      sourceConfigFingerprint: sourceConfigFingerprint(rowConfig),
      canonicalSourceKey: entitySourceKey({
        ...base,
        entityIdentity: resolveEntityIdentity(document, {
          resource: 'event',
          record: rowConfig.record,
        }),
      }),
    }),
  );
  expect(JSON.stringify([...rows])).toBe(snapshot);
});

it('preserves opaque inherited localIds through v2 adoption and v3 reentry without accepting changed typed source proof', async () => {
  const { rows, store, options } = fixture();
  rows.get('atomic:principal')![core.properties.localId] =
    'legacy-principal-identity';
  rows.get('atomic:table')![core.properties.localId] = 'legacy-table-identity';
  rows.get('atomic:row')![core.properties.localId] = 'legacy-record-identity';
  const proposed = await collectSyncableFlatAdoption(store, options);
  expect(proposed.blocks).toEqual([]);
  const table = proposed.aliases.find(
    alias => alias.subject === 'atomic:table',
  )!;
  const row = proposed.aliases.find(alias => alias.subject === 'atomic:row')!;
  expect(table.localId).toBe('legacy-table-identity');
  expect(row.localId).toBe('legacy-record-identity');
  rows.get('atomic:table')![p['syncable-source-key']] =
    table.canonicalSourceKey;
  rows.get('atomic:table')![p['syncable-source-config']] = {
    ...base,
    version: 3,
    kind: 'collection',
    resource: 'event',
  };
  rows.get('atomic:row')![p['syncable-source-key']] = row.canonicalSourceKey;
  rows.get('atomic:row')![p['syncable-source-config']] = row.canonicalConfig;
  const reentered = await collectSyncableFlatAdoption(store, options);
  expect(reentered.blocks).toEqual([]);
  expect(reentered.aliases).toEqual([]);
  expect(rows.get('atomic:row')![core.properties.localId]).toBe(
    'legacy-record-identity',
  );
  rows.get('atomic:row')![p['syncable-source-config']] = {
    ...row.canonicalConfig,
    record: { id: '11', name: 'Wrong typed identity' },
  };
  const changed = await collectSyncableFlatAdoption(store, options);
  expect(changed.blocks).toEqual([
    expect.objectContaining({
      principal: base.principal,
      resource: 'event',
      message: expect.stringContaining('invalid'),
    }),
  ]);
});

it('retains unsupported older formats and only blocks the matching integration', async () => {
  const { add, store, options } = fixture();
  const oldKey = (platform: string) =>
    JSON.stringify([base.proxyOrigin, platform, 'collection', 'opaque', '']);
  add('atomic:other-service', 'atomic:app', oldKey('other-service'), {});
  await expect(
    collectSyncableFlatAdoption(store, options),
  ).resolves.toBeDefined();
  add('atomic:old-source', 'atomic:app', oldKey(base.platform), {});
  await expect(collectSyncableFlatAdoption(store, options)).rejects.toThrow(
    'Their data was retained',
  );
});

it('blocks competing tables and typed duplicate entities without choosing a primary or allocating another copy', async () => {
  const { add, store, options, tableKey, tableConfig, rowKey, rowConfig } =
    fixture();
  add('atomic:other-table', 'atomic:principal', tableKey, tableConfig);
  add('atomic:other-row', 'atomic:other-table', rowKey, rowConfig);
  const result = await collectSyncableFlatAdoption(store, options);
  expect(result.blocks).toEqual([
    expect.objectContaining({
      principal: base.principal,
      resource: 'event',
      message: expect.stringContaining('same canonical entity'),
    }),
  ]);
  expect(
    result.aliases.filter(alias => alias.subject.includes('table')),
  ).toEqual([]);
  expect(
    result.aliases.filter(
      alias =>
        alias.canonicalSourceKey === result.aliases[0].canonicalSourceKey,
    ),
  ).toHaveLength(2);
});

it('retains manually moved rows as protected aliases while blocking moved table adoption', async () => {
  const { rows, store, options } = fixture();
  rows.set('atomic:folder', { [core.properties.parent]: 'atomic:drive' });
  rows.get('atomic:row')![core.properties.parent] = 'atomic:folder';
  const result = await collectSyncableFlatAdoption(store, options);
  expect(result.blocks).toEqual([]);
  expect(
    result.aliases.find(alias => alias.subject === 'atomic:row'),
  ).not.toHaveProperty('reparentToLogicalParent');
  expect(result.warnings.join(' ')).toContain('protected');
  rows.get('atomic:table')![core.properties.parent] = 'atomic:folder';
  const moved = await collectSyncableFlatAdoption(store, options);
  expect(moved.blocks).toHaveLength(1);
  expect(rows.get('atomic:row')!['atomic:user-note']).toBe('Keep my note');
});

it('keeps number and string canonical field values distinct and ignores other platform sources', async () => {
  const { rows, add, store, options, rowConfig } = fixture();
  const config = { ...rowConfig, record: { ...rowConfig.record, id: '11' } };
  const key = sourceKey({
    ...config,
    kind: 'record',
    collection: { name: 'events', resource: 'event' },
    remoteId: '11',
  });
  add('atomic:string-id', 'atomic:table', key, config);
  const result = await collectSyncableFlatAdoption(store, options);
  expect(result.blocks).toEqual([]);
  expect(
    new Set(
      result.aliases
        .filter(alias => alias.subject !== 'atomic:table')
        .map(alias => alias.canonicalSourceKey),
    ).size,
  ).toBe(2);
  rows.get('atomic:string-id')![p['syncable-source-key']] = sourceKey({
    ...config,
    platform: 'other-service',
    kind: 'record',
    collection: { name: 'events', resource: 'event' },
    remoteId: '11',
  });
  const other = await collectSyncableFlatAdoption(store, options);
  expect(
    other.aliases.some(alias => alias.subject === 'atomic:string-id'),
  ).toBe(false);
});

it('rejects truncated, duplicated and changing raw query coverage before filtering foreign members', async () => {
  const { store, options, override } = fixture();
  const foreign = Array.from(
    { length: 100 },
    (_, index) => 'https://foreign.example/' + index,
  );
  override({ total: 101, pages: [foreign, [foreign[0]]] });
  await expect(collectSyncableFlatAdoption(store, options)).rejects.toThrow(
    'duplicate',
  );
  override({
    total: 101,
    pages: [foreign.slice(0, 99), ['https://foreign.example/100']],
  });
  await expect(collectSyncableFlatAdoption(store, options)).rejects.toThrow(
    'incomplete',
  );
  override({ total: 10_001, pages: [] });
  await expect(collectSyncableFlatAdoption(store, options)).rejects.toThrow(
    'excessive',
  );
});

it('replaces independent query snapshots instead of merging an old empty members container into a newer count', async () => {
  const { rows, store, options } = fixture();
  const members = ['atomic:principal', 'atomic:table', 'atomic:row'];

  const snapshot = (peer: number, subjects: string[]) => {
    const doc = new LoroDoc();
    doc.setPeerId(peer);
    const values = doc.getMap('properties');
    const list = values.setContainer(
      collections.properties.members,
      new LoroList(),
    );
    for (const subject of subjects) list.push(subject);
    values.set(collections.properties.totalMembers, subjects.length);
    doc.commit();

    return doc.export({ mode: 'snapshot' });
  };

  const responses = [snapshot(100, []), snapshot(1, members)];
  const merged = new LoroDoc();
  for (const response of responses) merged.import(response);
  expect(merged.getMap('properties').toJSON()).toMatchObject({
    [collections.properties.totalMembers]: 3,
    [collections.properties.members]: [],
  });
  let cached = new LoroDoc();
  let next = 0;
  vi.mocked(store.fetchResourceFromServer).mockImplementation(
    async (_url, fetchOptions) => {
      if (fetchOptions?.forceOverride) cached = new LoroDoc();
      cached.import(responses[next++]);
      const values = () => cached.getMap('properties').toJSON();

      return {
        getLoroDoc: () => cached,
        get: (property: string) => values()[property],
        getSubjects: (property: string) => values()[property],
      } as never;
    },
  );
  const before = JSON.stringify([...rows]);
  expect((await collectSyncableFlatAdoption(store, options)).aliases).toEqual(
    [],
  );
  const refreshed = await collectSyncableFlatAdoption(store, options);
  expect(refreshed.aliases.map(alias => alias.subject)).toEqual([
    'atomic:table',
    'atomic:row',
  ]);
  expect(refreshed.blocks).toEqual([]);
  expect(JSON.stringify([...rows])).toBe(before);
});

it('preserves a unique untouched nested table and its original relationship as a saved rule', async () => {
  const { rows, add, store, options } = fixture();
  const doc = prepareDocument({
    ...document,
    components: {
      ...document.components,
      crudResources: {
        ...(document.components!.crudResources as Record<string, unknown>),
        folder: {
          schema: { type: 'object', properties: { id: { type: 'integer' } } },
          identity: {
            urlTemplate: '/folders/{folder_id}',
            bindings: { folder_id: { field: 'id' } },
          },
          collections: { folders: { urlTemplate: '/me/folders' } },
        },
        event: {
          ...(
            document.components!.crudResources as Record<
              string,
              Record<string, unknown>
            >
          ).event,
          collections: {
            folderEvents: { urlTemplate: '/folders/{folder_id}/events' },
          },
        },
      },
    },
    paths: {
      ...document.paths,
      '/me/folders': {
        get: {
          operationId: 'folders',
          'x-crud': {
            action: 'list',
            resource: 'folder',
            collection: 'folders',
          },
          responses: { '200': { description: 'Folders' } },
        },
      },
      '/folders/{folder_id}/events': {
        get: {
          operationId: 'folderEvents',
          'x-crud': {
            action: 'list',
            resource: 'event',
            collection: 'folderEvents',
          },
          parameters: [
            {
              name: 'folder_id',
              in: 'path',
              required: true,
              schema: { type: 'integer' },
            },
          ],
          responses: { '200': { description: 'Events' } },
        },
      },
    },
  });
  rows.delete('atomic:table');
  rows.delete('atomic:row');
  const folderBound = bindCollection(doc, { collection: 'folders' });
  const folderKey = sourceKey({
    ...base,
    kind: 'collection',
    collection: collectionIdentity(folderBound),
  });
  add('atomic:folders', 'atomic:principal', folderKey, {
    ...base,
    collection: folderBound,
  });
  const folderRecord = { id: 3 };
  const folderRowKey = sourceKey({
    ...base,
    kind: 'record',
    collection: { name: 'folders', resource: 'folder' },
    remoteId: 3,
    parentSourceKey: folderKey,
  });
  add('atomic:folder-row', 'atomic:folders', folderRowKey, {
    ...base,
    resource: 'folder',
    record: folderRecord,
    context: {},
    parentSourceKey: folderKey,
  });
  const navigation = relatedCollectionReads(doc, {
    resource: 'folder',
    record: folderRecord,
    context: {},
  })[0];
  expect(navigation).toBeDefined();
  const nestedKey = sourceKey({
    ...base,
    kind: 'collection',
    collection: collectionIdentity(undefined, navigation),
    parentSourceKey: folderRowKey,
  });
  add('atomic:nested-table', 'atomic:folder-row', nestedKey, {
    ...base,
    navigation,
    parentSourceKey: folderRowKey,
  });
  const nestedRowKey = sourceKey({
    ...base,
    kind: 'record',
    collection: { name: 'folderEvents', resource: 'event' },
    remoteId: 11,
    parentSourceKey: nestedKey,
  });
  add('atomic:nested-row', 'atomic:nested-table', nestedRowKey, {
    ...base,
    resource: 'event',
    record: { id: 11, name: 'Keep title' },
    context: { folder_id: '3' },
    parentSourceKey: nestedKey,
  });
  const before = JSON.stringify([...rows]);
  const result = await collectSyncableFlatAdoption(store, {
    ...options,
    document: doc,
  });
  expect(result.blocks).toEqual([]);
  expect(
    result.aliases.find(alias => alias.subject === 'atomic:nested-table'),
  ).toMatchObject({
    reparentToLogicalParent: true,
    previousParent: 'atomic:folder-row',
  });
  expect(
    result.rules.find(rule => rule.definition.resource === 'event'),
  ).toMatchObject({
    definition: {
      source: { kind: 'related', origin: { entity: { resource: 'folder' } } },
    },
  });
  expect(
    result.aliases.find(alias => alias.subject === 'atomic:nested-row'),
  ).toMatchObject({
    canonicalConfig: {
      version: 3,
      resource: 'event',
      record: { id: 11, name: 'Keep title' },
      read: { collection: 'folderEvents' },
    },
  });
  expect(JSON.stringify([...rows])).toBe(before);
});
