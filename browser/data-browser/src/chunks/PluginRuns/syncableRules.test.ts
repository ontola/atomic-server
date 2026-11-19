import { afterEach, expect, it, vi } from 'vitest';
import { CollectionBuilder, core, dataBrowser, type Store } from '@tomic/lib';
import {
  readSelectionKey,
  resolveEntityIdentity,
  type ReadSelection,
} from 'syncables/browser';
import {
  entitySourceKey,
  entityTableKey,
  ruleSourceKey,
} from './builtinSyncIdentity.js';
import { assertSyncAppDrive } from './builtinSyncablesProfile';
import {
  parseSyncableRuleConfig,
  parseSyncableRuleRun,
  readSyncableRuleStatus,
  resolveSyncableRule,
  syncableRuleDefinitionStamp,
} from './syncableRules';

afterEach(() => vi.restoreAllMocks());
const principal = {
  kind: 'authenticated' as const,
  namespace: 'https://identity.example',
  subject: 7,
};
const properties = {
  'syncable-source-config': 'atomic:config',
  'syncable-source-key': 'atomic:key',
  'syncable-mirror-status': 'atomic:status',
};
const read = {
  collection: 'events',
  resource: 'event',
  path: '/events',
  method: 'GET' as const,
  pathParams: {},
  query: {},
  body: {},
};
const bound = {
  version: 1 as const,
  resource: 'event',
  source: { kind: 'bound' as const, bound: read },
};
const config = (definition: ReadSelection = bound) => ({
  version: 3,
  kind: 'rule',
  resource: definition.resource,
  definition,
  ruleKey: readSelectionKey(definition),
});

it('strictly parses saved rule identity independently of presentation and status', () => {
  const parsed = parseSyncableRuleConfig(config());
  expect(parsed.definition).toEqual(bound);
  const stamp = syncableRuleDefinitionStamp(parsed);
  expect(syncableRuleDefinitionStamp(parseSyncableRuleConfig(config()))).toBe(
    stamp,
  );
  expect(() => parseSyncableRuleConfig({ ...config(), grant: 'all' })).toThrow(
    'definition',
  );
  expect(() =>
    parseSyncableRuleConfig({ ...config(), ruleKey: 'forged' }),
  ).toThrow('key');
  expect(() =>
    parseSyncableRuleConfig({ ...config(), resource: 'other' }),
  ).toThrow('resource');
  expect(() =>
    parseSyncableRuleConfig(
      config({
        ...bound,
        source: { ...bound.source, arbitrary: true },
      } as unknown as ReadSelection),
    ),
  ).toThrow();
  expect(
    readSyncableRuleStatus({
      paused: true,
      enabled: false,
      rows: 3,
      run: { generation: 'g', runId: 'r', startOrder: 1 },
    }),
  ).toMatchObject({ paused: true, rows: 3, run: { generation: 'g' } });
  expect(() => readSyncableRuleStatus({ paused: 'false' })).toThrow('status');
  expect(() =>
    parseSyncableRuleRun({ generation: 'g', runId: 'r', startOrder: NaN }),
  ).toThrow('generation');
});

function fixture() {
  const tableKey = entityTableKey({
    proxyOrigin: 'https://proxy.example',
    platform: 'calendar-service',
    principal,
    resource: 'event',
  });
  const viewKey = ruleSourceKey(tableKey, readSelectionKey(bound));
  const records = new Map<string, Record<string, unknown>>([
    ['atomic:drive', {}],
    [
      'atomic:table',
      {
        [core.properties.parent]: 'atomic:drive',
        [properties['syncable-source-key']]: tableKey,
        [dataBrowser.properties.tableViews]: ['atomic:rule'],
      },
    ],
    [
      'atomic:rule',
      {
        [core.properties.parent]: 'atomic:table',
        [core.properties.isA]: [dataBrowser.classes.view],
        [properties['syncable-source-config']]: config(),
        [properties['syncable-source-key']]: viewKey,
        [core.properties.localId]:
          'syncables:node:' + encodeURIComponent(viewKey),
      },
    ],
  ]);
  const resources = new Map();
  const wrap = (subject: string) => ({
    subject,
    get: (property: string) => records.get(subject)?.[property],
    getSubjects: (property: string) =>
      (records.get(subject)?.[property] ?? []) as string[],
  });
  const store = {
    resources,
    getDrive: () => 'atomic:drive',
    getServerUrl: () => 'https://node.example',
    normalizeSubject: (subject: string) => subject,
    getResource: vi.fn(async (subject: string) => {
      if (!records.has(subject)) throw new Error('Missing');
      const resource = wrap(subject);
      resources.set(subject, resource);

      return resource;
    }),
  } as unknown as Store;
  for (const subject of records.keys()) resources.set(subject, wrap(subject));
  const options = {
    drive: 'atomic:drive',
    table: 'atomic:table',
    subject: 'atomic:rule',
    proxyOrigin: 'https://proxy.example',
    platform: 'calendar-service',
    principal,
    resource: 'event',
    properties,
    assertCurrent: vi.fn(),
    assertDrive: (subject: string) =>
      assertSyncAppDrive(store, 'atomic:drive', subject),
  };

  return { records, store, options };
}

it('requires a linked View belonging to the exact table and rejects foreign URLs before fetching', async () => {
  const { records, store, options } = fixture();
  const resolved = await resolveSyncableRule(store, options);
  resolved.assertCurrent();
  records.get('atomic:rule')![core.properties.name] = 'Renamed';
  records.get('atomic:rule')![properties['syncable-mirror-status']] = {
    paused: true,
  };
  resolved.assertCurrent();
  records.get('atomic:rule')![core.properties.parent] = 'atomic:other';
  expect(() => resolved.assertCurrent()).toThrow();
  await expect(resolveSyncableRule(store, options)).rejects.toThrow(
    'saved Sync filter',
  );
  vi.mocked(store.getResource).mockClear();
  await expect(
    resolveSyncableRule(store, {
      ...options,
      subject: 'https://foreign.example/rule',
    }),
  ).rejects.toThrow('another server');
  expect(store.getResource).not.toHaveBeenCalled();
});

it('rechecks definition changes before a delayed write without requiring a provider request', async () => {
  const { records, store, options } = fixture();
  const resolved = await resolveSyncableRule(store, options);
  records.get('atomic:rule')![properties['syncable-source-config']] = config({
    ...bound,
    source: {
      kind: 'bound',
      bound: { ...read, pathParams: { calendar: 'other' } },
    },
  });
  expect(() => resolved.assertCurrent()).toThrow('definition changed');
});

it('replaces untrusted origin snapshots with unique current source rows and revokes changed provenance', async () => {
  const { records, store, options } = fixture();
  const entity = resolveEntityIdentity(
    {
      openapi: '3.0.3',
      info: { title: 'Fixture', version: '1' },
      paths: {},
      components: {
        crudResources: {
          event: {
            identity: {
              urlTemplate: '/events/{id}',
              bindings: { id: { field: 'id' } },
            },
          },
        },
      },
    },
    { resource: 'event', record: { id: 7 } },
  );
  const definition: ReadSelection = {
    version: 1,
    resource: 'task',
    source: {
      kind: 'related',
      origin: {
        entity,
        record: { id: 7, label: 'forged old label' },
        context: {},
        read,
      },
      via: { collection: 'tasks', kind: 'identity' },
    },
  };
  const targetTableKey = entityTableKey({ ...options, resource: 'task' });
  const targetViewKey = ruleSourceKey(
    targetTableKey,
    readSelectionKey(definition),
  );
  records.get('atomic:table')![properties['syncable-source-key']] =
    targetTableKey;
  records.get('atomic:rule')![properties['syncable-source-key']] =
    targetViewKey;
  records.get('atomic:rule')![core.properties.localId] =
    'syncables:node:' + encodeURIComponent(targetViewKey);
  records.get('atomic:rule')![properties['syncable-source-config']] =
    config(definition);
  const source = {
    version: 3,
    kind: 'record',
    proxyOrigin: options.proxyOrigin,
    platform: options.platform,
    principal,
    resource: 'event',
    entityIdentity: entity,
    record: { id: 7, label: 'actual stored record' },
    context: {},
    read,
  };
  const key = entitySourceKey({ ...options, entityIdentity: entity });
  records.set('atomic:source', {
    [core.properties.parent]: 'atomic:drive',
    [properties['syncable-source-key']]: key,
    [properties['syncable-source-config']]: source,
  });
  const answer = {
    totalMembers: 1,
    waitForReady: async () => undefined,
    getMemberWithIndex: async () => 'atomic:source',
  };
  vi.spyOn(CollectionBuilder.prototype, 'build').mockReturnValue(
    answer as never,
  );
  const resolved = await resolveSyncableRule(store, {
    ...options,
    resource: 'task',
  });
  expect(resolved.origins[0].record).toEqual(source.record);
  records.get('atomic:source')![properties['syncable-source-config']] = {
    ...source,
    record: { id: 7, label: 'changed during response' },
  };
  expect(() => resolved.assertCurrent()).toThrow('source entity changed');
  answer.totalMembers = 2;
  await expect(
    resolveSyncableRule(store, { ...options, resource: 'task' }),
  ).rejects.toThrow('ambiguous');
});
