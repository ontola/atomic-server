import { describe, expect, it } from 'vitest';
import { core, dataBrowser, Datatype, findSchema } from '@tomic/lib';
import { fakeSchemaStore as createFakeSchemaStore } from '../../../../lib/src/test-schema-store.js';
import {
  ensureSyncableNode,
  findSyncableNode,
  syncableHierarchySchema,
  syncableSourceKey,
  type SyncableNodeInput,
} from './syncableHierarchy';

function fakeSchemaStore() {
  const fixture = createFakeSchemaStore();
  fixture.resources.set(core.properties.name, {
    [core.properties.isA]: [core.classes.property],
    [core.properties.datatype]: Datatype.STRING,
    [core.properties.shortname]: 'name',
  });

  return fixture;
}

const base = {
  drive: 'drive',
  proxyOrigin: 'https://proxy.example',
  platform: 'github-issues',
} as const;

const repositoryMirror = {
  ...base,
  parent: 'github-repo-resource',
  kind: 'mirror',
  remoteId: 'github-repo:456',
  collectionName: 'issues',
  name: 'Issues',
  config: { connectionId: 'connection-1', repoId: '456' },
} satisfies SyncableNodeInput;

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
    expect(syncableSourceKey(repositoryMirror)).not.toBe(
      syncableSourceKey({
        ...repositoryMirror,
        collectionName: 'pull-requests',
      }),
    );
  });

  it('distinguishes two connections to one repository and requires a connection', () => {
    expect(syncableSourceKey(repositoryMirror)).not.toBe(
      syncableSourceKey({
        ...repositoryMirror,
        config: { ...repositoryMirror.config, connectionId: 'connection-2' },
      }),
    );
    expect(() =>
      syncableSourceKey({ ...repositoryMirror, config: undefined }),
    ).toThrow('A connection ID is required');
  });
});

describe('ensureSyncableNode', () => {
  it('creates a GitHub account → Organizations → owner → Repositories → repository → Issues tree', async () => {
    const { store, resources } = fakeSchemaStore();
    resources.set('github-platform-table', {
      [core.properties.parent]: 'drive',
    });
    resources.set('user-folder', { [core.properties.parent]: 'drive' });
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
      config: { connectionId: 'connection-1', ownerId: '123' },
    });
    const repo = await ensureSyncableNode(store, {
      ...base,
      parent: repositories,
      kind: 'repository',
      remoteId: 'github-repo:456',
      name: 'atomic-server',
    });
    const issues = await ensureSyncableNode(store, {
      ...repositoryMirror,
      parent: repo,
    });

    expect(resources.get(account)?.[core.properties.parent]).toBe(
      'github-platform-table',
    );
    expect(resources.get(organizations)?.[core.properties.parent]).toBe(
      account,
    );
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

    for (const table of [organizations, repositories]) {
      const rowClass = await store.getResource(
        resources.get(table)?.[core.properties.classtype] as string,
      );
      expect(rowClass.get(core.properties.recommends)).toEqual([
        core.properties.name,
      ]);
    }

    const moved = await store.getResource(issues);
    await moved.set(core.properties.parent, 'user-folder');
    await moved.save();

    expect(
      await findSyncableNode(store, { ...repositoryMirror, parent: repo }),
    ).toBe(issues);
  });

  it('repairs the title column on an existing Issues mirror', async () => {
    const { store, resources } = fakeSchemaStore();
    resources.set(repositoryMirror.parent, {
      [core.properties.parent]: 'drive',
    });
    const subject = await ensureSyncableNode(store, repositoryMirror);
    const rowClass = await store.getResource(
      resources.get(subject)?.[core.properties.classtype] as string,
    );
    const [title, ...issueProperties] = rowClass.get(
      core.properties.recommends,
    ) as string[];
    expect(title).toBe(core.properties.name);
    expect(issueProperties).toHaveLength(5);
    await rowClass.set(core.properties.recommends, issueProperties);
    await rowClass.save();

    expect(await ensureSyncableNode(store, repositoryMirror)).toBe(subject);
    expect(rowClass.get(core.properties.recommends)).toEqual([
      core.properties.name,
      ...issueProperties,
    ]);
  });

  it('reuses one organization across accounts by canonical provider ID', async () => {
    const { store, resources } = fakeSchemaStore();
    resources.set('account-one-orgs', { [core.properties.parent]: 'drive' });
    resources.set('account-two-orgs', { [core.properties.parent]: 'drive' });
    const one = {
      ...base,
      kind: 'owner',
      remoteId: 'github-owner:123',
      ownerKind: 'organization',
      parent: 'account-one-orgs',
      name: 'ontola',
      config: { connectionId: 'connection-1', ownerId: '123' },
    } as const;
    const first = await ensureSyncableNode(store, one);
    const second = await ensureSyncableNode(store, {
      ...one,
      parent: 'account-two-orgs',
      config: { connectionId: 'connection-2', ownerId: '123' },
    });
    expect(second).toBe(first);
    const schema = await findSchema(store, 'drive', syncableHierarchySchema());
    const config = schema.properties!['syncable-source-config'];
    expect(resources.get(first)?.[core.properties.parent]).toBe(
      'account-one-orgs',
    );
    expect(resources.get(first)?.[config]).toEqual(one.config);
  });

  it('keeps repository listings connection-specific and reuses canonical repository rows', async () => {
    const { store, resources } = fakeSchemaStore();
    resources.set('owner', { [core.properties.parent]: 'drive' });
    const listing = {
      ...base,
      parent: 'owner',
      kind: 'repositories',
      remoteId: 'github-owner:123',
      name: 'Repositories',
      config: { connectionId: 'connection-1', ownerId: '123' },
    } satisfies SyncableNodeInput;
    const first = await ensureSyncableNode(store, listing);
    const second = await ensureSyncableNode(store, {
      ...listing,
      config: { ...listing.config, connectionId: 'connection-2' },
    });
    expect(second).not.toBe(first);

    const repository = {
      ...base,
      parent: first,
      kind: 'repository',
      remoteId: 'github-repo:456',
      name: 'atomic-server',
    } satisfies SyncableNodeInput;
    const canonical = await ensureSyncableNode(store, repository);
    expect(
      await ensureSyncableNode(store, { ...repository, parent: second }),
    ).toBe(canonical);
    expect(resources.get(canonical)?.[core.properties.parent]).toBe(first);
  });

  it('accepts a moved legacy mirror only for its original connection', async () => {
    const { store, resources } = fakeSchemaStore();
    const { parent } = repositoryMirror;
    resources.set(parent, { [core.properties.parent]: 'drive' });
    resources.set('new-folder', { [core.properties.parent]: 'drive' });
    const first = await ensureSyncableNode(store, repositoryMirror);
    const schema = await findSchema(store, 'drive', syncableHierarchySchema());
    const source = schema.properties!['syncable-source-key'];
    const index = schema.properties!['syncable-resource-index'];
    const key = syncableSourceKey(repositoryMirror);
    const legacyKey = JSON.stringify(JSON.parse(key).slice(0, 5));

    const root = await store.getResource('drive');
    await root.set(index, { [legacyKey]: first });
    const original = await store.getResource(first);
    await original.set(source, legacyKey);
    await original.set(core.properties.parent, 'new-folder');
    await original.save();

    const secondInput = {
      ...repositoryMirror,
      config: { ...repositoryMirror.config, connectionId: 'connection-2' },
    };
    expect(await findSyncableNode(store, secondInput)).toBeUndefined();
    expect(await ensureSyncableNode(store, secondInput)).not.toBe(first);
    expect(await ensureSyncableNode(store, repositoryMirror)).toBe(first);
    expect(resources.get(first)?.[core.properties.parent]).toBe('new-folder');
    expect(resources.get(first)?.[source]).toBe(key);
  });

  it('ignores a stale index pointing outside the drive and rejects foreign parents', async () => {
    const { store, resources } = fakeSchemaStore();
    const { parent } = repositoryMirror;
    resources.set(parent, { [core.properties.parent]: 'drive' });
    resources.set('other-drive', {});
    const initial = await ensureSyncableNode(store, repositoryMirror);
    const original = await store.getResource(initial);
    await original.set(core.properties.parent, 'other-drive');
    await original.save();

    expect(await findSyncableNode(store, repositoryMirror)).toBeUndefined();
    await expect(
      ensureSyncableNode(store, { ...repositoryMirror, parent: 'other-drive' }),
    ).rejects.toThrow('outside this Syncables drive');
    expect(await ensureSyncableNode(store, repositoryMirror)).not.toBe(initial);
  });

  it('provisions concurrent discoveries of the same canonical owner once', async () => {
    const { store, resources } = fakeSchemaStore();
    resources.set('first-account', { [core.properties.parent]: 'drive' });
    resources.set('second-account', { [core.properties.parent]: 'drive' });
    const owner = {
      ...base,
      kind: 'owner',
      remoteId: 'github-owner:123',
      name: 'ontola',
      parent: 'first-account',
    } satisfies SyncableNodeInput;

    const [first, second] = await Promise.all([
      ensureSyncableNode(store, owner),
      ensureSyncableNode(store, { ...owner, parent: 'second-account' }),
    ]);
    expect(first).toBe(second);
  });
});
