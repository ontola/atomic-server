import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Store } from '@tomic/lib';
import type { AppExecutionRegistry } from '@chunks/AppPage/AppExecutionRuntime';
import { appProfile } from './BuiltinSyncablesApp';
import { collectSyncableLegacySources } from './syncableLegacy';
import { syncableApiSchema } from './syncableApiSchema';
import { syncProxyTransport } from './builtinSyncablesProfile';
import {
  ruleSourceKey,
  sourceConfigFingerprint,
} from './builtinSyncIdentity.js';
import { CollectionBuilder, core, dataBrowser } from '@tomic/lib';
import { readSelectionKey } from 'syncables/browser';

const state = vi.hoisted(() => ({
  actor: { subject: 'atomic:agent:person' },
  installation: 'atomic:installation' as string | undefined,
  kind: 'platform' as 'platform' | 'legacy' | 'collection',
  paused: false,
  boundSlot: undefined as string | undefined,
  flat: false,
  runSchema: false,
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
vi.mock('@chunks/AppPage/AppExecutionRuntime', () => ({
  useAppExecutions: () => undefined,
}));
vi.mock('../../routes/ShowRoute', () => ({
  ShowRoute: { useSearch: () => undefined },
}));
vi.mock('./syncableDocument', () => ({
  fetchSyncableDocument: vi.fn(async () => ({ document: state.document })),
}));
vi.mock('./syncablePlatform', () => ({
  findSyncablePlatform: vi.fn(async () => state.installation),
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
vi.mock('./syncableApiSchema', () => ({
  syncableApiSchema: vi.fn(async () => ({ classes: {}, properties: {} })),
}));
vi.mock('./builtinSyncablesProfile', () => ({
  assertSyncAppDrive: vi.fn(),
  assertSyncAppContext: vi.fn(),
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
  vi.stubGlobal('location', { href: 'https://node.example/current' });
  state.actor = { subject: 'atomic:agent:person' };
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
  expect(syncProxyTransport).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ subject: 'atomic:source' }),
    expect.any(Function),
    expect.objectContaining({ document: state.document }),
    expect.any(Function),
    expect.any(Function),
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
