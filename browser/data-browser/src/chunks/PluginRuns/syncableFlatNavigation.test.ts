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
  resolveFlatSyncableRowActions,
  resolveFlatSyncableRecordActions,
  saveFlatSyncableSelection,
} from './syncableFlatNavigation';
import { resolveSyncableRule } from './syncableRules';
import { assertSyncAppDrive } from './builtinSyncablesProfile';

const p = Object.fromEntries(
  [
    'syncable-source-config',
    'syncable-source-key',
    'syncable-collection-view',
    'syncable-entity-table',
    'syncable-navigation-intents',
    'syncable-node-kind',
    'syncable-mirror-status',
    'syncable-rule-memberships',
  ].map(name => [name, 'atomic:' + name]),
);
vi.mock('@tomic/lib', async original => ({
  ...(await original<typeof import('@tomic/lib')>()),
  findSchema: async () => ({
    properties: p,
    classes: { 'syncable-reference': 'atomic:reference' },
  }),
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
    writable: true,
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
    [p['syncable-collection-view']]: {
      version: 1,
      rowClass: 'atomic:workspace-class',
      title: 'Workspaces',
      columns: [{ property: core.properties.name, label: 'Name' }],
      relationships: [
        {
          resource: 'task',
          title: 'Tasks',
          via: { collection: 'tasks', kind: 'identity' },
        },
      ],
    },
    [p['syncable-source-config']]: source,
    [p['syncable-source-key']]: tableKey,
    [dataBrowser.properties.tableViews]: ['atomic:rule'],
  });
  values.set('atomic:tasks', {
    [core.properties.parent]: 'atomic:principal',
    [core.properties.isA]: [dataBrowser.classes.table],
    [p['syncable-source-config']]: targetSource,
    [core.properties.classtype]: 'atomic:task-class',
    [p['syncable-collection-view']]: {
      version: 1,
      rowClass: 'atomic:task-class',
      title: 'Tasks',
      columns: [{ property: core.properties.name, label: 'Name' }],
      relationships: [],
    },
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
    [p['syncable-source-key']]: ruleSourceKey(
      tableKey,
      readSelectionKey(definition),
    ),
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
      canWrite: async () => [session.writable, undefined],
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
    getResource: async (subject: string) => {
      const resource = wrap(subject);
      resources.set(subject, resource);

      return resource;
    },
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

it('requires native target write rights before allocating a saved filter', async () => {
  const { store, table, row, session, values } = fixture();
  session.writable = false;
  const before = JSON.stringify([...values]);
  await expect(
    openFlatSyncableRow(store, 'atomic:drive', table, row),
  ).rejects.toThrow('Write access');
  expect(store.newResource).not.toHaveBeenCalled();
  expect(JSON.stringify([...values])).toBe(before);
});

it('opens an embedded summary as stored data without claiming collection-read provenance', async () => {
  const { store, table, row, values } = fixture();
  const config = values.get('atomic:row')![
    p['syncable-source-config']
  ] as Record<string, unknown>;
  delete config.read;
  expect(await openFlatSyncableRow(store, 'atomic:drive', table, row)).toEqual({
    subject: row.subject,
  });
  expect(store.newResource).not.toHaveBeenCalled();
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

it.each(['account', 'target move', 'target class', 'source definition'])(
  'rejects saving a delayed native filter after %s changes',
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
    else if (change === 'target class')
      values.get('atomic:tasks')![core.properties.isA] = [
        dataBrowser.classes.view,
      ];
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

function addEntityTable(
  values: Map<string, Record<string, unknown>>,
  resource: string,
  relationships: unknown[] = [],
) {
  const subject = 'atomic:' + resource;
  values.set(subject, {
    [core.properties.parent]: 'atomic:principal',
    [core.properties.isA]: [dataBrowser.classes.table],
    [core.properties.classtype]: 'atomic:' + resource + '-class',
    [p['syncable-source-config']]: {
      version: 3,
      kind: 'collection',
      ...scope,
      resource,
    },
    [p['syncable-source-key']]: entityTableKey({ ...scope, resource }),
    [p['syncable-collection-view']]: {
      version: 1,
      rowClass: 'atomic:' + resource + '-class',
      title: resource,
      columns: [{ property: core.properties.name, label: 'Name' }],
      relationships,
    },
  });

  return subject;
}

function twoHopFixture(queryGate?: () => Promise<void>) {
  const set = fixture(queryGate);
  const descriptor = set.values.get('atomic:tasks')![
    p['syncable-collection-view']
  ] as { relationships: unknown[] };
  descriptor.relationships = [
    {
      resource: 'comment',
      title: 'Comments',
      via: { collection: 'taskComments', kind: 'identity' },
    },
  ];
  addEntityTable(set.values, 'comment');

  return set;
}

it('resolves all actions through stored data without writes, provider reads or parent-dependent ownership', async () => {
  const { store, row, values, saved } = fixture();
  values.get('atomic:row')![core.properties.parent] = 'atomic:drive';
  const before = JSON.stringify([...values]);
  const remote = vi.fn(() => {
    throw new Error('Provider access is forbidden');
  });
  Object.assign(store, { fetchResourceFromServer: remote });
  const resolved = await resolveFlatSyncableRecordActions(
    store,
    'atomic:drive',
    row,
  );
  expect(resolved?.table.subject).toBe('atomic:workspaces');
  expect(resolved?.actions).toMatchObject([
    { label: 'Tasks', targetResource: 'task' },
  ]);
  expect(JSON.stringify([...values])).toBe(before);
  expect(store.newResource).not.toHaveBeenCalled();
  expect(saved).not.toHaveBeenCalled();
  expect(remote).not.toHaveBeenCalled();
});

it('checks every direct intent against its descriptor and supports an explicitly chosen second action', async () => {
  const { store, row, table, values } = fixture();
  addEntityTable(values, 'project');
  const descriptor = values.get(table.subject)![
    p['syncable-collection-view']
  ] as { relationships: unknown[] };
  descriptor.relationships.push({
    resource: 'project',
    title: 'Projects',
    via: { collection: 'projects', kind: 'identity' },
  });
  const intents = values.get(row.subject)![
    p['syncable-navigation-intents']
  ] as Record<string, unknown>[];
  const project = structuredClone(intents[0]);
  project.resource = 'project';
  project.label = 'Projects';
  const selection = project.definition as ReadSelection;
  selection.resource = 'project';
  if (selection.source.kind === 'related')
    selection.source.via.collection = 'projects';
  intents.push(
    { ...project, definition: { ...selection, resource: 'unapproved' } },
    project,
    structuredClone(project),
  );
  const actions = await resolveFlatSyncableRowActions(
    store,
    'atomic:drive',
    table,
    row,
  );
  expect(actions.map(action => action.label)).toEqual(['Tasks', 'Projects']);
  const target = await openFlatSyncableRow(
    store,
    'atomic:drive',
    table,
    row,
    undefined,
    actions[1].id,
  );
  expect(target).toMatchObject({ subject: 'atomic:project' });
  expect(
    (
      values.get('atomic:saved-rule')![p['syncable-source-config']] as {
        resource: string;
      }
    ).resource,
  ).toBe('project');
});

it('ignores descriptor-mismatched direct evidence and rejects stale requested actions', async () => {
  const { store, row, table, values } = fixture();
  const [action] = await resolveFlatSyncableRowActions(
    store,
    'atomic:drive',
    table,
    row,
  );
  (
    values.get(table.subject)![p['syncable-collection-view']] as {
      relationships: unknown[];
    }
  ).relationships = [];
  expect(
    await resolveFlatSyncableRowActions(store, 'atomic:drive', table, row),
  ).toEqual([]);
  await expect(
    openFlatSyncableRow(
      store,
      'atomic:drive',
      table,
      row,
      undefined,
      action.id,
    ),
  ).rejects.toThrow('no longer available');
  expect(store.newResource).not.toHaveBeenCalled();
});

it('reuses the exact attached saved filter without source or target write access', async () => {
  const { store, row, table, session, saved } = fixture();
  const first = await openFlatSyncableRow(store, 'atomic:drive', table, row);
  session.writable = false;
  saved.mockClear();
  expect(await openFlatSyncableRow(store, 'atomic:drive', table, row)).toEqual(
    first,
  );
  expect(store.newResource).toHaveBeenCalledTimes(1);
  expect(saved).not.toHaveBeenCalled();
});

it('composes Organizations → Repositories → Issues from declared relationships without enumerating cached entities', async () => {
  const { store, row, table, values } = fixture();
  const org = { ...entity, resource: 'organization' };
  org.key = JSON.stringify([org.resource, org.template, org.values]);
  const source = {
    version: 3,
    kind: 'collection',
    ...scope,
    resource: 'organization',
  };
  const rowKey = entitySourceKey({ ...scope, entityIdentity: org });
  Object.assign(values.get(table.subject)!, {
    [p['syncable-source-config']]: source,
    [p['syncable-source-key']]: entityTableKey(source),
    [p['syncable-collection-view']]: {
      version: 1,
      rowClass: 'atomic:workspace-class',
      title: 'Organizations',
      columns: [{ property: core.properties.name, label: 'Name' }],
      relationships: [
        {
          resource: 'repository',
          title: 'Repositories',
          via: { collection: 'orgRepos', kind: 'identity' },
        },
      ],
    },
  });
  const orgRead = { ...read, resource: 'organization' };
  const repos: ReadSelection = {
    version: 1,
    resource: 'repository',
    source: {
      kind: 'related',
      origin: { entity: org, record: { id: 7 }, context: {}, read: orgRead },
      via: { collection: 'orgRepos', kind: 'identity' },
    },
  };
  Object.assign(values.get(row.subject)!, {
    [p['syncable-source-key']]: rowKey,
    [p['syncable-source-config']]: {
      ...source,
      kind: 'record',
      entityIdentity: org,
      record: { id: 7 },
      context: {},
      read: orgRead,
    },
    [p['syncable-navigation-intents']]: [
      {
        version: 1,
        resource: 'repository',
        sourceEntityKey: rowKey,
        label: 'Repositories',
        definition: repos,
      },
    ],
  });
  addEntityTable(values, 'repository', [
    {
      resource: 'issue',
      title: 'Issues',
      via: { collection: 'repoIssues', kind: 'identity' },
    },
  ]);
  addEntityTable(values, 'issue');
  const actions = await resolveFlatSyncableRowActions(
    store,
    'atomic:drive',
    table,
    row,
  );
  expect(actions.map(action => action.label)).toEqual([
    'Repositories',
    'Issues (via Repositories)',
  ]);
  expect(actions[1].definition.source).toMatchObject({
    kind: 'fanout',
    from: repos,
    via: { collection: 'repoIssues' },
  });
  expect(actions[1].definition.source).not.toHaveProperty('entities');
  const result = await openFlatSyncableRow(
    store,
    'atomic:drive',
    table,
    row,
    undefined,
    actions[1].id,
  );
  expect(result).toMatchObject({ subject: 'atomic:issue' });
  expect(values.get('atomic:saved-rule')).not.toHaveProperty(
    p['syncable-mirror-status'],
  );
  expect(values.get(row.subject)![p['syncable-rule-memberships']]).toEqual([
    'atomic:rule',
  ]);
});

it.each(['missing', 'ambiguous', 'foreign', 'other principal', 'incomplete'])(
  'omits the derived action for a %s canonical target without writing',
  async condition => {
    const { store, row, table, values } = twoHopFixture();
    if (condition === 'missing') values.delete('atomic:comment');
    if (condition === 'ambiguous')
      values.set('atomic:duplicate-comment', {
        ...values.get('atomic:comment'),
      });

    if (condition === 'foreign') {
      values.set('atomic:other-drive', {
        [core.properties.isA]: [server.classes.drive],
      });
      values.get('atomic:comment')![core.properties.parent] =
        'atomic:other-drive';
    }

    if (condition === 'other principal') {
      (
        values.get('atomic:comment')![p['syncable-source-config']] as Record<
          string,
          unknown
        >
      ).principal = {
        kind: 'authenticated',
        namespace: 'https://identity.example',
        subject: 8,
      };
    }

    if (condition === 'incomplete') {
      const original = vi
        .mocked(CollectionBuilder.prototype.build)
        .getMockImplementation()!;
      vi.mocked(CollectionBuilder.prototype.build).mockImplementation(
        function (this: CollectionBuilder) {
          const result = original.call(this);
          const params = (this as unknown as { params: { value: string } })
            .params;
          if (
            params.value === entityTableKey({ ...scope, resource: 'comment' })
          )
            Object.assign(result, { totalMembers: 2 });

          return result;
        },
      );
    }

    const actions = await resolveFlatSyncableRowActions(
      store,
      'atomic:drive',
      table,
      row,
    );
    expect(actions.map(action => action.label)).toEqual(['Tasks']);
    expect(store.newResource).not.toHaveBeenCalled();
  },
);

it('stops at depth two, ignores cycles and deduplicates repeated selections', async () => {
  const { store, row, table, values } = twoHopFixture();
  const tasks = values.get('atomic:tasks')![p['syncable-collection-view']] as {
    relationships: unknown[];
  };
  tasks.relationships.push({
    resource: 'workspace',
    title: 'Back to workspaces',
    via: { collection: 'workspaces', kind: 'identity' },
  });
  const comments = values.get('atomic:comment')![
    p['syncable-collection-view']
  ] as { relationships: unknown[] };
  comments.relationships.push({
    resource: 'reaction',
    title: 'Reactions',
    via: { collection: 'reactions', kind: 'identity' },
  });
  addEntityTable(values, 'reaction');
  const intents = values.get(row.subject)![
    p['syncable-navigation-intents']
  ] as unknown[];
  intents.push(structuredClone(intents[0]));
  const actions = await resolveFlatSyncableRowActions(
    store,
    'atomic:drive',
    table,
    row,
  );
  expect(actions.map(action => action.label)).toEqual([
    'Tasks',
    'Comments (via Tasks)',
  ]);
});

it.each(['descriptor', 'row evidence', 'account'])(
  'revokes an explicit two-hop action when %s changes while its filter lookup is pending',
  async change => {
    let release!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>(resolve => {
      entered = resolve;
    });
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const { store, row, table, values, session } = twoHopFixture(async () => {
      entered();
      await gate;
    });
    const action = (
      await resolveFlatSyncableRowActions(store, 'atomic:drive', table, row)
    )[1];
    const operation = openFlatSyncableRow(
      store,
      'atomic:drive',
      table,
      row,
      undefined,
      action.id,
    );
    await waiting;
    if (change === 'descriptor')
      (
        values.get('atomic:tasks')![p['syncable-collection-view']] as {
          relationships: unknown[];
        }
      ).relationships = [];
    if (change === 'row evidence')
      values.get(row.subject)![p['syncable-navigation-intents']] = [];
    if (change === 'account') session.actor = 'atomic:agent:another';
    release();
    await expect(operation).rejects.toThrow(/changed/);
    expect(store.newResource).not.toHaveBeenCalled();
  },
);

it('keeps allocations bounded by target rights without requiring source write rights', async () => {
  const { store, row, table } = fixture();
  const sourcePermission = vi
    .spyOn(table, 'canWrite')
    .mockResolvedValue([false, undefined]);
  expect(
    await openFlatSyncableRow(store, 'atomic:drive', table, row),
  ).toMatchObject({ subject: 'atomic:tasks' });
  expect(sourcePermission).not.toHaveBeenCalled();
});

it('does not follow an external logical-table pointer when opening a stored resource', async () => {
  const { store, row, values } = fixture();
  values.get(row.subject)![p['syncable-entity-table']] =
    'https://provider.example/repos';
  const get = vi.spyOn(store, 'getResource');
  await expect(
    resolveFlatSyncableRecordActions(store, 'atomic:drive', row),
  ).rejects.toThrow('another server');
  expect(get).not.toHaveBeenCalledWith('https://provider.example/repos');
});

it('does not derive cycles, self relationships or a third navigation hop', async () => {
  const { store, row, table, values } = twoHopFixture();
  const middle = values.get('atomic:tasks')![p['syncable-collection-view']] as {
    relationships: unknown[];
  };
  middle.relationships.push(
    {
      resource: 'workspace',
      title: 'Workspaces',
      via: { collection: 'workspaces', kind: 'identity' },
    },
    {
      resource: 'task',
      title: 'Tasks',
      via: { collection: 'tasks', kind: 'identity' },
    },
  );
  (
    values.get('atomic:comment')![p['syncable-collection-view']] as {
      relationships: unknown[];
    }
  ).relationships = [
    {
      resource: 'attachment',
      title: 'Attachments',
      via: { collection: 'attachments', kind: 'identity' },
    },
  ];
  addEntityTable(values, 'attachment');
  const actions = await resolveFlatSyncableRowActions(
    store,
    'atomic:drive',
    table,
    row,
  );
  expect(actions.map(action => action.targetResource)).toEqual([
    'task',
    'comment',
  ]);
});

it('rechecks a selected intermediate descriptor while saving a two-hop filter', async () => {
  let entered!: () => void;
  let release!: () => void;
  const waiting = new Promise<void>(resolve => {
    entered = resolve;
  });
  const gate = new Promise<void>(resolve => {
    release = resolve;
  });
  const { store, row, table, values } = fixture(async () => {
    entered();
    await gate;
  });
  (
    values.get('atomic:tasks')![p['syncable-collection-view']] as {
      relationships: unknown[];
    }
  ).relationships = [
    {
      resource: 'comment',
      title: 'Comments',
      via: { collection: 'taskComments', kind: 'identity' },
    },
  ];
  addEntityTable(values, 'comment');
  const actions = await resolveFlatSyncableRowActions(
    store,
    'atomic:drive',
    table,
    row,
  );
  const operation = openFlatSyncableRow(
    store,
    'atomic:drive',
    table,
    row,
    undefined,
    actions[1].id,
  );
  await waiting;
  (
    values.get('atomic:tasks')![p['syncable-collection-view']] as {
      relationships: unknown[];
    }
  ).relationships = [];
  release();
  await expect(operation).rejects.toThrow('relationships changed');
  expect(store.newResource).not.toHaveBeenCalled();
});

it('reuses a saved filter already attached under its legacy subject alias without requiring a grant', async () => {
  const { store, row, table, values, session, saved } = fixture();
  const first = await openFlatSyncableRow(store, 'atomic:drive', table, row);
  values.get('atomic:tasks')![dataBrowser.properties.tableViews] = [
    'did:ad:saved-rule',
  ];
  session.writable = false;
  saved.mockClear();
  expect(await openFlatSyncableRow(store, 'atomic:drive', table, row)).toEqual(
    first,
  );
  expect(saved).not.toHaveBeenCalled();
  expect(
    values.get('atomic:tasks')![dataBrowser.properties.tableViews],
  ).toEqual(['did:ad:saved-rule']);
});

it.each(['embedded object', 'scalar reference'])(
  'offers reference-origin actions only for a %s with stored raw data',
  async kind => {
    const { store, row, values, saved } = fixture();
    const raw = values.get(row.subject)!;
    raw[core.properties.isA] = ['atomic:reference'];
    const config = raw[p['syncable-source-config']] as Record<string, unknown>;
    delete config.read;
    if (kind === 'scalar reference') config.record = {};
    const before = JSON.stringify([...values]);
    const resolved = await resolveFlatSyncableRecordActions(
      store,
      'atomic:drive',
      row,
    );
    expect(resolved?.table.subject).toBe('atomic:workspaces');
    expect(resolved?.actions.map(action => action.label)).toEqual(
      kind === 'embedded object' ? ['Tasks'] : [],
    );
    if (kind === 'embedded object')
      expect(resolved?.actions[0].definition.source).toMatchObject({
        kind: 'related',
        origin: { entity, record: config.record },
      });
    expect(JSON.stringify(resolved?.actions)).not.toContain('"read":');
    expect(JSON.stringify([...values])).toBe(before);
    expect(store.newResource).not.toHaveBeenCalled();
    expect(saved).not.toHaveBeenCalled();
  },
);

it.each([false, true])(
  'lazily derives direct and two-hop candidates for existing reference summaries (full API class: %s)',
  async fullClass => {
    const { store, row, table, values, session, saved } = fixture();
    const raw = values.get(row.subject)!;
    raw[core.properties.isA] = [
      'atomic:reference',
      ...(fullClass ? ['atomic:workspace-class'] : []),
    ];
    delete (raw[p['syncable-source-config']] as Record<string, unknown>).read;
    delete raw[p['syncable-navigation-intents']];
    delete raw[p['syncable-rule-memberships']];
    const descriptor = values.get('atomic:tasks')![
      p['syncable-collection-view']
    ] as { relationships: unknown[] };
    descriptor.relationships = [
      {
        resource: 'note',
        title: 'Notes',
        via: { collection: 'taskNotes', kind: 'identity' },
      },
    ];
    addEntityTable(values, 'note');
    const before = JSON.stringify([...values]);
    const actions = await resolveFlatSyncableRowActions(
      store,
      'atomic:drive',
      table,
      row,
    );
    expect(actions.map(action => action.label)).toEqual([
      'Tasks',
      'Notes (via Tasks)',
    ]);
    expect(JSON.stringify(actions)).not.toContain('"read":');
    expect(JSON.stringify([...values])).toBe(before);
    expect(saved).not.toHaveBeenCalled();
    const destination = await openFlatSyncableRow(
      store,
      'atomic:drive',
      table,
      row,
      undefined,
      actions[1].id,
    );
    expect(destination?.subject).toBe('atomic:note');
    if (!destination || !('syncFilter' in destination))
      throw new Error('Expected a saved navigation filter');
    const savedDefinition = (
      values.get('atomic:saved-rule')![p['syncable-source-config']] as {
        definition: ReadSelection;
      }
    ).definition;
    expect(savedDefinition).toEqual(actions[1].definition);
    session.writable = false;
    saved.mockClear();
    expect(
      await openFlatSyncableRow(
        store,
        'atomic:drive',
        table,
        row,
        undefined,
        actions[1].id,
      ),
    ).toEqual(destination);
    expect(saved).not.toHaveBeenCalled();
    const prepared = await resolveSyncableRule(store, {
      drive: 'atomic:drive',
      table: destination!.subject,
      subject: destination.syncFilter,
      ...scope,
      resource: 'note',
      properties: p,
      assertCurrent: () => {},
      assertDrive: subject =>
        assertSyncAppDrive(store, 'atomic:drive', subject),
    });
    expect(prepared.definition).toEqual(savedDefinition);
    expect(prepared.origins).toHaveLength(1);
    expect(Object.hasOwn(prepared.origins[0], 'read')).toBe(false);
    expect(prepared.origins[0].record).toEqual(
      (raw[p['syncable-source-config']] as Record<string, unknown>).record,
    );
    expect(raw[p['syncable-rule-memberships']]).toBeUndefined();
    expect(
      (raw[p['syncable-source-config']] as Record<string, unknown>).read,
    ).toBeUndefined();
    await expect(
      openFlatSyncableRow(store, 'atomic:drive', table, row, 'atomic:rule'),
    ).rejects.toThrow('selected filter');
  },
);

it.each(['missing', 'ambiguous', 'foreign'])(
  'withholds reference candidates for a %s target',
  async kind => {
    const { store, row, table, values } = fixture();
    const raw = values.get(row.subject)!;
    raw[core.properties.isA] = ['atomic:reference'];
    delete (raw[p['syncable-source-config']] as Record<string, unknown>).read;
    delete raw[p['syncable-navigation-intents']];
    if (kind === 'missing') values.delete('atomic:tasks');
    if (kind === 'ambiguous')
      values.set('atomic:duplicate', { ...values.get('atomic:tasks') });
    if (kind === 'foreign')
      values.get('atomic:tasks')!['https://atomicdata.dev/properties/drive'] =
        'atomic:other-drive';
    expect(
      await resolveFlatSyncableRowActions(store, 'atomic:drive', table, row),
    ).toEqual([]);
    expect(store.newResource).not.toHaveBeenCalled();
  },
);

it.each(['empty', 'malformed', 'ordinary'])(
  'does not replace %s navigation evidence with reference candidates',
  async kind => {
    const { store, row, table, values } = fixture();
    const raw = values.get(row.subject)!;
    raw[core.properties.isA] =
      kind === 'ordinary' ? ['atomic:workspace-class'] : ['atomic:reference'];
    delete (raw[p['syncable-source-config']] as Record<string, unknown>).read;
    if (kind === 'ordinary') delete raw[p['syncable-navigation-intents']];
    else
      raw[p['syncable-navigation-intents']] = kind === 'empty' ? [] : 'invalid';
    expect(
      await resolveFlatSyncableRowActions(store, 'atomic:drive', table, row),
    ).toEqual([]);
    expect(store.newResource).not.toHaveBeenCalled();
  },
);

it.each(['principal', 'source key', 'Drive', 'unrelated class'])(
  'still rejects a reference summary with corrupt %s evidence',
  async corruption => {
    const { store, row, values } = fixture();
    const raw = values.get(row.subject)!;
    raw[core.properties.isA] = ['atomic:reference'];
    const config = raw[p['syncable-source-config']] as Record<string, unknown>;
    delete config.read;
    if (corruption === 'principal')
      config.principal = {
        kind: 'authenticated',
        namespace: 'https://identity.example',
        subject: 8,
      };
    if (corruption === 'source key') raw[p['syncable-source-key']] = 'invalid';
    if (corruption === 'Drive')
      raw['https://atomicdata.dev/properties/drive'] = 'atomic:other-drive';
    if (corruption === 'unrelated class')
      raw[core.properties.isA] = ['atomic:unrelated'];
    await expect(
      resolveFlatSyncableRecordActions(store, 'atomic:drive', row),
    ).rejects.toThrow();
    expect(store.newResource).not.toHaveBeenCalled();
  },
);

function addOrdinaryTableView(values: Map<string, Record<string, unknown>>) {
  values.get('atomic:tasks')![dataBrowser.properties.tableViews] = [
    'atomic:table-view',
  ];
  values.set('atomic:table-view', {
    [core.properties.parent]: 'atomic:tasks',
    [core.properties.isA]: [dataBrowser.classes.view],
    [core.properties.name]: 'My table',
    [dataBrowser.properties.viewKind]: 'table',
  });
}

it('returns the ordinary Table presentation with the same saved filter identity', async () => {
  const { store, row, table, values } = fixture();
  addOrdinaryTableView(values);
  const first = await openFlatSyncableRow(store, 'atomic:drive', table, row);
  expect(first).toEqual({
    subject: 'atomic:tasks',
    view: 'atomic:table-view',
    syncFilter: 'atomic:saved-rule',
  });
  expect(
    values.get('atomic:saved-rule')![dataBrowser.properties.viewKind],
  ).toBe('table');
  expect(await openFlatSyncableRow(store, 'atomic:drive', table, row)).toEqual(
    first,
  );
  expect(store.newResource).toHaveBeenCalledTimes(1);
});

it.each(['target move', 'source descriptor'])(
  'rechecks %s while an ordinary Table View read is pending',
  async change => {
    const { store, row, table, values } = fixture();
    addOrdinaryTableView(values);
    let entered!: () => void;
    let release!: () => void;
    const waiting = new Promise<void>(resolve => {
      entered = resolve;
    });
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const get = store.getResource.bind(store);
    vi.spyOn(store, 'getResource').mockImplementation(async subject => {
      const resource = await get(subject);

      if (subject === 'atomic:table-view') {
        entered();
        await gate;
      }

      return resource;
    });
    const operation = openFlatSyncableRow(store, 'atomic:drive', table, row);
    await waiting;
    if (change === 'target move')
      values.get('atomic:tasks')![core.properties.parent] = 'atomic:drive';
    else
      (
        values.get(table.subject)![p['syncable-collection-view']] as {
          relationships: unknown[];
        }
      ).relationships = [];
    release();
    await expect(operation).rejects.toThrow(/changed/);
  },
);

it('skips external and invalid stored View pointers before resource reads', async () => {
  const { store, row, table, values } = fixture();
  addOrdinaryTableView(values);
  values.get('atomic:tasks')![dataBrowser.properties.tableViews] = [
    'https://provider.example/view',
    '//provider.example/view',
    'invalid',
    'atomic:table-view',
  ];
  const get = vi.spyOn(store, 'getResource');
  expect(
    await openFlatSyncableRow(store, 'atomic:drive', table, row),
  ).toMatchObject({ view: 'atomic:table-view' });
  for (const subject of [
    'https://provider.example/view',
    '//provider.example/view',
    'invalid',
  ])
    expect(get).not.toHaveBeenCalledWith(subject);
});

it('does not prefer a View detached or reparented during its read', async () => {
  const { store, row, table, values } = fixture();
  addOrdinaryTableView(values);
  const get = store.getResource.bind(store);
  vi.spyOn(store, 'getResource').mockImplementation(async subject => {
    const resource = await get(subject);
    if (subject === 'atomic:table-view')
      values.get(subject)![core.properties.parent] = 'atomic:other-table';

    return resource;
  });
  expect(
    await openFlatSyncableRow(store, 'atomic:drive', table, row),
  ).toMatchObject({
    view: 'atomic:saved-rule',
    syncFilter: 'atomic:saved-rule',
  });
});
