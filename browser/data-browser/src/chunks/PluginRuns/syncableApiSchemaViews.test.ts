import { afterEach, describe, expect, it, vi } from 'vitest';
import { core, dataBrowser, server, type Store } from '@tomic/lib';
import { entityTableKey } from './builtinSyncIdentity.js';
import {
  migrateSyncableApiViews,
  replaceSyncableViewColumns,
} from './syncableApiSchemaViews';

const mocks = vi.hoisted(() => ({ query: vi.fn(), schema: vi.fn() }));
vi.mock('@tomic/lib', async original => ({
  ...(await original<typeof import('@tomic/lib')>()),
  readConnectionSubjects: mocks.query,
  findSchema: mocks.schema,
}));
afterEach(() => vi.clearAllMocks());
const configProperty = 'atomic:source-config';
const keyProperty = 'atomic:source-key';
const raw = 'atomic:owner-json';
const link = 'atomic:repository-owner-link';
const apiSchema = {
  classes: { repository: 'atomic:repository-class' },
  properties: { owner: raw },
  resourceProperties: { repository: { owner: link } },
};
const replacements = new Map([[raw, link]]);

describe('positional property replacement', () => {
  it('keeps custom/virtual keys and order, deduplicating managed replacement collisions', () => {
    expect(
      replaceSyncableViewColumns(
        ['atomic:custom', raw, 'derived:days', link, raw, 'row-action:done'],
        replacements,
      ),
    ).toEqual(['atomic:custom', link, 'derived:days', 'row-action:done']);
  });
  it('retains hidden columns, empty defaults, absence and malformed settings', () => {
    for (const input of [
      undefined,
      [],
      ['atomic:custom'],
      [1],
      { columns: raw },
    ])
      expect(replaceSyncableViewColumns(input, replacements)).toBe(input);
  });
  it('does not rewrite unrelated duplicate keys or cascade replacements', () => {
    expect(
      replaceSyncableViewColumns(
        ['x', 'x', raw],
        new Map([
          [raw, link],
          [link, 'atomic:other'],
        ]),
      ),
    ).toEqual(['x', 'x', link]);
  });
});

function fixture() {
  let actor = 'atomic:agent';
  const source = {
    version: 3,
    kind: 'collection',
    proxyOrigin: 'https://proxy.example',
    platform: 'service',
    principal: { kind: 'public' as const },
    resource: 'repository',
  };
  const records = new Map<string, Record<string, unknown>>([
    [
      'atomic:drive',
      {
        [core.properties.isA]: [server.classes.drive],
        [dataBrowser.properties.trashFolder]: 'atomic:trash',
      },
    ],
    ['atomic:trash', { [core.properties.parent]: 'atomic:drive' }],
    ['atomic:other-drive', { [core.properties.isA]: [server.classes.drive] }],
    [
      'atomic:table',
      {
        [core.properties.parent]: 'atomic:drive',
        [core.properties.isA]: [dataBrowser.classes.table],
        [core.properties.classtype]: apiSchema.classes.repository,
        [configProperty]: source,
        [keyProperty]: entityTableKey(source),
        [dataBrowser.properties.tableViews]: ['atomic:view'],
        [dataBrowser.properties.tableDefaultView]: 'atomic:view',
        [dataBrowser.properties.tableColumnWidths]: [80, 150, 90],
      },
    ],
    [
      'atomic:view',
      {
        [core.properties.parent]: 'atomic:table',
        [core.properties.isA]: [dataBrowser.classes.view],
        [dataBrowser.properties.viewColumns]: [
          'atomic:name',
          raw,
          'atomic:custom',
        ],
        [dataBrowser.properties.viewColumnOrder]: [
          'row-action:done',
          raw,
          'atomic:name',
          'derived:days',
        ],
        [dataBrowser.properties.viewSortBy]: raw,
        [dataBrowser.properties.viewFilters]: [
          { property: raw, value: '{"id":7}' },
        ],
      },
    ],
  ]);
  const resources = new Map();
  const hooks: {
    canWrite?: () => void;
    beforeSet?: () => void;
  } = {};
  const writes = vi.fn();
  const saves = vi.fn();
  let writable = true;
  const wrap = (subject: string) => ({
    subject,
    get: (property: string) => records.get(subject)?.[property],
    getSubjects: (property: string) => records.get(subject)?.[property] ?? [],
    hasClasses: (type: string) =>
      (
        records.get(subject)?.[core.properties.isA] as string[] | undefined
      )?.includes(type),
    canWrite: vi.fn(async () => {
      hooks.canWrite?.();

      return [writable];
    }),
    set: vi.fn(async (property, value, _validate, _datatype, guard) => {
      hooks.beforeSet?.();
      guard();
      writes(subject, property, value);
      records.get(subject)![property] = value;
    }),
    save: vi.fn(async () => {
      saves(subject);
    }),
  });
  for (const subject of records.keys()) resources.set(subject, wrap(subject));
  const store = {
    resources,
    getAgent: () => ({ subject: actor }),
    getServerUrl: () => 'https://node.example',
    normalizeSubject: (subject: string) => subject,
    getResource: vi.fn(async (subject: string) => {
      if (!records.has(subject)) throw new Error('Missing resource');
      if (!resources.has(subject)) resources.set(subject, wrap(subject));

      return resources.get(subject);
    }),
  } as unknown as Store;
  mocks.schema.mockResolvedValue({
    properties: {
      'syncable-source-config': configProperty,
      'syncable-source-key': keyProperty,
    },
  });
  mocks.query.mockResolvedValue(['atomic:table']);
  const run = () =>
    migrateSyncableApiViews(store, 'atomic:drive', apiSchema, vi.fn());

  return {
    records,
    store,
    resources,
    hooks,
    writes,
    saves,
    run,
    readOnly: () => {
      writable = false;
    },
    changeActor: () => {
      actor = 'atomic:other-agent';
    },
  };
}

it('migrates both saved positions once and preserves raw filters, sorting and positional widths', async () => {
  const f = fixture();
  await f.run();
  const view = f.records.get('atomic:view')!;
  expect(view[dataBrowser.properties.viewColumns]).toEqual([
    'atomic:name',
    link,
    'atomic:custom',
  ]);
  expect(view[dataBrowser.properties.viewColumnOrder]).toEqual([
    'row-action:done',
    link,
    'atomic:name',
    'derived:days',
  ]);
  expect(view[dataBrowser.properties.viewSortBy]).toBe(raw);
  expect(view[dataBrowser.properties.viewFilters]).toEqual([
    { property: raw, value: '{"id":7}' },
  ]);
  expect(
    f.records.get('atomic:table')![dataBrowser.properties.tableColumnWidths],
  ).toEqual([80, 150, 90]);
  expect(f.saves).toHaveBeenCalledTimes(1);
  await f.run();
  expect(f.saves).toHaveBeenCalledTimes(1);
  expect(mocks.query).toHaveBeenCalledWith(
    f.store,
    'atomic:drive',
    core.properties.classtype,
    apiSchema.classes.repository,
    { includeTrashed: true },
  );
});

it('includes the default View even when absent from tableViews', async () => {
  const f = fixture();
  f.records.get('atomic:table')![dataBrowser.properties.tableViews] = [];
  await f.run();
  expect(f.saves).toHaveBeenCalledWith('atomic:view');
});

it('leaves read-only Views and config-absent ordinary Tables unchanged', async () => {
  const f = fixture();
  f.readOnly();
  await f.run();
  expect(f.writes).not.toHaveBeenCalled();
  delete f.records.get('atomic:table')![configProperty];
  await f.run();
  expect(f.writes).not.toHaveBeenCalled();
});

it('leaves valid V2 source views available for later flat adoption', async () => {
  const f = fixture();
  f.records.get('atomic:table')![configProperty] = {
    version: 2,
    proxyOrigin: 'https://proxy.example',
    platform: 'service',
    principal: { kind: 'public' },
    collection: {
      collection: 'repositories',
      resource: 'repository',
      path: '/repositories',
      method: 'GET',
      pathParams: {},
      query: {},
      body: {},
    },
  };
  await f.run();
  expect(f.writes).not.toHaveBeenCalled();
});

it('skips proven foreign Drive matches and retained Trash without treating unknown ancestry as absent', async () => {
  const f = fixture();
  f.records.get('atomic:table')![core.properties.parent] = 'atomic:other-drive';
  await f.run();
  expect(f.writes).not.toHaveBeenCalled();
  f.records.get('atomic:table')![core.properties.parent] = 'atomic:trash';
  await f.run();
  expect(f.writes).not.toHaveBeenCalled();
  f.records.get('atomic:table')![core.properties.parent] = 'atomic:missing';
  await expect(f.run()).rejects.toThrow('Missing resource');
  expect(f.writes).not.toHaveBeenCalled();
});

it('rejects foreign default URLs before fetching and malformed table identities', async () => {
  const f = fixture();
  f.records.get('atomic:table')![dataBrowser.properties.tableDefaultView] =
    'https://foreign.example/view';
  await expect(f.run()).rejects.toThrow('another server');
  expect(f.store.getResource).not.toHaveBeenCalledWith(
    'https://foreign.example/view',
  );
  delete f.records.get('atomic:table')![
    dataBrowser.properties.tableDefaultView
  ];
  f.records.get('atomic:table')![keyProperty] = 'forged';
  await expect(f.run()).rejects.toThrow();
  expect(f.writes).not.toHaveBeenCalled();
});

it.each(['table-config', 'class', 'parent', 'columns', 'actor'])(
  'rejects %s changing across awaited write checks',
  async change => {
    const f = fixture();

    f.hooks.canWrite = () => {
      if (change === 'table-config')
        f.records.get('atomic:table')![configProperty] = {};
      if (change === 'class')
        f.records.get('atomic:table')![core.properties.classtype] =
          'atomic:other-class';
      if (change === 'parent')
        f.records.get('atomic:view')![core.properties.parent] = 'atomic:drive';
      if (change === 'columns')
        f.records.get('atomic:view')![dataBrowser.properties.viewColumns] = [
          'user-chosen',
        ];
      if (change === 'actor') f.changeActor();
    };

    await expect(f.run()).rejects.toThrow('changed');
    expect(f.writes).not.toHaveBeenCalled();
    expect(f.saves).not.toHaveBeenCalled();
  },
);

it('guards the actual set mutation after awaited Property validation', async () => {
  const f = fixture();

  f.hooks.beforeSet = () => {
    f.records.get('atomic:view')![core.properties.parent] = 'atomic:drive';
  };

  await expect(f.run()).rejects.toThrow('changed');
  expect(f.writes).not.toHaveBeenCalled();
});
