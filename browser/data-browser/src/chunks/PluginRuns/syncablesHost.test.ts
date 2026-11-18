import { afterEach, describe, expect, it, vi } from 'vitest';
import { core, Datatype, findSchema, type Store } from '@tomic/lib';
import { fakeSchemaStore } from '../../../../lib/src/test-schema-store.js';
import { defaultIntegrationProxy } from '@helpers/integrationProxy';
import type { ProxyConnections } from '@helpers/proxyConnections';
import { ensureSyncablePlatform } from './syncablePlatform';
import { syncablesHostRequest } from './syncablesHost';
import {
  findSyncableNode,
  syncableHierarchySchema,
  type SyncableNodeInput,
} from './syncableHierarchy';

const base = {
  drive: 'drive',
  proxyOrigin: defaultIntegrationProxy,
  platform: 'github-issues',
} as const;

const publicRepository = {
  id: 456,
  name: 'atomic-server',
  full_name: 'ontola/atomic-server',
  private: false,
  has_issues: true,
  owner: { id: 123, login: 'ontola', type: 'Organization' },
};

afterEach(() => vi.restoreAllMocks());

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
    publicIssuePages: new Map<
      string,
      { page: number; after?: string } | 'loading'
    >(),
  };
  const store = fake as unknown as Store;
  const get = fake.getResource.bind(fake);
  const readOnlyTables = new Set<string>();

  fake.getResource = async subject => {
    const resource = await get(subject);

    return Object.assign(resource, {
      canWrite: async () => [!readOnlyTables.has(subject), undefined],
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
    signal?: AbortSignal,
  ) =>
    syncablesHostRequest(
      store,
      'drive',
      table,
      { op, ...args },
      proxy,
      discovery,
      signal,
    );

  return { store, resources, proxy, request, readOnlyTables };
}

async function installPlatform() {
  const ctx = setup();
  const platform = await ensureSyncablePlatform(ctx.store, {
    ...base,
    name: 'GitHub',
  });

  return { ...ctx, platform };
}

async function openOrganizations(
  installed?: Awaited<ReturnType<typeof installPlatform>>,
) {
  const ctx = installed ?? (await installPlatform());
  const { platform } = ctx;
  const { subject: organizations } = (await ctx.request(
    platform,
    'syncablesOpenAccount',
    {
      connectionId: 'test-connection',
    },
  )) as { subject: string };

  return { ...ctx, platform, organizations };
}

describe('GitHub custom directory context', () => {
  it('lets compatible unbound tables browse stored rows without provider access', async () => {
    const { store, resources, organizations, request, proxy } =
      await openOrganizations();
    const terms = await findSchema(store, 'drive', syncableHierarchySchema());
    resources.set('ordinary-owners', {
      [core.properties.parent]: 'drive',
      [core.properties.classtype]:
        resources.get(organizations)![core.properties.classtype],
    });
    vi.mocked(proxy.readKeyed).mockClear();
    const writesBefore = resources.size;
    expect(
      await request('ordinary-owners', 'syncablesDirectoryContext'),
    ).toEqual({
      platform: 'github-issues',
      kind: 'organizations',
      storedOnly: true,
    });
    await expect(
      request('ordinary-owners', 'syncablesRead', { read: 'organizations' }),
    ).rejects.toThrow('not a Syncables table');
    expect(proxy.readKeyed).not.toHaveBeenCalled();
    expect(resources.size).toBe(writesBefore);
    resources.get('ordinary-owners')![
      terms.properties!['syncable-source-key']
    ] = 'invalid';
    await expect(
      request('ordinary-owners', 'syncablesDirectoryContext'),
    ).rejects.toThrow('source binding');
  });

  it('validates existing bindings and rejects unrelated row classes', async () => {
    const { organizations, platform, request } = await openOrganizations();
    expect(
      await request(organizations, 'syncablesDirectoryContext'),
    ).toMatchObject({ kind: 'organizations', connectionId: 'test-connection' });
    await expect(
      request(platform, 'syncablesDirectoryContext'),
    ).rejects.toThrow('row type');
  });
});

async function scaffold(
  installed?: Awaited<ReturnType<typeof installPlatform>>,
) {
  const ctx = await openOrganizations(installed);
  await ctx.request(ctx.organizations, 'syncablesRead', {
    read: 'repositories',
  });
  const repos = (await ctx.request(ctx.organizations, 'syncablesOpenOwner', {
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

async function openPublic() {
  const ctx = await installPlatform();
  const { subject: publicTable } = (await ctx.request(
    ctx.platform,
    'syncablesOpenPublic',
  )) as { subject: string };

  return { ...ctx, publicTable };
}

describe('linking a public GitHub repository', () => {
  const op = 'syncablesLinkPublicRepository';

  it('opens and links Public without a connection, using identities distinct from account mirrors', async () => {
    const ctx = await openPublic();
    const { request, publicTable, platform, proxy, resources } = ctx;
    expect(resources.get(publicTable)?.[core.properties.parent]).toBe(platform);
    await expect(request(platform, 'syncablesOpenPublic')).resolves.toEqual({
      subject: publicTable,
    });
    await expect(
      request(publicTable, 'syncablesContext'),
    ).resolves.toMatchObject({
      kind: 'public',
      mode: 'public',
      canReconnect: false,
    });
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => Response.json(publicRepository));
    const linked = (await request(publicTable, op, {
      repository: 'Ontola/atomic-server',
    })) as { subject: string };
    expect(fetch).toHaveBeenCalledWith(
      'https://api.github.com/repos/Ontola/atomic-server',
      {
        method: 'GET',
        cache: 'no-store',
        credentials: 'omit',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        headers: { Accept: 'application/vnd.github+json' },
        signal: expect.any(AbortSignal),
      },
    );
    await expect(
      request(linked.subject, 'syncablesContext'),
    ).resolves.toMatchObject({
      kind: 'mirror',
      mode: 'public',
      canReconnect: false,
      ownerId: '123',
      ownerLogin: 'ontola',
      repoId: '456',
      repoName: 'atomic-server',
    });
    const repository = resources.get(linked.subject)?.[
      core.properties.parent
    ] as string;
    const owner = resources.get(repository)?.[core.properties.parent] as string;
    expect(resources.get(owner)?.[core.properties.parent]).toBe(publicTable);
    expect(resources.get(repository)?.[core.properties.name]).toBe(
      'atomic-server',
    );
    expect(resources.get(owner)?.[core.properties.name]).toBe('ontola');
    expect(proxy.readKeyed).not.toHaveBeenCalled();
    expect(proxy.listKeyed).not.toHaveBeenCalled();
    expect(proxy.activeKeyedConnection).not.toHaveBeenCalled();

    const account = await scaffold(ctx);
    expect(account.issues).not.toBe(linked.subject);
    await request(account.issues, 'syncablesRead', { read: 'issues' });
    const issuesUrl = vi.mocked(proxy.readKeyed).mock.lastCall?.[0];
    expect(issuesUrl?.origin).toBe(defaultIntegrationProxy);
    expect(issuesUrl?.pathname).toBe(
      '/proxy/test-connection/github-issues/repositories/456/issues',
    );

    resources.set('another-folder', { [core.properties.parent]: 'drive' });
    const moved = await ctx.store.getResource(linked.subject);
    await moved.set(core.properties.parent, 'another-folder');
    await moved.save();
    await expect(
      request(publicTable, op, {
        repository: 'ontola/atomic-server',
      }),
    ).resolves.toEqual(linked);
    expect(moved.get(core.properties.parent)).toBe('another-folder');
  });

  it('rejects unsafe repository references before contacting GitHub', async () => {
    const { request, proxy, publicTable } = await openPublic();
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => Response.json(publicRepository));

    for (const repository of [
      'https://github.com/ontola/atomic-server',
      '../atomic-server',
      'ontola/..',
      'ontola/%2e%2e',
      'ontola/atomic-server?x=y',
      'ontola/atomic-server/extra',
      'ontola/atomic-server\n',
    ]) {
      await expect(request(publicTable, op, { repository })).rejects.toThrow(
        'Enter a GitHub repository as owner/repo',
      );
    }

    expect(fetch).not.toHaveBeenCalled();
    expect(proxy.readKeyed).not.toHaveBeenCalled();
  });

  it('only opens Public from a writable platform and links from a writable Public table', async () => {
    const { request, platform, publicTable, readOnlyTables } =
      await openPublic();
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => Response.json(publicRepository));
    const args = { repository: 'ontola/atomic-server' };
    await expect(request(platform, op, args)).rejects.toThrow(
      'Expected public GitHub repositories',
    );
    await expect(request(publicTable, 'syncablesOpenPublic')).rejects.toThrow(
      'Expected platform table',
    );
    readOnlyTables.add(platform);
    await expect(request(platform, 'syncablesOpenPublic')).rejects.toThrow(
      'Write access',
    );
    readOnlyTables.add(publicTable);
    await expect(request(publicTable, op, args)).rejects.toThrow(
      'Write access',
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    [{ private: true }, 'Choose a public GitHub repository'],
    [{ has_issues: false }, 'Choose a public GitHub repository'],
    [
      { full_name: 'someone-else/atomic-server' },
      'unexpected repository metadata',
    ],
    [{ id: Number.MAX_SAFE_INTEGER + 1 }, 'Invalid repository ID'],
  ])(
    'rejects unverified repository metadata %j without writing resources',
    async (patch, error) => {
      const { request, resources, publicTable } = await openPublic();
      const count = resources.size;
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        Response.json({ ...publicRepository, ...patch }),
      );
      await expect(
        request(publicTable, op, {
          repository: 'ontola/atomic-server',
        }),
      ).rejects.toThrow(error);
      expect(resources.size).toBe(count);
    },
  );

  it('reads only scoped anonymous issue pages and withholds a response when the repository goes private', async () => {
    const { request, proxy, publicTable } = await openPublic();
    const nextLink =
      '<https://api.github.com/repositories/456/issues?page=2>; rel="next"';
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(Response.json(publicRepository))
      .mockResolvedValueOnce(
        Response.json([], {
          headers: { Link: nextLink },
        }),
      )
      .mockResolvedValueOnce(Response.json([{ id: 9001 }]))
      .mockResolvedValueOnce(
        Response.json([{ id: 9002 }], {
          status: 404,
          headers: { Link: nextLink },
        }),
      );
    const { subject } = (await request(publicTable, op, {
      repository: 'ontola/atomic-server',
    })) as { subject: string };
    await expect(
      request(publicTable, 'syncablesRead', { read: 'issues' }),
    ).rejects.toThrow('cannot read');
    await expect(
      request(subject, 'syncablesRead', { read: 'profile' }),
    ).rejects.toThrow('cannot read');
    await expect(
      request(subject, 'syncablesRead', { read: 'issues', page: 41 }),
    ).rejects.toThrow('Invalid pagination');
    await expect(
      request(subject, 'syncablesRead', { read: 'issues', page: 2 }),
    ).rejects.toThrow('pages in order');
    expect(fetch).toHaveBeenCalledTimes(1);

    await expect(
      request(subject, 'syncablesRead', { read: 'issues' }),
    ).resolves.toEqual({
      status: 200,
      body: [],
      nextPage: true,
    });
    await expect(
      request(subject, 'syncablesRead', { read: 'issues', page: 2 }),
    ).resolves.toEqual({
      status: 200,
      body: [{ id: 9001 }],
      nextPage: false,
    });
    expect(fetch).toHaveBeenLastCalledWith(
      'https://api.github.com/repositories/456/issues?per_page=100&page=2&state=all',
      expect.objectContaining({
        method: 'GET',
        credentials: 'omit',
        cache: 'no-store',
        redirect: 'error',
        headers: { Accept: 'application/vnd.github+json' },
      }),
    );
    await expect(
      request(subject, 'syncablesRead', { read: 'issues' }),
    ).resolves.toEqual({
      status: 404,
      body: null,
      nextPage: false,
    });
    expect(proxy.readKeyed).not.toHaveBeenCalled();
  });

  it('rejects an inconsistent public source identity or a saved connection', async () => {
    const { store, request, publicTable } = await openPublic();
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(Response.json(publicRepository));
    const { subject } = (await request(publicTable, op, {
      repository: 'ontola/atomic-server',
    })) as { subject: string };
    const schema = await findSchema(
      store,
      base.drive,
      syncableHierarchySchema(),
    );
    const property = schema.properties!['syncable-source-config'];
    const resource = await store.getResource(subject);
    const config = resource.get(property) as Record<string, string>;

    await resource.set(property, {
      ...config,
      connectionId: 'test-connection',
    });
    await expect(
      request(subject, 'syncablesRead', { read: 'issues' }),
    ).rejects.toThrow('Invalid public GitHub source binding');
    await resource.set(property, { ...config, repoId: '567' });
    await expect(
      request(subject, 'syncablesRead', { read: 'issues' }),
    ).rejects.toThrow('Invalid public GitHub source binding');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('follows same-repository cursors through page 40 and restarts from page one', async () => {
    const { request, publicTable } = await openPublic();
    const calls: string[] = [];
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async input => {
        const url = new URL(String(input));
        if (url.pathname.startsWith('/repos/'))
          return Response.json(publicRepository);

        const page = Number(url.searchParams.get('page'));
        expect(url.searchParams.get('after')).toBe(
          page > 1 ? 'Y3Vyc29yOjY=' : null,
        );
        calls.push(url.href);

        return Response.json([], {
          headers:
            page < 40
              ? {
                  Link: `</repositories/456/issues?per_page=100&page=${page + 1}&state=all&after=Y3Vyc29yOjY%3D>; rel="next"`,
                }
              : {},
        });
      });
    const { subject } = (await request(publicTable, op, {
      repository: 'ontola/atomic-server',
    })) as { subject: string };

    for (let page = 1; page <= 40; page++) {
      await expect(
        request(subject, 'syncablesRead', {
          read: 'issues',
          page,
        }),
      ).resolves.toMatchObject({ status: 200, nextPage: page < 40 });
    }

    await expect(
      request(subject, 'syncablesRead', {
        read: 'issues',
        page: 41,
      }),
    ).rejects.toThrow('Invalid pagination');
    await request(subject, 'syncablesRead', { read: 'issues' });
    expect(calls[39]).toContain('page=40&state=all&after=Y3Vyc29yOjY%3D');
    expect(new URL(calls[40]).searchParams.has('after')).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(42);
  });

  it.each([
    'https://api.github.com/repositories/999/issues?page=2',
    'https://elsewhere.example/repositories/456/issues?page=2',
    'https://user:password@api.github.com/repositories/456/issues?page=2',
    'http://api.github.com/repositories/456/issues?page=2',
    'https://api.github.com/repositories/456/issues?page=2#fragment',
    'https://api.github.com/repositories/456/issues?page=2&access_token=secret',
    'https://api.github.com/repositories/456/issues?page=2&page=2',
    'https://api.github.com/repositories/456/issues?page=2&state=open',
    'https://api.github.com/repositories/456/issues?page=2&per_page=1',
    'https://api.github.com/repositories/456/issues?page=3',
    'https://api.github.com/repositories/456/issues?page=2&after=bad%20cursor',
  ])('rejects out-of-scope issue continuation %s', async next => {
    const { request, publicTable } = await openPublic();
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(Response.json(publicRepository))
      .mockResolvedValueOnce(
        Response.json([], {
          headers: { Link: `<${next}>; rel="next"` },
        }),
      );
    const { subject } = (await request(publicTable, op, {
      repository: 'ontola/atomic-server',
    })) as { subject: string };
    await expect(
      request(subject, 'syncablesRead', {
        read: 'issues',
      }),
    ).rejects.toThrow('invalid issue continuation');
    await expect(
      request(subject, 'syncablesRead', {
        read: 'issues',
        page: 2,
      }),
    ).rejects.toThrow('pages in order');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('does not reuse a cursor from a different public repository', async () => {
    const { request, publicTable } = await openPublic();
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(Response.json(publicRepository))
      .mockResolvedValueOnce(
        Response.json({
          ...publicRepository,
          id: 789,
          name: 'atomic-plugins',
          full_name: 'ontola/atomic-plugins',
        }),
      )
      .mockResolvedValueOnce(
        Response.json([], {
          headers: {
            Link: '</repositories/456/issues?page=2&after=Y3Vyc29yOjY%3D>; rel="next"',
          },
        }),
      );
    const first = (await request(publicTable, op, {
      repository: 'ontola/atomic-server',
    })) as { subject: string };
    const second = (await request(publicTable, op, {
      repository: 'ontola/atomic-plugins',
    })) as { subject: string };
    await request(first.subject, 'syncablesRead', { read: 'issues' });
    await expect(
      request(second.subject, 'syncablesRead', {
        read: 'issues',
        page: 2,
      }),
    ).rejects.toThrow('pages in order');
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('does not provision after the view cancels its lookup', async () => {
    const { request, resources, publicTable } = await openPublic();
    const count = resources.size;
    const controller = new AbortController();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      controller.abort();

      return Response.json(publicRepository);
    });
    await expect(
      request(
        publicTable,
        op,
        {
          repository: 'ontola/atomic-server',
        },
        controller.signal,
      ),
    ).rejects.toThrow('aborted');
    expect(resources.size).toBe(count);
  });
});
