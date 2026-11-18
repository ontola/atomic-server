// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { mergeQuerySelections } from 'syncables/browser';
import catalogFixture from './fixtures/github-syncables-catalog.json';
import catalogSelection from './fixtures/github-syncables-selection.json';
import {
  createSyncApp,
  sourceKeys,
  view,
  // @ts-expect-error The server-delivered plain JavaScript module has no declarations.
} from './builtinSyncApp.js';

const P = 'https://atomicdata.dev/properties/';
const names = [
  'mirror-status',
  'issue-number',
  'issue-state',
  'issue-updated',
  'issue-link',
  'issue-body',
  'source-config',
  'source-key',
  'node-kind',
  'owner-kind',
  'repository-count',
  'repository-private',
  'repository-has-issues',
  'repository-open-issues',
  'collection-view',
  'open-target',
];
const properties = Object.fromEntries(
  names.map(name => ['syncable-' + name, 'atomic:' + name]),
);
const classes = Object.fromEntries(
  ['account', 'owner', 'repository', 'record'].map(name => [
    'syncable-' + name,
    'atomic:' + name,
  ]),
);
const prop = (name: string) => properties['syncable-' + name];
const root = 'atomic:root';
const origin = 'https://integrations.example';
const issue = (title = 'First issue') => ({
  id: 1001,
  number: 1,
  title,
  state: 'open',
  updated_at: '2026-11-18T10:00:00Z',
  body: null,
  html_url: 'https://github.com/org/project/issues/1',
});
const repo = {
  id: 200,
  name: 'project',
  full_name: 'org/project',
  owner: { id: 100, login: 'org', type: 'Organization' },
  private: false,
  has_issues: true,
  open_issues_count: 7,
};

/** The composed published IAP catalog, with one unrelated test-only collection. */
function apiDocument() {
  return {
    ...structuredClone(catalogFixture),
    paths: {
      ...structuredClone(catalogFixture.paths),
      '/unrelated': {
        get: {
          parameters: [
            { name: 'filter', in: 'query', schema: { type: 'string' } },
          ],
          responses: {},
        },
      },
    },
    components: {
      ...structuredClone(catalogFixture.components),
      crudResources: {
        ...structuredClone(catalogFixture.components.crudResources),
        unrelated: {
          collections: { unrelated: { urlTemplate: '/unrelated' } },
        },
      },
    },
  };
}

function setup(
  kind = 'organizations',
  extra: { querySelection?: unknown; [name: string]: unknown } = {},
) {
  const data = new Map<string, Record<string, unknown>>([[root, {}]]);
  let sequence = 0;
  const resource = (subject: string) => ({
    subject,
    get: (p: string) => data.get(subject)?.[p],
    hasClasses: (...wanted: string[]) =>
      wanted.every(c =>
        ((data.get(subject)?.[P + 'isA'] ?? []) as string[]).includes(c),
      ),
    set(p: string, value: unknown) {
      data.get(subject)![p] = value;

      return this;
    },
    save: vi.fn(async () => undefined),
  });
  const context = {
    subject: root,
    drive: 'atomic:drive',
    proxyOrigin: origin,
    platform: 'github-issues',
    kind,
    connectionId: 'slot',
    ownerId: '100',
    ownerLogin: 'org',
    repoId: '200',
    repoName: 'project',
    document: apiDocument(),
    schema: { properties, classes },
    ...extra,
    querySelection: mergeQuerySelections(
      catalogSelection,
      extra.querySelection,
    ),
  };
  const request = vi.fn(
    async ({
      path,
    }: {
      path: string;
      connectionId?: string;
      query?: Record<string, string>;
    }) => ({
      status: 200,
      headers: {} as Record<string, string>,
      body: (path === 'user/repos'
        ? [repo]
        : path === 'user/orgs'
          ? [{ id: 100, login: 'org' }]
          : path === 'user'
            ? { id: 300, login: 'person' }
            : path === 'repos/org/project'
              ? repo
              : [issue()]) as unknown,
    }),
  );
  const store = {
    getContext: vi.fn(async () => context),
    getResource: vi.fn(async (subject: string) => resource(subject)),
    getMany: vi.fn(async (subjects: string[]) => subjects.map(resource)),
    query: vi.fn(
      async ({
        property,
        value,
        page = 0,
        pageSize = 500,
      }: {
        property: string;
        value: string;
        page?: number;
        pageSize?: number;
      }) =>
        [...data]
          .filter(([, props]) => props[property] === value)
          .map(([subject]) => subject)
          .slice(page * pageSize, (page + 1) * pageSize),
    ),
    newResource: vi.fn(
      async ({
        parent,
        isA,
        propVals,
      }: {
        parent: string;
        isA: string[];
        propVals: Record<string, unknown>;
      }) => {
        const subject = 'atomic:created-' + ++sequence;
        data.set(subject, {
          [P + 'parent']: parent,
          [P + 'isA']: isA,
          ...propVals,
        });

        return resource(subject);
      },
    ),
    proxy: { request, connections: vi.fn(async () => []), connect: vi.fn() },
    ui: { openResource: vi.fn() },
    execution: vi.fn(async () => ({ running: false })),
  };

  return { data, store, context, app: createSyncApp(store, context), request };
}

const nodes = (data: Map<string, Record<string, unknown>>, kind: string) =>
  [...data].filter(([, props]) => props[prop('node-kind')] === kind);

describe('GitHub sync app using the shared bridge', () => {
  it.each(['organizations', 'repositories', 'mirror'])(
    'opens %s Sync with stored state and no GitHub refresh',
    async kind => {
      const { store } = setup(kind);
      const rootElement = document.createElement('div');
      await view({ root: rootElement, store });
      expect(store.proxy.request).not.toHaveBeenCalled();
      expect(store.execution).toHaveBeenCalledWith('state');
      expect(store.execution).not.toHaveBeenCalledWith('start');
      expect(rootElement.querySelector('table')).toBeNull();
      expect(rootElement.textContent).toContain(
        kind === 'mirror' ? 'Sync now' : 'Refresh list',
      );
    },
  );

  it('persists discovery metadata and native browsing destinations idempotently', async () => {
    const { app, data } = setup();
    expect(await app.refresh()).toMatchObject({ rows: 2, incomplete: false });
    const owners = nodes(data, 'owner');
    expect(
      owners.find(([, row]) => row[P + 'name'] === 'org')![1][
        prop('repository-count')
      ],
    ).toBe(1);
    expect(
      owners.find(([, row]) => row[P + 'name'] === 'person')![1][
        prop('repository-count')
      ],
    ).toBe(0);
    expect(nodes(data, 'repository')[0][1]).toMatchObject({
      [prop('repository-private')]: false,
      [prop('repository-has-issues')]: true,
      [prop('repository-open-issues')]: 7,
    });
    const before = data.size;
    await app.refresh();
    expect(data.size).toBe(before);
    expect(nodes(data, 'repositories')).toHaveLength(2);
  });

  it('derives saved collection labels and enum labels from the composed API schema', async () => {
    const { app, data, context } = setup();
    const schema = context.document.components.schemas.builtinGithubRepository;
    schema.title = 'API supplied repository heading';
    schema.properties.name.title = 'API supplied name label';
    schema.properties.private.oneOf = [
      { enum: [true], title: 'API hidden' },
      { enum: [false], title: 'API visible' },
    ];
    await app.refresh();
    const listing = nodes(data, 'repositories')[0][1];
    expect(listing[prop('collection-view')]).toMatchObject({
      version: 1,
      rowClass: classes['syncable-repository'],
      title: 'API supplied repository heading',
      openTargetProperty: prop('open-target'),
      columns: expect.arrayContaining([
        { property: P + 'name', label: 'API supplied name label' },
        {
          property: prop('repository-private'),
          label: 'Kind',
          format: 'enum',
          labels: { true: 'API hidden', false: 'API visible' },
        },
      ]),
    });
    expect(data.get(root)![prop('collection-view')]).toMatchObject({
      rowClass: classes['syncable-owner'],
      columns: expect.arrayContaining([
        {
          property: prop('repository-count'),
          label: 'API supplied repository heading',
          format: 'count',
        },
        {
          property: prop('owner-kind'),
          label: 'Kind',
          format: 'enum',
          labels: { organization: 'Organization', personal: 'Personal owner' },
        },
      ]),
    });
  });

  it('materializes navigation links during explicit discovery and mirror creation without eager issue reads', async () => {
    const { app, data, store, context, request } = setup();
    await app.refresh();
    const [ownerSubject, owner] = nodes(data, 'owner').find(
      ([, props]) => props[P + 'name'] === 'org',
    )!;
    const [listingSubject] = nodes(data, 'repositories').find(
      ([, props]) => props[P + 'parent'] === ownerSubject,
    )!;
    expect(owner[prop('open-target')]).toBe(listingSubject);
    expect(nodes(data, 'mirror')).toHaveLength(0);
    expect(request.mock.calls.map(([call]) => call.path)).not.toContain(
      'repositories/200/issues',
    );
    const [repoSubject, savedRepo] = nodes(data, 'repository')[0];
    expect(savedRepo[prop('open-target')]).toBeUndefined();
    const repositories = createSyncApp(store, {
      ...context,
      subject: listingSubject,
      kind: 'repositories',
    });
    const before = request.mock.calls.length;
    const mirror = await repositories.ensureMirror(
      await store.getResource(repoSubject),
    );
    expect(savedRepo[prop('open-target')]).toBe(mirror.subject);
    expect(request.mock.calls.length).toBe(before);
    const identity = savedRepo[P + 'localId'];
    await repositories.ensureMirror(await store.getResource(repoSubject));
    expect(savedRepo[P + 'localId']).toBe(identity);
    expect(nodes(data, 'mirror')).toHaveLength(1);
  });

  it('retains counts and rows after an incomplete discovery', async () => {
    const { app, data, request } = setup();
    await app.refresh();
    const owner = nodes(data, 'owner').find(
      ([, row]) => row[P + 'name'] === 'org',
    )![1];
    owner[prop('repository-count')] = 42;
    request.mockImplementation(async ({ path }) => ({
      status: 200,
      headers: (path === 'user/repos'
        ? { link: '<https://api.github.com/user/repos?page=2>; rel="next"' }
        : {}) as Record<string, string>,
      body:
        path === 'user/repos'
          ? [repo]
          : path === 'user/orgs'
            ? []
            : { id: 300, login: 'person' },
    }));
    expect(await app.refresh()).toMatchObject({ incomplete: true });
    expect(owner[prop('repository-count')]).toBe(42);
    expect(nodes(data, 'repository')).toHaveLength(1);
  });

  it('leaves unavailable metadata and incomplete owner counts unknown', async () => {
    const { app, data, request } = setup();
    request.mockImplementation(async ({ path }) => ({
      status: 200,
      headers: (path === 'user/repos'
        ? { link: '<https://api.github.com/user/repos?page=2>; rel="next"' }
        : {}) as Record<string, string>,
      body:
        path === 'user/repos'
          ? [{ id: repo.id, name: repo.name, owner: repo.owner }]
          : path === 'user/orgs'
            ? []
            : { id: 300, login: 'person' },
    }));
    expect(await app.refresh()).toMatchObject({ incomplete: true });
    for (const [, owner] of nodes(data, 'owner'))
      expect(owner[prop('repository-count')]).toBeUndefined();
    const row = nodes(data, 'repository')[0][1];
    for (const name of [
      'repository-private',
      'repository-has-issues',
      'repository-open-issues',
    ])
      expect(row[prop(name)]).toBeUndefined();
  });

  it('reuses moved sources without reparenting or updating outside the selected root', async () => {
    const { app, data } = setup();
    await app.refresh();
    const owner = nodes(data, 'owner').find(
      ([, row]) => row[P + 'name'] === 'org',
    )![1];
    owner[P + 'parent'] = 'atomic:elsewhere';
    owner[prop('repository-count')] = 99;
    const before = data.size;
    await app.refresh();
    expect(data.size).toBe(before);
    expect(owner[P + 'parent']).toBe('atomic:elsewhere');
    expect(owner[prop('repository-count')]).toBe(99);
  });

  it('refuses to provision a missing descendant beneath a moved account', async () => {
    const { app, data, store } = setup('platform');
    await app.openAccount('slot');
    const [, account] = nodes(data, 'account')[0];
    account[P + 'parent'] = 'atomic:elsewhere';
    for (const [subject] of nodes(data, 'organizations')) data.delete(subject);
    store.newResource.mockClear();
    await expect(app.openAccount('slot')).rejects.toThrow(
      'moved GitHub resource',
    );
    expect(store.newResource).not.toHaveBeenCalled();
  });

  it('rejects a conflicting resource occupying a stable source identity', async () => {
    const { app, data, store } = setup();
    await app.refresh();
    const [, owner] = nodes(data, 'owner')[0];
    owner[prop('source-key')] = 'unrelated';
    store.newResource.mockClear();
    await expect(app.refresh()).rejects.toThrow(
      'source identity does not match',
    );
    expect(store.newResource).not.toHaveBeenCalled();
  });

  it('reuses a moved legacy mirror without changing its identity or location', async () => {
    const { app, data, store } = setup('repositories');
    await app.refresh();
    const [repoSubject] = nodes(data, 'repository')[0];
    const mirror = await app.ensureMirror(await store.getResource(repoSubject));
    const saved = data.get(mirror.subject)!;
    const [, legacy] = sourceKeys(
      origin,
      'mirror',
      'github-repo:200',
      'slot',
      'issues',
    );
    saved[P + 'parent'] = 'atomic:elsewhere';
    saved[prop('source-key')] = legacy;
    saved[P + 'localId'] = 'syncables:node:' + encodeURIComponent(legacy);
    store.newResource.mockClear();
    expect(
      (await app.ensureMirror(await store.getResource(repoSubject))).subject,
    ).toBe(mirror.subject);
    expect(store.newResource).not.toHaveBeenCalled();
    expect(saved[P + 'parent']).toBe('atomic:elsewhere');
    expect(saved[prop('source-key')]).toBe(legacy);
  });

  it('upserts typed issues by identity, preserves user fields and retains rows on errors', async () => {
    const { app, data, request } = setup('mirror');
    expect(await app.refresh()).toMatchObject({
      added: 1,
      changed: 0,
      unchanged: 0,
    });
    const imported = [...data].find(
      ([, row]) => row[P + 'localId'] === 'syncables:github-issue:1001',
    )![1];
    imported['atomic:user-note'] = 'keep';
    expect(imported[prop('issue-updated')]).toBe(
      Date.parse(issue().updated_at),
    );
    expect(await app.refresh()).toMatchObject({ unchanged: 1 });
    request.mockResolvedValue({
      status: 200,
      headers: {},
      body: [issue('Changed')],
    });
    expect(await app.refresh()).toMatchObject({ changed: 1 });
    expect(imported['atomic:user-note']).toBe('keep');
    request.mockResolvedValue({ status: 500, headers: {}, body: null });
    await expect(app.refresh()).rejects.toThrow('HTTP 500');
    expect(imported[P + 'name']).toBe('Changed');
    expect((await app.status()).error).toContain('HTTP 500');
  });

  it('keeps identical remote issue IDs in another mirror separate', async () => {
    const { app, data } = setup('mirror');
    const foreign = {
      [P + 'parent']: 'atomic:other-mirror',
      [P + 'isA']: [classes['syncable-record']],
      [P + 'localId']: 'syncables:github-issue:1001',
      [P + 'name']: 'Other account or public mirror copy',
    };
    data.set('atomic:other-issue', foreign);
    expect(await app.refresh()).toMatchObject({ added: 1 });
    expect(foreign[P + 'name']).toBe('Other account or public mirror copy');
    expect(
      [...data.values()].filter(
        row => row[P + 'localId'] === foreign[P + 'localId'],
      ),
    ).toHaveLength(2);
  });

  it.each([{ id: '1001' }, { number: '1' }, { updated_at: 123 }])(
    'rejects invalid typed issue fields %s before import',
    async invalid => {
      const { app, store, request } = setup('mirror');
      request.mockResolvedValue({
        status: 200,
        headers: {},
        body: [{ ...issue(), ...invalid }],
      });
      await expect(app.refresh()).rejects.toThrow('invalid issue');
      expect(store.newResource).not.toHaveBeenCalled();
    },
  );

  it('rejects an issue identity occupied by a different row type', async () => {
    const { app, data, store } = setup('mirror');
    data.set('atomic:user-row', {
      [P + 'parent']: root,
      [P + 'localId']: 'syncables:github-issue:1001',
      [P + 'isA']: ['atomic:user-type'],
      [P + 'name']: 'Keep me',
    });
    await expect(app.refresh()).rejects.toThrow('identity is already in use');
    expect(store.newResource).not.toHaveBeenCalled();
    expect(data.get('atomic:user-row')![P + 'name']).toBe('Keep me');
  });

  it('loads existing mirror rows past the first local query page', async () => {
    const { app, data, store } = setup('mirror');
    for (let i = 0; i < 101; i++)
      data.set('atomic:cached-' + i, {
        [P + 'parent']: root,
        [P + 'isA']: [classes['syncable-record']],
        [P + 'localId']:
          'syncables:github-issue:' + (i === 100 ? 1001 : 2000 + i),
        [P + 'name']: 'Cached',
      });
    expect(await app.refresh()).toMatchObject({ added: 0, changed: 1 });
    expect(data.get('atomic:cached-100')![P + 'name']).toBe('First issue');
    expect(store.newResource).not.toHaveBeenCalled();
    expect(store.query).toHaveBeenCalledWith(
      expect.objectContaining({ page: 1, pageSize: 100 }),
    );
    expect(
      store.getMany.mock.calls.every(([subjects]) => subjects.length <= 100),
    ).toBe(true);
  });

  it('refuses paused work without contacting GitHub', async () => {
    const { app, data, request } = setup('mirror');
    data.get(root)![prop('mirror-status')] = { paused: true };
    await expect(app.refresh()).rejects.toThrow('Resume');
    expect(request).not.toHaveBeenCalled();
  });

  it.each([undefined, 'public'])(
    'forwards a pinned issue cursor for %s access',
    async mode => {
      const { app, request } = setup('mirror', { mode });
      request.mockResolvedValueOnce({
        status: 200,
        headers: {
          link: '</repositories/200/issues?per_page=100&page=2&state=all&after=Y3Vyc29yOjY%3D>; rel="next"',
        },
        body: [issue()],
      });
      request.mockResolvedValueOnce({ status: 200, headers: {}, body: [] });
      await app.refresh();
      expect(request).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          path: 'repositories/200/issues',
          query: {
            per_page: '100',
            page: '2',
            state: 'all',
            after: 'Y3Vyc29yOjY=',
          },
        }),
      );
    },
  );

  it('selects only the mirror collection while retaining unrelated catalog defaults', async () => {
    const { app, request } = setup('mirror', {
      querySelection: {
        query_overrides: [
          { path: '/unrelated', values: { filter: 'stored-default' } },
        ],
      },
    });
    expect(await app.refresh()).toMatchObject({ rows: 1, incomplete: false });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        path: 'repositories/200/issues',
        query: { per_page: '100', state: 'all' },
      }),
    );
  });

  it('opens saved Sync controls without needing provider metadata', async () => {
    const { store, app, request } = setup('mirror', { document: undefined });
    const element = document.createElement('div');
    await view({ root: element, store });
    expect(element.textContent).toContain('Sync now');
    expect(request).not.toHaveBeenCalled();
    await expect(app.refresh()).rejects.toThrow(
      'API description is unavailable',
    );
    expect(request).not.toHaveBeenCalled();
  });

  it('retains accepted rows and the last success when a later page fails', async () => {
    const { app, data, request } = setup('mirror');
    data.get(root)![prop('mirror-status')] = {
      lastSuccess: 'earlier complete read',
    };
    request.mockResolvedValueOnce({
      status: 200,
      headers: {
        link: '</repositories/200/issues?per_page=100&page=2&state=all>; rel="next"',
      },
      body: [issue()],
    });
    request.mockResolvedValueOnce({ status: 503, headers: {}, body: [] });
    expect(await app.refresh()).toMatchObject({
      rows: 1,
      added: 1,
      incomplete: true,
    });
    expect(await app.status()).toMatchObject({
      lastSuccess: 'earlier complete read',
      error: expect.stringContaining('HTTP 503'),
    });
    expect(
      [...data.values()].some(row => row[P + 'name'] === 'First issue'),
    ).toBe(true);
  });

  it.each([undefined, 'public'])(
    'keeps accepted records when the library reaches the %s request budget',
    async mode => {
      const { app, request, data } = setup('mirror', {
        mode,
        ...(mode ? { connectionId: undefined } : {}),
      });
      data.get(root)![prop('mirror-status')] = {
        lastSuccess: 'earlier complete read',
      };
      let page = 0;
      request.mockImplementation(async () => {
        page++;

        return {
          status: 200,
          headers: {
            link:
              '</repositories/200/issues?per_page=100&page=' +
              (page + 1) +
              '&state=all>; rel="next"',
          },
          body: [{ ...issue(), id: 1000 + page, number: page }],
        };
      });
      const limit = mode === 'public' ? 40 : 20;
      expect(await app.refresh()).toMatchObject({
        added: limit,
        rows: limit,
        incomplete: true,
      });
      expect(request).toHaveBeenCalledTimes(limit);
      expect(await app.status()).toMatchObject({
        lastSuccess: 'earlier complete read',
      });
      expect(
        request.mock.calls.every(
          ([sent]) => sent.connectionId === (mode ? undefined : 'slot'),
        ),
      ).toBe(true);
    },
  );

  it('retains an incomplete prefix if continuation repeats a provider identity', async () => {
    const { app, request } = setup('mirror');
    request.mockResolvedValueOnce({
      status: 200,
      headers: {
        link: '</repositories/200/issues?per_page=100&page=2&state=all>; rel="next"',
      },
      body: [issue()],
    });
    request.mockResolvedValueOnce({
      status: 200,
      headers: {},
      body: [issue()],
    });
    expect(await app.refresh()).toMatchObject({
      added: 1,
      rows: 1,
      incomplete: true,
    });
    expect((await app.status()).error).toContain('repeated record identity');
  });

  it('uses library link validation and retains rows without contacting a foreign origin', async () => {
    const { app, request } = setup('mirror');
    request.mockResolvedValue({
      status: 200,
      headers: {
        link: '<https://evil.example/repositories/200/issues?per_page=100&page=2&state=all>; rel="next"',
      },
      body: [issue()],
    });
    expect(await app.refresh()).toMatchObject({ added: 1, incomplete: true });
    expect(request).toHaveBeenCalledTimes(1);
    expect((await app.status()).error).toContain('origin');
  });

  it('refuses a lossy query conversion before sending a continuation', async () => {
    const { app, request } = setup('mirror');
    request.mockResolvedValue({
      status: 200,
      headers: {
        link: '</repositories/200/issues?per_page=100&page=2&state=open&state=all>; rel="next"',
      },
      body: [issue()],
    });
    expect(await app.refresh()).toMatchObject({ added: 1, incomplete: true });
    expect(request).toHaveBeenCalledTimes(1);
    expect((await app.status()).error).toContain('Repeated GitHub query');
  });

  it('forwards the exact next URL to host permission checks without rewriting its scope', async () => {
    const { app, request } = setup('mirror');
    request.mockResolvedValueOnce({
      status: 200,
      headers: {
        link: '</repositories/999/issues?per_page=100&page=2&state=open>; rel="next"',
      },
      body: [issue()],
    });
    request.mockImplementationOnce(async () => {
      throw new Error('Host refused a different source');
    });
    expect(await app.refresh()).toMatchObject({ added: 1, incomplete: true });
    expect(request).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        path: 'repositories/999/issues',
        query: { per_page: '100', page: '2', state: 'open' },
      }),
    );
    expect((await app.status()).error).toBe('Host refused a different source');
  });

  it('links anonymous repositories separately and reuses their identities', async () => {
    const { app, data, store } = setup('public', {
      connectionId: undefined,
      mode: 'public',
    });
    const first = await app.linkPublic('org/project');
    const before = data.size;
    const second = await app.linkPublic('org/project');
    expect(first.subject).toBe(second.subject);
    expect(data.size).toBe(before);
    expect(nodes(data, 'public-owner')[0][1][prop('repository-count')]).toBe(1);
    expect(store.ui.openResource).toHaveBeenCalledWith(
      expect.stringMatching(/^atomic:created-/),
    );
    await expect(app.linkPublic('../project')).rejects.toThrow('owner/repo');
  });

  it('handshakes the generic worker before performing an explicit sync', async () => {
    const { store } = setup('mirror', { worker: true });
    await view({ root: undefined, store });
    expect(store.execution).toHaveBeenCalledWith('state');
    expect(store.proxy.request).toHaveBeenCalledTimes(1);
  });
});

describe('public pagination and stable source binding', () => {
  it('retains account-qualified mirror keys and the old lookup identity', () => {
    const [current, legacy] = sourceKeys(
      origin,
      'mirror',
      'github-repo:200',
      'slot',
      'issues',
    );
    expect(JSON.parse(current)).toEqual([
      origin,
      'github-issues',
      'mirror',
      'github-repo:200',
      'issues',
      'slot',
    ]);
    expect(JSON.parse(legacy)).toHaveLength(5);
  });
});
