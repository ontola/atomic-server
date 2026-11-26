import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Store } from '@tomic/lib';
import { AppExecutionRegistry } from '@chunks/AppPage/AppExecutionRuntime';
import {
  appProfile,
  prepareSyncablePrincipalAppOpen,
} from './BuiltinSyncablesApp';
import type { SyncablePrincipalAppRef } from './syncablePrincipalApp';
import { prepareDocument } from 'syncables/browser';
import { collectSyncableLegacySources } from './syncableLegacy';
import { collectSyncableFlatAdoption } from './syncableFlatAdoption';
import { migrateSyncableApiViews } from './syncableApiSchemaViews';
import { syncableApiSchema } from './syncableApiSchema';
import {
  syncProxyTransport,
  subscribeSyncAppContext,
} from './builtinSyncablesProfile';
import {
  ruleSourceKey,
  sourceConfigFingerprint,
  sourceKey,
} from './builtinSyncIdentity.js';
import { CollectionBuilder, core, dataBrowser } from '@tomic/lib';
import { readSelectionKey } from 'syncables/browser';

const state = vi.hoisted(() => ({
  principalApps: [] as SyncablePrincipalAppRef[],
  queryScope: vi.fn(async (..._args: unknown[]): Promise<boolean> => true),
  promote: vi.fn(async (..._args: unknown[]) => 'atomic:principal-app'),
  actor: { subject: 'atomic:agent:person' },
  installation: 'atomic:installation' as string | undefined,
  kind: 'platform' as 'platform' | 'legacy' | 'collection',
  paused: false,
  boundSlot: undefined as string | undefined,
  flat: false,
  runSchema: false,
  invalidateOrigins: undefined as (() => void) | undefined,
  ruleSubject: undefined as string | undefined,
  ruleStatus: {} as Record<string, unknown>,
  ruleResource: {
    get: vi.fn((_property: string): unknown => undefined),
    getSubjects: vi.fn((_property: string): string[] => []),
    set: vi.fn(async (..._args: unknown[]) => undefined),
    save: vi.fn(async () => undefined),
    canWrite: vi.fn(async () => [true]),
  },
  proxy: {
    preferredKeyedConnection: vi.fn(
      async (..._args: unknown[]): Promise<string | undefined> => undefined,
    ),
    consumePreferredKeyedConnection: vi.fn(
      async (..._args: unknown[]) => undefined,
    ),
    activeKeyedConnection: vi.fn(async () => 'active'),
    keyedPrincipalProvenance: vi.fn(
      async (
        ..._args: unknown[]
      ): Promise<{ principal?: object } | undefined> => undefined,
    ),
    listKeyed: vi.fn(async () => [
      { connection_id: 's'.repeat(43), platform: 'calendar-service' },
    ]),
    canReconnectKeyed: vi.fn(async () => true),
    canReconnectLegacyKeyed: vi.fn(async () => false),
    prepareLegacyKeyedReconnect: vi.fn(
      async (..._args: unknown[]) => undefined,
    ),
    startKeyedReconnect: vi.fn(async () => '/same-slot-reconnect'),
    startKeyed: vi.fn(async () => '/new-account'),
  },
  legacy: { sources: [] as unknown[], warnings: [] as string[] },
  resource: {
    get: vi.fn((_property: string): unknown => undefined),
    getSubjects: vi.fn((_property: string): string[] => []),
    set: vi.fn(),
    save: vi.fn(),
    canWrite: vi.fn(async () => [true]),
  },
  document: {
    openapi: '3.0.3',
    info: { title: 'Fixture', version: '1' },
    servers: [{ url: 'https://api.example/v2' }],
    paths: {},
    components: { crudResources: {} },
  },
}));
vi.mock('@tomic/lib', async importActual => ({
  ...(await importActual<typeof import('@tomic/lib')>()),
  findSchema: vi.fn(async () => ({
    properties: { 'app-data': 'atomic:app-data' },
  })),
}));
vi.mock('@helpers/integrationProxy', () => ({
  getIntegrationProxy: () => 'https://proxy.example',
  useIntegrationProxy: () => 'https://proxy.example',
}));
vi.mock('@helpers/proxyConnections', () => ({
  ProxyConnections: class {
    constructor() {
      Object.assign(this, state.proxy);
    }
  },
}));
vi.mock('@components/AtomicLink', () => ({ AtomicLink: () => null }));
vi.mock('@chunks/AppPage/AppFrame', () => ({ AppFrame: () => null }));
vi.mock('@chunks/AppPage/AppExecutionRuntime', async original => ({
  ...(await original<typeof import('@chunks/AppPage/AppExecutionRuntime')>()),
  useAppExecutions: () => undefined,
}));
vi.mock('../../routes/ShowRoute', () => ({
  ShowRoute: { useSearch: () => undefined },
}));
vi.mock('./syncableDocument', () => ({
  fetchSyncableDocument: vi.fn(async () => ({ document: state.document })),
}));
vi.mock('./syncablePlatform', async importActual => ({
  ...(await importActual<typeof import('./syncablePlatform')>()),
  findSyncablePlatform: vi.fn(async () => state.installation),
  classifySyncableResourceDrive: (...args: unknown[]) =>
    state.queryScope(...args),
}));
vi.mock('./syncablePrincipalApp', () => ({
  listSyncablePrincipalApps: vi.fn(async () => state.principalApps),
  ensureSyncablePrincipalApp: (...args: unknown[]) => state.promote(...args),
}));
vi.mock('./syncableLegacy', () => ({
  collectSyncableLegacySources: vi.fn(async () => state.legacy),
}));
vi.mock('./syncableFlatAdoption', async importActual => ({
  ...(await importActual<typeof import('./syncableFlatAdoption')>()),
  collectSyncableFlatAdoption: vi.fn(async () => ({
    aliases: [],
    blocks: [],
    warnings: [],
  })),
}));
vi.mock('./syncableApiSchemaViews', () => ({
  migrateSyncableApiViews: vi.fn(async () => undefined),
}));
vi.mock('./syncableApiSchema', () => ({
  syncableApiSchema: vi.fn(async () => ({ classes: {}, properties: {} })),
}));
vi.mock('./builtinSyncablesProfile', () => ({
  assertSyncAppDrive: vi.fn(),
  assertSyncAppContext: vi.fn(),
  subscribeSyncAppContext: vi.fn((_context, invalidate: () => void) => {
    state.invalidateOrigins = invalidate;

    return vi.fn();
  }),
  syncAppOriginEntityKeys: vi.fn(() => []),
  syncAppContext: vi.fn(async () => ({
    subject: 'atomic:source',
    drive: 'drive',
    platform: 'calendar-service',
    proxyOrigin: 'https://proxy.example',
    kind: state.kind,
    connectionId: state.boundSlot,
    ...(state.flat
      ? { resource: 'event', sourceKey: 'canonical-table-key' }
      : {}),
    ...(state.ruleSubject
      ? {
          rule: {
            subject: state.ruleSubject,
            key: 'rule-key',
            resource: 'event',
            definition: {
              version: 1,
              resource: 'event',
              source: { kind: 'bound', bound: {} },
            },
          },
        }
      : {}),
    proxyTransport: 'host',
    schema: {
      classes: state.runSchema
        ? { 'syncable-sync-run': 'atomic:run-class' }
        : {},
      properties: {
        'syncable-source-key': 'atomic:source-key',
        'syncable-source-config': 'atomic:source-config',
        'syncable-mirror-status': 'atomic:status',
        ...(state.runSchema ? { 'syncable-sync-run': 'atomic:run' } : {}),
      },
    },
  })),
  canonicalSyncAppContext: vi.fn(context => context),
  // Session validation is required during construction, before any provider call.
  syncProxyTransport: vi.fn(
    (
      _proxy,
      _context,
      assertSession: () => void,
      _trusted,
      assertRead: () => void = () => undefined,
      _canReconnectLegacy?: (slot: string) => Promise<boolean>,
    ) => {
      assertSession();

      return {
        origin: 'https://proxy.example',
        request: vi.fn(async () => {
          assertSession();
          assertRead();

          return { status: 200, headers: {}, text: '[]' };
        }),
      };
    },
  ),
}));
const store = {
  getAgent: () => state.actor,
  getServerUrl: () => 'https://node.example',
  getDrive: () => 'drive',
  resources: new Map(),
  getResource: vi.fn(async () => state.resource),
  subscribe: vi.fn(() => () => undefined),
} as unknown as Store;
const registry = {
  isRunning: vi.fn(() => false),
  isQueued: vi.fn(() => false),
  pageProgress: vi.fn(() => undefined),
  start: vi.fn(async () => undefined),
  cancel: vi.fn(),
  ready: vi.fn(),
} as unknown as AppExecutionRegistry;
const open = (
  worker = false,
  ruleSubject?: string,
  signal = new AbortController().signal,
) =>
  appProfile(
    store,
    'drive',
    'atomic:source',
    registry,
    signal,
    worker,
    undefined,
    ruleSubject,
  );
beforeEach(() => {
  vi.clearAllMocks();
  state.invalidateOrigins = undefined;
  vi.mocked(collectSyncableFlatAdoption).mockResolvedValue({
    aliases: [],
    blocks: [],
    warnings: [],
    rules: [],
  });
  vi.mocked(collectSyncableLegacySources).mockImplementation(
    async () => state.legacy as never,
  );
  vi.mocked(migrateSyncableApiViews).mockResolvedValue(undefined);
  vi.stubGlobal('location', { href: 'https://node.example/current' });
  vi.stubGlobal('localStorage', {});
  state.actor = { subject: 'atomic:agent:person' };
  state.principalApps = [];
  state.queryScope.mockResolvedValue(true);
  state.promote.mockResolvedValue('atomic:principal-app');
  state.proxy.preferredKeyedConnection.mockResolvedValue(undefined);
  state.proxy.activeKeyedConnection.mockResolvedValue('active');
  state.proxy.keyedPrincipalProvenance.mockResolvedValue(undefined);
  state.boundSlot = undefined;
  state.flat = false;
  state.runSchema = false;
  state.ruleSubject = undefined;
  state.ruleStatus = {};
  state.resource.getSubjects.mockReturnValue([]);
  state.ruleResource.getSubjects.mockReturnValue([dataBrowser.classes.view]);
  state.ruleResource.get.mockImplementation(property =>
    property === 'atomic:status' ? state.ruleStatus : undefined,
  );
  state.ruleResource.set.mockImplementation(
    async (property, value, _save, _options, guard) => {
      (guard as (() => void) | undefined)?.();
      if (property === 'atomic:status')
        state.ruleStatus = value as Record<string, unknown>;
    },
  );
  state.proxy.listKeyed.mockResolvedValue([
    { connection_id: 's'.repeat(43), platform: 'calendar-service' },
  ]);
  state.proxy.canReconnectKeyed.mockResolvedValue(true);
  state.proxy.canReconnectLegacyKeyed.mockResolvedValue(false);
  state.proxy.prepareLegacyKeyedReconnect.mockImplementation(
    async (...args) => {
      (args[4] as () => void)();
    },
  );
  state.proxy.startKeyedReconnect.mockResolvedValue('/same-slot-reconnect');
  state.proxy.startKeyed.mockResolvedValue('/new-account');
  state.installation = 'atomic:installation';
  state.kind = 'platform';
  state.paused = false;
  state.resource.get.mockImplementation(property =>
    property === 'atomic:status' ? { paused: state.paused } : undefined,
  );
  state.legacy = { sources: [], warnings: [] };
  vi.mocked(store.getResource).mockImplementation(
    async subject =>
      (subject === state.ruleSubject
        ? state.ruleResource
        : state.resource) as never,
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it('passes the scoped OAuth return to the platform chooser', async () => {
  const connectionId = 'n'.repeat(43);
  state.proxy.preferredKeyedConnection.mockResolvedValue(connectionId);

  const spec = await open();

  expect(state.proxy.preferredKeyedConnection).toHaveBeenCalledWith(
    { drive: 'drive', app: 'atomic:source' },
    'calendar-service',
  );
  expect(spec.profile.context).toMatchObject({
    preferredConnectionId: connectionId,
  });
  expect(state.proxy.consumePreferredKeyedConnection).not.toHaveBeenCalled();
});

it('keeps the OAuth return out of a collection profile', async () => {
  state.kind = 'collection';
  state.proxy.preferredKeyedConnection.mockResolvedValue('n'.repeat(43));

  const spec = await open();

  expect(state.proxy.preferredKeyedConnection).not.toHaveBeenCalled();
  expect(spec.profile.context).not.toHaveProperty('preferredConnectionId');
});

it('reconnects only the explicitly requested owned verified connection from the platform root', async () => {
  const spec = await open();
  await expect(
    spec.profile.connect!('calendar-service', 's'.repeat(43)),
  ).resolves.toBe('/same-slot-reconnect');
  expect(state.proxy.startKeyedReconnect).toHaveBeenCalledWith(
    { drive: 'drive', app: 'atomic:source', appAgent: 'atomic:agent:person' },
    'calendar-service',
    's'.repeat(43),
    'https://node.example/current',
    'Atomic Syncables',
  );
  expect(state.proxy.startKeyed).not.toHaveBeenCalled();
});

it('starts a separate account connection when no root connection is requested', async () => {
  const spec = await open();
  await expect(spec.profile.connect!('calendar-service')).resolves.toBe(
    '/new-account',
  );
  expect(state.proxy.startKeyedReconnect).not.toHaveBeenCalled();
});

it('rejects malformed, unknown, wrong-platform and unverified reconnect requests without creating a replacement', async () => {
  const spec = await open();
  await expect(
    spec.profile.connect!('calendar-service', 'bad'),
  ).rejects.toThrow('connection');
  await expect(
    spec.profile.connect!('other-service', 's'.repeat(43)),
  ).rejects.toThrow('platform');
  await expect(
    spec.profile.connect!('calendar-service', 'x'.repeat(43)),
  ).rejects.toThrow('connection');
  state.proxy.canReconnectKeyed.mockResolvedValue(false);
  await expect(
    spec.profile.connect!('calendar-service', 's'.repeat(43)),
  ).rejects.toThrow('reconnect');
  expect(state.proxy.startKeyedReconnect).not.toHaveBeenCalled();
  expect(state.proxy.startKeyed).not.toHaveBeenCalled();
});

it('cannot switch the connection of a selected source', async () => {
  state.kind = 'collection';
  state.boundSlot = 's'.repeat(43);
  const spec = await open();
  await expect(
    spec.profile.connect!('calendar-service', 'x'.repeat(43)),
  ).rejects.toThrow('connection');
  await expect(spec.profile.connect!('calendar-service')).resolves.toBe(
    '/same-slot-reconnect',
  );
  expect(state.proxy.startKeyed).not.toHaveBeenCalled();
});

it('revokes a reconnect handoff when the signed-in actor changes during its creation', async () => {
  const spec = await open();
  state.proxy.startKeyedReconnect.mockImplementationOnce(async () => {
    state.actor = { subject: 'atomic:other-person' };

    return '/must-not-navigate';
  });
  await expect(
    spec.profile.connect!('calendar-service', 's'.repeat(43)),
  ).rejects.toThrow();
});
it('passes validated installation aliases and blocking warnings into the existing scoped host', async () => {
  const alias = {
    subject: 'atomic:old-principal',
    kind: 'principal',
    connectionId: 's'.repeat(43),
  };
  state.legacy = {
    sources: [alias],
    warnings: ['A saved source is ambiguous.'],
  };
  const spec = await open();
  expect(collectSyncableLegacySources).toHaveBeenCalledWith(
    store,
    expect.objectContaining({
      app: 'atomic:installation',
      appDataProperty: 'atomic:app-data',
      drive: 'drive',
      platform: 'calendar-service',
      proxyOrigin: 'https://proxy.example',
      currentSourceIsLegacy: false,
      collections: [],
    }),
  );
  expect(spec.profile.context).toMatchObject({
    legacySources: [alias],
    legacyWarnings: state.legacy.warnings,
    legacyMigrationBlocked: true,
  });
  expect(spec.profile.access?.root).toBe('atomic:source');
  expect(spec.profile).toHaveProperty('authoritativeQueries', true);
  expect(syncProxyTransport).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ subject: 'atomic:source' }),
    expect.any(Function),
    expect.objectContaining({ document: state.document }),
    expect.any(Function),
    expect.any(Function),
    expect.any(Function),
    expect.any(Function),
    undefined,
  );
});

it('passes an exact Public item-type block for an unsupported v1 cache even when no legacy warnings exist', async () => {
  state.legacy = {
    warnings: [],
    sources: [
      {
        subject: 'atomic:old-public-table',
        kind: 'collection',
        principal: { kind: 'public' },
        collection: { name: 'projectIssues', resource: 'issue' },
        sourceKey: JSON.stringify([
          'https://proxy.example',
          'calendar-service',
          'public-mirror',
          'project',
          'issues',
        ]),
      },
    ],
  };
  const spec = await open();
  expect(spec.profile.context).toMatchObject({
    legacyMigrationBlocked: false,
    flatMigrationBlocks: [
      {
        principal: { kind: 'public' },
        resource: 'issue',
        message: expect.stringContaining('historical identity review'),
      },
    ],
  });
  expect(state.resource.set).not.toHaveBeenCalled();
});

it('prepares a legacy slot only on explicit reconnect and rechecks its saved source before marker mutation', async () => {
  const slot = 's'.repeat(43);
  const config = { connectionId: slot, ownerLogin: 'historical-label' };
  const principal = {
    kind: 'authenticated',
    namespace: 'https://identity.example',
    subject: 408412,
  };
  const alias = {
    subject: 'atomic:old-account',
    kind: 'principal',
    connectionId: slot,
    principal,
    sourceKey: 'old-source',
    localId: 'old-local',
    sourceConfigFingerprint: sourceConfigFingerprint(config),
  };
  state.legacy.sources = [alias];
  let savedConfig = config;
  const row = {
    get: (property: string) =>
      property === 'atomic:source-key'
        ? alias.sourceKey
        : property === core.properties.localId
          ? alias.localId
          : property === 'atomic:source-config'
            ? savedConfig
            : undefined,
  };
  vi.mocked(store.getResource).mockImplementation(
    async subject =>
      (subject === alias.subject ? row : state.resource) as never,
  );
  state.proxy.canReconnectKeyed.mockResolvedValue(false);
  state.proxy.canReconnectLegacyKeyed.mockResolvedValue(true);
  const spec = await open();
  expect(state.proxy.prepareLegacyKeyedReconnect).not.toHaveBeenCalled();
  const eligibility = vi.mocked(syncProxyTransport).mock.calls.at(-1)![5]!;
  await expect(eligibility(slot)).resolves.toBe(true);
  expect(state.proxy.prepareLegacyKeyedReconnect).not.toHaveBeenCalled();
  await expect(spec.profile.connect!('calendar-service', slot)).resolves.toBe(
    '/same-slot-reconnect',
  );
  expect(state.proxy.prepareLegacyKeyedReconnect).toHaveBeenCalledWith(
    'calendar-service',
    slot,
    principal,
    [],
    expect.any(Function),
  );
  expect(state.proxy.startKeyed).not.toHaveBeenCalled();
  state.proxy.prepareLegacyKeyedReconnect.mockClear();
  state.proxy.startKeyedReconnect.mockClear();
  state.proxy.prepareLegacyKeyedReconnect.mockImplementationOnce(
    async (...args) => {
      savedConfig = { ...config, ownerLogin: 'changed-during-preparation' };
      (args[4] as () => void)();
    },
  );
  await expect(spec.profile.connect!('calendar-service', slot)).rejects.toThrow(
    'saved account source changed',
  );
  expect(state.proxy.startKeyedReconnect).not.toHaveBeenCalled();
});
it('rejects unresolved legacy sources before schema installation or frame mounting and retains a validated installation link', async () => {
  state.kind = 'legacy';
  await expect(open()).rejects.toMatchObject({
    installationApp: 'atomic:installation',
    message: expect.stringContaining('no replacement'),
  });
  expect(collectSyncableLegacySources).toHaveBeenCalledWith(
    store,
    expect.objectContaining({ currentSourceIsLegacy: true }),
  );
  expect(syncableApiSchema).not.toHaveBeenCalled();
  expect(syncProxyTransport).not.toHaveBeenCalled();
});
it('does not create a replacement when its installation cannot be validated', async () => {
  state.installation = undefined;
  await expect(open()).rejects.toThrow('installation is unavailable');
  expect(collectSyncableLegacySources).not.toHaveBeenCalled();
  expect(syncableApiSchema).not.toHaveBeenCalled();
});

it('authorizes only stored resources under its captured Drive and rejects external targets before fetching', async () => {
  const spec = await open();
  const original = vi.mocked(store.getResource).getMockImplementation()!;

  try {
    vi.mocked(store.getResource).mockImplementation(
      async subject =>
        ({
          subject,
          get: (property: string) =>
            property === core.properties.parent
              ? subject === 'atomic:own-row'
                ? 'drive'
                : 'atomic:another-drive'
              : undefined,
        }) as never,
    );
    await expect(
      spec.profile.authorizeRead!('atomic:own-row'),
    ).resolves.toBeUndefined();
    await expect(
      spec.profile.authorizeRead!('atomic:foreign-row'),
    ).rejects.toThrow('selected drive');
    vi.mocked(store.getResource).mockClear();
    for (const subject of [
      'https://foreign.example/row',
      'https://person@node.example/row',
      'https://node.example/row#fragment',
      'malformed',
    ])
      await expect(spec.profile.authorizeRead!(subject)).rejects.toThrow();
    expect(store.getResource).not.toHaveBeenCalled();
  } finally {
    vi.mocked(store.getResource).mockImplementation(original);
  }
});

it('classifies complete query members under the captured Drive and fails closed on unknown ancestry or revoked session', async () => {
  const spec = await open();
  await expect(
    spec.profile.queryMemberInScope!('atomic:own-row'),
  ).resolves.toBe(true);
  expect(state.queryScope).toHaveBeenCalledWith(
    store,
    'drive',
    'atomic:own-row',
  );
  state.queryScope.mockResolvedValueOnce(false);
  await expect(
    spec.profile.queryMemberInScope!('atomic:foreign-row'),
  ).resolves.toBe(false);
  state.queryScope.mockRejectedValueOnce(new Error('Ancestry unknown'));
  await expect(
    spec.profile.queryMemberInScope!('atomic:unknown'),
  ).rejects.toThrow('Ancestry unknown');
  state.queryScope.mockImplementationOnce(async () => {
    state.actor = { subject: 'atomic:agent:other' };

    return true;
  });
  await expect(
    spec.profile.queryMemberInScope!('atomic:own-row'),
  ).rejects.toThrow('changed');
});

it('rechecks the native read session after awaited Drive ancestry validation', async () => {
  const controller = new AbortController();
  const spec = await open(false, undefined, controller.signal);
  const original = vi.mocked(store.getResource).getMockImplementation()!;

  try {
    vi.mocked(store.getResource).mockImplementation(async subject => {
      controller.abort();

      return {
        subject,
        get: (property: string) =>
          property === core.properties.parent ? 'drive' : undefined,
      } as never;
    });
    await expect(
      spec.profile.authorizeRead!('atomic:own-row'),
    ).rejects.toThrow();
  } finally {
    vi.mocked(store.getResource).mockImplementation(original);
  }
});

it('mounts a paused interactive profile while rejecting provider reads and worker starts until resumed', async () => {
  state.kind = 'collection';
  state.paused = true;
  const spec = await open();
  expect(spec.profile.context).toMatchObject({
    kind: 'collection',
    worker: false,
  });
  const request = {
    platform: 'calendar-service',
    path: 'v2/items',
    method: 'GET',
  };
  await expect(spec.profile.proxy!.request!(request)).rejects.toThrow(
    'Resume this collection',
  );
  await expect(spec.profile.execution!('start')).rejects.toThrow(
    'Resume this collection',
  );
  expect(registry.start).not.toHaveBeenCalled();
  state.paused = false;
  await expect(spec.profile.proxy!.request!(request)).resolves.toMatchObject({
    status: 200,
  });
  await expect(spec.profile.execution!('start')).resolves.toEqual({
    running: false,
    queued: false,
  });
  expect(registry.start).toHaveBeenCalledOnce();
});

it('uses filter-scoped pause and execution while keeping writes rooted at the canonical table', async () => {
  state.kind = 'collection';
  state.flat = true;
  state.ruleSubject = 'atomic:rule-one';
  state.ruleStatus = { paused: true };
  const spec = await open(false, state.ruleSubject);
  expect(spec.profile.access.root).toBe('atomic:source');
  await expect(spec.profile.execution!('start')).rejects.toThrow('Resume');
  state.ruleStatus = { paused: false, enabled: true };
  await spec.profile.execution!('start');
  expect(registry.start).toHaveBeenCalledWith(
    JSON.stringify(['drive', 'atomic:source', 'atomic:rule-one']),
    expect.any(Function),
    expect.objectContaining({
      group: JSON.stringify(['drive', 'atomic:source']),
      subscribe: expect.any(Function),
      failed: expect.any(Function),
    }),
  );
  await spec.profile.execution!('cancel');
  expect(registry.cancel).toHaveBeenCalledWith(
    JSON.stringify(['drive', 'atomic:source', 'atomic:rule-one']),
  );
});

it('creates the generation only when the queued worker is prepared and rejects stale worker writes', async () => {
  state.kind = 'collection';
  state.flat = true;
  state.ruleSubject = 'atomic:rule-one';
  const controller = new AbortController();
  const interactive = await open(false, state.ruleSubject, controller.signal);
  await interactive.profile.execution!('start');
  expect(state.ruleResource.set).not.toHaveBeenCalled();
  const prepare = vi.mocked(registry.start).mock.calls.at(-1)![1];
  controller.abort();
  const worker = await prepare(new AbortController().signal);
  expect(worker.profile.context?.rule).toMatchObject({
    run: {
      generation: expect.any(String),
      runId: expect.any(String),
      startOrder: expect.any(Number),
    },
  });
  expect(state.resource.set).not.toHaveBeenCalled();
  worker.profile.access.assertCurrent();
  state.ruleStatus = {
    ...state.ruleStatus,
    run: { generation: 'new', runId: 'other', startOrder: Date.now() + 1 },
  };
  expect(() => worker.profile.access.assertCurrent()).toThrow(
    'no longer current',
  );
});

it('rejects a queued scope changed before activation and requires a rule for flat collection execution', async () => {
  state.kind = 'collection';
  state.flat = true;
  const noRule = await open();
  await expect(noRule.profile.execution!('start')).rejects.toThrow(
    'saved filter',
  );
  state.ruleSubject = 'atomic:rule-one';
  const spec = await open(false, state.ruleSubject);
  await spec.profile.execution!('start');
  const prepare = vi.mocked(registry.start).mock.calls.at(-1)![1];
  state.resource.get.mockImplementation(property =>
    property === 'atomic:source-config' ? { changed: true } : undefined,
  );
  await expect(prepare(new AbortController().signal)).rejects.toThrow(
    'source, account or server changed',
  );
  expect(state.ruleResource.set).not.toHaveBeenCalled();
});

it('advances beyond durable orders across filters and run ledgers after a clock rollback', async () => {
  state.kind = 'collection';
  state.flat = true;
  state.runSchema = true;
  state.ruleSubject = 'atomic:rule-one';
  state.ruleStatus = {
    run: { generation: 'previous', runId: 'previous', startOrder: 100 },
  };
  const definition = {
    version: 1 as const,
    resource: 'event',
    source: {
      kind: 'bound' as const,
      bound: {
        collection: 'events',
        resource: 'event',
        method: 'GET' as const,
        path: '/events',
        pathParams: {},
        query: {},
        body: {},
      },
    },
  };
  const key = readSelectionKey(definition);
  const futureView = {
    get: (property: string) =>
      property === core.properties.parent
        ? 'atomic:source'
        : property === 'atomic:source-config'
          ? {
              version: 3,
              kind: 'rule',
              resource: 'event',
              definition,
              ruleKey: key,
            }
          : property === 'atomic:source-key'
            ? ruleSourceKey('canonical-table-key', key)
            : property === 'atomic:status'
              ? {
                  run: {
                    generation: 'future',
                    runId: 'future',
                    startOrder: 7_000_000_000_000_000,
                  },
                }
              : undefined,
    getSubjects: () => [dataBrowser.classes.view],
  };
  const ledger = {
    get: (property: string) =>
      property === core.properties.parent
        ? 'atomic:future-rule'
        : property === 'atomic:run'
          ? {
              ruleSubject: 'atomic:future-rule',
              ruleKey: key + ':historical-definition',
              startOrder: 8_000_000_000_000_000,
            }
          : undefined,
  };
  state.resource.getSubjects.mockReturnValue(['atomic:future-rule']);
  vi.mocked(store.getResource).mockImplementation(
    async subject =>
      (subject === 'atomic:future-rule'
        ? futureView
        : subject === 'atomic:future-ledger'
          ? ledger
          : subject === state.ruleSubject
            ? state.ruleResource
            : state.resource) as never,
  );
  vi.spyOn(CollectionBuilder.prototype, 'build').mockReturnValue({
    waitForReady: async () => undefined,
    totalMembers: 1,
    getAllMembers: async () => ['atomic:future-ledger'],
  } as never);
  vi.spyOn(Date, 'now').mockReturnValue(10);
  const worker = await open(true, state.ruleSubject);
  expect(
    (worker.profile.context!.rule as { run: { startOrder: number } }).run
      .startOrder,
  ).toBeGreaterThan(8_000_000_000_000_000);
});

const chosenPrincipal = {
  kind: 'authenticated' as const,
  namespace: 'https://identity.example',
  subject: 7,
};
const chosenSlot = 's'.repeat(43);

function principalPreparation(
  principal: typeof chosenPrincipal | { kind: 'public' } = chosenPrincipal,
) {
  const context = {
    subject: 'atomic:source',
    drive: 'drive',
    proxyOrigin: 'https://proxy.example',
    platform: 'calendar-service',
    kind: 'platform' as const,
    proxyTransport: 'host' as const,
    schema: {
      classes: {},
      properties: {
        'syncable-source-key': 'atomic:source-key',
        'syncable-source-config': 'atomic:source-config',
      },
    },
  };
  const config = {
    version: 2 as const,
    platform: context.platform,
    proxyOrigin: context.proxyOrigin,
    principal,
    ...(principal.kind === 'authenticated' ? { connectionId: chosenSlot } : {}),
  };
  const key = sourceKey({ ...config, kind: 'principal' });
  const row = {
    subject: 'atomic:chosen',
    get: (property: string) =>
      property === 'atomic:source-key'
        ? key
        : property === 'atomic:source-config'
          ? config
          : undefined,
  };
  vi.mocked(store.getResource).mockResolvedValue(row as never);
  const document = prepareDocument({
    ...state.document,
    paths: {
      '/session': {
        get: {
          operationId: 'currentPrincipal',
          security: [{ oauth: [] }],
          'x-authenticated-principal': {
            kind: 'user',
            namespace: chosenPrincipal.namespace,
            subject: '$response.body#/id',
            identifier: { scope: 'provider', stable: true, reassigned: false },
          },
          responses: { '200': { description: 'Current identity' } },
        },
      },
    },
  });

  return {
    row,
    config,
    options: {
      store,
      drive: 'drive',
      setup: 'atomic:source',
      context,
      trusted: { document },
      proxy:
        state.proxy as unknown as import('@helpers/proxyConnections').ProxyConnections,
      verified: new Map([
        [
          chosenSlot,
          {
            connectionId: chosenSlot,
            principal: chosenPrincipal,
            activeId: 'active',
          },
        ],
      ]),
      principalApps: [] as SyncablePrincipalAppRef[],
      assertCurrent: vi.fn(),
    },
  };
}

it('promotes only the catalog-verified typed principal through native preparation', async () => {
  const { options } = principalPreparation();
  await expect(
    prepareSyncablePrincipalAppOpen(options, 'atomic:chosen'),
  ).resolves.toBe('atomic:principal-app');
  expect(state.promote).toHaveBeenCalledWith(
    store,
    expect.objectContaining({
      setup: 'atomic:source',
      subject: 'atomic:chosen',
      principal: chosenPrincipal,
      providerName: 'Fixture',
    }),
  );
});

it('rejects a forged principal even when its editable key and config agree', async () => {
  const { options } = principalPreparation({ ...chosenPrincipal, subject: 8 });
  await expect(
    prepareSyncablePrincipalAppOpen(options, 'atomic:chosen'),
  ).rejects.toThrow('principal');
  expect(state.promote).not.toHaveBeenCalled();
});

it('does not promote after the observed connection slot changes', async () => {
  const { options } = principalPreparation();
  state.proxy.activeKeyedConnection.mockResolvedValue('replacement');
  await expect(
    prepareSyncablePrincipalAppOpen(options, 'atomic:chosen'),
  ).rejects.toThrow('connection changed');
  expect(state.promote).not.toHaveBeenCalled();
});

it('can promote a historical principal using host-held typed proof without a provider read', async () => {
  const { options } = principalPreparation();
  options.verified.clear();
  state.proxy.keyedPrincipalProvenance.mockResolvedValue({
    principal: chosenPrincipal,
  });
  await expect(
    prepareSyncablePrincipalAppOpen(options, 'atomic:chosen'),
  ).resolves.toBe('atomic:principal-app');
  expect(state.proxy.keyedPrincipalProvenance).toHaveBeenCalledWith(
    'calendar-service',
    chosenSlot,
  );
});

it('opens an existing registered principal App without refreshing or changing its connection', async () => {
  const { options } = principalPreparation();
  options.verified.clear();
  const ref = {
    subject: 'atomic:chosen',
    principal: chosenPrincipal,
    name: 'Custom App',
  };
  options.principalApps = [ref];
  state.principalApps = [ref];
  await expect(
    prepareSyncablePrincipalAppOpen(options, 'atomic:chosen'),
  ).resolves.toBe('atomic:chosen');
  expect(state.promote).not.toHaveBeenCalled();
  expect(state.proxy.keyedPrincipalProvenance).not.toHaveBeenCalled();
});

it('does not install a Public App for a catalog without anonymous reads', async () => {
  const { options } = principalPreparation({ kind: 'public' });
  options.verified.clear();
  await expect(
    prepareSyncablePrincipalAppOpen(options, 'atomic:chosen'),
  ).rejects.toThrow('Public App');
  expect(state.promote).not.toHaveBeenCalled();
});

it('rechecks the native session after loading a promotion candidate', async () => {
  const { options } = principalPreparation();
  let active = true;
  options.assertCurrent = vi.fn(() => {
    if (!active) throw new Error('Account changed');
  });
  const load = vi.mocked(store.getResource).getMockImplementation()!;
  vi.mocked(store.getResource).mockImplementation(async subject => {
    const result = await load(subject);
    active = false;

    return result;
  });
  await expect(
    prepareSyncablePrincipalAppOpen(options, 'atomic:chosen'),
  ).rejects.toThrow('Account changed');
  expect(state.promote).not.toHaveBeenCalled();
});

it('keeps an existing binding when discovery verifies an older orphan slot', async () => {
  const { options } = principalPreparation();
  const ref = {
    subject: 'atomic:chosen',
    principal: chosenPrincipal,
    name: 'Saved App',
  };
  options.principalApps = [ref];
  state.principalApps = [ref];
  options.verified.set('o'.repeat(43), {
    connectionId: 'o'.repeat(43),
    principal: chosenPrincipal,
    activeId: 'active',
  });
  await expect(
    prepareSyncablePrincipalAppOpen(options, 'atomic:chosen'),
  ).resolves.toBe('atomic:chosen');
  expect(state.promote).not.toHaveBeenCalled();
});

it('updates the existing binding only for a matching explicit OAuth selection and consumes it after success', async () => {
  const { options } = principalPreparation();
  const ref = {
    subject: 'atomic:chosen',
    principal: chosenPrincipal,
    name: 'Saved App',
  };
  options.principalApps = [ref];
  state.principalApps = [ref];
  const next = 'n'.repeat(43);
  options.verified.set(next, {
    connectionId: next,
    principal: chosenPrincipal,
    activeId: 'active',
  });
  state.proxy.preferredKeyedConnection.mockResolvedValue(next);
  await expect(
    prepareSyncablePrincipalAppOpen(options, 'atomic:chosen'),
  ).resolves.toBe('atomic:principal-app');
  expect(state.promote).toHaveBeenCalledWith(
    store,
    expect.objectContaining({ connectionId: next }),
  );
  expect(state.proxy.consumePreferredKeyedConnection).toHaveBeenCalledWith(
    { drive: 'drive', app: 'atomic:source' },
    'calendar-service',
    next,
  );
});

it.each([undefined, 'atomic:selected-rule'])(
  'prepares canonical collection controls without waiting for unrelated migration scans (filter=%s)',
  async ruleSubject => {
    state.kind = 'collection';
    state.flat = true;
    state.ruleSubject = ruleSubject;
    const blocked = new Promise<never>(() => undefined);
    vi.mocked(collectSyncableFlatAdoption).mockReturnValue(blocked);
    vi.mocked(collectSyncableLegacySources).mockReturnValue(blocked);
    vi.mocked(migrateSyncableApiViews).mockReturnValue(blocked);
    let timeout: ReturnType<typeof setTimeout> | undefined;

    try {
      const spec = await Promise.race([
        open(false, ruleSubject),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error('Controls waited for unrelated rows')),
            100,
          );
        }),
      ]);
      expect(spec.profile.context).toMatchObject({
        kind: 'collection',
        resource: 'event',
        worker: false,
      });
      expect(spec.profile.access.root).toBe('atomic:source');
      expect(spec.profile.proxy).toBeDefined();
      expect(spec.profile.execution).toBeDefined();
      expect(collectSyncableFlatAdoption).not.toHaveBeenCalled();
      expect(collectSyncableLegacySources).not.toHaveBeenCalled();
      expect(migrateSyncableApiViews).not.toHaveBeenCalled();
      expect(syncableApiSchema).toHaveBeenCalled();
      expect(state.resource.set).not.toHaveBeenCalled();
      expect(state.ruleResource.set).not.toHaveBeenCalled();
    } finally {
      clearTimeout(timeout);
    }
  },
);

it.each(['preparing', 'active'])(
  'revokes accepted %s execution when a stored rule origin is invalidated',
  async phase => {
    state.kind = 'collection';
    state.flat = true;
    state.ruleSubject = 'atomic:rule';
    const runs = new AppExecutionRegistry();
    const interactive = await appProfile(
      store,
      'drive',
      'atomic:source',
      runs,
      new AbortController().signal,
      false,
      undefined,
      state.ruleSubject,
    );
    let release!: () => void;
    const waiting = new Promise<void>(resolve => {
      release = resolve;
    });
    if (phase === 'preparing')
      vi.mocked(collectSyncableFlatAdoption).mockImplementationOnce(
        async () => {
          await waiting;

          return { aliases: [], blocks: [], warnings: [], rules: [] };
        },
      );
    const observed: boolean[] = [];
    const key = JSON.stringify(['drive', 'atomic:source', state.ruleSubject]);
    runs.subscribe(() => observed.push(runs.isRunning(key)));
    await interactive.profile.execution!('start');
    expect(vi.mocked(subscribeSyncAppContext)).toHaveBeenCalled();
    if (phase === 'active')
      await vi.waitFor(() => expect(runs.getSnapshot()).toHaveLength(1));
    const active = runs.getSnapshot()[0];
    expect(runs.isRunning(key)).toBe(true);
    expect(state.invalidateOrigins).toBeDefined();
    state.invalidateOrigins!();
    expect(runs.isRunning(key)).toBe(false);
    expect(runs.getSnapshot()).toEqual([]);
    expect(observed.at(-1)).toBe(false);
    if (active) expect(active.controller.signal.aborted).toBe(true);
    release();
    await Promise.resolve();
    await Promise.resolve();
    expect(runs.getSnapshot()).toEqual([]);
    runs.clear();
  },
);

it('still waits for complete adoption evidence when the actual canonical worker is prepared', async () => {
  state.kind = 'collection';
  state.flat = true;
  state.ruleSubject = 'atomic:selected-rule';
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>(resolve => {
    release = resolve;
  });
  const scanning = new Promise<void>(resolve => {
    entered = resolve;
  });
  vi.mocked(collectSyncableFlatAdoption).mockImplementation(async () => {
    entered();
    await gate;

    return { aliases: [], blocks: [], warnings: [], rules: [] };
  });
  let prepared = false;
  const operation = open(true, state.ruleSubject).then(spec => {
    prepared = true;

    return spec;
  });
  await scanning;
  expect(prepared).toBe(false);
  expect(state.ruleResource.set).not.toHaveBeenCalled();
  release();
  const worker = await operation;
  expect(prepared).toBe(true);
  expect(collectSyncableLegacySources).toHaveBeenCalled();
  expect(worker.profile.context).toMatchObject({
    worker: true,
    kind: 'collection',
    resource: 'event',
  });
  expect(state.ruleResource.set).toHaveBeenCalled();
});

it('retains setup adoption and view migration for noncanonical collection contexts', async () => {
  state.kind = 'collection';
  state.flat = false;
  const spec = await open();
  expect(spec.profile.context).toMatchObject({
    kind: 'collection',
    worker: false,
  });
  expect(collectSyncableFlatAdoption).toHaveBeenCalled();
  expect(collectSyncableLegacySources).toHaveBeenCalled();
  expect(migrateSyncableApiViews).toHaveBeenCalled();
});
