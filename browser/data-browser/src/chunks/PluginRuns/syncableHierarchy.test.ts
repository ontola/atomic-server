import { describe, expect, it } from 'vitest';
import { core, dataBrowser } from '@tomic/lib';
import { fakeSchemaStore } from '../../../../lib/src/test-schema-store.js';
import {
  ensureSyncableNode,
  findSyncableNode,
  syncableSourceKey,
  type SyncableNodeInput,
} from './syncableHierarchy';

const base = {
  drive: 'drive',
  proxyOrigin: 'https://proxy.example',
  platform: 'github-issues',
} as const;

describe('syncableSourceKey', () => {
  it('does not depend on name or location', () => {
    const input = {
      ...base,
      kind: 'owner',
      remoteId: 'github-owner:123',
      name: 'ontola',
      parent: 'organizations-1',
    } satisfies SyncableNodeInput;

    expect(syncableSourceKey(input)).toBe(
      syncableSourceKey({
        ...input,
        name: 'Renamed organization',
        parent: 'moved-elsewhere',
      }),
    );
  });

  it('distinguishes issues from other collections of the same repository', () => {
    const input = {
      ...base,
      kind: 'mirror',
      remoteId: 'github-repo:456',
      name: 'Issues',
      parent: 'github-repo-resource',
      collectionName: 'issues',
    } satisfies SyncableNodeInput;

    expect(syncableSourceKey(input)).not.toBe(
      syncableSourceKey({ ...input, collectionName: 'pull-requests' }),
    );
  });
});

describe('ensureSyncableNode', () => {
  it('creates a GitHub account → Organizations → owner → Repositories → repository → Issues tree', async () => {
    const { store, resources } = fakeSchemaStore();
    const account = await ensureSyncableNode(store, {
      ...base,
      parent: 'github-platform-table',
      kind: 'account',
      remoteId: 'connection-1',
      name: 'my-account',
    });
    const organizations = await ensureSyncableNode(store, {
      ...base,
      parent: account,
      kind: 'organizations',
      remoteId: 'connection-1',
      name: 'Organizations',
    });
    const owner = await ensureSyncableNode(store, {
      ...base,
      parent: organizations,
      kind: 'owner',
      remoteId: 'github-owner:123',
      ownerKind: 'organization',
      name: 'ontola',
    });
    const repositories = await ensureSyncableNode(store, {
      ...base,
      parent: owner,
      kind: 'repositories',
      remoteId: 'github-owner:123',
      name: 'Repositories',
    });
    const repo = await ensureSyncableNode(store, {
      ...base,
      parent: repositories,
      kind: 'repository',
      remoteId: 'github-repo:456',
      name: 'atomic-server',
    });
    const issues = await ensureSyncableNode(store, {
      ...base,
      parent: repo,
      kind: 'mirror',
      remoteId: 'github-repo:456',
      collectionName: 'issues',
      name: 'Issues',
    });

    expect(resources.get(account)?.[core.properties.parent]).toBe(
      'github-platform-table',
    );
    expect(resources.get(organizations)?.[core.properties.parent]).toBe(account);
    expect(resources.get(owner)?.[core.properties.parent]).toBe(organizations);
    expect(resources.get(repositories)?.[core.properties.parent]).toBe(owner);
    expect(resources.get(repo)?.[core.properties.parent]).toBe(repositories);
    expect(resources.get(issues)?.[core.properties.parent]).toBe(repo);
    expect(resources.get(issues)?.[core.properties.isA]).toContain(
      dataBrowser.classes.table,
    );
    expect(typeof resources.get(issues)?.[core.properties.classtype]).toBe(
      'string',
    );

    const moved = await store.getResource(issues);
    await moved.set(core.properties.parent, 'user-folder');
    await moved.save();

    expect(
      await findSyncableNode(store, {
        ...base,
        parent: repo,
        kind: 'mirror',
        remoteId: 'github-repo:456',
        collectionName: 'issues',
        name: 'Issues',
      }),
    ).toBe(issues);
  });

  it('reuses one organization across accounts by canonical provider ID', async () => {
    const { store } = fakeSchemaStore();
    const one = {
      ...base,
      kind: 'owner',
      remoteId: 'github-owner:123',
      ownerKind: 'organization',
      parent: 'account-one-orgs',
      name: 'ontola',
    } as const;
    const first = await ensureSyncableNode(store, one);
    const second = await ensureSyncableNode(store, {
      ...one,
      parent: 'account-two-orgs',
    });
    expect(second).toBe(first);
  });
});
