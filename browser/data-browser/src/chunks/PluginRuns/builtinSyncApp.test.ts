// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import {
  bindCollection,
  deriveOntology,
  prepareDocument,
  type OpenApiDocument,
} from 'syncables/browser';
import {
  createSyncApp,
  view,
  // @ts-expect-error The server-delivered JavaScript module has no declarations.
} from './builtinSyncApp.js';
import {
  collectionIdentity,
  sourceKey,
  sourceConfigFingerprint,
} from './builtinSyncIdentity.js';

const P = 'https://atomicdata.dev/properties/';
const tableClass = 'https://atomicdata.dev/classes/Table';
const root = 'atomic:root';
const origin = 'https://integrations.example';
const principal = {
  kind: 'authenticated' as const,
  namespace: 'https://identity.example',
  subject: 7,
};
const properties = Object.fromEntries(
  [
    'source-config',
    'source-key',
    'node-kind',
    'collection-view',
    'open-target',
    'mirror-status',
  ].map(name => ['syncable-' + name, 'atomic:' + name]),
);
const classes = {
  'syncable-principal': 'atomic:principal',
  'syncable-record': 'atomic:record',
};
const prop = (name: string) => properties['syncable-' + name];

/** An unrelated provider with a mutable address, response Link, direct child and public input. */
function apiDocument(): OpenApiDocument {
  const operation = (resource: string, collection?: string) => ({
    operationId: collection ?? resource + 'Detail',
    ...(collection
      ? {
          parameters: [
            { name: 'page', in: 'query', schema: { type: 'integer' } },
          ],
        }
      : {}),
    'x-crud': {
      action: collection ? 'list' : 'read',
      resource,
      ...(collection ? { collection } : {}),
    },
    ...(collection ? { 'x-pagination': [{ scheme: 'pages' }] } : {}),
    responses: {
      '200': {
        description: 'Result',
        content: {
          'application/json': {
            schema: {
              type: collection ? 'array' : 'object',
              ...(collection ? { items: { type: 'object' } } : {}),
            },
          },
        },
      },
    },
  });

  return prepareDocument({
    openapi: '3.0.3',
    info: { title: 'Example service', version: '1' },
    servers: [{ url: 'https://api.example/v2' }],
    components: {
      crudResources: {
        team: {
          schema: {
            type: 'object',
            title: 'Teams',
            properties: {
              id: { type: 'integer' },
              name: { type: 'string' },
              handle: { type: 'string' },
            },
          },
          identity: {
            urlTemplate: '/teams/{team_id}',
            bindings: { team_id: { field: 'id' } },
          },
          references: {
            address: {
              resource: 'teamAddress',
              bindings: { handle: { field: 'handle' } },
            },
          },
          collections: { myTeams: { urlTemplate: '/me/teams' } },
        },
        teamAddress: {
          identity: {
            urlTemplate: '/names/{handle}',
            bindings: { handle: { field: 'handle' } },
          },
        },
        workspace: {
          schema: {
            type: 'object',
            title: 'Workspaces',
            properties: {
              id: { type: 'integer' },
              name: { type: 'string', title: 'Workspace' },
              updated_at: { type: 'string', format: 'date-time' },
              active: {
                type: 'boolean',
                oneOf: [
                  { enum: [true], title: 'Active' },
                  { enum: [false], title: 'Inactive' },
                ],
              },
            },
          },
          identity: {
            urlTemplate: '/workspaces/{workspace_id}',
            bindings: { workspace_id: { field: 'id' } },
          },
          collections: {
            myWorkspaces: { urlTemplate: '/me/workspaces' },
            teamWorkspaces: { urlTemplate: '/names/{handle}/workspaces' },
          },
        },
        task: {
          schema: {
            type: 'object',
            title: 'Tasks',
            properties: {
              id: { type: 'string' },
              name: { type: 'string' },
            },
          },
          identity: {
            urlTemplate: '/workspaces/{workspace_id}/tasks/{task_id}',
            bindings: { task_id: { field: 'id' } },
          },
          collections: {
            tasks: {
              urlTemplate: '/workspaces/{workspace_id}/tasks',
              listQuery: { status: 'all' },
            },
          },
        },
      },
      paginationSchemes: {
        pages: {
          type: 'nextLink',
          request: { queryParameters: { limit: { role: 'pageSize' } } },
          response: { headers: { Link: { role: 'nextLink' } } },
        },
      },
    },
    paths: {
      '/session': {
        get: {
          operationId: 'currentPrincipal',
          security: [{ oauth: [] }],
          'x-authenticated-principal': {
            kind: 'user',
            namespace: principal.namespace,
            subject: '$response.body#/id',
            identifier: { scope: 'provider', stable: true, reassigned: false },
            claims: { name: '$response.body#/label' },
          },
          responses: { '200': { description: 'Current principal' } },
        },
      },
      '/me/teams': { get: operation('team', 'myTeams') },
      '/me/workspaces': { get: operation('workspace', 'myWorkspaces') },
      '/names/{handle}': {
        get: {
          ...operation('teamAddress'),
          responses: {
            '200': {
              description: 'Team address',
              links: {
                workspaces: {
                  operationId: 'teamWorkspaces',
                  parameters: { handle: '$response.body#/handle' },
                },
              },
            },
          },
        },
      },
      '/names/{handle}/workspaces': {
        get: operation('workspace', 'teamWorkspaces'),
      },
      '/workspaces/{workspace_id}/tasks': {
        get: {
          ...operation('task', 'tasks'),
          parameters: [
            {
              name: 'workspace_id',
              in: 'path',
              required: true,
              schema: { type: 'integer', title: 'Workspace ID' },
            },
            { name: 'status', in: 'query', schema: { type: 'string' } },
            { name: 'page', in: 'query', schema: { type: 'integer' } },
          ],
        },
      },
    },
  });
}

type Stored = Record<string, unknown>;
type Request = {
  path: string;
  connectionId?: string;
  method?: string;
  query?: Record<string, string>;
  body?: string;
};
const team = { id: 100, name: 'A team', handle: 'old-handle' };
const workspace = {
  id: 200,
  name: 'A workspace',
  updated_at: '2026-11-19T10:00:00Z',
  active: true,
};

function withPublicEntrypoint() {
  const document = apiDocument();
  const resources = document.components!.crudResources as Record<
    string,
    unknown
  >;
  resources.workspaceAddress = {
    identity: {
      urlTemplate: '/public/{team}/{space}',
      bindings: { team: { field: 'team' }, space: { field: 'space' } },
    },
  };
  document.paths['/public/{team}/{space}'] = {
    get: {
      operationId: 'publicWorkspace',
      security: [],
      'x-crud': { action: 'read', resource: 'workspaceAddress' },
      parameters: [
        {
          name: 'team',
          in: 'path',
          required: true,
          schema: { type: 'string', title: 'Team reference' },
        },
        {
          name: 'space',
          in: 'path',
          required: true,
          schema: { type: 'string', title: 'Workspace reference' },
        },
      ],
      responses: {
        '200': {
          description: 'A workspace',
          links: {
            tasks: {
              operationId: 'tasks',
              parameters: { workspace_id: '$response.body#/id' },
            },
          },
        },
      },
    },
  } as never;

  return document;
}

function setup(kind = 'collection', extra: Record<string, unknown> = {}) {
  const document = apiDocument();
  const apiSchema = {
    classes: Object.fromEntries(
      deriveOntology(document)
        .terms.filter(term => term.kind === 'class')
        .map(term => [term.shortname, 'atomic:api-class-' + term.shortname]),
    ),
    properties: Object.fromEntries(
      deriveOntology(document)
        .terms.filter(term => term.kind === 'property')
        .map(term => [term.shortname, 'atomic:api-property-' + term.shortname]),
    ),
  };
  const data = new Map<string, Stored>([[root, { [P + 'isA']: [tableClass] }]]);
  let sequence = 0;
  const resource = (subject: string) => ({
    subject,
    get: (property: string) => data.get(subject)?.[property],
    hasClasses: (...wanted: string[]) =>
      wanted.every(klass =>
        ((data.get(subject)?.[P + 'isA'] ?? []) as string[]).includes(klass),
      ),
    set(property: string, value: unknown) {
      data.get(subject)![property] = value;

      return this;
    },
    remove(property: string) {
      delete data.get(subject)![property];

      return this;
    },
    save: vi.fn(async () => undefined),
  });
  const context = {
    subject: root,
    drive: 'atomic:drive',
    proxyOrigin: origin,
    platform: 'example-service',
    kind,
    principal,
    connectionId: 'slot',
    document,
    schema: { properties, classes },
    apiSchema,
    collection: bindCollection(document, { collection: 'myTeams' }),
    ...extra,
  };
  const request = vi.fn(async ({ path }: Request) => ({
    status: 200,
    headers: {} as Record<string, string>,
    body: (path === 'v2/session'
      ? { id: 7, label: 'Ada' }
      : path === 'v2/me/teams'
        ? [team]
        : path === 'v2/names/old-handle'
          ? { handle: 'new-handle' }
          : path.endsWith('/workspaces')
            ? [workspace]
            : [{ id: 'task-1', name: 'A task' }]) as unknown,
  }));
  const store = {
    getContext: vi.fn(async () => context),
    getResource: vi.fn(async (subject: string) => resource(subject)),
    getMany: vi.fn(async (subjects: string[]) => subjects.map(resource)),
    query: vi.fn(
      async ({
        property,
        value,
        page = 0,
        pageSize = 500,
      }: {
        property: string;
        value: unknown;
        page?: number;
        pageSize?: number;
      }) =>
        [...data]
          .filter(([, props]) => props[property] === value)
          .map(([subject]) => subject)
          .slice(page * pageSize, (page + 1) * pageSize),
    ),
    newResource: vi.fn(
      async ({
        parent,
        isA,
        propVals,
      }: {
        parent: string;
        isA: string[];
        propVals: Stored;
      }) => {
        const subject = 'atomic:created-' + ++sequence;
        data.set(subject, {
          [P + 'parent']: parent,
          [P + 'isA']: isA,
          ...propVals,
        });

        return resource(subject);
      },
    ),
    proxy: {
      request,
      connections: vi.fn(async () => [
        { connectionId: 'slot', platform: 'example-service' },
      ]),
      connect: vi.fn(),
    },
    ui: { openResource: vi.fn() },
    execution: vi.fn(async () => ({ running: false })),
  };

  return { data, store, context, request, app: createSyncApp(store, context) };
}

const nodes = (data: Map<string, Stored>, kind: string) =>
  [...data].filter(([, props]) => props[prop('node-kind')] === kind);
const config = (row: Stored) =>
  row[prop('source-config')] as Record<string, unknown>;

function childApp(set: ReturnType<typeof setup>, subject: string) {
  const saved = set.data.get(subject)!;

  return createSyncApp(set.store, {
    ...set.context,
    ...config(saved),
    subject,
    kind: saved[prop('node-kind')],
    sourceKey: saved[prop('source-key')],
  });
}

describe('catalog-driven Sync through the shared app bridge', () => {
  it.each(['principal', 'collection'])(
    'opens %s using saved state without provider reads',
    async kind => {
      const { store, request } = setup(kind);
      const rootElement = document.createElement('div');
      await view({ root: rootElement, store });
      expect(request).not.toHaveBeenCalled();
      expect(store.execution).not.toHaveBeenCalledWith('start');
      expect(rootElement.querySelector('table')).toBeNull();
    },
  );

  it('populates newly connected principals on App entry using identity reads only', async () => {
    const set = setup('platform');
    const element = document.createElement('div');
    await view({ root: element, store: set.store });
    expect(set.request.mock.calls.map(([call]) => call.path)).toEqual([
      'v2/session',
    ]);
    expect(nodes(set.data, 'principal')).toHaveLength(2);
    expect(
      [...element.querySelectorAll('button')].filter(
        button => button.textContent === 'Public',
      ),
    ).toHaveLength(1);
    expect(nodes(set.data, 'record')).toHaveLength(0);
    expect(set.store.execution).not.toHaveBeenCalledWith('start');
  });

  it('keeps Public and connection controls available when a principal cannot be resolved', async () => {
    const set = setup('platform');
    set.request.mockResolvedValue({ status: 503, headers: {}, body: null });
    const element = document.createElement('div');
    await view({ root: element, store: set.store });
    expect(element.querySelector('[role="alert"]')?.textContent).toContain(
      '503',
    );
    expect(element.textContent).toContain('Connect account');
    expect(element.textContent).toContain('Public');
    expect(set.request.mock.calls.map(([request]) => request.path)).toEqual([
      'v2/session',
    ]);
  });

  it('resolves a real principal and provisions only catalog root collections without eager reads', async () => {
    const set = setup('platform');
    const first = await set.app.openPrincipal('slot');
    expect(set.request.mock.calls.map(([call]) => call.path)).toEqual([
      'v2/session',
    ]);
    expect(nodes(set.data, 'principal')).toHaveLength(1);
    expect(set.data.get(first.subject)?.[P + 'name']).toBe('Ada');
    expect(
      nodes(set.data, 'collection').map(
        ([, row]) =>
          (config(row).collection as { collection: string }).collection,
      ),
    ).toEqual(['myTeams', 'myWorkspaces']);
    expect(nodes(set.data, 'record')).toHaveLength(0);
    const count = set.data.size;
    await set.app.openPrincipal('another-connection');
    expect(set.data.size).toBe(count);
    expect(config(set.data.get(first.subject)!).connectionId).toBe(
      'another-connection',
    );
  });

  it('preserves typed principals and keeps Public separate from authenticated namespaces', async () => {
    const set = setup('platform');
    await set.app.openPrincipal('slot');
    set.request.mockResolvedValueOnce({
      status: 200,
      headers: {},
      body: { id: '7', label: 'Ada' },
    });
    await set.app.openPrincipal('slot');
    const calls = set.request.mock.calls.length;
    await set.app.openPublic();
    expect(set.request).toHaveBeenCalledTimes(calls);
    expect(nodes(set.data, 'principal')).toHaveLength(3);
    expect(
      new Set(
        nodes(set.data, 'principal').map(([, row]) => row[prop('source-key')]),
      ).size,
    ).toBe(3);

    for (const [, row] of nodes(set.data, 'collection')) {
      if ((config(row).principal as { kind: string }).kind === 'public')
        expect(config(row).connectionId).toBeUndefined();
    }
  });

  it('creates saved child navigation during explicit Sync and reads only the selected root collection', async () => {
    const set = setup();
    expect(await set.app.refresh()).toMatchObject({
      added: 1,
      rows: 1,
      incomplete: false,
    });
    expect(set.request.mock.calls.map(([call]) => call.path)).toEqual([
      'v2/me/teams',
    ]);
    const [rowSubject, row] = nodes(set.data, 'record')[0];
    const [childSubject, child] = nodes(set.data, 'collection')[0];
    expect(child[P + 'parent']).toBe(rowSubject);
    expect(row[prop('open-target')]).toBe(childSubject);
    expect(config(child).navigation).toMatchObject({
      kind: 'responseLink',
      collection: 'teamWorkspaces',
    });
    expect(set.data.get(root)![prop('collection-view')]).toMatchObject({
      rowClass: set.context.apiSchema.classes.team,
      title: 'Teams',
      columns: expect.arrayContaining([
        { property: set.context.apiSchema.properties.name, label: 'name' },
      ]),
    });
  });

  it('executes a catalog-declared POST list read through the same shared bridge', async () => {
    const document = apiDocument();
    const definition = (
      document.components!.crudResources as Record<
        string,
        { collections: Record<string, unknown> }
      >
    ).team;
    definition.collections.myTeams = {
      urlTemplate: '/me/teams',
      listMethod: 'POST',
      listBody: { filter: 'all' },
    };
    const path = document.paths['/me/teams'];
    path.post = path.get;
    delete path.get;
    const set = setup('collection', {
      document,
      collection: bindCollection(document, { collection: 'myTeams' }),
    });
    expect(await set.app.refresh()).toMatchObject({ added: 1 });
    expect(set.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'POST',
        path: 'v2/me/teams',
        body: JSON.stringify({ filter: 'all' }),
      }),
    );
  });

  it('resolves the source detail Link only during child Sync and never reads sibling collections', async () => {
    const set = setup();
    await set.app.refresh();
    const [childSubject] = nodes(set.data, 'collection')[0];
    set.request.mockClear();
    const child = childApp(set, childSubject);
    expect(await child.refresh()).toMatchObject({ added: 1 });
    expect(set.request.mock.calls.map(([call]) => call.path)).toEqual([
      'v2/names/old-handle',
      'v2/names/new-handle/workspaces',
    ]);
    expect(nodes(set.data, 'collection')).toHaveLength(2);
    const tasks = nodes(set.data, 'collection').find(
      ([, row]) =>
        (config(row).navigation as { collection: string }).collection ===
        'tasks',
    )![1];
    expect(config(tasks).navigation).toMatchObject({
      kind: 'direct',
      bound: { path: '/workspaces/200/tasks' },
    });
    expect(set.data.get(childSubject)![prop('collection-view')]).toMatchObject({
      columns: expect.arrayContaining([
        {
          property: set.context.apiSchema.properties.active,
          label: 'active',
          format: 'enum',
          labels: { true: 'Active', false: 'Inactive' },
        },
        {
          property: set.context.apiSchema.properties['updated-at'],
          label: 'updated_at',
        },
      ]),
    });
  });

  it('keeps every nested storage lookup within the existing bridge query limit', async () => {
    const set = setup();
    const query = set.store.query.getMockImplementation()!;
    set.store.query.mockImplementation(async args => {
      if (typeof args.value === 'string' && args.value.length > 2000)
        throw new Error('value must be text of at most 2000 characters');

      return query(args);
    });
    await set.app.refresh();
    const [workspaces] = nodes(set.data, 'collection')[0];
    await childApp(set, workspaces).refresh();
    const [tasks] = nodes(set.data, 'collection').find(
      ([, row]) =>
        (config(row).navigation as { collection: string }).collection ===
        'tasks',
    )!;
    await childApp(set, tasks).refresh();
    expect(nodes(set.data, 'record')).toHaveLength(3);

    for (const [, row] of nodes(set.data, 'record')) {
      const key = row[prop('source-key')] as string;
      expect(key.length).toBeLessThanOrEqual(2000);
      expect(JSON.parse(key).parentSourceKeyHash).toBe(
        sourceConfigFingerprint(config(row).parentSourceKey),
      );
      expect(typeof config(row).parentSourceKey).toBe('string');
    }
  });

  it('refreshes mutable navigation addresses without changing child table identity', async () => {
    const set = setup();
    await set.app.refresh();
    const [childSubject, child] = nodes(set.data, 'collection')[0];
    const key = child[prop('source-key')];
    const localId = child[P + 'localId'];
    set.request.mockResolvedValue({
      status: 200,
      headers: {},
      body: [{ ...team, handle: 'renamed' }],
    });
    await set.app.refresh();
    expect(nodes(set.data, 'collection')).toHaveLength(1);
    expect(child[prop('source-key')]).toBe(key);
    expect(child[P + 'localId']).toBe(localId);
    expect(config(set.data.get(childSubject)!).navigation).toMatchObject({
      source: { path: '/names/renamed' },
    });
  });

  it('upserts typed fields idempotently and preserves user values and subjects', async () => {
    const set = setup();
    await set.app.refresh();
    const [rowSubject, row] = nodes(set.data, 'record')[0];
    row['atomic:user-note'] = 'Keep this';
    const localId = row[P + 'localId'];
    const before = set.data.size;
    expect(await set.app.refresh()).toMatchObject({
      unchanged: 1,
      added: 0,
      changed: 0,
    });
    expect(set.data.size).toBe(before);
    set.request.mockResolvedValue({
      status: 200,
      headers: {},
      body: [{ ...team, name: 'Renamed' }],
    });
    expect(await set.app.refresh()).toMatchObject({ changed: 1 });
    expect(set.data.get(rowSubject)).toMatchObject({
      [P + 'name']: 'Renamed',
      'atomic:user-note': 'Keep this',
      [P + 'localId']: localId,
    });
  });

  it('uses a declared string column label when the library falls back to an ID', async () => {
    const set = setup();
    set.request.mockResolvedValue({
      status: 200,
      headers: {},
      body: [{ id: 100, handle: 'catalog-label' }],
    });
    await set.app.refresh();
    expect(nodes(set.data, 'record')[0][1][P + 'name']).toBe('catalog-label');
  });

  it('blocks new destinations while historical sources need review', async () => {
    const set = setup('principal', { legacyMigrationBlocked: true });
    await expect(set.app.createCollection('myTeams')).rejects.toThrow(
      'historical source warnings',
    );
    expect(set.store.newResource).not.toHaveBeenCalled();
  });

  it('clears null or absent previously managed fields while preserving user properties', async () => {
    const set = setup('collection', {
      collection: bindCollection(apiDocument(), { collection: 'myWorkspaces' }),
    });
    await set.app.refresh();
    const [, row] = nodes(set.data, 'record')[0];
    row['atomic:user-note'] = 'Keep this';
    set.request.mockResolvedValue({
      status: 200,
      headers: {},
      body: [{ id: 200, name: 'A workspace', active: null }],
    });
    expect(await set.app.refresh()).toMatchObject({ changed: 1 });
    expect(row[set.context.apiSchema.properties.active]).toBeUndefined();
    expect(row[set.context.apiSchema.properties['updated-at']]).toBeUndefined();
    expect(row['atomic:user-note']).toBe('Keep this');
    expect(await set.app.refresh()).toMatchObject({ unchanged: 1 });
  });

  it('retains stable rows after same-drive moves without writing outside the selected root', async () => {
    const set = setup();
    await set.app.refresh();
    const [, row] = nodes(set.data, 'record')[0];
    row[P + 'parent'] = 'atomic:another-parent';
    const before = set.data.size;
    set.request.mockResolvedValue({
      status: 200,
      headers: {},
      body: [{ ...team, name: 'Remote update' }],
    });
    expect(await set.app.refresh()).toMatchObject({ added: 0 });
    expect(set.data.size).toBe(before);
    expect(row[P + 'name']).toBe(team.name);
    expect(row[P + 'parent']).toBe('atomic:another-parent');
  });

  it('adopts canonical source format through explicit aliases while preserving subject and local ID', async () => {
    const set = setup();
    await set.app.refresh();
    const [subject, row] = nodes(set.data, 'record')[0];
    const current = row[prop('source-key')] as string;
    row[prop('source-key')] = 'legacy-source-key';
    row[P + 'localId'] = 'legacy-local-id';
    const migrated = createSyncApp(set.store, {
      ...set.context,
      identityAliases: { [current]: ['legacy-source-key'] },
    });
    const count = set.data.size;
    expect(await migrated.refresh()).toMatchObject({ added: 0, changed: 1 });
    expect(set.data.size).toBe(count);
    expect(set.data.get(subject)![P + 'localId']).toBe('legacy-local-id');
    expect(row[prop('source-key')]).toBe(current);
  });

  it('migrates a host-validated principal alias after resolving its real connection identity', async () => {
    const set = setup('platform');
    const subject = 'atomic:legacy-account';
    set.data.set(subject, {
      [P + 'parent']: root,
      [P + 'isA']: ['atomic:old-account'],
      [P + 'localId']: 'old-account-local-id',
      [P + 'name']: 'Custom account title',
      [prop('source-key')]: 'old-source-key',
      [prop('node-kind')]: 'account',
    });
    const app = createSyncApp(set.store, {
      ...set.context,
      legacySources: [
        {
          subject,
          sourceKey: 'old-source-key',
          localId: 'old-account-local-id',
          kind: 'principal',
          connectionId: 'slot',
        },
      ],
    });
    expect((await app.openPrincipal('slot')).subject).toBe(subject);
    const saved = set.data.get(subject)!;
    expect(saved[P + 'localId']).toBe('old-account-local-id');
    expect(saved[P + 'name']).toBe('Custom account title');
    expect(saved[P + 'isA']).toEqual(
      expect.arrayContaining([
        tableClass,
        classes['syncable-principal'],
        'atomic:old-account',
      ]),
    );
    expect(JSON.parse(saved[prop('source-key')] as string)).toMatchObject({
      version: 2,
      kind: 'principal',
      principal: { subject: 7 },
    });
    expect(config(saved).principal).toEqual(principal);
    expect(nodes(set.data, 'principal')).toHaveLength(1);
  });

  it('reuses host-described flat legacy rows without interpreting provider IDs or fields', async () => {
    const set = setup();
    await set.app.refresh();
    const [subject, row] = nodes(set.data, 'record')[0];
    const canonical = row[prop('source-key')] as string;
    const parentSourceKey = config(row).parentSourceKey;
    delete row[prop('source-key')];
    row[P + 'localId'] = 'opaque-legacy-local-id';
    row[P + 'isA'] = ['atomic:legacy-class'];
    row[prop('node-kind')] = 'old-row';
    const app = createSyncApp(set.store, {
      ...set.context,
      legacySources: [
        {
          subject,
          localId: 'opaque-legacy-local-id',
          kind: 'record',
          connectionId: 'slot',
          collection: { name: 'myTeams', resource: 'team' },
          parentSourceKey,
          remoteId: 100,
        },
      ],
    });
    expect(await app.refresh()).toMatchObject({ added: 0, changed: 1 });
    expect(row[prop('source-key')]).toBe(canonical);
    expect(row[P + 'localId']).toBe('opaque-legacy-local-id');
    expect(row[P + 'isA']).toEqual(
      expect.arrayContaining([
        'atomic:legacy-class',
        set.context.apiSchema.classes.team,
      ]),
    );
    expect(nodes(set.data, 'record')).toHaveLength(1);
  });

  it('refuses to duplicate a matching historical destination whose saved identity changed', async () => {
    const set = setup();
    const subject = 'atomic:changed-legacy';
    set.data.set(subject, {
      [P + 'parent']: root,
      [P + 'localId']: 'changed-local-id',
      [prop('source-key')]: 'old-key',
    });
    const parentSourceKey = sourceKey({
      proxyOrigin: origin,
      platform: set.context.platform,
      principal,
      kind: 'collection',
      collection: collectionIdentity(set.context.collection),
    });
    const app = createSyncApp(set.store, {
      ...set.context,
      legacySources: [
        {
          subject,
          sourceKey: 'old-key',
          localId: 'expected-old-local-id',
          kind: 'record',
          connectionId: 'slot',
          collection: { name: 'myTeams', resource: 'team' },
          parentSourceKey,
          remoteId: 100,
        },
      ],
    });
    await expect(app.refresh()).rejects.toThrow('no duplicate was created');
    expect(set.store.newResource).not.toHaveBeenCalled();
  });

  it.each(['configuration', 'identity'])(
    'rechecks a legacy alias %s immediately before adoption',
    async changed => {
      const set = setup();
      const subject = 'atomic:legacy';
      const raw = { slot: 'a' };
      set.data.set(subject, {
        [P + 'parent']: root,
        [P + 'localId']: 'legacy',
        [prop('source-key')]: 'old-key',
        [prop('source-config')]:
          changed === 'configuration' ? { slot: 'b' } : raw,
        'atomic:legacy-identity': changed === 'identity' ? 200 : 100,
      });
      const parentSourceKey = sourceKey({
        proxyOrigin: origin,
        platform: set.context.platform,
        principal,
        kind: 'collection',
        collection: collectionIdentity(set.context.collection),
      });
      const app = createSyncApp(set.store, {
        ...set.context,
        legacySources: [
          {
            subject,
            sourceKey: 'old-key',
            localId: 'legacy',
            kind: 'record',
            connectionId: 'slot',
            collection: { name: 'myTeams', resource: 'team' },
            parentSourceKey,
            remoteId: 100,
            sourceConfigFingerprint: sourceConfigFingerprint(raw),
            remoteIdProperty: 'atomic:legacy-identity',
          },
        ],
      });
      await expect(app.refresh()).rejects.toThrow('no duplicate was created');
      expect(set.store.newResource).not.toHaveBeenCalled();
    },
  );

  it('displays native compatibility warnings without any provider read', async () => {
    const set = setup('principal', {
      legacyWarnings: ['A historical source needs review.'],
    });
    const element = document.createElement('div');
    await view({ root: element, store: set.store });
    expect(element.querySelector('[role="status"]')?.textContent).toBe(
      'A historical source needs review.',
    );
    expect(set.request).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'relocates only an unchanged native-described legacy parent (user moved: %s)',
    async moved => {
      const set = setup('principal');
      const owner = 'atomic:old-owner';
      const userParent = 'atomic:user-parent';
      set.data.set(owner, { [P + 'parent']: root });
      set.data.set(userParent, { [P + 'parent']: root });
      const subject = 'atomic:old-table';
      set.data.set(subject, {
        [P + 'parent']: moved ? userParent : owner,
        [P + 'isA']: [tableClass],
        [P + 'localId']: 'legacy-table',
        [prop('source-key')]: 'old-key',
      });
      const app = createSyncApp(set.store, {
        ...set.context,
        legacySources: [
          {
            subject,
            sourceKey: 'old-key',
            localId: 'legacy-table',
            kind: 'collection',
            connectionId: 'slot',
            collection: { name: 'myTeams', resource: 'team', context: {} },
            previousParent: owner,
            reparentToLogicalParent: true,
          },
        ],
      });
      expect(
        (await app.ensureCollection({ bound: set.context.collection })).subject,
      ).toBe(subject);
      expect(set.data.get(subject)![P + 'parent']).toBe(
        moved ? userParent : root,
      );
      expect(set.data.get(subject)![P + 'localId']).toBe('legacy-table');
    },
  );

  it('uses principal and collection-instance identity to isolate identical remote IDs', async () => {
    const set = setup();
    await set.app.refresh();
    const separate = createSyncApp(set.store, {
      ...set.context,
      principal: { ...principal, subject: '7' },
    });
    expect(await separate.refresh()).toMatchObject({ added: 1 });
    expect(nodes(set.data, 'record')).toHaveLength(2);
  });

  it('rejects conflicting resource classes occupying a source identity', async () => {
    const set = setup();
    await set.app.refresh();
    const [, row] = nodes(set.data, 'record')[0];
    row[P + 'isA'] = ['atomic:unrelated'];
    set.store.newResource.mockClear();
    await expect(set.app.refresh()).rejects.toThrow('identity does not match');
    expect(set.store.newResource).not.toHaveBeenCalled();
  });

  it('keeps accepted prefix rows and earlier success when a later page fails', async () => {
    const set = setup();
    set.data.get(root)![prop('mirror-status')] = {
      lastSuccess: 'earlier complete read',
    };
    set.request.mockResolvedValueOnce({
      status: 200,
      headers: {
        Link: '<https://api.example/v2/me/teams?page=2>; rel="next"',
      },
      body: [team],
    });
    set.request.mockResolvedValueOnce({ status: 503, headers: {}, body: null });
    expect(await set.app.refresh()).toMatchObject({
      added: 1,
      rows: 1,
      incomplete: true,
    });
    expect(await set.app.status()).toMatchObject({
      lastSuccess: 'earlier complete read',
      error: expect.stringContaining('503'),
    });
    expect(nodes(set.data, 'record')).toHaveLength(1);
  });

  it('retains previously stored rows on complete empty reads and provider errors', async () => {
    const set = setup();
    await set.app.refresh();
    set.request.mockResolvedValue({ status: 200, headers: {}, body: [] });
    expect(await set.app.refresh()).toMatchObject({ rows: 0 });
    expect(nodes(set.data, 'record')).toHaveLength(1);
    set.request.mockResolvedValue({ status: 500, headers: {}, body: null });
    await expect(set.app.refresh()).rejects.toThrow('500');
    expect(nodes(set.data, 'record')).toHaveLength(1);
  });

  it('lets the library refuse a foreign next-link without issuing that request', async () => {
    const set = setup();
    set.request.mockResolvedValue({
      status: 200,
      headers: {
        Link: '<https://foreign.example/v2/me/teams?page=2>; rel="next"',
      },
      body: [team],
    });
    expect(await set.app.refresh()).toMatchObject({
      added: 1,
      incomplete: true,
    });
    expect(set.request).toHaveBeenCalledTimes(1);
  });

  it('opens saved controls without metadata and refuses a refresh before network access', async () => {
    const set = setup('collection', { document: undefined });
    const element = document.createElement('div');
    await view({ root: element, store: set.store });
    expect(element.textContent).toContain('Sync now');
    await expect(set.app.refresh()).rejects.toThrow(
      'API description is unavailable',
    );
    expect(set.request).not.toHaveBeenCalled();
  });

  it('refuses paused work before contacting the provider', async () => {
    const set = setup();
    set.data.get(root)![prop('mirror-status')] = { paused: true };
    await expect(set.app.refresh()).rejects.toThrow('Resume');
    expect(set.request).not.toHaveBeenCalled();
  });

  it.each([{ id: null }, { id: 1.5 }, { id: '' }])(
    'rejects an invalid remote identity before storing records %j',
    async invalid => {
      const set = setup();
      set.request.mockResolvedValue({
        status: 200,
        headers: {},
        body: [{ ...team, ...invalid }],
      });
      await expect(set.app.refresh()).rejects.toThrow();
      expect(nodes(set.data, 'record')).toHaveLength(0);
    },
  );

  it('stores timestamp projection as an integer and rejects invalid scalar fields', async () => {
    const doc = apiDocument();
    const set = setup('collection', {
      collection: bindCollection(doc, { collection: 'myWorkspaces' }),
    });
    await set.app.refresh();
    const [, row] = nodes(set.data, 'record')[0];
    expect(row[set.context.apiSchema.properties['updated-at']]).toBe(
      Date.parse(workspace.updated_at),
    );
    set.request.mockResolvedValue({
      status: 200,
      headers: {},
      body: [{ ...workspace, active: 'true' }],
    });
    await expect(set.app.refresh()).rejects.toThrow();
    expect(row[set.context.apiSchema.properties.active]).toBe(true);
  });

  it('validates the accepted snapshot before clearing any previously managed fields', async () => {
    const set = setup('collection', {
      collection: bindCollection(apiDocument(), { collection: 'myWorkspaces' }),
    });
    await set.app.refresh();
    const [, row] = nodes(set.data, 'record')[0];
    set.request.mockResolvedValue({
      status: 200,
      headers: {},
      body: [
        { ...workspace, active: null },
        { ...workspace, id: 201, active: 'invalid' },
      ],
    });
    await expect(set.app.refresh()).rejects.toThrow();
    expect(row[set.context.apiSchema.properties.active]).toBe(true);
    expect((config(row).record as { active: boolean }).active).toBe(true);
    expect(nodes(set.data, 'record')).toHaveLength(1);
  });

  it('loads saved principals from Atomic without resolving connections on reentry', async () => {
    const set = setup('platform');
    const saved = await set.app.openPrincipal('slot');
    set.request.mockClear();
    const element = document.createElement('div');
    await view({ root: element, store: set.store });
    expect(element.textContent).toContain('Ada');
    expect(set.request).not.toHaveBeenCalled();
    expect(
      (await set.app.storedPrincipals()).map(
        (row: { subject: string }) => row.subject,
      ),
    ).toContain(saved.subject);
  });

  it('renders catalog inputs for parameterized public reads and saves a concrete instance without fetching', async () => {
    const set = setup('principal', {
      principal: { kind: 'public' },
      connectionId: undefined,
    });
    const element = document.createElement('div');
    await view({ root: element, store: set.store });
    const select = element.querySelector('select')!;
    select.value = 'tasks';
    select.dispatchEvent(new Event('change'));
    expect(element.querySelector('input')?.getAttribute('aria-label')).toBe(
      'Workspace ID',
    );
    const saved = await set.app.createCollection('tasks', {
      workspace_id: '42',
    });
    expect(config(set.data.get(saved.subject)!).collection).toMatchObject({
      path: '/workspaces/42/tasks',
      query: { status: 'all' },
    });
    expect(set.request).not.toHaveBeenCalled();
  });

  it('resolves a catalog public entrypoint on submit and persists only canonical collection identity', async () => {
    const document = withPublicEntrypoint();
    const set = setup('principal', {
      document,
      principal: { kind: 'public' },
      connectionId: undefined,
    });
    set.request.mockResolvedValue({
      status: 200,
      headers: {},
      body: { id: 42 },
    });
    const element = globalThis.document.createElement('div');
    await view({ root: element, store: set.store });
    const select = element.querySelector(
      'select[aria-label="Collection"]',
    ) as HTMLSelectElement;
    select.value = 'tasks';
    select.dispatchEvent(new Event('change'));
    expect(element.querySelector('input')?.getAttribute('aria-label')).toBe(
      'Team reference',
    );
    expect(set.request).not.toHaveBeenCalled();
    const first = await set.app.createCollection(
      'tasks',
      { team: 'one', space: 'first-name' },
      '/public/{team}/{space}',
    );
    const second = await set.app.createCollection(
      'tasks',
      { team: 'one', space: 'renamed' },
      '/public/{team}/{space}',
    );
    expect(first.subject).toBe(second.subject);
    const row = set.data.get(first.subject)!;
    expect(config(row).collection).toMatchObject({
      path: '/workspaces/42/tasks',
      pathParams: { workspace_id: '42' },
    });
    expect(config(row).navigation).toBeUndefined();
    expect(JSON.parse(row[prop('source-key')] as string).collection).toEqual({
      name: 'tasks',
      resource: 'task',
      context: { workspace_id: '42' },
    });
    expect(set.request.mock.calls.map(([request]) => request.path)).toEqual([
      'v2/public/one/first-name',
      'v2/public/one/renamed',
    ]);
    expect(
      set.request.mock.calls.every(
        ([request]) => request.connectionId === undefined,
      ),
    ).toBe(true);
    set.request.mockResolvedValue({
      status: 200,
      headers: {},
      body: { id: 43 },
    });
    const third = await set.app.createCollection(
      'tasks',
      { team: 'two', space: 'different' },
      '/public/{team}/{space}',
    );
    expect(third.subject).not.toBe(first.subject);
  });

  it('handshakes the shared worker before reading the selected collection', async () => {
    const set = setup('collection', { worker: true });
    await view({ root: undefined, store: set.store });
    expect(set.store.execution).toHaveBeenCalledWith('state');
    expect(set.request).toHaveBeenCalledTimes(1);
  });

  it('keeps durable row keys independent of the Atomic parent and display title', () => {
    const bound = bindCollection(apiDocument(), { collection: 'myTeams' });
    expect(
      JSON.parse(
        sourceKey({
          proxyOrigin: origin,
          platform: 'example-service',
          principal,
          kind: 'collection',
          collection: collectionIdentity(bound),
        }),
      ),
    ).toMatchObject({
      version: 2,
      principal: { subject: 7 },
      collection: { resource: 'team', name: 'myTeams' },
    });
  });
});
