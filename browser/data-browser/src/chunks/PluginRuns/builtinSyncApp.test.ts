// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import {
  bindCollection,
  deriveOntology,
  readSelectionKey,
  prepareDocument,
  resolveEntityIdentity,
  type OpenApiDocument,
} from 'syncables/browser';
import {
  createSyncApp,
  view,
  // @ts-expect-error The server-delivered JavaScript module has no declarations.
} from './builtinSyncApp.js';
import {
  entityTableKey,
  entitySourceKey,
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
    'rule-memberships',
    'navigation-intents',
    'observation',
    'sync-run',
    'entity-table',
    'reference-diagnostics',
  ].map(name => ['syncable-' + name, 'atomic:' + name]),
);
const classes = {
  'syncable-principal': 'atomic:principal',
  'syncable-record': 'atomic:record',
  'syncable-reference': 'atomic:reference',
  'syncable-observation': 'atomic:observation-class',
  'syncable-sync-run': 'atomic:run-class',
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
                nullable: true,
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
  const document =
    (extra.document as OpenApiDocument | undefined) ?? apiDocument();
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
  const saves: Array<{ subject: string; props: Stored | undefined }> = [];
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
    save: vi.fn(async () => {
      saves.push({ subject, props: structuredClone(data.get(subject)) });
    }),
  });
  const context = {
    subject: root,
    drive: 'atomic:drive',
    proxyOrigin: origin,
    platform: 'example-service',
    kind,
    principal: (extra.principal ?? principal) as
      | typeof principal
      | { kind: 'public' },
    connectionId: 'slot',
    document,
    schema: { properties, classes },
    apiSchema,
    collection:
      (extra.collection as ReturnType<typeof bindCollection> | undefined) ??
      bindCollection(document, { collection: 'myTeams' }),
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
          ? { id: 100, handle: 'new-handle' }
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
      connections: vi.fn(
        async (): Promise<
          Array<{
            connectionId: string;
            platform: string;
            label?: string;
            canReconnect?: boolean;
          }>
        > => [{ connectionId: 'slot', platform: 'example-service' }],
      ),
      connect: vi.fn(),
    },
    ui: { openResource: vi.fn() },
    execution: vi.fn(
      async (): Promise<{ running: boolean; queued?: boolean }> => ({
        running: false,
      }),
    ),
  };

  if (kind === 'collection') {
    const bound = context.collection;
    const definition = {
      version: 1 as const,
      resource: bound.resource,
      source: { kind: 'bound' as const, bound },
    };
    const key = readSelectionKey(definition);
    const run = { generation: 'generation-1', runId: 'run-1', startOrder: 1 };
    const rule = 'atomic:initial-rule';
    data.get(root)![prop('source-config')] = {
      version: 3,
      kind: 'collection',
      proxyOrigin: origin,
      platform: context.platform,
      principal: context.principal,
      ...(context.principal.kind !== 'public'
        ? { connectionId: context.connectionId }
        : {}),
      resource: bound.resource,
    };
    data.get(root)![prop('source-key')] = entityTableKey({
      ...context,
      resource: bound.resource,
    });
    data.get(root)![P + 'table-views'] = [rule];
    data.set(rule, {
      [P + 'parent']: root,
      [P + 'isA']: ['https://atomicdata.dev/classes/View'],
      [P + 'name']: 'My saved filter',
      [prop('source-config')]: {
        version: 3,
        kind: 'rule',
        resource: bound.resource,
        definition,
        ruleKey: key,
      },
      [prop('mirror-status')]: { run },
    });
    Object.assign(context, {
      resource: bound.resource,
      sourceKey: data.get(root)![prop('source-key')],
      rule: { subject: rule, key, resource: bound.resource, definition, run },
    });
  }

  return {
    data,
    saves,
    store,
    context,
    request,
    app: createSyncApp(store, context),
  };
}

const nodes = (data: Map<string, Stored>, kind: string) =>
  [...data].filter(([, props]) => props[prop('node-kind')] === kind);
const config = (row: Stored) =>
  row[prop('source-config')] as Record<string, unknown>;

function tableFor(set: ReturnType<typeof setup>, resource: string) {
  const found = nodes(set.data, 'collection').find(
    ([, props]) => config(props).resource === resource,
  );
  if (!found) throw new Error('Missing entity table ' + resource);

  return found[0];
}

function ruleFor(
  set: ReturnType<typeof setup>,
  table: string,
  collection?: string,
) {
  const found = [...set.data].find(
    ([, row]) =>
      row[P + 'parent'] === table &&
      config(row)?.kind === 'rule' &&
      (!collection ||
        (
          config(row).definition as {
            source: { bound?: { collection: string } };
          }
        ).source.bound?.collection === collection),
  );
  if (!found) throw new Error('Missing saved rule');

  return found[0];
}

let order = 10;

function worker(set: ReturnType<typeof setup>, table: string, rule: string) {
  const saved = set.data.get(table)!;
  const ruleConfig = config(set.data.get(rule)!);
  const run = {
    generation: 'generation-' + ++order,
    runId: 'run-' + order,
    startOrder: order,
  };
  const previous = set.data.get(rule)![prop('mirror-status')] as
    | Record<string, unknown>
    | undefined;
  set.data.get(rule)![prop('mirror-status')] = { ...previous, run };

  return createSyncApp(set.store, {
    ...set.context,
    ...config(saved),
    subject: table,
    kind: 'collection',
    sourceKey: saved[prop('source-key')],
    rule: {
      subject: rule,
      key: ruleConfig.ruleKey,
      resource: ruleConfig.resource,
      definition: ruleConfig.definition,
      run,
    },
  });
}

async function ready() {
  const set = setup('platform');
  await set.app.openPrincipal('slot');
  set.request.mockClear();

  return set;
}

describe('catalog-driven Sync through the shared app bridge', () => {
  it('stores declared links to host-prepared summaries without writing or fetching their targets', async () => {
    const document = apiDocument();
    const definitions = document.components!.crudResources as Record<
      string,
      Record<string, unknown>
    >;
    (
      definitions.team.schema as { properties: Record<string, unknown> }
    ).properties.owner = { type: 'object' };
    (
      definitions.team.schema as { properties: Record<string, unknown> }
    ).properties.reviewers = { type: 'array', items: { type: 'object' } };
    definitions.team['x-embeddedResources'] = {
      owner: {
        discriminator: { field: 'type', mapping: { User: 'person' } },
        cardinality: 'one',
      },
      reviewers: { resource: 'person', cardinality: 'many' },
    };
    definitions.person = {
      schema: {
        type: 'object',
        properties: { id: { type: 'integer' }, name: { type: 'string' } },
      },
      identity: {
        urlTemplate: '/people/{id}',
        bindings: { id: { field: 'id' } },
      },
    };
    const set = setup('collection', { document });
    Object.assign(set.context.apiSchema, {
      resourceProperties: {
        team: {
          ...set.context.apiSchema.properties,
          owner: 'atomic:owner-link',
          reviewers: 'atomic:reviewer-links',
        },
      },
    });
    const owner = { id: 17, name: 'A supplied owner', type: 'User' };
    const entityIdentity = resolveEntityIdentity(document, {
      resource: 'person',
      record: owner,
    });
    const key = entitySourceKey({ ...set.context, entityIdentity });
    set.data.set('atomic:host-prepared-person', {
      [P + 'isA']: [classes['syncable-reference']],
      [P + 'parent']: 'atomic:people-table',
      [prop('source-key')]: key,
      [prop('node-kind')]: 'record',
      [prop('source-config')]: {
        version: 3,
        kind: 'record',
        proxyOrigin: origin,
        platform: set.context.platform,
        principal,
        resource: 'person',
        entityIdentity,
        record: owner,
      },
      [P + 'name']: owner.name,
      'atomic:custom-notes': 'Keep this',
    });
    const snapshot = structuredClone(
      set.data.get('atomic:host-prepared-person'),
    );
    set.request.mockResolvedValue({
      status: 200,
      headers: {},
      body: [{ ...team, owner, reviewers: [owner, owner] }],
    });
    await set.app.refresh();
    const rootRow = nodes(set.data, 'record').find(
      ([, row]) => config(row).resource === 'team',
    )![1];
    expect(rootRow['atomic:owner-link']).toBe('atomic:host-prepared-person');
    expect(rootRow['atomic:reviewer-links']).toEqual([
      'atomic:host-prepared-person',
      'atomic:host-prepared-person',
    ]);
    expect(rootRow[set.context.apiSchema.properties.owner]).toBeUndefined();
    expect((config(rootRow).record as Record<string, unknown>).owner).toEqual(
      owner,
    );
    expect(set.data.get('atomic:host-prepared-person')).toEqual(snapshot);
    expect(
      set.saves.some(save => save.subject === 'atomic:host-prepared-person'),
    ).toBe(false);
    expect(set.request.mock.calls.map(([call]) => call.path)).toEqual([
      'v2/me/teams',
    ]);

    for (const unresolved of [{ id: 18, type: 'Robot' }, { id: 18 }]) {
      set.request.mockResolvedValue({
        status: 200,
        headers: {},
        body: [
          {
            ...team,
            owner: unresolved,
            reviewers: [owner, { id: '../unsafe' }],
          },
        ],
      });
      await worker(set, root, 'atomic:initial-rule').refresh();
      const changed = nodes(set.data, 'record').find(
        ([, row]) => config(row).resource === 'team',
      )![1];
      expect(changed['atomic:owner-link']).toBeUndefined();
      expect(changed['atomic:reviewer-links']).toBeUndefined();
      expect((config(changed).record as Record<string, unknown>).owner).toEqual(
        unresolved,
      );
      expect(changed[prop('reference-diagnostics')]).toEqual(
        expect.arrayContaining([expect.objectContaining({ field: 'owner' })]),
      );
    }
  });

  it('enriches a canonical partial source row without changing its identity or custom fields', async () => {
    const set = setup();
    const entityIdentity = resolveEntityIdentity(set.context.document, {
      resource: 'team',
      record: team,
    });
    const key = entitySourceKey({ ...set.context, entityIdentity });
    set.data.set('atomic:partial-team', {
      [P + 'isA']: [classes['syncable-reference'], 'atomic:custom-class'],
      [P + 'parent']: root,
      [prop('source-key')]: key,
      [prop('node-kind')]: 'record',
      [prop('source-config')]: {
        version: 3,
        kind: 'record',
        proxyOrigin: origin,
        platform: set.context.platform,
        principal,
        resource: 'team',
        entityIdentity,
        record: { id: team.id },
      },
      'atomic:custom-notes': 'Keep this',
    });
    await set.app.refresh();
    expect(nodes(set.data, 'record')).toHaveLength(1);
    const row = set.data.get('atomic:partial-team')!;
    expect(row[P + 'isA']).toContain(set.context.apiSchema.classes.team);
    expect(row[P + 'isA']).toContain('atomic:custom-class');
    expect(row[prop('source-key')]).toBe(key);
    expect(row['atomic:custom-notes']).toBe('Keep this');
  });

  it('keeps supplied rows partial until custom Atomic class requirements can be satisfied', async () => {
    const set = setup();
    set.data.set(set.context.apiSchema.classes.team, {
      [P + 'requires']: ['atomic:required-note'],
    });
    await set.app.refresh();
    const [subject, row] = nodes(set.data, 'record')[0];
    expect(row[P + 'isA']).toContain(classes['syncable-reference']);
    expect(row[P + 'isA']).not.toContain(set.context.apiSchema.classes.team);
    row['atomic:required-note'] = 'A user supplied note';
    await worker(set, root, 'atomic:initial-rule').refresh();
    expect(nodes(set.data, 'record')).toHaveLength(1);
    expect(set.data.get(subject)?.[P + 'isA']).toContain(
      set.context.apiSchema.classes.team,
    );
    expect(set.data.get(subject)?.['atomic:required-note']).toBe(
      'A user supplied note',
    );
  });
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

  it('shows a genuine empty state only when no slots or saved accounts exist', async () => {
    const set = setup('platform');
    set.store.proxy.connections.mockResolvedValue([]);
    const element = document.createElement('div');
    await view({ root: element, store: set.store });
    expect(element.textContent).toContain('No accounts connected yet.');
    expect(element.querySelector('[role="alert"]')).toBeNull();
    expect(set.request).not.toHaveBeenCalled();
  });

  it('shows an expired orphan slot without hiding a saved authenticated account', async () => {
    const set = setup('platform');
    const saved = await set.app.openPrincipal('slot');
    const oldLocalId = set.data.get(saved.subject)![P + 'localId'];
    set.store.proxy.connections.mockResolvedValue([
      { connectionId: 'slot', platform: 'example-service' },
      { connectionId: 'orphan', platform: 'example-service' },
    ]);
    set.request.mockClear();
    set.request.mockResolvedValue({
      status: 401,
      headers: {},
      body: { error: 'credential_refresh_failed' },
    });
    const element = document.createElement('div');
    await view({ root: element, store: set.store });
    expect(element.textContent).toContain('Ada');
    expect(element.textContent).toContain('This connection has expired.');
    expect(element.textContent).not.toContain('No accounts connected');
    expect(element.textContent).not.toContain(
      'Authenticated principal returned HTTP',
    );
    expect(
      set.request.mock.calls.map(([request]) => request.connectionId),
    ).toEqual(['orphan']);
    expect(set.data.get(saved.subject)![P + 'localId']).toBe(oldLocalId);
  });

  it('offers authorization recovery for unknown 401 slots without claiming no account is connected', async () => {
    const set = setup('platform');
    set.request.mockResolvedValue({ status: 401, headers: {}, body: {} });
    const element = document.createElement('div');
    await view({ root: element, store: set.store });
    expect(element.textContent).toContain(
      'This connection could not authorize its account.',
    );
    expect(element.textContent).toContain('Connect account again');
    expect(element.textContent).not.toContain('No accounts connected');
    expect(
      nodes(set.data, 'principal').filter(
        ([, row]) =>
          (config(row).principal as { kind: string }).kind === 'authenticated',
      ),
    ).toHaveLength(0);
  });

  it.each([true, false])(
    'uses native reconnect eligibility (%s) instead of inferring connection ownership',
    async canReconnect => {
      const set = setup('platform');
      set.store.proxy.connections.mockResolvedValue([
        {
          connectionId: 'expired-slot',
          platform: 'example-service',
          label: 'Saved connection',
          canReconnect,
        },
      ]);
      set.request.mockResolvedValue({
        status: 401,
        headers: {},
        body: { error: 'credential_refresh_failed' },
      });
      const element = document.createElement('div');
      await view({ root: element, store: set.store });
      expect(element.textContent).toContain('Saved connection');
      const recovery = [...element.querySelectorAll('button')].find(
        button =>
          button.textContent ===
          (canReconnect ? 'Reconnect connection' : 'Connect account again'),
      )!;
      recovery.click();
      await vi.waitFor(() =>
        expect(set.store.proxy.connect).toHaveBeenCalledWith({
          platform: 'example-service',
          ...(canReconnect ? { connectionId: 'expired-slot' } : {}),
        }),
      );
      expect(
        set.store.newResource.mock.calls.every(
          ([args]) =>
            (
              args.propVals[prop('source-config')] as {
                principal?: { kind: string };
              }
            )?.principal?.kind !== 'authenticated',
        ),
      ).toBe(true);
    },
  );

  it('retains a historical saved account when its connection expires and no modern principal exists', async () => {
    const subject = 'atomic:historical-account';
    const set = setup('platform', {
      legacySources: [{ subject, kind: 'principal', connectionId: 'slot' }],
    });
    set.data.set(subject, {
      [P + 'parent']: root,
      [P + 'name']: 'Saved legacy account',
      [P + 'localId']: 'old-local-id',
    });
    set.request.mockResolvedValue({
      status: 401,
      headers: {},
      body: { error: 'credential_refresh_failed' },
    });
    const element = document.createElement('div');
    await view({ root: element, store: set.store });
    expect(element.textContent).toContain('Saved legacy account');
    expect(element.textContent).not.toContain('No accounts connected');
    const account = [...element.querySelectorAll('button')].find(
      button => button.textContent === 'Saved legacy account',
    )!;
    account.click();
    await vi.waitFor(() =>
      expect(set.store.ui.openResource).toHaveBeenCalledWith(subject),
    );
    expect(set.data.get(subject)![P + 'localId']).toBe('old-local-id');
  });

  it.each([403, 503])(
    'keeps HTTP %s visible alongside recoverable authorization failures',
    async status => {
      const set = setup('platform');
      set.store.proxy.connections.mockResolvedValue([
        { connectionId: 'expired', platform: 'example-service' },
        { connectionId: 'failed', platform: 'example-service' },
      ]);
      set.request.mockImplementation(async request => ({
        status: request.connectionId === 'expired' ? 401 : status,
        headers: {},
        body: {},
      }));
      const element = document.createElement('div');
      await view({ root: element, store: set.store });
      expect(element.textContent).toContain(
        'This connection could not authorize its account.',
      );
      expect(element.textContent).toContain(String(status));
      expect(element.querySelectorAll('[role="alert"]')).toHaveLength(2);
      expect(element.textContent).not.toContain('No accounts connected');
    },
  );

  it.each(['network', 'schema'])(
    'does not misclassify %s failures as expired authorization',
    async failure => {
      const set = setup('platform');
      if (failure === 'network')
        set.request.mockRejectedValue(new Error('Network unavailable'));
      else
        set.request.mockResolvedValue({ status: 200, headers: {}, body: {} });
      const element = document.createElement('div');
      await view({ root: element, store: set.store });
      expect(element.querySelector('[role="alert"]')).not.toBeNull();
      expect(element.textContent).not.toContain('This connection has expired.');
      expect(element.textContent).not.toContain('Connect account again');
      expect(element.textContent).not.toContain('No accounts connected');
    },
  );
});

describe('shared entity tables and independent saved filters', () => {
  it('provisions every collection-backed entity type and only root rules without reading collection data', async () => {
    const set = await ready();
    expect(
      nodes(set.data, 'collection')
        .map(([, props]) => config(props).resource)
        .sort(),
    ).toEqual(['task', 'team', 'workspace']);
    expect(nodes(set.data, 'rule')).toHaveLength(2);
    expect(nodes(set.data, 'record')).toHaveLength(0);
    expect(set.request).not.toHaveBeenCalled();

    for (const [subject, row] of nodes(set.data, 'collection')) {
      expect(JSON.parse(row[prop('source-key')] as string)).toMatchObject({
        version: 3,
        kind: 'collection',
        resource: config(row).resource,
      });
      expect(JSON.parse(row[prop('source-key')] as string)).not.toHaveProperty(
        'parentSourceKeyHash',
      );

      for (const [rule, props] of set.data) {
        if (props[P + 'parent'] === subject && config(props)?.kind === 'rule')
          expect(row[P + 'table-views']).toContain(rule);
      }
    }
  });
  it('shares one row between root and related reads and saves intents without creating child tables', async () => {
    const set = await ready();
    const teamTable = tableFor(set, 'team'),
      workspaceTable = tableFor(set, 'workspace');
    await worker(set, workspaceTable, ruleFor(set, workspaceTable)).refresh();
    const initial = nodes(set.data, 'record').find(
      ([, props]) => config(props).resource === 'workspace',
    )!;
    const initialLocalId = initial[1][P + 'localId'];
    const tableCount = nodes(set.data, 'collection').length;
    await worker(set, teamTable, ruleFor(set, teamTable)).refresh();
    const teamRow = nodes(set.data, 'record').find(
      ([, props]) => config(props).resource === 'team',
    )!;
    const intent = (
      teamRow[1][prop('navigation-intents')] as Array<{
        resource: string;
        definition: unknown;
        label: string;
      }>
    ).find(item => item.resource === 'workspace')!;
    expect(intent).toBeTruthy();
    expect(nodes(set.data, 'collection')).toHaveLength(tableCount);
    expect(
      nodes(set.data, 'collection').every(
        ([, row]) => row[P + 'parent'] !== teamRow[0],
      ),
    ).toBe(true);
    // Simulate the native explicit Open materializing the already stored intent.
    const related = await set.app.ensureRule(
      await set.store.getResource(workspaceTable),
      intent.definition,
      intent.label,
    );
    set.request.mockClear();
    expect(
      await worker(set, workspaceTable, related.subject).refresh(),
    ).toMatchObject({ added: 0, rows: 1, incomplete: false });
    expect(set.request.mock.calls.map(([request]) => request.path)).toEqual([
      'v2/names/old-handle',
      'v2/names/new-handle/workspaces',
    ]);
    const workspaces = nodes(set.data, 'record').filter(
      ([, props]) => config(props).resource === 'workspace',
    );
    expect(workspaces).toHaveLength(1);
    expect(workspaces[0][0]).toBe(initial[0]);
    expect(workspaces[0][1][P + 'localId']).toBe(initialLocalId);
    expect(workspaces[0][1][prop('rule-memberships')]).toEqual(
      expect.arrayContaining([
        ruleFor(set, workspaceTable, 'myWorkspaces'),
        related.subject,
      ]),
    );
    expect(workspaces[0][1][prop('entity-table')]).toBe(workspaceTable);
  });
  it('completes a fanout only after every selected partition and retains old membership on partial refresh', async () => {
    const set = await ready();
    const table = tableFor(set, 'task');
    const from = {
      version: 1,
      resource: 'workspace',
      source: {
        kind: 'bound',
        bound: bindCollection(set.context.document, {
          collection: 'myWorkspaces',
        }),
      },
    };
    const rule = await set.app.ensureRule(
      await set.store.getResource(table),
      {
        version: 1,
        resource: 'task',
        source: {
          kind: 'fanout',
          from,
          via: { collection: 'tasks', kind: 'identity' },
        },
      },
      'Tasks in my workspaces',
    );
    let fail = false;
    set.request.mockImplementation(async request => {
      if (request.path === 'v2/me/workspaces')
        return {
          status: 200,
          headers: {},
          body: [workspace, { ...workspace, id: 201 }],
        };
      if (fail && request.path.includes('/201/'))
        return { status: 503, headers: {}, body: {} };

      return {
        status: 200,
        headers: {},
        body: [{ id: fail ? 'new-task' : 'same-local-id', name: 'Task' }],
      };
    });
    expect(await worker(set, table, rule.subject).refresh()).toMatchObject({
      incomplete: false,
      rows: 2,
    });
    fail = true;
    expect(await worker(set, table, rule.subject).refresh()).toMatchObject({
      incomplete: true,
      rows: 1,
    });
    const rows = nodes(set.data, 'record').filter(
      ([, props]) => config(props).resource === 'task',
    );
    expect(rows).toHaveLength(3);
    expect(
      rows.every(([, props]) =>
        (props[prop('rule-memberships')] as string[]).includes(rule.subject),
      ),
    ).toBe(true);
  });

  it('adopts a uniquely proven old row without changing its subject, local ID or user fields', async () => {
    const set = await ready();
    const table = tableFor(set, 'workspace'),
      rule = ruleFor(set, table);
    await worker(set, table, rule).refresh();
    const [subject, row] = nodes(set.data, 'record').find(
      ([, props]) => config(props).resource === 'workspace',
    )!;
    const canonicalSourceKey = row[prop('source-key')] as string,
      localId = row[P + 'localId'];
    row[prop('source-key')] = 'old-row-key';
    row[prop('source-config')] = {
      version: 2,
      principal,
      record: workspace,
      resource: 'workspace',
    };
    row[P + 'description'] = 'Retain user note';
    Object.assign(set.context, {
      flatIdentityAliases: [
        {
          canonicalSourceKey,
          subject,
          previousSourceKey: 'old-row-key',
          localId,
          sourceConfigFingerprint: sourceConfigFingerprint(
            row[prop('source-config')],
          ),
        },
      ],
    });
    await worker(set, table, rule).refresh();
    expect(nodes(set.data, 'record')).toHaveLength(1);
    expect(row[prop('source-key')]).toBe(canonicalSourceKey);
    expect(row[P + 'localId']).toBe(localId);
    expect(row[P + 'description']).toBe('Retain user note');
    expect(config(row).version).toBe(3);
    expect(set.data.has(subject)).toBe(true);
  });

  it('uses string transport context for composed GitHub Issue navigation while preserving typed scoped identity', async () => {
    const document = prepareDocument(
      JSON.parse(
        readFileSync(
          new NodeURL(
            './fixtures/github-syncables-catalog.json',
            import.meta.url,
          ),
          'utf8',
        ),
      ),
    );
    const bound = bindCollection(document, {
      collection: 'repositoryIssues',
      context: { repository_id: '456' },
    });
    const set = setup('collection', {
      document,
      collection: bound,
      principal: { kind: 'public' },
      connectionId: undefined,
    });
    set.request.mockResolvedValue({
      status: 200,
      headers: {},
      body: [
        {
          id: 9001,
          number: 15,
          title: 'Scoped issue',
          state: 'open',
          body: 'Body',
          updated_at: '2026-11-19T10:00:00Z',
          html_url: 'https://github.com/ontola/atomic-server/issues/15',
        },
      ],
    });
    expect(await set.app.refresh()).toMatchObject({
      rows: 1,
      incomplete: false,
    });
    const row = nodes(set.data, 'record')[0][1];
    expect(config(row).context).toMatchObject({ repository_id: 456 });
    expect(config(row).entityIdentity).toMatchObject({
      values: [
        ['repository_id', 456],
        ['issue_number', 15],
      ],
    });
    expect(row[prop('navigation-intents')]).toMatchObject([
      {
        resource: 'issueComment',
        definition: {
          source: {
            kind: 'related',
            origin: {
              context: { repository_id: 456 },
              read: { pathParams: { repository_id: '456' } },
            },
          },
        },
      },
    ]);
  });

  it('preserves absent relationship binding fields across narrower overlapping observations', async () => {
    const set = await ready();
    const table = tableFor(set, 'team'),
      rule = ruleFor(set, table);
    await worker(set, table, rule).refresh();
    const row = nodes(set.data, 'record').find(
      ([, props]) => config(props).resource === 'team',
    )![1];
    expect(row[prop('navigation-intents')]).toHaveLength(1);
    set.request.mockResolvedValue({
      status: 200,
      headers: {},
      body: [{ id: 100 }],
    });
    await worker(set, table, rule).refresh();
    expect(config(row).record).toMatchObject({ id: 100, handle: 'old-handle' });
    expect(row[prop('navigation-intents')]).toHaveLength(1);
  });

  it('keeps identical remote IDs distinct when required canonical identity context differs', async () => {
    const set = await ready();
    const table = tableFor(set, 'task');

    for (const workspaceId of ['200', '201']) {
      const bound = bindCollection(set.context.document, {
        collection: 'tasks',
        context: { workspace_id: workspaceId },
      });
      const rule = await set.app.ensureRule(
        await set.store.getResource(table),
        { version: 1, resource: 'task', source: { kind: 'bound', bound } },
        'Workspace ' + workspaceId,
      );
      await worker(set, table, rule.subject).refresh();
    }

    const tasks = nodes(set.data, 'record').filter(
      ([, props]) => config(props).resource === 'task',
    );
    expect(tasks).toHaveLength(2);
    expect(new Set(tasks.map(([, row]) => row[prop('source-key')])).size).toBe(
      2,
    );
    expect(tasks.every(([, row]) => row[P + 'parent'] === table)).toBe(true);
  });
  it('replays durable evidence idempotently and preserves user fields across absent and explicit-null updates', async () => {
    const set = await ready();
    const table = tableFor(set, 'workspace'),
      rule = ruleFor(set, table);
    await worker(set, table, rule).refresh();
    const [subject, row] = nodes(set.data, 'record').find(
      ([, props]) => config(props).resource === 'workspace',
    )!;
    const key = row[prop('source-key')],
      localId = row[P + 'localId'];
    row[P + 'description'] = 'A user note';
    const initialCount = nodes(set.data, 'record').length;
    expect(await worker(set, table, rule).refresh()).toMatchObject({
      added: 0,
      changed: 0,
      unchanged: 1,
    });
    set.request.mockResolvedValue({
      status: 200,
      headers: {},
      body: [{ id: 200, name: 'A newer name' }],
    });
    await worker(set, table, rule).refresh();
    expect(row[set.context.apiSchema.properties.active]).toBe(true);
    expect(row[P + 'name']).toBe('A newer name');
    set.request.mockResolvedValue({
      status: 200,
      headers: {},
      body: [{ id: 200, name: 'A newer name', active: null }],
    });
    await worker(set, table, rule).refresh();
    expect(row[set.context.apiSchema.properties.active]).toBeUndefined();
    expect(row[P + 'description']).toBe('A user note');
    expect(row[prop('source-key')]).toBe(key);
    expect(row[P + 'localId']).toBe(localId);
    expect(set.data.has(subject)).toBe(true);
    expect(nodes(set.data, 'record')).toHaveLength(initialCount);
    expect(nodes(set.data, 'syncable-observation').length).toBeGreaterThan(3);
    expect(nodes(set.data, 'syncable-sync-run').length).toBeGreaterThan(3);
  });
  it('replaces only a complete selected filter membership without deleting retained rows', async () => {
    const set = await ready();
    const table = tableFor(set, 'workspace'),
      rootRule = ruleFor(set, table);
    const alternateBound = bindCollection(set.context.document, {
      collection: 'teamWorkspaces',
      context: { handle: 'old-handle' },
    });
    const other = await set.app.ensureRule(
      await set.store.getResource(table),
      {
        version: 1,
        resource: 'workspace',
        source: { kind: 'bound', bound: alternateBound },
      },
      'Another scope',
    );
    await worker(set, table, rootRule).refresh();
    await worker(set, table, other.subject).refresh();
    const [subject, row] = nodes(set.data, 'record').find(
      ([, props]) => config(props).resource === 'workspace',
    )!;
    set.request.mockResolvedValue({ status: 200, headers: {}, body: [] });
    await worker(set, table, rootRule).refresh();
    expect(set.data.has(subject)).toBe(true);
    expect(row[prop('rule-memberships')]).toEqual([other.subject]);
    expect(row[set.context.apiSchema.properties.name]).toBe('A workspace');
  });
  it.each([25, 130])(
    'pages authenticated filters beyond 20 requests while retaining the 128-request bound (%i pages)',
    async pages => {
      const set = await ready();
      const table = tableFor(set, 'workspace'),
        rule = ruleFor(set, table);
      set.request.mockClear();
      set.request.mockImplementation(async request => {
        const page = Number(request.query?.page ?? '1');
        const headers: Record<string, string> =
          page < pages
            ? {
                link: `<https://api.example/v2/me/workspaces?page=${page + 1}>; rel="next"`,
              }
            : {};

        return {
          status: 200,
          headers,
          body: [{ ...workspace, id: 1000 + page, name: `Workspace ${page}` }],
        };
      });
      const result = await worker(set, table, rule).refresh();
      expect(result.incomplete).toBe(pages > 128);
      expect(set.request.mock.calls).toHaveLength(Math.min(pages, 128));
      const records = nodes(set.data, 'record').filter(
        ([, props]) => config(props).resource === 'workspace',
      );
      expect(records).toHaveLength(Math.min(pages, 128));
      if (pages > 128) expect(result.error).toContain('128 requests');
    },
  );
  it.each([
    { pages: 25, processingMs: 6_000, accepted: 25, incomplete: false },
    { pages: 40, processingMs: 11_000, accepted: 28, incomplete: true },
  ])(
    'budgets elapsed bridge processing while retaining accepted pages ($pages pages, $processingMs ms per response)',
    async ({ pages, processingMs, accepted, incomplete }) => {
      const set = await ready();
      const table = tableFor(set, 'workspace'),
        rule = ruleFor(set, table);
      set.request.mockClear();
      const started = Date.now();
      let now = started;
      const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);

      try {
        set.request.mockImplementation(async request => {
          const page = Number(request.query?.page ?? '1');
          const headers: Record<string, string> =
            page < pages
              ? {
                  link: `<https://api.example/v2/me/workspaces?page=${page + 1}>; rel="next"`,
                }
              : {};
          // A bridge response includes host-side observation validation and
          // linked-record storage before the reader can request the next page.
          now += processingMs;

          return {
            status: 200,
            headers,
            body: [
              { ...workspace, id: 1000 + page, name: `Workspace ${page}` },
            ],
          };
        });
        const result = await worker(set, table, rule).refresh();
        expect(result).toMatchObject({ rows: accepted, incomplete });
        expect(set.request.mock.calls).toHaveLength(accepted);
        const records = nodes(set.data, 'record').filter(
          ([, props]) => config(props).resource === 'workspace',
        );
        expect(records).toHaveLength(accepted);
        expect(
          records.every(([, row]) =>
            (row[prop('rule-memberships')] as string[]).includes(rule),
          ),
        ).toBe(true);

        if (incomplete) {
          expect(now - started).toBeGreaterThan(300_000);
          expect(result.error).toContain('Read timed out');
        } else {
          expect(now - started).toBeGreaterThan(120_000);
          expect(now - started).toBeLessThan(300_000);
          expect(result.error).toBeNull();
        }
      } finally {
        clock.mockRestore();
      }
    },
  );
  it('retains old memberships and accepted partial observations when a later page fails', async () => {
    const set = await ready();
    const table = tableFor(set, 'workspace'),
      rule = ruleFor(set, table);
    await worker(set, table, rule).refresh();
    set.request.mockImplementation(async request =>
      request.query?.page === '2'
        ? { status: 503, headers: {} as Record<string, string>, body: {} }
        : {
            status: 200,
            headers: {
              link: '<https://api.example/v2/me/workspaces?page=2>; rel="next"',
            },
            body: [{ ...workspace, id: 201, name: 'Accepted prefix' }],
          },
    );
    expect(await worker(set, table, rule).refresh()).toMatchObject({
      incomplete: true,
    });
    const rows = nodes(set.data, 'record').filter(
      ([, props]) => config(props).resource === 'workspace',
    );
    expect(rows).toHaveLength(2);
    expect(
      rows.every(([, row]) =>
        (row[prop('rule-memberships')] as string[]).includes(rule),
      ),
    ).toBe(true);
  });
  it('retains cached rows and membership after unauthorized reads', async () => {
    const set = await ready();
    const table = tableFor(set, 'workspace'),
      rule = ruleFor(set, table);
    await worker(set, table, rule).refresh();
    const before = structuredClone(nodes(set.data, 'record'));
    set.request.mockResolvedValue({
      status: 401,
      headers: {},
      body: { error: 'credential_refresh_failed' },
    });
    const app = worker(set, table, rule);

    try {
      await app.refresh();
    } catch {
      /* A provider failure may be surfaced as an error or incomplete snapshot. */
    }

    expect(nodes(set.data, 'record')).toEqual(before);
    expect((await app.status()).error).toContain('401');
  });
  it('rejects stale responses and leaves accepted data unchanged after pausing while a read is pending', async () => {
    const set = await ready();
    const table = tableFor(set, 'workspace'),
      rule = ruleFor(set, table);
    await worker(set, table, rule).refresh();
    const before = structuredClone(nodes(set.data, 'record'));
    let release!: (value: {
      status: number;
      headers: Record<string, string>;
      body: unknown;
    }) => void;
    set.request.mockImplementation(
      () =>
        new Promise(resolve => {
          release = resolve;
        }),
    );
    const pending = worker(set, table, rule).refresh();
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    const status = set.data.get(rule)![prop('mirror-status')] as Record<
      string,
      unknown
    >;
    status.paused = true;
    release({
      status: 200,
      headers: {},
      body: [{ ...workspace, name: 'Must not be applied' }],
    });
    await expect(pending).rejects.toThrow('no longer current');
    expect(nodes(set.data, 'record')).toEqual(before);
  });
  it('pauses one rule while another rule updates their shared entity', async () => {
    const set = await ready();
    const table = tableFor(set, 'workspace'),
      first = ruleFor(set, table);
    const bound = bindCollection(set.context.document, {
      collection: 'teamWorkspaces',
      context: { handle: 'another' },
    });
    const second = await set.app.ensureRule(
      await set.store.getResource(table),
      { version: 1, resource: 'workspace', source: { kind: 'bound', bound } },
      'Other filter',
    );
    await worker(set, table, first).refresh();
    set.data.get(first)![prop('mirror-status')] = { paused: true };
    await expect(worker(set, table, first).refresh()).rejects.toThrow(
      'no longer current',
    );
    set.request.mockResolvedValue({
      status: 200,
      headers: {},
      body: [{ ...workspace, name: 'Changed by active filter' }],
    });
    await worker(set, table, second.subject).refresh();
    const row = nodes(set.data, 'record').find(
      ([, props]) => config(props).resource === 'workspace',
    )![1];
    expect(row[P + 'name']).toBe('Changed by active filter');
    expect(row[prop('rule-memberships')]).toEqual(
      expect.arrayContaining([first, second.subject]),
    );
    expect(
      (set.data.get(first)![prop('mirror-status')] as { paused: boolean })
        .paused,
    ).toBe(true);
  });
  it('keeps a manually moved canonical entity instead of creating a duplicate', async () => {
    const set = await ready();
    const table = tableFor(set, 'workspace'),
      rule = ruleFor(set, table);
    await worker(set, table, rule).refresh();
    const [subject, row] = nodes(set.data, 'record').find(
      ([, props]) => config(props).resource === 'workspace',
    )!;
    row[P + 'parent'] = 'atomic:outside-table';
    set.data.set('atomic:outside-table', { [P + 'parent']: root });
    const result = await worker(set, table, rule).refresh();
    expect(result.protected).toBe(1);
    expect(result.error).toContain('Moved cached rows');
    expect(
      nodes(set.data, 'record').filter(
        ([, props]) => config(props).resource === 'workspace',
      ),
    ).toHaveLength(1);
    expect(set.data.get(subject)![P + 'parent']).toBe('atomic:outside-table');
  });
  it.each(['discovery', 'save filter'])(
    'preserves the old saved read rule and adopts proven row metadata before navigation during %s',
    async entry => {
      const set = await ready();
      const table = tableFor(set, 'workspace'),
        rule = ruleFor(set, table);
      await worker(set, table, rule).refresh();
      const [subject, row] = nodes(set.data, 'record').find(
        ([, props]) => config(props).resource === 'workspace',
      )!;
      const original = structuredClone(config(row));
      const canonicalSourceKey = row[prop('source-key')] as string;
      const canonicalTableKey = set.data.get(table)![
        prop('source-key')
      ] as string;
      const bound = bindCollection(set.context.document, {
        collection: 'teamWorkspaces',
        context: { handle: 'old-handle' },
      });
      const oldTableKey = sourceKey({
        ...set.context,
        kind: 'collection',
        collection: {
          name: bound.collection,
          resource: bound.resource,
          context: bound.pathParams,
        },
      });
      const oldRowKey = sourceKey({
        ...set.context,
        kind: 'record',
        collection: { name: bound.collection, resource: bound.resource },
        parentSourceKey: oldTableKey,
        remoteId: 200,
      });
      const tableProps = set.data.get(table)!;
      tableProps[prop('source-key')] = oldTableKey;
      tableProps[P + 'localId'] =
        'syncables:node:' + encodeURIComponent(oldTableKey);
      tableProps[prop('source-config')] = {
        version: 2,
        proxyOrigin: origin,
        platform: set.context.platform,
        principal,
        connectionId: 'slot',
        collection: bound,
      };
      row[prop('source-key')] = oldRowKey;
      row[P + 'localId'] = 'syncables:node:' + encodeURIComponent(oldRowKey);
      row[prop('source-config')] = {
        version: 2,
        proxyOrigin: origin,
        platform: set.context.platform,
        principal,
        connectionId: 'slot',
        parentSourceKey: oldTableKey,
        resource: 'workspace',
        record: workspace,
        context: bound.pathParams,
        managedProperties: original.managedProperties,
      };
      row[P + 'description'] = 'Keep user field';
      const oldLocalId = row[P + 'localId'];
      Object.assign(set.context, {
        flatIdentityAliases: [
          {
            canonicalSourceKey: canonicalTableKey,
            subject: table,
            previousSourceKey: oldTableKey,
            localId: tableProps[P + 'localId'],
            sourceConfigFingerprint: sourceConfigFingerprint(
              config(tableProps),
            ),
          },
          {
            canonicalSourceKey,
            subject,
            previousSourceKey: oldRowKey,
            localId: oldLocalId,
            sourceConfigFingerprint: sourceConfigFingerprint(config(row)),
            entityTableSourceKey: canonicalTableKey,
            canonicalConfig: {
              ...original,
              context: bound.pathParams,
              read: bound,
            },
          },
        ],
        flatAdoptionRules: [
          {
            tableSourceKey: canonicalTableKey,
            definition: {
              version: 1,
              resource: 'workspace',
              source: { kind: 'bound', bound },
            },
            label: 'Previously synced collection',
          },
        ],
      });
      set.saves.length = 0;
      set.request.mockClear();
      set.store.ui.openResource.mockClear();

      if (entry === 'discovery') {
        const result = await set.app.discoverPrincipals();
        expect(result.errors).toEqual([]);
      } else {
        set.store.ui.openResource.mockImplementation(async () => {
          expect(row[prop('source-key')]).toBe(canonicalSourceKey);
          expect(config(row).version).toBe(3);
        });
        await createSyncApp(set.store, {
          ...set.context,
          subject: tableProps[P + 'parent'],
          kind: 'principal',
        }).createCollection('teamWorkspaces', { handle: 'old-handle' });
        expect(set.store.ui.openResource).toHaveBeenCalledOnce();
      }

      expect(set.request).not.toHaveBeenCalled();
      const adoptedRule = ruleFor(set, table, 'teamWorkspaces');
      const tableWrites = set.saves.filter(save => save.subject === table);
      const firstRuleWrite = tableWrites.findIndex(save =>
        (save.props?.[P + 'table-views'] as string[] | undefined)?.includes(
          adoptedRule,
        ),
      );
      const firstRekey = tableWrites.findIndex(
        save =>
          (save.props?.[prop('source-config')] as { version?: number })
            ?.version === 3,
      );
      expect(firstRuleWrite).toBeGreaterThanOrEqual(0);
      expect(firstRuleWrite).toBeLessThan(firstRekey);
      expect(row[prop('source-key')]).toBe(canonicalSourceKey);
      expect(row[P + 'localId']).toBe(oldLocalId);
      expect(config(row).version).toBe(3);
      expect(config(row).read).toEqual(bound);
      expect(row[P + 'description']).toBe('Keep user field');
      expect(row[prop('entity-table')]).toBe(table);
    },
  );

  it('blocks fresh shared-table allocation while older same-principal collections remain unresolved', async () => {
    const set = setup('platform');
    set.data.set('atomic:older-table', {
      [P + 'parent']: root,
      [P + 'isA']: [tableClass],
      [prop('node-kind')]: 'collection',
      [prop('source-config')]: {
        version: 2,
        principal,
        collection: { resource: 'team', collection: 'myTeams', pathParams: {} },
      },
    });
    await expect(set.app.openPrincipal('slot')).rejects.toThrow(
      'need adoption',
    );
    expect(
      nodes(set.data, 'collection').filter(
        ([, props]) =>
          config(props).resource === 'team' && config(props).version === 3,
      ),
    ).toHaveLength(0);
    expect(
      nodes(set.data, 'collection').some(
        ([, props]) => config(props).resource === 'workspace',
      ),
    ).toBe(true);
    expect(
      nodes(set.data, 'collection').some(
        ([, props]) => config(props).resource === 'task',
      ),
    ).toBe(true);
  });
  it('retains unsupported historical Public data and refuses a competing destination when native blocks that exact resource', async () => {
    const old = 'atomic:v1-public-cache';
    const publicPrincipal = { kind: 'public' };
    const set = setup('principal', {
      principal: publicPrincipal,
      connectionId: undefined,
      legacySources: [
        {
          subject: old,
          kind: 'collection',
          principal: publicPrincipal,
          collection: {
            name: 'tasks',
            resource: 'task',
            context: { workspace_id: '200' },
          },
        },
      ],
      flatMigrationBlocks: [
        {
          principal: publicPrincipal,
          resource: 'task',
          message: 'Historical collection requires migration review',
        },
      ],
    });
    const saved = {
      [P + 'parent']: root,
      [P + 'localId']: 'historical-public-local-id',
      [P + 'description']: 'Keep saved public values',
      [prop('source-key')]: 'old-v1-public-source',
      [prop('node-kind')]: 'public-mirror',
    };
    set.data.set(old, saved);
    await expect(
      set.app.createCollection('tasks', { workspace_id: '200' }),
    ).rejects.toThrow('migration review');
    expect(set.store.newResource).not.toHaveBeenCalled();
    expect(set.data.get(old)).toEqual(saved);
    expect(set.request).not.toHaveBeenCalled();
  });

  it('creates a named Public saved filter from generic catalog entrypoint inputs and canonical binding', async () => {
    const document = withPublicEntrypoint();
    const set = setup('principal', {
      document,
      principal: { kind: 'public' },
      connectionId: undefined,
    });
    set.request.mockResolvedValue({
      status: 200,
      headers: {},
      body: { id: 200 },
    });
    const rule = await set.app.createCollection(
      'tasks',
      { team: 'one', space: 'two' },
      '/public/{team}/{space}',
      'Public tasks',
    );
    expect(set.request.mock.calls.map(([request]) => request.path)).toEqual([
      'v2/public/one/two',
    ]);
    expect(set.request.mock.calls[0][0].connectionId).toBeUndefined();
    const saved = set.data.get(rule.subject)!;
    expect(saved[P + 'name']).toBe('Public tasks');
    expect(config(saved)).toMatchObject({
      version: 3,
      kind: 'rule',
      resource: 'task',
      definition: {
        source: {
          kind: 'bound',
          bound: { pathParams: { workspace_id: '200' } },
        },
      },
    });
    const tables = nodes(set.data, 'collection');
    expect(tables).toHaveLength(1);
    expect(config(tables[0][1]).principal).toEqual({ kind: 'public' });
    expect(config(tables[0][1]).connectionId).toBeUndefined();
  });
  it('shows queued state without allowing a duplicate start and preserves selected-filter navigation', async () => {
    vi.useFakeTimers();

    try {
      const set = setup();
      set.store.execution.mockResolvedValue({ running: false, queued: true });
      const element = document.createElement('div');
      await view({ root: element, store: set.store });
      const queued = [...element.querySelectorAll('button')].find(
        button => button.textContent === 'Queued',
      )!;
      expect(queued.disabled).toBe(true);
      expect(set.request).not.toHaveBeenCalled();
      const browse = [...element.querySelectorAll('button')].find(
        button => button.textContent === 'Browse stored data',
      )!;
      browse.click();
      await Promise.resolve();
      expect(set.store.ui.openResource).toHaveBeenCalledWith(
        'atomic:initial-rule',
      );
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('opens saved-filter controls without provider reads and pauses only the selected rule', async () => {
    const set = setup();
    const element = document.createElement('div');
    await view({ root: element, store: set.store });
    expect(set.request).not.toHaveBeenCalled();
    const pauseButton = [...element.querySelectorAll('button')].find(
      button => button.textContent === 'Pause',
    )!;
    pauseButton.click();
    await vi.waitFor(() => expect(element.textContent).toContain('Resume'));
    expect(set.store.execution).toHaveBeenCalledWith('cancel');
    expect(
      (
        set.data.get('atomic:initial-rule')![prop('mirror-status')] as {
          paused: boolean;
        }
      ).paused,
    ).toBe(true);
    expect(set.data.get(root)![prop('mirror-status')]).toBeUndefined();
  });
});

describe('verified principal migration compatibility', () => {
  it.each([false, true])(
    'migrates a host-validated principal alias with cross-slot identity proof (%s)',
    async crossSlot => {
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
            connectionId: crossSlot ? 'historical-slot' : 'slot',
            ...(crossSlot ? { principal } : {}),
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
    },
  );

  it('does not allocate a duplicate principal when a different historical slot lacks identity proof', async () => {
    const set = setup('platform');
    const subject = 'atomic:historical-account';
    const old = {
      [P + 'parent']: root,
      [P + 'name']: 'Saved account',
      [P + 'localId']: 'historical-account',
      [prop('source-key')]: 'historical-source',
    };
    set.data.set(subject, old);
    const app = createSyncApp(set.store, {
      ...set.context,
      legacySources: [
        {
          subject,
          sourceKey: 'historical-source',
          localId: 'historical-account',
          kind: 'principal',
          connectionId: 'older-slot',
        },
      ],
    });
    await expect(app.openPrincipal('slot')).rejects.toThrow('saved account');
    expect(set.store.newResource).not.toHaveBeenCalled();
    expect(set.data.get(subject)).toEqual(old);
  });

  it('refuses competing canonical and legacy resources for the same proven typed principal', async () => {
    const set = setup('platform');
    const canonical = await set.app.openPrincipal('slot');
    const subject = 'atomic:historical-account';
    set.data.set(subject, {
      [P + 'parent']: root,
      [P + 'name']: 'Saved account',
      [P + 'localId']: 'historical-account',
      [prop('source-key')]: 'historical-source',
    });
    const before = structuredClone([...set.data]);
    set.store.newResource.mockClear();
    const app = createSyncApp(set.store, {
      ...set.context,
      legacySources: [
        {
          subject,
          sourceKey: 'historical-source',
          localId: 'historical-account',
          kind: 'principal',
          connectionId: 'older-slot',
          principal,
        },
      ],
    });
    await expect(app.openPrincipal('slot')).rejects.toThrow(
      'conflicting saved sources',
    );
    expect(set.store.newResource).not.toHaveBeenCalled();
    expect([...set.data]).toEqual(before);
    expect(set.data.has(canonical.subject)).toBe(true);
  });

  it('reports canonical and proven historical principal conflicts even when the canonical slot is already known', async () => {
    const set = setup('platform');
    const canonical = await set.app.openPrincipal('slot');
    const subject = 'atomic:historical-account';
    set.data.set(subject, {
      [P + 'parent']: root,
      [P + 'name']: 'Historical saved name',
    });
    Object.assign(set.context, {
      legacySources: [
        { subject, kind: 'principal', connectionId: 'old-slot', principal },
      ],
    });
    set.request.mockClear();
    const element = document.createElement('div');
    await view({ root: element, store: set.store });
    expect(element.textContent).toContain('conflicting saved sources');
    expect(element.textContent).toContain('Historical saved name');
    expect(element.textContent).toContain('Ada');
    expect(set.data.has(canonical.subject)).toBe(true);
    expect(set.request).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'allows a distinct proven principal or an already adopted historical alias (%s)',
    async adopted => {
      const set = setup('platform');
      const first = await set.app.openPrincipal('old-slot');
      const alias = {
        subject: first.subject,
        kind: 'principal',
        connectionId: 'old-slot',
        ...(adopted ? {} : { principal }),
      };
      const app = createSyncApp(set.store, {
        ...set.context,
        legacySources: [alias],
      });
      set.request.mockResolvedValue({
        status: 200,
        headers: {},
        body: { id: 8, label: 'Another account' },
      });
      await app.openPrincipal('another-slot');
      expect(nodes(set.data, 'principal')).toHaveLength(2);
      expect(set.data.get(first.subject)![P + 'name']).toBe('Ada');
    },
  );
});

describe('principal Apps outside the setup write root', () => {
  it.each([false, true])(
    'reuses a promoted principal App without sibling writes (%s)',
    async publicSource => {
      const set = setup('platform');
      const first = publicSource
        ? await set.app.openPublic()
        : await set.app.openPrincipal('slot');
      const identity = publicSource ? { kind: 'public' } : principal;
      const props = set.data.get(first.subject)!;
      props[P + 'parent'] = 'atomic:drive';
      props[P + 'name'] = 'My named integration';
      const count = set.data.size;
      const writes = set.saves.length;
      const app = createSyncApp(set.store, {
        ...set.context,
        principalApps: [
          {
            subject: first.subject,
            principal: identity,
            name: 'My named integration',
            ...(publicSource ? {} : { connectionId: 'slot' }),
          },
        ],
      });
      expect(
        (await app.storedPrincipals()).map(
          (row: { subject: string }) => row.subject,
        ),
      ).toEqual([first.subject]);
      const reopened = publicSource
        ? await app.openPublic()
        : await app.openPrincipal('replacement-slot');
      expect(reopened.subject).toBe(first.subject);
      expect(set.data.size).toBe(count);
      expect(set.saves).toHaveLength(writes);
      expect(props[P + 'parent']).toBe('atomic:drive');
      expect(props[P + 'name']).toBe('My named integration');
    },
  );
});
