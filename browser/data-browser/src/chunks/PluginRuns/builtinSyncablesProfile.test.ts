import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  core,
  Datatype,
  dataBrowser,
  pluginSchema,
  ensureSchema,
  type Store,
  type Resource,
} from '@tomic/lib';
import {
  bindCollection,
  relatedCollectionReads,
  prepareDocument,
  type OpenApiDocument,
  readSelectionKey,
  resolveEntityIdentity,
  type ReadSelection,
} from 'syncables/browser';
import { fakeSchemaStore } from '../../../../lib/src/test-schema-store';
import { defaultIntegrationProxy } from '@helpers/integrationProxy';
import type { ProxyConnections } from '@helpers/proxyConnections';
import { syncablePlatformSchema } from './syncablePlatform';
import { syncableHierarchySchema } from './syncableHierarchy';
import {
  collectionIdentity,
  sourceKey,
  entityTableKey,
  sourceConfigFingerprint,
} from './builtinSyncIdentity.js';
import {
  assertSyncAppDrive,
  assertSyncAppContext,
  syncAppContext,
  syncProxyTransport,
  canonicalSyncAppContext,
  type SyncAppContext,
} from './builtinSyncablesProfile';

afterEach(() => vi.restoreAllMocks());
const principal = {
  kind: 'authenticated' as const,
  namespace: 'https://identity.example',
  subject: 7,
};
const slot = 's'.repeat(43);
const context: SyncAppContext = {
  subject: 'collection',
  drive: 'drive',
  platform: 'calendar-service',
  proxyOrigin: defaultIntegrationProxy,
  kind: 'collection',
  principal,
  connectionId: slot,
  proxyTransport: 'host',
  schema: { classes: {}, properties: {} },
};
const DRIVE_PROPERTY = 'https://atomicdata.dev/properties/drive';

function cachedDriveStore(records: Record<string, Record<string, unknown>>) {
  return {
    normalizeSubject: (subject: string) => subject,
    resources: new Map(
      Object.keys(records).map(subject => [
        subject,
        {
          get: (property: string) => records[subject][property],
          error: undefined,
          // Rights in the destination must not silently widen this session's drive.
          canWrite: async () => [true, undefined],
        },
      ]),
    ),
  } as unknown as Pick<Store, 'resources' | 'normalizeSubject'>;
}

describe('running Sync drive authority', () => {
  it('keeps a same-drive move bound to its stable source and rejects a root moved into another writable drive', () => {
    const records: Record<string, Record<string, unknown>> = {
      mirror: {
        [DRIVE_PROPERTY]: 'drive',
        [core.properties.parent]: 'folder',
        source: 'github-repo:456',
      },
      folder: { [DRIVE_PROPERTY]: 'drive', [core.properties.parent]: 'drive' },
      sibling: { [DRIVE_PROPERTY]: 'drive', [core.properties.parent]: 'drive' },
      'other-drive': { [core.properties.write]: ['person'] },
    };
    const store = cachedDriveStore(records);
    assertSyncAppDrive(store, 'drive', 'mirror');
    records.mirror[core.properties.parent] = 'sibling';
    assertSyncAppDrive(store, 'drive', 'mirror');
    expect(records.mirror.source).toBe('github-repo:456');
    records.mirror[core.properties.parent] = 'other-drive';
    records.mirror[DRIVE_PROPERTY] = 'other-drive';
    expect(() => assertSyncAppDrive(store, 'drive', 'mirror')).toThrow(
      'selected drive',
    );
  });

  it('checks a legacy root through cached parents and rejects a moved ancestor', () => {
    const records: Record<string, Record<string, unknown>> = {
      mirror: { [core.properties.parent]: 'folder' },
      folder: { [core.properties.parent]: 'sibling' },
      sibling: { [DRIVE_PROPERTY]: 'drive', [core.properties.parent]: 'drive' },
      'other-drive': { [core.properties.write]: ['person'] },
    };
    const store = cachedDriveStore(records);
    assertSyncAppDrive(store, 'drive', 'mirror');
    records.folder[core.properties.parent] = 'drive';
    assertSyncAppDrive(store, 'drive', 'mirror');
    records.folder[core.properties.parent] = 'other-drive';
    expect(() => assertSyncAppDrive(store, 'drive', 'mirror')).toThrow(
      'selected drive',
    );
  });

  it('rejects an ancestor move even while the root retains its old drive stamp', () => {
    const records: Record<string, Record<string, unknown>> = {
      mirror: { [DRIVE_PROPERTY]: 'drive', [core.properties.parent]: 'folder' },
      folder: { [DRIVE_PROPERTY]: 'drive', [core.properties.parent]: 'drive' },
      'other-drive': { [core.properties.write]: ['person'] },
    };
    const store = cachedDriveStore(records);
    assertSyncAppDrive(store, 'drive', 'mirror');
    records.folder[core.properties.parent] = 'other-drive';
    expect(() => assertSyncAppDrive(store, 'drive', 'mirror')).toThrow(
      'selected drive',
    );
    expect(records.mirror[DRIVE_PROPERTY]).toBe('drive');
  });

  it('rejects unavailable cached membership and parent cycles', () => {
    const records = { mirror: { [core.properties.parent]: 'missing' } };
    const store = cachedDriveStore(records);
    expect(() => assertSyncAppDrive(store, 'drive', 'missing')).toThrow(
      'selected drive',
    );
    expect(() => assertSyncAppDrive(store, 'drive', 'mirror')).toThrow(
      'selected drive',
    );
    records.mirror[core.properties.parent] = 'mirror';
    expect(() => assertSyncAppDrive(store, 'drive', 'mirror')).toThrow(
      'selected drive',
    );
  });
});

function apiDocument(): OpenApiDocument {
  const operation = (resource: string, collection?: string) => ({
    operationId: collection ?? resource + 'Detail',
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

function setupProxy() {
  const readKeyed = vi.fn(
    async (
      url: URL,
      _signal?: AbortSignal,
      _request?: unknown,
    ): Promise<{
      status: number;
      body: unknown;
      headers: Record<string, string>;
    }> => ({
      status: 200,
      body: url.pathname.endsWith('/session')
        ? { id: 7 }
        : url.pathname.includes('/names/') &&
            !url.pathname.endsWith('/workspaces')
          ? { handle: 'current-handle' }
          : [],
      headers: {},
    }),
  );
  const rememberKeyedPrincipal = vi.fn(async () => undefined);
  const proxy = {
    listKeyed: vi.fn(async () => [
      { connection_id: slot, platform: context.platform },
    ]),
    canReconnectKeyed: vi.fn(async () => true),
    activeKeyedConnection: vi.fn(async () => 'active'),
    readKeyed,
    rememberKeyedPrincipal,
  } as unknown as ProxyConnections;

  return { proxy, readKeyed, rememberKeyedPrincipal };
}

function selected(document = apiDocument()): SyncAppContext {
  return {
    ...context,
    collection: bindCollection(document, {
      collection: 'tasks',
      context: { workspace_id: '13' },
    }),
  };
}

const request = (
  path = 'v2/workspaces/13/tasks',
  patch: Record<string, unknown> = {},
) => ({
  platform: context.platform,
  connectionId: slot,
  path,
  query: { status: 'all' },
  ...patch,
});

describe('generic saved source context', () => {
  it('resolves a promoted principal before its provider App metadata', async () => {
    const { store, resources } = fakeSchemaStore();
    resources.set(core.properties.name, {
      [core.properties.isA]: [core.classes.property],
      [core.properties.datatype]: Datatype.STRING,
      [core.properties.shortname]: 'name',
    });
    const h = await ensureSchema(store, 'drive', syncableHierarchySchema());
    const p = await ensureSchema(store, 'drive', syncablePlatformSchema());
    const config = {
      version: 2 as const,
      proxyOrigin: context.proxyOrigin,
      platform: context.platform,
      principal,
      connectionId: slot,
    };
    const key = sourceKey({ ...config, kind: 'principal' });
    resources.set('principal-app', {
      [core.properties.parent]: 'drive',
      [p.properties['syncable-platform-id']]: context.platform,
      [p.properties['syncable-proxy-origin']]: context.proxyOrigin,
      [h.properties['syncable-source-key']]: key,
      [h.properties['syncable-source-config']]: config,
    });
    expect(
      await syncAppContext(store as unknown as Store, 'drive', 'principal-app'),
    ).toMatchObject({
      kind: 'principal',
      principal,
      connectionId: slot,
      sourceKey: key,
    });
    resources.get('principal-app')![h.properties['syncable-source-config']] = {
      ...config,
      principal: { ...principal, subject: '7' },
    };
    await expect(
      syncAppContext(store as unknown as Store, 'drive', 'principal-app'),
    ).rejects.toThrow('source identity');
  });

  it('keeps moved collection identities and rejects source/config/principal disagreement', async () => {
    const { store, resources } = fakeSchemaStore();
    resources.set(core.properties.name, {
      [core.properties.isA]: [core.classes.property],
      [core.properties.datatype]: Datatype.STRING,
      [core.properties.shortname]: 'name',
    });
    const h = await ensureSchema(store, 'drive', syncableHierarchySchema());
    await ensureSchema(store, 'drive', syncablePlatformSchema());
    const collection = selected().collection!;
    const config = {
      version: 2 as const,
      proxyOrigin: context.proxyOrigin,
      platform: context.platform,
      principal,
      connectionId: slot,
      collection,
    };
    const key = sourceKey({
      ...config,
      kind: 'collection',
      collection: collectionIdentity(collection),
    });
    resources.set('folder', { [core.properties.parent]: 'drive' });
    resources.set(
      'collection',
      JSON.parse(
        JSON.stringify({
          [core.properties.parent]: 'folder',
          [h.properties['syncable-source-key']]: key,
          [h.properties['syncable-source-config']]: config,
        }),
      ),
    );
    expect(
      await syncAppContext(store as unknown as Store, 'drive', 'collection'),
    ).toMatchObject({ ...context, sourceKey: key, collection });
    resources.get('collection')![h.properties['syncable-source-config']] =
      JSON.parse(
        JSON.stringify({
          ...config,
          principal: { ...principal, subject: '7' },
        }),
      );
    await expect(
      syncAppContext(store as unknown as Store, 'drive', 'collection'),
    ).rejects.toThrow('source identity');
    resources.get('folder')![core.properties.parent] = 'other-drive';
    await expect(
      syncAppContext(store as unknown as Store, 'drive', 'collection'),
    ).rejects.toThrow('outside');
  });
});

it('resolves moved child provenance by source identity and revokes it when its source ancestor leaves the drive', async () => {
  const { store, resources } = fakeSchemaStore();
  const runtime = store as unknown as Store;
  runtime.normalizeSubject = value => value;
  const getResource = store.getResource.bind(store);

  store.getResource = async subject => {
    const resource = await getResource(subject);
    runtime.resources.set(subject, resource as unknown as Resource);

    return resource;
  };

  resources.set(core.properties.name, {
    [core.properties.isA]: [core.classes.property],
    [core.properties.datatype]: Datatype.STRING,
    [core.properties.shortname]: 'name',
  });
  const h = await ensureSchema(store, 'drive', syncableHierarchySchema());
  await ensureSchema(store, 'drive', syncablePlatformSchema());
  const doc = apiDocument();
  const record = { id: 13, handle: 'old-handle' };
  const navigation = relatedCollectionReads(doc, {
    resource: 'team',
    record,
  })[0]!;
  const rowKey = sourceKey({
    ...context,
    kind: 'record',
    principal,
    collection: { name: 'myTeams', resource: 'team' },
    parentSourceKey: 'saved-parent-collection',
    remoteId: 13,
  });
  const key = sourceKey({
    ...context,
    kind: 'collection',
    principal,
    collection: collectionIdentity(undefined, navigation),
    parentSourceKey: rowKey,
  });
  const config = {
    version: 2,
    proxyOrigin: context.proxyOrigin,
    platform: context.platform,
    principal,
    connectionId: slot,
  };
  resources.set('source-folder', { [core.properties.parent]: 'drive' });
  resources.set('moved-folder', { [core.properties.parent]: 'drive' });
  resources.set(
    'atomic:source-row',
    JSON.parse(
      JSON.stringify({
        [core.properties.parent]: 'source-folder',
        [h.properties['syncable-source-key']]: rowKey,
        [h.properties['syncable-source-config']]: {
          ...config,
          parentSourceKey: 'saved-parent-collection',
          record,
          resource: 'team',
          context: {},
        },
      }),
    ),
  );
  resources.set(
    'atomic:child',
    JSON.parse(
      JSON.stringify({
        [core.properties.parent]: 'moved-folder',
        [h.properties['syncable-source-key']]: key,
        [h.properties['syncable-source-config']]: {
          ...config,
          navigation,
          parentSourceKey: rowKey,
        },
      }),
    ),
  );
  resources.get('drive')![h.properties['syncable-resource-index']] = {
    [rowKey]: 'atomic:source-row',
  };
  const resolved = await syncAppContext(runtime, 'drive', 'atomic:child');
  expect(resolved.parentRecord?.record).toEqual(record);
  const canonical = canonicalSyncAppContext(resolved, { document: doc });
  expect(canonical.navigation).toEqual(navigation);
  const { proxy, readKeyed } = setupProxy();
  const transport = syncProxyTransport(proxy, canonical, () => undefined, {
    document: doc,
  });
  await transport.request!(request('v2/names/old-handle', { query: {} }));
  const providerReads = readKeyed.mock.calls.length;
  resources.get('source-folder')![core.properties.parent] = 'other-drive';
  // This is the guard used by delayed store writes: no subsequent proxy read.
  expect(() => assertSyncAppContext(canonical)).toThrow('selected drive');
  expect(readKeyed).toHaveBeenCalledTimes(providerReads);
  await expect(
    transport.request!(request('v2/names/old-handle', { query: {} })),
  ).rejects.toThrow('selected drive');
  expect(readKeyed).toHaveBeenCalledTimes(providerReads);
  resources.get('source-folder')![core.properties.parent] = 'drive';
  const parentConfig = resources.get('atomic:source-row')![
    h.properties['syncable-source-config']
  ] as Record<string, unknown>;
  parentConfig.record = { ...record, handle: 'edited-after-response' };
  expect(() => assertSyncAppContext(canonical)).toThrow(
    'source record changed',
  );
  expect(readKeyed).toHaveBeenCalledTimes(providerReads);
});

describe('catalog-derived host relay', () => {
  it('scopes a flat shared table to its exact saved filter and keeps unselected tables read-free', async () => {
    const doc = apiDocument();
    const definition: ReadSelection = {
      version: 1,
      resource: 'task',
      source: { kind: 'bound', bound: selected(doc).collection! },
    };
    const flat: SyncAppContext = {
      ...context,
      resource: 'task',
      rule: {
        subject: 'atomic:rule',
        resource: 'task',
        key: readSelectionKey(definition),
        definition,
      },
    };
    const { proxy, readKeyed } = setupProxy();
    const transport = syncProxyTransport(proxy, flat, () => undefined, {
      document: doc,
    });
    await expect(
      transport.request!(request('v2/workspaces/14/tasks')),
    ).rejects.toThrow('filter');
    expect(readKeyed).not.toHaveBeenCalled();
    await expect(transport.request!(request())).resolves.toMatchObject({
      status: 200,
    });
    expect(readKeyed.mock.calls.map(([url]) => url.pathname)).toEqual([
      expect.stringMatching(/\/calendar-service\/v2\/session$/),
      expect.stringMatching(/\/calendar-service\/v2\/workspaces\/13\/tasks$/),
    ]);
    const count = readKeyed.mock.calls.length;
    const unselected = syncProxyTransport(
      proxy,
      { ...context, resource: 'task' },
      () => undefined,
      { document: doc },
    );
    await expect(unselected.request!(request())).rejects.toThrow('filter');
    expect(readKeyed).toHaveBeenCalledTimes(count);
    expect(() =>
      syncProxyTransport(
        proxy,
        { ...flat, rule: { ...flat.rule!, key: 'forged' } },
        () => undefined,
        { document: doc },
      ),
    ).toThrow('filter');
  });

  it('unlocks only actual-response related partitions and rejects forged sibling targets', async () => {
    const doc = apiDocument();
    const record = { id: 7, name: 'Team', handle: 'old-handle' };
    const definition: ReadSelection = {
      version: 1,
      resource: 'workspace',
      source: {
        kind: 'related',
        origin: {
          entity: resolveEntityIdentity(doc, { resource: 'team', record }),
          record,
          context: {},
          read: bindCollection(doc, { collection: 'myTeams' }),
        },
        via: {
          collection: 'teamWorkspaces',
          kind: 'responseLink',
          reference: 'address',
          link: 'workspaces',
        },
      },
    };
    const { proxy, readKeyed } = setupProxy();
    readKeyed.mockImplementation(async url => ({
      status: 200,
      headers: {},
      body: url.pathname.endsWith('/session')
        ? { id: 7 }
        : url.pathname.endsWith('/names/old-handle')
          ? { id: 7, handle: 'current-handle' }
          : [],
    }));
    const transport = syncProxyTransport(
      proxy,
      {
        ...context,
        resource: 'workspace',
        rule: {
          subject: 'atomic:related-rule',
          resource: 'workspace',
          key: readSelectionKey(definition),
          definition,
        },
      },
      () => undefined,
      { document: doc },
    );
    await expect(
      transport.request!(request('v2/names/forged/workspaces', { query: {} })),
    ).rejects.toThrow('filter');
    await expect(
      transport.request!(
        request('v2/names/current-handle/workspaces', { query: {} }),
      ),
    ).rejects.toThrow('filter');
    expect(readKeyed).not.toHaveBeenCalled();
    await transport.request!(request('v2/names/old-handle', { query: {} }));
    await transport.request!(
      request('v2/names/current-handle/workspaces', { query: {} }),
    );
    const count = readKeyed.mock.calls.length;
    await expect(
      transport.request!(request('v2/names/forged/workspaces', { query: {} })),
    ).rejects.toThrow('filter');
    expect(readKeyed).toHaveBeenCalledTimes(count);
  });

  it('exposes only sanitized connection metadata and native reconnect eligibility', async () => {
    const doc = apiDocument();
    const { proxy, readKeyed } = setupProxy();
    vi.mocked(proxy.listKeyed).mockResolvedValue([
      {
        connection_id: slot,
        platform: context.platform,
        label: '  Account\nname\u0000  ',
        delegations: [],
      },
      {
        connection_id: 'x'.repeat(43),
        platform: context.platform,
        label: 'x'.repeat(200),
        delegations: [],
      },
    ]);
    vi.mocked(proxy.canReconnectKeyed).mockImplementation(
      async (_platform, id) => id === slot,
    );
    const transport = syncProxyTransport(
      proxy,
      {
        ...context,
        kind: 'platform',
        connectionId: undefined,
        principal: undefined,
      },
      () => undefined,
      { document: doc },
    );
    await expect(transport.connections!(context.platform)).resolves.toEqual([
      {
        connectionId: slot,
        platform: context.platform,
        label: 'Accountname',
        canReconnect: true,
      },
      {
        connectionId: 'x'.repeat(43),
        platform: context.platform,
        label: 'x'.repeat(120),
        canReconnect: false,
      },
    ]);
    expect(readKeyed).not.toHaveBeenCalled();
    const scoped = syncProxyTransport(proxy, selected(doc), () => undefined, {
      document: doc,
    });
    await expect(scoped.connections!(context.platform)).resolves.toHaveLength(
      1,
    );
    vi.mocked(proxy.listKeyed).mockClear();
    const publicTransport = syncProxyTransport(
      proxy,
      {
        ...context,
        kind: 'principal',
        principal: { kind: 'public' },
        connectionId: undefined,
      },
      () => undefined,
      { document: doc },
    );
    await expect(
      publicTransport.connections!(context.platform),
    ).resolves.toEqual([]);
    expect(proxy.listKeyed).not.toHaveBeenCalled();
  });

  it('revokes connection metadata when the session changes during eligibility lookup', async () => {
    const doc = apiDocument();
    const { proxy } = setupProxy();
    let current = true;
    vi.mocked(proxy.canReconnectKeyed).mockImplementationOnce(async () => {
      current = false;

      return true;
    });
    const transport = syncProxyTransport(
      proxy,
      selected(doc),
      () => {
        if (!current) throw new Error('Session changed');
      },
      { document: doc },
    );
    await expect(transport.connections!(context.platform)).rejects.toThrow(
      'Session changed',
    );
  });

  it('constructs while paused and blocks provider requests until resumed', async () => {
    const doc = apiDocument();
    const { proxy, readKeyed } = setupProxy();
    let paused = true;
    const transport = syncProxyTransport(
      proxy,
      selected(doc),
      () => undefined,
      { document: doc },
      () => {
        if (paused) throw new Error('Resume before provider reads');
      },
    );
    await expect(transport.request!(request())).rejects.toThrow(
      'Resume before provider reads',
    );
    expect(readKeyed).not.toHaveBeenCalled();
    paused = false;
    await expect(transport.request!(request())).resolves.toMatchObject({
      status: 200,
    });
    expect(readKeyed).toHaveBeenCalledTimes(2);
  });

  it('rechecks pause after a pending principal response before forwarding collection data', async () => {
    const doc = apiDocument();
    const { proxy, readKeyed, rememberKeyedPrincipal } = setupProxy();
    let paused = false;
    let release: (() => void) | undefined;
    const pending = new Promise<void>(resolve => {
      release = resolve;
    });
    const respond = readKeyed.getMockImplementation()!;
    readKeyed.mockImplementation(async (...args) => {
      await pending;

      return respond(...args);
    });
    const transport = syncProxyTransport(
      proxy,
      selected(doc),
      () => undefined,
      { document: doc },
      () => {
        if (paused) throw new Error('Resume before provider reads');
      },
    );
    const read = transport.request!(request());
    await vi.waitFor(() => expect(readKeyed).toHaveBeenCalledOnce());
    paused = true;
    release?.();
    await expect(read).rejects.toThrow('Resume before provider reads');
    expect(readKeyed).toHaveBeenCalledOnce();
    expect(rememberKeyedPrincipal).not.toHaveBeenCalled();
  });

  it('allows only the selected bound read and paging, after fresh typed principal verification', async () => {
    const doc = apiDocument();
    const { proxy, readKeyed, rememberKeyedPrincipal } = setupProxy();
    const transport = syncProxyTransport(
      proxy,
      selected(doc),
      () => undefined,
      { document: doc },
    );
    for (const patch of [
      { path: 'v2/me/teams' },
      { path: 'v2/workspaces/99/tasks' },
      { connectionId: 'other' },
      { platform: 'other' },
      { method: 'DELETE' },
      { body: '{}' },
      { query: { status: 'closed' } },
      { query: { status: 'all', redirect: 'foreign' } },
      { path: 'v2/../session' },
      { path: '//foreign.test/x' },
    ])
      await expect(
        transport.request!(request(undefined, patch)),
      ).rejects.toThrow();
    expect(readKeyed).not.toHaveBeenCalled();
    expect(
      await transport.request!(
        request(undefined, { query: { status: 'all', page: '2' } }),
      ),
    ).toEqual({ status: 200, headers: {}, text: '[]' });
    expect(readKeyed.mock.calls.map(([url]) => url.pathname)).toEqual([
      '/proxy/active/calendar-service/v2/session',
      '/proxy/active/calendar-service/v2/workspaces/13/tasks',
    ]);
    expect(rememberKeyedPrincipal).toHaveBeenCalledWith(
      'calendar-service',
      slot,
      principal,
      'currentPrincipal',
    );
    await transport.request!(request());
    expect(
      readKeyed.mock.calls.filter(([url]) => url.pathname.endsWith('/session')),
    ).toHaveLength(1);
  });
  it('rebinds stored route and request defaults from trusted metadata without widening the collection', () => {
    const doc = apiDocument();
    const saved = selected(doc);
    const edited = {
      ...saved,
      collection: {
        ...saved.collection!,
        path: '/unrelated',
        method: 'POST' as const,
        query: { redirect: 'foreign' },
        body: { filter: 'injected' },
      },
    };
    expect(
      canonicalSyncAppContext(edited, { document: doc }).collection,
    ).toEqual(saved.collection);
    expect(() =>
      canonicalSyncAppContext(
        {
          ...saved,
          collection: { ...saved.collection!, resource: 'unrelated' },
        },
        { document: doc },
      ),
    ).toThrow('selected catalog collection');
  });
  it('rejects numeric/string principal mismatch before collection data', async () => {
    const doc = apiDocument();
    const { proxy, readKeyed } = setupProxy();
    readKeyed.mockResolvedValue({
      status: 200,
      body: { id: '7' },
      headers: {},
    });
    const transport = syncProxyTransport(
      proxy,
      selected(doc),
      () => undefined,
      { document: doc },
    );
    await expect(transport.request!(request())).rejects.toThrow(
      'different authenticated principal',
    );
    expect(readKeyed).toHaveBeenCalledTimes(1);
  });
  it('revokes verified scope when the active credential changes before the collection read', async () => {
    const doc = apiDocument();
    const { proxy, readKeyed, rememberKeyedPrincipal } = setupProxy();
    let active = 'first-active';
    vi.mocked(proxy.activeKeyedConnection).mockImplementation(
      async () => active,
    );
    rememberKeyedPrincipal.mockImplementation(async () => {
      active = 'replacement';
    });
    const transport = syncProxyTransport(
      proxy,
      selected(doc),
      () => undefined,
      { document: doc },
    );
    await expect(transport.request!(request())).rejects.toThrow(
      'changed after identity verification',
    );
    expect(readKeyed).toHaveBeenCalledTimes(1);
    expect(readKeyed.mock.calls[0][0].pathname).toBe(
      '/proxy/first-active/calendar-service/v2/session',
    );
  });
  it('limits platform/principal roots to declared principal operations', async () => {
    const doc = apiDocument();
    const { proxy, readKeyed } = setupProxy();
    const transport = syncProxyTransport(
      proxy,
      {
        ...context,
        kind: 'platform',
        principal: undefined,
        connectionId: undefined,
      },
      () => undefined,
      { document: doc },
    );
    await expect(
      transport.request!(request('v2/me/teams', { query: {} })),
    ).rejects.toThrow('endpoint');
    expect(readKeyed).not.toHaveBeenCalled();
    await transport.request!(request('v2/session', { query: {} }));
    expect(readKeyed).toHaveBeenCalledTimes(1);
  });
  it('allows declared anonymous setup entrypoints only in Public principal scope', async () => {
    const doc = apiDocument();
    const { proxy, readKeyed } = setupProxy();
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => Response.json({ handle: 'canonical' }));
    const publicContext: SyncAppContext = {
      ...context,
      kind: 'principal',
      principal: { kind: 'public' },
      connectionId: undefined,
    };
    const transport = syncProxyTransport(
      proxy,
      publicContext,
      () => undefined,
      { document: doc },
    );
    await transport.request!(
      request('v2/names/explicit-input', {
        connectionId: undefined,
        query: {},
      }),
    );
    await expect(
      transport.request!(
        request('v2/me/teams', { connectionId: undefined, query: {} }),
      ),
    ).rejects.toThrow('endpoint');
    await expect(
      transport.request!(
        request('v2/session', { connectionId: undefined, query: {} }),
      ),
    ).rejects.toThrow('endpoint');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(readKeyed).not.toHaveBeenCalled();
    doc.paths['/names/{handle}']!.get!.security = [{ oauth: [] }];
    await expect(
      syncProxyTransport(proxy, publicContext, () => undefined, {
        document: doc,
      }).request!(
        request('v2/names/explicit-input', {
          connectionId: undefined,
          query: {},
        }),
      ),
    ).rejects.toThrow('endpoint');
  });
  it('bounds provider reads even for repeated declared Public setup requests', async () => {
    const doc = apiDocument();
    const { proxy } = setupProxy();
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => Response.json({ handle: 'canonical' }));
    const transport = syncProxyTransport(
      proxy,
      {
        ...context,
        kind: 'principal',
        principal: { kind: 'public' },
        connectionId: undefined,
      },
      () => undefined,
      { document: doc },
    );
    for (let i = 0; i < 64; i++)
      await transport.request!(
        request('v2/names/explicit-input', {
          connectionId: undefined,
          query: {},
        }),
      );
    await expect(
      transport.request!(
        request('v2/names/explicit-input', {
          connectionId: undefined,
          query: {},
        }),
      ),
    ).rejects.toThrow('budget');
    expect(fetch).toHaveBeenCalledTimes(64);
  });
  it('uses anonymous Public transport only for the selected declared public collection', async () => {
    const doc = apiDocument();
    const { proxy, readKeyed } = setupProxy();
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(Response.json([]));
    const transport = syncProxyTransport(
      proxy,
      {
        ...selected(doc),
        principal: { kind: 'public' },
        connectionId: undefined,
      },
      () => undefined,
      { document: doc },
    );
    await expect(transport.request!(request())).rejects.toThrow('account');
    await expect(
      transport.request!(
        request('v2/session', { connectionId: undefined, query: {} }),
      ),
    ).rejects.toThrow('endpoint');
    await transport.request!(request(undefined, { connectionId: undefined }));
    expect(fetch).toHaveBeenCalledWith(
      expect.objectContaining({
        href: 'https://api.example/v2/workspaces/13/tasks?status=all',
      }),
      expect.objectContaining({
        credentials: 'omit',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
      }),
    );
    expect(readKeyed).not.toHaveBeenCalled();
    doc.paths['/workspaces/{workspace_id}/tasks']!.get!.security = [
      { oauth: [] },
    ];
    expect(() =>
      syncProxyTransport(
        proxy,
        {
          ...selected(doc),
          principal: { kind: 'public' },
          connectionId: undefined,
        },
        () => undefined,
        { document: doc },
      ),
    ).toThrow('principal cannot read');
  });
  it('discards a read after cancellation or source changes', async () => {
    const doc = apiDocument();
    const { proxy, readKeyed } = setupProxy();
    let current = true;
    readKeyed.mockImplementation(async () => {
      current = false;

      return { status: 200, body: { id: 7 }, headers: {} };
    });
    const transport = syncProxyTransport(
      proxy,
      selected(doc),
      () => {
        if (!current) throw new Error('Source changed');
      },
      { document: doc },
    );
    await expect(transport.request!(request())).rejects.toThrow(
      'Source changed',
    );
    expect(readKeyed).toHaveBeenCalledTimes(1);
  });
  it('derives child list scope from the actual declared detail response using replay only', async () => {
    const doc = apiDocument();
    const { proxy, readKeyed } = setupProxy();
    const parent = {
      resource: 'team',
      record: { id: 13, handle: 'old-handle' },
      context: {},
      identity: {
        version: 2 as const,
        proxyOrigin: context.proxyOrigin,
        platform: context.platform,
        kind: 'record' as const,
        principal,
        collection: { name: 'myTeams', resource: 'team' },
        remoteId: 13,
      },
    };
    const navigation = relatedCollectionReads(doc, parent)[0]!;
    const saved = { ...context, navigation, parentRecord: parent };
    const canonical = canonicalSyncAppContext(saved, { document: doc });
    expect(canonical.navigation).toEqual(navigation);
    const transport = syncProxyTransport(proxy, saved, () => undefined, {
      document: doc,
    });
    await expect(
      transport.request!(
        request('v2/names/current-handle/workspaces', { query: {} }),
      ),
    ).rejects.toThrow('endpoint');
    expect(readKeyed).not.toHaveBeenCalled();
    await transport.request!(request('v2/names/old-handle', { query: {} }));
    await transport.request!(
      request('v2/names/current-handle/workspaces', { query: {} }),
    );
    await expect(
      transport.request!(request('v2/names/other/workspaces', { query: {} })),
    ).rejects.toThrow('endpoint');
    expect(readKeyed.mock.calls.map(([url]) => url.pathname)).toEqual([
      '/proxy/active/calendar-service/v2/session',
      '/proxy/active/calendar-service/v2/names/old-handle',
      '/proxy/active/calendar-service/v2/names/current-handle/workspaces',
    ]);
    expect(() =>
      canonicalSyncAppContext(
        {
          ...saved,
          parentRecord: { ...parent, record: { id: '13', handle: 'other' } },
        },
        { document: doc },
      ),
    ).toThrow('source record identity');
  });
});

it('reports only actual catalog-verified typed principal responses to the native host', async () => {
  const { proxy, rememberKeyedPrincipal } = setupProxy();
  const verified = vi.fn();
  const transport = syncProxyTransport(
    proxy,
    selected(),
    () => undefined,
    { document: apiDocument() },
    () => undefined,
    async () => false,
    verified,
  );
  await transport.request!(request());
  expect(rememberKeyedPrincipal).toHaveBeenCalled();
  expect(verified).toHaveBeenCalledWith({
    connectionId: slot,
    principal,
    activeId: 'active',
  });
});

it('inherits a principal App binding for a moved collection and revokes it when the binding changes', async () => {
  const { store, resources } = fakeSchemaStore();
  const runtime = store as unknown as Store;
  runtime.normalizeSubject = value => value;
  runtime.resources.clear();
  const load = store.getResource.bind(store);

  store.getResource = async subject => {
    const row = await load(subject);
    runtime.resources.set(subject, row as unknown as Resource);

    return row;
  };

  resources.set(core.properties.name, {
    [core.properties.isA]: [core.classes.property],
    [core.properties.datatype]: Datatype.STRING,
    [core.properties.shortname]: 'name',
  });
  const h = await ensureSchema(store, 'drive', syncableHierarchySchema());
  const p = await ensureSchema(store, 'drive', syncablePlatformSchema());
  const a = await ensureSchema(store, 'drive', pluginSchema());
  const principalConfig = {
    version: 2 as const,
    platform: context.platform,
    proxyOrigin: context.proxyOrigin,
    principal,
    connectionId: 'n'.repeat(43),
  };
  const principalKey = sourceKey({ ...principalConfig, kind: 'principal' });
  resources.get('drive')![p.properties['syncable-principal-app-index']] = {
    [sourceConfigFingerprint(principalKey)]: 'principal-app',
  };
  resources.set('principal-app', {
    [core.properties.parent]: 'drive',
    [core.properties.isA]: [
      dataBrowser.classes.table,
      a.classes.app,
      h.classes['syncable-principal'],
    ],
    [p.properties['builtin-app']]: 'syncables',
    [p.properties['syncable-platform-id']]: context.platform,
    [p.properties['syncable-proxy-origin']]: context.proxyOrigin,
    [a.properties['app-data']]: 'principal-app',
    [h.properties['syncable-node-kind']]: 'principal',
    [h.properties['syncable-source-key']]: principalKey,
    [h.properties['syncable-source-config']]: principalConfig,
  });
  resources.set('folder', { [core.properties.parent]: 'drive' });
  const config = {
    version: 3 as const,
    kind: 'collection' as const,
    platform: context.platform,
    proxyOrigin: context.proxyOrigin,
    principal,
    resource: 'task',
    connectionId: slot,
  };
  resources.set('moved-collection', {
    [core.properties.parent]: 'folder',
    [h.properties['syncable-source-key']]: entityTableKey(config),
    [h.properties['syncable-source-config']]: config,
  });
  const resolved = await syncAppContext(runtime, 'drive', 'moved-collection');
  expect(resolved).toMatchObject({
    principalApp: 'principal-app',
    connectionId: 'n'.repeat(43),
  });
  expect(config.connectionId).toBe(slot);
  assertSyncAppContext(resolved);
  principalConfig.connectionId = 'x'.repeat(43);
  expect(() => assertSyncAppContext(resolved)).toThrow(
    'principal App connection changed',
  );
});
