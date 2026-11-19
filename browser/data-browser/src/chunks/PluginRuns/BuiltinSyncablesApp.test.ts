import { beforeEach, expect, it, vi } from 'vitest';
import type { Store } from '@tomic/lib';
import type { AppExecutionRegistry } from '@chunks/AppPage/AppExecutionRuntime';
import { appProfile } from './BuiltinSyncablesApp';
import { collectSyncableLegacySources } from './syncableLegacy';
import { syncableApiSchema } from './syncableApiSchema';
import { syncProxyTransport } from './builtinSyncablesProfile';

const state = vi.hoisted(() => ({
  actor: { subject: 'atomic:agent:person' },
  installation: 'atomic:installation' as string | undefined,
  kind: 'platform' as 'platform' | 'legacy' | 'collection',
  paused: false,
  legacy: { sources: [] as unknown[], warnings: [] as string[] },
  resource: {
    get: vi.fn((_property: string): unknown => undefined),
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
vi.mock('@helpers/proxyConnections', () => ({ ProxyConnections: class {} }));
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
    proxyTransport: 'host',
    schema: {
      classes: {},
      properties: {
        'syncable-source-key': 'atomic:source-key',
        'syncable-source-config': 'atomic:source-config',
        'syncable-mirror-status': 'atomic:status',
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
  getResource: vi.fn(async () => state.resource),
} as unknown as Store;
const registry = {
  isRunning: vi.fn(() => false),
  start: vi.fn(async () => undefined),
  cancel: vi.fn(),
  ready: vi.fn(),
} as unknown as AppExecutionRegistry;
const open = () =>
  appProfile(
    store,
    'drive',
    'atomic:source',
    registry,
    new AbortController().signal,
  );
beforeEach(() => {
  vi.clearAllMocks();
  state.installation = 'atomic:installation';
  state.kind = 'platform';
  state.paused = false;
  state.resource.get.mockImplementation(property =>
    property === 'atomic:status' ? { paused: state.paused } : undefined,
  );
  state.legacy = { sources: [], warnings: [] };
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
  );
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
  });
  expect(registry.start).toHaveBeenCalledOnce();
});
