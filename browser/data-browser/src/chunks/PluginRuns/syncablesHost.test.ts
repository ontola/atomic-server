import { describe, expect, it, vi } from 'vitest';
import { core, Datatype, type Store } from '@tomic/lib';
import { fakeSchemaStore } from '../../../../lib/src/test-schema-store.js';
import { defaultIntegrationProxy } from '@helpers/integrationProxy';
import type { ProxyConnections } from '@helpers/proxyConnections';
import { ensureSyncablePlatform } from './syncablePlatform';
import { syncablesHostRequest } from './syncablesHost';
import { findSyncableNode, type SyncableNodeInput } from './syncableHierarchy';

const base = {
  drive: 'drive',
  proxyOrigin: defaultIntegrationProxy,
  platform: 'github-issues',
} as const;

function setup() {
  const { store: fake, resources } = fakeSchemaStore();
  resources.set(core.properties.name, {
    [core.properties.isA]: [core.classes.property],
    [core.properties.datatype]: Datatype.STRING,
    [core.properties.shortname]: 'name',
  });
  const discovery = {
    owners: new Set<string>(),
    repositories: new Map<string, boolean>(),
  };
  const store = fake as unknown as Store;
  const get = fake.getResource.bind(fake);

  fake.getResource = async subject => {
    const resource = await get(subject);

    return Object.assign(resource, {
      canWrite: async () => [true, undefined],
      hasClasses: (klass: string) => {
        const classes = resource.get(core.properties.isA);

        return Array.isArray(classes) && classes.includes(klass);
      },
    });
  };

  const find = fake.findByLocalId.bind(fake);

  fake.findByLocalId = async (...args) => {
    const resource = await find(...args);

    return resource && fake.getResource(resource.subject);
  };

  const proxy = {
    listKeyed: vi.fn(async () => [
      {
        connection_id: 'test-connection',
        platform: 'github-issues',
        delegations: [],
      },
    ]),
    activeKeyedConnection: vi.fn(
      async (_platform: string, slot: string) => slot,
    ),
    canReconnectGithub: vi.fn(async () => false),
    rememberKeyedGithubPrincipal: vi.fn(async () => undefined),
    readKeyed: vi.fn(async (url: URL) => ({
      status: 200,
      body: url.pathname.endsWith('/user/repos')
        ? [
            {
              id: 456,
              name: 'atomic-server',
              owner: { id: 123, login: 'ontola', type: 'Organization' },
            },
          ]
        : { login: 'michiel', id: 321 },
      headers: {},
    })),
  } as unknown as ProxyConnections;
  const request = (
    table: string,
    op: string,
    args: Record<string, unknown> = {},
  ) =>
    syncablesHostRequest(
      store,
      'drive',
      table,
      { op, ...args },
      proxy,
      discovery,
    );

  return { store, resources, proxy, request };
}

async function scaffold() {
  const ctx = setup();
  const platform = await ensureSyncablePlatform(ctx.store, {
    ...base,
    name: 'GitHub',
  });
  const accounts = (await ctx.request(platform, 'syncablesOpenAccount', {
    connectionId: 'test-connection',
  })) as { subject: string };
  await ctx.request(accounts.subject, 'syncablesRead', {
    read: 'repositories',
  });
  const repos = (await ctx.request(accounts.subject, 'syncablesOpenOwner', {
    connectionId: 'test-connection',
    ownerId: '123',
    ownerLogin: 'ontola',
    ownerKind: 'organization',
  })) as { subject: string };
  await ctx.request(repos.subject, 'syncablesRead', { read: 'repositories' });
  const issues = (await ctx.request(repos.subject, 'syncablesCreateMirror', {
    connectionId: 'test-connection',
    ownerId: '123',
    ownerLogin: 'ontola',
    repoId: '456',
    repoName: 'atomic-server',
  })) as { subject: string };

  return {
    ...ctx,
    platform,
    organizations: accounts.subject,
    repositories: repos.subject,
    issues: issues.subject,
  };
}

describe('the built-in host actions', () => {
  it('provisions a platform and exposes its context', async () => {
    const { request, platform } = await scaffold();
    await expect(request(platform, 'syncablesContext')).resolves.toMatchObject({
      kind: 'platform',
      platform: 'github-issues',
      proxyOrigin: defaultIntegrationProxy,
    });
  });

  it('validates account and owner context before creating repositories', async () => {
    const { request, organizations, repositories } = await scaffold();
    await expect(
      request(organizations, 'syncablesOpenOwner', {
        connectionId: 'other-connection',
        ownerId: '123',
        ownerLogin: 'ontola',
        ownerKind: 'organization',
      }),
    ).rejects.toThrow('Wrong account connection');
    await expect(
      request(repositories, 'syncablesContext'),
    ).resolves.toMatchObject({
      kind: 'repositories',
      ownerId: '123',
      ownerLogin: 'ontola',
    });
  });

  it('refuses to provision a repository not returned through this view', async () => {
    const { request, repositories } = await scaffold();
    await expect(
      request(repositories, 'syncablesCreateMirror', {
        connectionId: 'test-connection',
        ownerId: '123',
        ownerLogin: 'ontola',
        repoId: '999',
        repoName: 'other-repository',
      }),
    ).rejects.toThrow('not available for issue sync');
  });

  it('imports typed issue records, updates in place and preserves user columns', async () => {
    const { store, request, resources, issues } = await scaffold();
    const row = {
      id: 1000,
      number: 12,
      title: 'First issue',
      state: 'open',
      body: '',
      updatedAt: '2026-11-13T12:00:00Z',
      htmlUrl: 'https://github.com/ontola/atomic-server/issues/12',
    };
    await request(issues, 'syncablesImportIssues', { issues: [row] });
    const original = await store.findByLocalId(
      'drive',
      issues,
      'syncables:github-issue:1000',
    );
    expect(original?.get(core.properties.name)).toBe('First issue');
    const subject = original!.subject;
    const userColumn = 'https://example.org/notes';
    await original!.set(userColumn, 'Keep my notes');
    await original!.save();

    await request(issues, 'syncablesImportIssues', {
      issues: [{ ...row, title: 'Second title', state: 'closed' }],
    });
    const updated = await store.findByLocalId(
      'drive',
      issues,
      'syncables:github-issue:1000',
    );
    expect(updated?.subject).toBe(subject);
    expect(updated?.get(core.properties.name)).toBe('Second title');
    expect(updated?.get(userColumn)).toBe('Keep my notes');
    expect(resources.get(subject)?.[core.properties.parent]).toBe(issues);
  });

  it('keeps existing rows when paused, and a failed sync cannot delete them', async () => {
    const { request, issues } = await scaffold();
    await request(issues, 'syncablesSetPaused', { paused: true });
    await expect(
      request(issues, 'syncablesImportIssues', { issues: [] }),
    ).rejects.toThrow('paused');
    await request(issues, 'syncablesSetPaused', { paused: false });
    await request(issues, 'syncablesRecordSuccess', {
      imported: 1,
      incomplete: true,
      added: 1,
      changed: 0,
      unchanged: 0,
    });
    await expect(
      request(issues, 'syncablesMirrorStatus'),
    ).resolves.toMatchObject({
      rows: 1,
      incomplete: true,
      paused: false,
      lastSuccess: undefined,
    });
  });

  it('retains a canonical Issues identity after the table is moved', async () => {
    const { store, resources, issues } = await scaffold();
    resources.set('another-folder', { [core.properties.parent]: 'drive' });
    const node = await store.getResource(issues);
    await node.set(core.properties.parent, 'another-folder');
    await node.save();
    const input: SyncableNodeInput = {
      ...base,
      parent: 'old-repository',
      kind: 'mirror',
      remoteId: 'github-repo:456',
      collectionName: 'issues',
      name: 'Issues',
      config: { connectionId: 'test-connection', repoId: '456' },
    };
    expect(await findSyncableNode(store, input)).toBe(issues);
  });
});
