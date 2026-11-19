import { describe, expect, it, vi } from 'vitest';
import { core, collections as collectionTerms, type Store } from '@tomic/lib';
import type { CollectionDescription } from 'syncables/browser';
import { collectSyncableLegacySources } from './syncableLegacy';
import { sourceKey, sourceConfigFingerprint } from './builtinSyncIdentity.js';

type SourceQuery = (params: Record<string, unknown>) => {
  totalMembers: number;
  getMembersOnPage(page: number): string[];
};

const p = Object.fromEntries(
  [
    'platform-id',
    'proxy-origin',
    'source-key',
    'source-config',
    'node-kind',
    'owner-kind',
    'issue-number',
    'resource-index',
    'legacy-accounts',
  ].map(name => ['syncable-' + name, 'atomic:' + name]),
);
const origin = 'https://proxy.example';
const slot = 'a'.repeat(43);
const otherSlot = 'b'.repeat(43);
const prop = (name: string) => p['syncable-' + name];
const collections = [
  {
    name: 'githubOrganizations',
    resource: 'githubOrganization',
    contextParams: [],
    relationships: [],
  },
  {
    name: 'githubRepositories',
    resource: 'githubRepository',
    contextParams: [],
    relationships: [],
  },
  {
    name: 'organizationRepositories',
    resource: 'githubRepository',
    contextParams: ['org'],
    relationships: [
      { parentResource: 'githubOrganizationAddress' },
      {
        parentResource: 'githubOrganization',
        reference: 'byLogin',
        link: 'repositories',
      },
    ],
  },
  {
    name: 'repositoryIssues',
    resource: 'issue',
    contextParams: ['repository_id'],
    allowsAnonymous: true,
    relationships: [{ parentResource: 'githubRepository' }],
  },
] as CollectionDescription[];

function fixture() {
  const rows = new Map<string, Record<string, unknown>>();
  rows.set('drive', {});
  rows.set('app', {
    [core.properties.parent]: 'drive',
    [prop('platform-id')]: 'github-issues',
    [prop('proxy-origin')]: origin,
  });
  const getResource = vi.fn(async (subject: string) => {
    if (!rows.has(subject)) throw new Error('Missing');

    return {
      subject,
      get: (property: string) => rows.get(subject)?.[property],
      getChildrenCollection: async () => {
        const members = [...rows]
          .filter(([, values]) => values[core.properties.parent] === subject)
          .map(([id]) => id);

        return {
          waitForReady: async () => undefined,
          totalMembers: members.length,
          totalPages: Math.ceil(members.length / 100),
          getMembersOnPage: async (page: number) =>
            members.slice(page * 100, (page + 1) * 100),
        };
      },
    };
  });
  const store = {
    getResource,
    getServerUrl: () => 'https://node.example',
    fetchResourceFromServer: vi.fn(
      async (subject: string, options: unknown) => {
        const url = new URL(subject);
        expect(url.origin + url.pathname).toBe('https://node.example/query');
        expect(url.searchParams.get('include_nested')).toBe('false');
        expect(url.searchParams.has('value')).toBe(false);
        expect(options).toEqual({ noWebSocket: true });
        const answer = (
          store as unknown as {
            legacySources: ReturnType<typeof vi.fn<SourceQuery>>;
          }
        ).legacySources({
          drive: url.searchParams.get('drive'),
          property: url.searchParams.get('property'),
          pageSize: Number(url.searchParams.get('page_size')),
          preferServer: true,
        });

        return {
          getLoroDoc: () => undefined,
          get: (property: string) =>
            property === collectionTerms.properties.totalMembers
              ? answer.totalMembers
              : undefined,
          getSubjects: () =>
            answer.getMembersOnPage(
              Number(url.searchParams.get('current_page')),
            ),
        };
      },
    ),
    normalizeSubject: (subject: string) => subject,
    isForeignOriginSubject: (subject: string) => subject.startsWith('https://'),
    legacySources: vi.fn((params: Record<string, unknown>) => {
      expect(params).toEqual({
        drive: 'drive',
        property: prop('source-key'),
        pageSize: 100,
        preferServer: true,
      });
      const members = [...rows]
        .filter(([, value]) => value[prop('source-key')] !== undefined)
        .map(([subject]) => subject);

      return {
        waitForReady: async () => undefined,
        totalMembers: members.length,
        totalPages: Math.ceil(members.length / 100),
        getMembersOnPage: (page: number) =>
          members.slice(page * 100, (page + 1) * 100),
      };
    }),
  } as unknown as Store;

  const add = (
    subject: string,
    parent: string,
    kind: string,
    identity: string,
    config: Record<string, unknown> = { connectionId: slot },
    extra: Record<string, unknown> = {},
  ) => {
    const key = JSON.stringify([
      origin,
      'github-issues',
      kind,
      identity,
      kind.endsWith('mirror') ? 'issues' : '',
      ...(['repositories', 'mirror'].includes(kind)
        ? [config.connectionId]
        : []),
    ]);
    rows.set(subject, {
      [core.properties.parent]: parent,
      [core.properties.localId]: 'syncables:node:' + encodeURIComponent(key),
      [prop('source-key')]: key,
      [prop('node-kind')]: kind,
      [prop('source-config')]: config,
      ...extra,
    });

    return key;
  };

  const collect = (patch = {}) =>
    collectSyncableLegacySources(store, {
      drive: 'drive',
      app: 'app',
      proxyOrigin: origin,
      platform: 'github-issues',
      properties: p,
      collections,
      appDataProperty: 'atomic:app-data',
      ...patch,
    });

  const authenticatedTree = () => {
    add('account', 'app', 'account', slot);
    add('orgs', 'account', 'organizations', slot);
    add(
      'org',
      'orgs',
      'owner',
      'github-owner:12',
      { connectionId: slot, ownerId: '12', ownerLogin: 'renamable' },
      { [prop('owner-kind')]: 'organization' },
    );
    add('repos', 'org', 'repositories', 'github-owner:12', {
      connectionId: slot,
      ownerId: '12',
      ownerLogin: 'renamable',
    });
    add('repo', 'repos', 'repository', 'github-repo:45', {
      connectionId: slot,
      ownerId: '12',
      repoId: '45',
    });
    add('issues', 'repo', 'mirror', 'github-repo:45', {
      connectionId: slot,
      ownerId: '12',
      repoId: '45',
    });
    rows.set('issue', {
      [core.properties.parent]: 'issues',
      [core.properties.localId]: 'syncables:github-issue:9001',
      [prop('issue-number')]: 17,
      'atomic:user-note': 'Keep this',
    });
  };

  return {
    rows,
    getResource,
    add,
    collect,
    authenticatedTree,
    query: (
      store as unknown as {
        legacySources: ReturnType<typeof vi.fn<SourceQuery>>;
      }
    ).legacySources,
  };
}

describe('historical source collection', () => {
  it('does not scan modern installation data without legacy provenance', async () => {
    const f = fixture();
    f.rows.get('app')!['atomic:app-data'] = 'app';
    for (let i = 0; i < 30; i++)
      f.rows.set('modern-' + i, { [core.properties.parent]: 'app' });
    await expect(f.collect({ maxResources: 3 })).resolves.toEqual({
      sources: [],
      warnings: [],
    });
    expect(f.getResource.mock.calls.map(([subject]) => subject)).not.toContain(
      'modern-0',
    );
  });

  it('describes existing principal, organization, relationship, mirror and typed issue identities without mutation', async () => {
    const f = fixture();
    f.authenticatedTree();
    const before = JSON.stringify([...f.rows]);
    const result = await f.collect();
    expect(result.warnings).toEqual([]);
    expect(result.sources.map(row => row.subject)).toEqual([
      'account',
      'orgs',
      'org',
      'repos',
      'repo',
      'issues',
      'issue',
    ]);
    expect(result.sources.find(row => row.subject === 'repos')).toMatchObject({
      kind: 'collection',
      connectionId: slot,
      parentSourceSubject: 'org',
      collection: {
        name: 'organizationRepositories',
        resource: 'githubRepository',
        reference: 'byLogin',
        link: 'repositories',
      },
    });
    expect(result.sources.find(row => row.subject === 'issue')).toMatchObject({
      kind: 'record',
      remoteId: 17,
      localId: 'syncables:github-issue:9001',
      parentSourceSubject: 'issues',
      collection: { name: 'repositoryIssues', resource: 'issue' },
    });
    expect(result.sources[0].principal).toBeUndefined(); // OAuth has not verified an identity yet.
    expect(JSON.stringify([...f.rows])).toBe(before);
  });

  it('reads former Accounts containers and never infers identity from display names', async () => {
    const f = fixture();
    f.authenticatedTree();
    f.rows.set('accounts', {
      [core.properties.parent]: 'app',
      [core.properties.localId]: 'syncables:accounts',
      [prop('platform-id')]: 'github-issues',
      [prop('proxy-origin')]: origin,
    });
    f.rows.get('account')![core.properties.parent] = 'accounts';
    f.rows.get('org')![core.properties.name] = 'Arbitrary edited title';
    expect((await f.collect()).sources).toHaveLength(7);
  });

  it('retains indexed moved descendants but rejects foreign pointers and stale drive stamps', async () => {
    const f = fixture();
    f.authenticatedTree();
    f.rows.set('folder', { [core.properties.parent]: 'drive' });
    f.rows.get('issues')![core.properties.parent] = 'folder';
    const key = f.rows.get('issues')![prop('source-key')] as string;
    f.rows.get('drive')![prop('resource-index')] = {
      [key]: 'issues',
      [JSON.stringify([
        origin,
        'github-issues',
        'public',
        'github-public',
        '',
      ])]: 'https://evil.example/probe',
    };
    expect(
      (await f.collect()).sources.find(row => row.subject === 'issues'),
    ).toMatchObject({ parentSourceSubject: 'repo' });
    expect(f.getResource).not.toHaveBeenCalledWith(
      'https://evil.example/probe',
    );
    f.rows.get('folder')!['https://atomicdata.dev/properties/drive'] =
      'other-drive';
    f.getResource.mockClear();
    await f.collect();
    expect(f.getResource).not.toHaveBeenCalledWith('issue');
  });

  it('finds moved unindexed sources through a bounded selected-drive existence query', async () => {
    const f = fixture();
    f.authenticatedTree();
    f.rows.set('folder', { [core.properties.parent]: 'drive' });
    f.rows.get('issues')![core.properties.parent] = 'folder';
    f.add('unrelated', 'folder', 'public', 'github-public', {});
    const unrelated = JSON.stringify([
      origin,
      'unrelated-provider',
      'public',
      'github-public',
      '',
    ]);
    f.rows.get('unrelated')![prop('source-key')] = unrelated;
    f.rows.get('unrelated')![core.properties.localId] =
      'syncables:node:' + encodeURIComponent(unrelated);
    const result = await f.collect();
    expect(result.sources.find(row => row.subject === 'issues')).toMatchObject({
      parentSourceSubject: 'repo',
    });
    expect(result.sources.some(row => row.subject === 'unrelated')).toBe(false);
    expect(f.query).toHaveBeenCalledOnce();
    expect(f.rows.get('issues')![core.properties.parent]).toBe('folder');
  });

  it('keeps new installs cheap and fails explicitly when drive discovery exceeds its bound', async () => {
    const f = fixture();
    await f.collect();
    expect(f.query).not.toHaveBeenCalled();
    for (let id = 0; id < 20; id++)
      f.add('moved' + id, 'folder', 'account', slot);
    await expect(
      f.collect({ currentSourceIsLegacy: true, maxResources: 10 }),
    ).rejects.toThrow('resource limit');
    expect(f.getResource).not.toHaveBeenCalledWith('moved0');
  });

  it('does not resolve historical collection IDs for empty new provider installations', async () => {
    const f = fixture();
    expect(await f.collect({ collections: [] })).toEqual({
      sources: [],
      warnings: [],
    });
    f.rows.get('app')![prop('platform-id')] = 'calendar-service';
    expect(
      await f.collect({ platform: 'calendar-service', collections: [] }),
    ).toEqual({ sources: [], warnings: [] });
    expect(f.query).not.toHaveBeenCalled();
  });

  it('marks only an unmoved generated personal repository table for logical-parent relocation', async () => {
    const f = fixture();
    f.authenticatedTree();
    f.add(
      'personal-owner',
      'orgs',
      'owner',
      'github-owner:20',
      { connectionId: slot, ownerId: '20' },
      { [prop('owner-kind')]: 'personal' },
    );
    f.add(
      'personal-repos',
      'personal-owner',
      'repositories',
      'github-owner:20',
      { connectionId: slot, ownerId: '20' },
    );
    const before = JSON.stringify([...f.rows]);
    expect(
      (await f.collect()).sources.find(row => row.subject === 'personal-repos'),
    ).toMatchObject({
      collection: {
        name: 'githubRepositories',
        resource: 'githubRepository',
        context: {},
      },
      previousParent: 'personal-owner',
      reparentToLogicalParent: true,
    });
    expect(JSON.stringify([...f.rows])).toBe(before);
    f.rows.set('folder', { [core.properties.parent]: 'drive' });
    f.rows.get('personal-repos')![core.properties.parent] = 'folder';
    expect(
      (await f.collect()).sources.find(row => row.subject === 'personal-repos'),
    ).not.toHaveProperty('reparentToLogicalParent');
    f.rows.get('personal-repos')![core.properties.parent] = 'personal-owner';
    f.rows.get('personal-owner')![core.properties.parent] = 'folder';
    expect(
      (await f.collect()).sources.find(row => row.subject === 'personal-repos'),
    ).not.toHaveProperty('reparentToLogicalParent');
  });

  it('fails migration when the drive query omits a known historical source', async () => {
    const f = fixture();
    f.authenticatedTree();
    f.query.mockReturnValue({
      totalMembers: 0,
      getMembersOnPage: () => [],
    });
    await expect(f.collect()).rejects.toThrow('discovery is incomplete');
  });

  it('does not merge Public and authenticated mirrors for the same repository', async () => {
    const f = fixture();
    f.authenticatedTree();
    f.add('public', 'app', 'public', 'github-public', {});
    f.add(
      'public-repo',
      'public',
      'public-repository',
      'github-public-repo:45',
      { repoId: '45' },
    );
    f.add(
      'public-issues',
      'public-repo',
      'public-mirror',
      'github-public-repo:45',
      { repoId: '45' },
    );
    f.rows.set('public-issue', {
      [core.properties.parent]: 'public-issues',
      [core.properties.localId]: 'syncables:github-issue:9001',
      [prop('issue-number')]: 17,
    });
    const { sources } = await f.collect();
    expect(sources.find(row => row.subject === 'public-issues')).toMatchObject({
      principal: { kind: 'public' },
      collection: {
        name: 'repositoryIssues',
        resource: 'issue',
        context: { repository_id: '45' },
      },
    });
    expect(
      sources.find(row => row.subject === 'public-issues')?.parentSourceSubject,
    ).toBeUndefined();
    expect(
      sources.find(row => row.subject === 'public-issue')?.principal,
    ).toEqual({ kind: 'public' });
    expect(sources.find(row => row.subject === 'issues')?.connectionId).toBe(
      slot,
    );
  });

  it('reports competing personal destinations instead of picking a table', async () => {
    const f = fixture();
    f.authenticatedTree();

    for (const id of ['20', '21']) {
      f.add(
        'owner' + id,
        'orgs',
        'owner',
        'github-owner:' + id,
        { connectionId: slot, ownerId: id },
        { [prop('owner-kind')]: 'personal' },
      );
      f.add('repos' + id, 'owner' + id, 'repositories', 'github-owner:' + id, {
        connectionId: slot,
        ownerId: id,
      });
    }

    const { sources, warnings } = await f.collect();
    expect(
      sources.some(row => ['repos20', 'repos21'].includes(row.subject)),
    ).toBe(false);
    expect(warnings).toContain(
      'Several historical repository tables compete for one root collection; no destination was selected.',
    );
  });

  it('keeps other slots, proxies, malformed bindings and unsupported providers out', async () => {
    const f = fixture();
    f.authenticatedTree();
    f.rows.get('repos')![prop('source-config')] = {
      connectionId: otherSlot,
      ownerId: '12',
    };
    const result = await f.collect();
    expect(result.sources.some(row => row.subject === 'repos')).toBe(false);
    expect(result.warnings).toContain(
      'A legacy source has conflicting authentication provenance.',
    );
    await expect(
      f.collect({ proxyOrigin: 'https://other.example' }),
    ).rejects.toThrow('selected source');
    f.rows.get('app')![prop('platform-id')] = 'unrelated';
    expect(await f.collect({ platform: 'unrelated' })).toEqual({
      sources: [],
      warnings: [],
    });
  });

  it('collects unconverted issue rows beneath an already adopted mirror', async () => {
    const f = fixture();
    f.authenticatedTree();
    const principal = {
      kind: 'authenticated' as const,
      namespace: 'https://identity.example',
      subject: 7,
    };
    f.rows.get('issues')![prop('source-key')] = sourceKey({
      proxyOrigin: origin,
      platform: 'github-issues',
      kind: 'collection',
      principal,
      collection: { name: 'repositoryIssues', resource: 'issue' },
      parentSourceKey: 'saved-parent',
    });
    f.rows.get('issues')![prop('source-config')] = {
      version: 2,
      proxyOrigin: origin,
      platform: 'github-issues',
      principal,
      connectionId: slot,
      parentSourceKey: 'saved-parent',
      navigation: {
        kind: 'direct',
        collection: 'repositoryIssues',
        resource: 'issue',
        parentResource: 'githubRepository',
        bound: {
          collection: 'repositoryIssues',
          resource: 'issue',
          pathParams: { repository_id: '45' },
          path: '/repositories/45/issues',
          method: 'GET',
          query: { state: 'all' },
          body: {},
        },
      },
    };
    f.rows.get('issues')![prop('node-kind')] = 'collection';
    expect(
      (await f.collect()).sources.find(row => row.subject === 'issue'),
    ).toMatchObject({ principal, remoteId: 17 });
  });

  it('collects historical records beneath an adopted repository collection', async () => {
    const f = fixture();
    f.authenticatedTree();
    const principal = {
      kind: 'authenticated' as const,
      namespace: 'https://identity.example',
      subject: 7,
    };
    f.rows.get('repos')![prop('source-key')] = sourceKey({
      proxyOrigin: origin,
      platform: 'github-issues',
      kind: 'collection',
      principal,
      collection: {
        name: 'organizationRepositories',
        resource: 'githubRepository',
        reference: 'byLogin',
        link: 'repositories',
      },
      parentSourceKey: 'saved-parent',
    });
    f.rows.get('repos')![prop('source-config')] = {
      version: 2,
      proxyOrigin: origin,
      platform: 'github-issues',
      principal,
      connectionId: slot,
      parentSourceKey: 'saved-parent',
      navigation: {
        kind: 'responseLink',
        collection: 'organizationRepositories',
        resource: 'githubRepository',
        parentResource: 'githubOrganization',
        reference: 'byLogin',
        link: 'repositories',
        source: {
          path: '/orgs/fixture',
          template: '/orgs/{org}',
          method: 'GET',
          operationId: 'orgs-get-for-collection-navigation',
          pathParams: { org: 'fixture' },
        },
      },
    };
    f.rows.get('repos')![prop('node-kind')] = 'collection';
    expect(
      (await f.collect()).sources.find(row => row.subject === 'repo'),
    ).toMatchObject({ remoteId: 45, parentSourceSubject: 'repos' });
  });

  it('stamps legacy configuration and flat-record identity without exposing credentials', async () => {
    const f = fixture();
    f.authenticatedTree();
    const sources = (await f.collect()).sources;
    const account = sources.find(
      row => row.kind === 'principal' && row.connectionId === slot,
    )!;
    expect(account.sourceConfigFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(account.sourceConfigFingerprint).toBe(
      sourceConfigFingerprint(
        f.rows.get(account.subject)![prop('source-config')],
      ),
    );
    expect(sources.find(row => row.subject === 'issue')).toMatchObject({
      remoteId: 17,
      remoteIdProperty: prop('issue-number'),
    });
  });
  it('blocks unmapped legacy destinations when a current ancestor configuration contradicts its typed key', async () => {
    const f = fixture();
    f.authenticatedTree();
    const principal = {
      kind: 'authenticated' as const,
      namespace: 'https://identity.example',
      subject: 7,
    };
    f.rows.get('issues')![prop('source-key')] = sourceKey({
      proxyOrigin: origin,
      platform: 'github-issues',
      kind: 'collection',
      principal,
      collection: {
        name: 'repositoryIssues',
        resource: 'issue',
        context: { repository_id: '45' },
      },
    });
    f.rows.get('issues')![prop('node-kind')] = 'collection';
    f.rows.get('issues')![prop('source-config')] = {
      version: 2,
      proxyOrigin: origin,
      platform: 'github-issues',
      principal: { ...principal, subject: '7' },
      connectionId: slot,
      collection: {
        collection: 'repositoryIssues',
        resource: 'issue',
        path: '/repositories/45/issues',
        pathParams: { repository_id: '45' },
        method: 'GET',
        query: {},
        body: {},
      },
    };
    const result = await f.collect();
    expect(result.sources.some(row => row.subject === 'issue')).toBe(false);
    expect(result.warnings).toContain(
      'A current source configuration does not match its saved identity.',
    );
  });
  it('fails closed at the resource bound and rejects cyclic ancestry', async () => {
    const f = fixture();
    f.authenticatedTree();
    await expect(f.collect({ maxResources: 4 })).rejects.toThrow(
      'resource limit',
    );
    f.rows.get('app')![core.properties.parent] = 'app';
    await expect(f.collect()).rejects.toThrow('selected source');
  });
});
