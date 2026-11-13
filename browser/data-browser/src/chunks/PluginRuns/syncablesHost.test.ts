import { describe, expect, it, vi } from 'vitest';
import { core, type Store } from '@tomic/lib';
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
  const store = fake as unknown as Store;
  const proxy = {
    list: vi.fn(async () => [
      {
        connection_id: 'test-connection',
        platform: 'github-issues',
        delegations: [],
      },
    ]),
    delegate: vi.fn(async () => undefined),
  } as unknown as ProxyConnections;
  const request = (
    table: string,
    op: string,
    args: Record<string, unknown> = {},
  ) =>
    syncablesHostRequest(store, 'drive', table, { op, ...args }, proxy);
  return { store, resources, proxy, request };
}

async function scaffold() {
  const ctx = setup();
  const platform = await ensureSyncablePlatform(ctx.store, {
    ...base,
    name: 'GitHub',
  });
  const accounts = await ctx.request(platform, 'syncablesOpenAccount', {
    connectionId: 'test-connection',
  }) as { subject: string };
  const repos = await ctx.request(accounts.subject, 'syncablesOpenOwner', {
    connectionId: 'test-connection',
    ownerId: '123',
    ownerLogin: 'ontola',
    ownerKind: 'organization',
  }) as { subject: string };
  const issues = await ctx.request(repos.subject, 'syncablesCreateMirror', {
    connectionId: 'test-connection',
    ownerId: '123',
    ownerLogin: 'ontola',
    repoId: '456',
    repoName: 'atomic-server',
  }) as { subject: string };
  return { ...ctx, platform, organizations: accounts.subject, repositories: repos.subject, issues: issues.subject };
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
    await expect(request(repositories, 'syncablesContext')).resolves.toMatchObject({
      kind: 'repositories',
      ownerId: '123',
      ownerLogin: 'ontola',
    });
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
    });
    await expect(
      request(issues, 'syncablesMirrorStatus'),
    ).resolves.toMatchObject({
      rows: 1,
      incomplete: true,
      paused: false,
    });
  });

  it('retains a canonical Issues identity after the table is moved', async () => {
    const { store, issues } = await scaffold();
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
    };
    expect(await findSyncableNode(store, input)).toBe(issues);
  });
});
