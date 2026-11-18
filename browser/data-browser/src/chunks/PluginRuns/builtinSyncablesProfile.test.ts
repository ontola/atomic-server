import { afterEach, describe, expect, it, vi } from 'vitest';
import { core, Datatype, ensureSchema, type Store } from '@tomic/lib';
import { fakeSchemaStore } from '../../../../lib/src/test-schema-store';
import { defaultIntegrationProxy } from '@helpers/integrationProxy';
import type { ProxyConnections } from '@helpers/proxyConnections';
import { syncablePlatformSchema } from './syncablePlatform';
import { syncableHierarchySchema } from './syncableHierarchy';
import {
  assertSyncAppDrive,
  syncAppContext,
  syncProxyTransport,
  type SyncAppContext,
} from './builtinSyncablesProfile';

afterEach(() => vi.restoreAllMocks());
const context = {
  subject: 'mirror',
  drive: 'drive',
  platform: 'github-issues',
  proxyOrigin: defaultIntegrationProxy,
  kind: 'mirror',
  connectionId: 'slot',
  ownerId: '123',
  ownerLogin: 'ontola',
  repoId: '456',
  repoName: 'atomic-server',
  proxyTransport: 'host',
  schema: { classes: {}, properties: {} },
} satisfies SyncAppContext;

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

function setupProxy() {
  const readKeyed = vi.fn(async (_url: URL, _signal?: AbortSignal) => ({
    status: 200,
    body: [],
    headers: {},
  }));
  const rememberKeyedGithubPrincipal = vi.fn(async () => undefined);
  const proxy = {
    listKeyed: vi.fn(async () => [{ connection_id: 'slot' }]),
    activeKeyedConnection: vi.fn(async () => 'transport-id'),
    readKeyed,
    rememberKeyedGithubPrincipal,
  } as unknown as ProxyConnections;

  return { proxy, readKeyed, rememberKeyedGithubPrincipal };
}

describe('built-in source and proxy capabilities', () => {
  it('binds moved mirrors to their stored source, not their parent path', async () => {
    const { store: fake, resources } = fakeSchemaStore();
    resources.set(core.properties.name, {
      [core.properties.isA]: [core.classes.property],
      [core.properties.datatype]: Datatype.STRING,
      [core.properties.shortname]: 'name',
    });
    const h = await ensureSchema(fake, 'drive', syncableHierarchySchema());
    await ensureSchema(fake, 'drive', syncablePlatformSchema());
    resources.set('folder', { [core.properties.parent]: 'drive' });
    resources.set('mirror', {
      [core.properties.parent]: 'folder',
      [h.properties['syncable-source-key']]: JSON.stringify([
        defaultIntegrationProxy,
        'github-issues',
        'mirror',
        'github-repo:456',
        'issues',
        'slot',
      ]),
      [h.properties['syncable-source-config']]: {
        connectionId: 'slot',
        ownerId: '123',
        ownerLogin: 'ontola',
        repoId: '456',
        repoName: 'atomic-server',
      },
    });
    expect(
      await syncAppContext(fake as unknown as Store, 'drive', 'mirror'),
    ).toMatchObject(context);
    resources.get('mirror')![h.properties['syncable-source-config']] = {
      connectionId: 'other',
      ownerId: '123',
      ownerLogin: 'ontola',
      repoId: '456',
      repoName: 'atomic-server',
    };
    await expect(
      syncAppContext(fake as unknown as Store, 'drive', 'mirror'),
    ).rejects.toThrow('account');
    resources.get('folder')![core.properties.parent] = 'other-drive';
    await expect(
      syncAppContext(fake as unknown as Store, 'drive', 'mirror'),
    ).rejects.toThrow('outside');
  });
  it('keeps keyed credentials outside the app and restricts each mirror route/account', async () => {
    const { proxy, readKeyed } = setupProxy();
    const transport = syncProxyTransport(proxy, context, () => undefined);
    for (const patch of [
      { connectionId: 'other' },
      { path: 'user/repos' },
      { path: 'repositories/999/issues' },
      { platform: 'spotify' },
      { method: 'POST' },
      { body: '{}' },
      { query: { page: 21 } },
      { query: { state: 'closed' } },
      { query: { redirect: 'elsewhere' } },
    ])
      await expect(
        transport.request!({
          platform: 'github-issues',
          connectionId: 'slot',
          path: 'repositories/456/issues',
          ...patch,
        }),
      ).rejects.toThrow();
    expect(readKeyed).not.toHaveBeenCalled();
    const result = await transport.request!({
      platform: 'github-issues',
      connectionId: 'slot',
      path: 'repositories/456/issues',
      query: { page: 2, per_page: 100, state: 'all' },
    });
    expect(readKeyed.mock.calls[0][0].href).toBe(
      defaultIntegrationProxy +
        '/proxy/transport-id/github-issues/repositories/456/issues?page=2&per_page=100&state=all',
    );
    expect(result).toEqual({ status: 200, headers: {}, text: '[]' });
    expect(JSON.stringify(result)).not.toContain('transport-id');
  });
  it('refuses replies when the source/session changes during a provider read', async () => {
    const { proxy, readKeyed } = setupProxy();
    let current = true;
    readKeyed.mockImplementation(async () => {
      current = false;

      return { status: 200, body: [], headers: {} };
    });
    const transport = syncProxyTransport(proxy, context, () => {
      if (!current) throw new Error('Source changed');
    });
    await expect(
      transport.request!({
        platform: 'github-issues',
        connectionId: 'slot',
        path: 'repositories/456/issues',
      }),
    ).rejects.toThrow('Source changed');
  });
  it('uses credential-free Public reads fixed to the selected repository', async () => {
    const { proxy, readKeyed } = setupProxy();
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(Response.json([]));
    const transport = syncProxyTransport(
      proxy,
      { ...context, mode: 'public', connectionId: undefined },
      () => undefined,
    );
    await expect(
      transport.request!({
        platform: 'github-issues',
        path: 'repositories/999/issues',
      }),
    ).rejects.toThrow('endpoint');
    await expect(
      transport.request!({
        platform: 'github-issues',
        connectionId: 'slot',
        path: 'repositories/456/issues',
      }),
    ).rejects.toThrow('endpoint');
    await transport.request!({
      platform: 'github-issues',
      path: 'repositories/456/issues',
      query: { per_page: 100, state: 'all' },
    });
    expect(fetch).toHaveBeenCalledWith(
      expect.objectContaining({
        href: 'https://api.github.com/repositories/456/issues?per_page=100&state=all',
      }),
      expect.objectContaining({
        credentials: 'omit',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
      }),
    );
    expect(readKeyed).not.toHaveBeenCalled();
  });
});
