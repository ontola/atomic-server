// @wc-ignore-file
import { afterEach, expect, it, vi } from 'vitest';
import {
  CollectionBuilder,
  core,
  dataBrowser,
  server,
  type Resource,
  type Store,
} from '@tomic/lib';
import { readSelectionKey, type ReadSelection } from 'syncables/browser';
import {
  entitySourceKey,
  entityTableKey,
  ruleSourceKey,
} from './builtinSyncIdentity.js';
import {
  openFlatSyncableRow,
  saveFlatSyncableSelection,
} from './syncableFlatNavigation';

const p = Object.fromEntries(
  [
    'syncable-source-config',
    'syncable-source-key',
    'syncable-entity-table',
    'syncable-navigation-intents',
    'syncable-node-kind',
    'syncable-rule-memberships',
  ].map(name => [name, 'atomic:' + name]),
);
vi.mock('@tomic/lib', async original => ({
  ...(await original<typeof import('@tomic/lib')>()),
  findSchema: async () => ({ properties: p }),
}));
afterEach(() => vi.restoreAllMocks());
const principal = { kind: 'public' as const };
const scope = {
  proxyOrigin: 'https://proxy.example',
  platform: 'work-tracker',
  principal,
};
const read = {
  collection: 'workspaces',
  resource: 'workspace',
  path: '/workspaces',
  method: 'GET' as const,
  pathParams: {},
  query: {},
  body: {},
};
const entity = {
  resource: 'workspace',
  template: '/workspaces/{id}',
  values: [['id', 7] as [string, number]],
  path: '/workspaces/7',
  key: JSON.stringify(['workspace', '/workspaces/{id}', [['id', 7]]]),
};
const definition: ReadSelection = {
  version: 1,
  resource: 'workspace',
  source: { kind: 'bound', bound: read },
};
const related: ReadSelection = {
  version: 1,
  resource: 'task',
  source: {
    kind: 'related',
    origin: {
      entity,
      record: { id: 7, name: 'Field team' },
      context: {},
      read,
    },
    via: { collection: 'tasks', kind: 'identity' },
  },
};

function fixture(queryGate?: () => Promise<void>) {
  const saved = vi.fn(async () => undefined);
  const session = {
    actor: 'atomic:agent:current',
    server: 'https://node.example',
  };
  const values = new Map<string, Record<string, unknown>>();
  const source = {
    version: 3,
    kind: 'collection',
    ...scope,
    resource: 'workspace',
  };
  const targetSource = { ...source, resource: 'task' };
  const tableKey = entityTableKey(source);
  const rowKey = entitySourceKey({ ...scope, entityIdentity: entity });
  values.set('atomic:drive', {});
  values.set('atomic:principal', { [core.properties.parent]: 'atomic:drive' });
  values.set('atomic:workspaces', {
    [core.properties.parent]: 'atomic:principal',
    [core.properties.isA]: [dataBrowser.classes.table],
    [core.properties.classtype]: 'atomic:workspace-class',
    [p['syncable-source-config']]: source,
    [p['syncable-source-key']]: tableKey,
    [dataBrowser.properties.tableViews]: ['atomic:rule'],
  });
  values.set('atomic:tasks', {
    [core.properties.parent]: 'atomic:principal',
    [core.properties.isA]: [dataBrowser.classes.table],
    [p['syncable-source-config']]: targetSource,
    [p['syncable-source-key']]: entityTableKey(targetSource),
  });
  values.set('atomic:row', {
    [core.properties.parent]: 'atomic:workspaces',
    [core.properties.isA]: ['atomic:workspace-class'],
    [core.properties.name]: 'Field team',
    [p['syncable-entity-table']]: 'atomic:workspaces',
    [p['syncable-source-key']]: rowKey,
    [p['syncable-source-config']]: {
      ...source,
      kind: 'record',
      entityIdentity: entity,
      record: { id: 7, name: 'Latest field team' },
      context: {},
      read,
    },
    [p['syncable-rule-memberships']]: ['atomic:rule'],
    [p['syncable-navigation-intents']]: [
      {
        version: 1,
        resource: 'task',
        sourceEntityKey: rowKey,
        label: 'Tasks',
        definition: related,
      },
    ],
  });
  values.set('atomic:rule', {
    [core.properties.parent]: 'atomic:workspaces',
    [core.properties.isA]: [dataBrowser.classes.view],
    [core.properties.name]: 'Selected workspaces',
    [p['syncable-source-config']]: {
      version: 3,
      kind: 'rule',
      resource: 'workspace',
      definition,
      ruleKey: readSelectionKey(definition),
    },
  });
  const wrap = (subject: string): Resource =>
    ({
      subject,
      error: undefined,
      get: (key: string) => values.get(subject)?.[key],
      getSubjects: (key: string) => values.get(subject)?.[key] ?? [],
      hasClasses: (klass: string) =>
        (
          (values.get(subject)?.[core.properties.isA] as string[]) ?? []
        ).includes(klass),
      save: saved,
      set: async (
        key: string,
        value: unknown,
        _validate?: boolean,
        _datatype?: unknown,
        before?: () => void,
      ) => {
        before?.();
        values.get(subject)![key] = value;
      },
      push: async (key: string, added: string[]) => {
        const row = values.get(subject)!;
        row[key] = [...((row[key] as string[]) ?? []), ...added];
      },
    }) as unknown as Resource;
  const resources = new Map(
    [...values.keys()].map(subject => [subject, wrap(subject)]),
  );
  const store = {
    resources,
    getServerUrl: () => session.server,
    getAgent: () => ({ subject: session.actor }),
    getDrive: () => 'atomic:drive',
    normalizeSubject: (subject: string) => subject,
    getResource: async (subject: string) => wrap(subject),
    newResource: vi.fn(
      async (input: {
        parent: string;
        isA: string;
        propVals: Record<string, unknown>;
      }) => {
        const subject = 'atomic:saved-rule';
        values.set(subject, {
          [core.properties.parent]: input.parent,
          [core.properties.isA]: [input.isA],
          ...input.propVals,
        });
        resources.set(subject, wrap(subject));

        return wrap(subject);
      },
    ),
  } as unknown as Store;
  vi.spyOn(CollectionBuilder.prototype, 'build').mockImplementation(
    function (this: CollectionBuilder) {
      const params = (
        this as unknown as { params: { property: string; value: string } }
      ).params;
      const matching = [...values]
        .filter(([, record]) => record[params.property] === params.value)
        .map(([subject]) => subject);

      return {
        waitForReady: async () => {
          if (queryGate && params.value.includes('\"kind\":\"rule\"'))
            await queryGate();
        },
        totalMembers: matching.length,
        getAllMembers: async () => matching,
        getMemberWithIndex: async (index: number) => {
          if (index >= matching.length) throw new Error('Index out of bounds');

          return matching[index];
        },
      } as never;
    },
  );

  return {
    saved,
    session,
    store,
    values,
    table: wrap('atomic:workspaces'),
    row: wrap('atomic:row'),
  };
}

it('opens a declared relationship as an idempotent sibling filter without provider reads', async () => {
  const { store, table, row, values } = fixture();
  const before = values.size;
  const target = await openFlatSyncableRow(store, 'atomic:drive', table, row);
  expect(target).toEqual({
    subject: 'atomic:tasks',
    view: 'atomic:saved-rule',
    syncFilter: 'atomic:saved-rule',
  });
  const saved = values.get('atomic:saved-rule')!;
  const config = saved[p['syncable-source-config']] as {
    definition: ReadSelection;
    ruleKey: string;
  };
  expect(config.definition.source).toMatchObject({
    kind: 'related',
    origin: { record: { name: 'Latest field team' } },
  });
  expect(saved[p['syncable-source-key']]).toBe(
    ruleSourceKey(
      entityTableKey({ ...scope, resource: 'task' }),
      config.ruleKey,
    ),
  );
  expect(values.size).toBe(before + 1);
  expect(await openFlatSyncableRow(store, 'atomic:drive', table, row)).toEqual(
    target,
  );
  expect(values.size).toBe(before + 1);
});

it('retains the selected scope when opening one entity and refuses removed memberships', async () => {
  const { store, table, row, values } = fixture();
  await openFlatSyncableRow(store, 'atomic:drive', table, row, 'atomic:rule');
  const config = values.get('atomic:saved-rule')![
    p['syncable-source-config']
  ] as { definition: ReadSelection };
  expect(config.definition.source).toMatchObject({
    kind: 'fanout',
    from: definition,
    entities: [entity],
  });
  values.get('atomic:row')![p['syncable-rule-memberships']] = [];
  await expect(
    openFlatSyncableRow(store, 'atomic:drive', table, row, 'atomic:rule'),
  ).rejects.toThrow('selected filter');
});

it('refuses another principal target and ambiguous canonical tables without writing', async () => {
  const { store, table, values } = fixture();
  values.set('atomic:duplicate', { ...values.get('atomic:tasks') });
  await expect(
    saveFlatSyncableSelection(store, 'atomic:drive', table, related, 'Tasks'),
  ).rejects.toThrow('ambiguous');
  expect(store.newResource).not.toHaveBeenCalled();
  values.delete('atomic:duplicate');
  const target = values.get('atomic:tasks')!;
  target[p['syncable-source-config']] = {
    ...(target[p['syncable-source-config']] as Record<string, unknown>),
    principal: {
      kind: 'authenticated',
      namespace: 'https://identity.example',
      subject: 7,
    },
    connectionId: 'a'.repeat(43),
  };
  await expect(
    saveFlatSyncableSelection(store, 'atomic:drive', table, related, 'Tasks'),
  ).rejects.toThrow('changed');
  expect(store.newResource).not.toHaveBeenCalled();
});

it.each(['account', 'target move', 'source definition'])(
  'revokes a delayed native Open after %s changes',
  async change => {
    let release!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>(resolve => {
      entered = resolve;
    });
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const { store, values, table, session } = fixture(async () => {
      entered();
      await gate;
    });
    const operation = saveFlatSyncableSelection(
      store,
      'atomic:drive',
      table,
      related,
      'Tasks',
    );
    await waiting;
    if (change === 'account') session.actor = 'atomic:agent:another';
    else if (change === 'target move')
      values.get('atomic:tasks')![core.properties.parent] = 'atomic:elsewhere';
    else
      values.get('atomic:workspaces')![p['syncable-source-config']] = {
        version: 3,
        kind: 'collection',
        ...scope,
        resource: 'other',
      };
    release();
    await expect(operation).rejects.toThrow(/changed|outside|selected drive/);
    expect(store.newResource).not.toHaveBeenCalled();
  },
);

it.each(['account', 'target move'])(
  'rechecks %s after asynchronous resource initialization before saving',
  async change => {
    const { store, values, table, session, saved } = fixture();
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const waiting = new Promise<void>(resolve => {
      entered = resolve;
    });
    const create = vi.mocked(store.newResource).getMockImplementation()!;
    vi.mocked(store.newResource).mockImplementation(async input => {
      const row = await create(input);
      entered();
      await gate;

      return row;
    });
    const operation = saveFlatSyncableSelection(
      store,
      'atomic:drive',
      table,
      related,
      'Tasks',
    );
    await waiting;
    if (change === 'account') session.actor = 'atomic:agent:another';
    else
      values.get('atomic:tasks')![core.properties.parent] = 'atomic:elsewhere';
    release();
    await expect(operation).rejects.toThrow();
    expect(saved).not.toHaveBeenCalled();
    expect(
      values.get('atomic:tasks')![dataBrowser.properties.tableViews],
    ).toBeUndefined();
  },
);

it('opens the same logical destination after it was moved elsewhere in the same drive', async () => {
  const { store, table, row, values } = fixture();
  values.get('atomic:tasks')![core.properties.parent] = 'atomic:drive';
  await expect(
    openFlatSyncableRow(store, 'atomic:drive', table, row),
  ).resolves.toEqual({
    subject: 'atomic:tasks',
    view: 'atomic:saved-rule',
    syncFilter: 'atomic:saved-rule',
  });
  expect(values.get('atomic:tasks')![core.properties.parent]).toBe(
    'atomic:drive',
  );
  expect(store.newResource).toHaveBeenCalledTimes(1);
});

it('opens its cached target despite a matching unstamped table in another Drive without provider access', async () => {
  const { store, table, values } = fixture();
  const otherDrive = 'atomic:other-drive';
  values.set(otherDrive, { [core.properties.isA]: [server.classes.drive] });
  values.set('atomic:foreign-tasks', {
    ...values.get('atomic:tasks'),
    [core.properties.parent]: otherDrive,
  });
  const remote = vi.fn(() => {
    throw new Error('Cached native Open must stay offline');
  });
  Object.assign(store, { fetchResourceFromServer: remote, noServer: true });
  expect(
    await saveFlatSyncableSelection(
      store,
      'atomic:drive',
      table,
      related,
      'Tasks',
    ),
  ).toMatchObject({ subject: 'atomic:tasks' });
  values.set('atomic:foreign-rule', {
    ...values.get('atomic:saved-rule'),
    [core.properties.parent]: 'atomic:foreign-tasks',
  });
  expect(
    await saveFlatSyncableSelection(
      store,
      'atomic:drive',
      table,
      related,
      'Tasks',
    ),
  ).toMatchObject({ subject: 'atomic:tasks', view: 'atomic:saved-rule' });
  expect(store.newResource).toHaveBeenCalledTimes(1);
  expect(remote).not.toHaveBeenCalled();
});

it('refuses an unproven target query member instead of treating it as foreign absence', async () => {
  const { store, table, values } = fixture();
  values.set('atomic:unknown-tasks', {
    ...values.get('atomic:tasks'),
    [core.properties.parent]: 'atomic:missing-parent',
  });
  await expect(
    saveFlatSyncableSelection(store, 'atomic:drive', table, related, 'Tasks'),
  ).rejects.toThrow('ancestry');
  expect(store.newResource).not.toHaveBeenCalled();
});
