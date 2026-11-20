import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('loro-crdt', () => import('loro-crdt/nodejs'));
import {
  CollectionBuilder,
  collections,
  core,
  type JSONValue,
  type Store,
} from '@tomic/react';
import type { ProxyHost } from '@helpers/proxyConnections';
import {
  bindHostProfile,
  handleRequest,
  type HostStoreProfile,
} from './hostStore';

const ROOT = 'https://node.test/selected';
const CHILD = 'https://node.test/child';
const OUTSIDE = 'https://node.test/other';
const DRIVE = 'https://node.test/drive';

afterEach(() => vi.restoreAllMocks());

function setup() {
  let actor = { subject: 'did:ad:agent:person' };
  let server = 'https://node.test';
  let writable = true;
  let current = true;
  const controller = new AbortController();
  const rows = new Map<string, Record<string, JSONValue>>([
    [ROOT, { [core.properties.parent]: DRIVE }],
    [
      CHILD,
      { [core.properties.parent]: ROOT, [core.properties.name]: 'Before' },
    ],
    [OUTSIDE, { [core.properties.parent]: DRIVE }],
  ]);
  const saved = vi.fn();
  const destroyed = vi.fn();
  const wrap = (subject: string) => ({
    subject,
    title: subject,
    error: undefined,
    get: (property: string) => rows.get(subject)?.[property],
    getPropVals: () => ({ ...rows.get(subject) }),
    canWrite: async () => [writable, undefined],
    set: vi.fn(
      async (
        property: string,
        value: JSONValue,
        _validate?: boolean,
        _datatype?: unknown,
        beforeMutation?: () => void,
      ) => {
        beforeMutation?.();
        rows.get(subject)![property] = value;
      },
    ),
    remove: vi.fn((property: string) => delete rows.get(subject)![property]),
    save: async () => saved(subject, actor),
    destroy: async () => destroyed(subject, actor),
  });
  const resources = new Map(
    [...rows.keys()].map(subject => [subject, wrap(subject)]),
  );
  const store = {
    getAgent: () => actor,
    getServerUrl: () => server,
    getDrive: () => 'https://node.test/another-drive',
    resources,
    normalizeSubject: (subject: string) => subject,
    getResource: vi.fn(
      async (subject: string) => resources.get(subject) ?? wrap(subject),
    ),
    newResource: vi.fn(async ({ parent, isA, propVals }) => {
      const subject = 'https://node.test/new';
      rows.set(subject, {
        [core.properties.parent]: parent,
        [core.properties.isA]: isA,
        ...propVals,
      });
      const resource = wrap(subject);
      resources.set(subject, resource);

      return resource;
    }),
    removeResource: vi.fn(),
  } as unknown as Store;
  const profile = bindHostProfile(store, {
    context: { kind: 'collection', subject: OUTSIDE, agent: 'forged' },
    access: {
      root: ROOT,
      signal: controller.signal,
      assertCurrent: () => {
        if (!current) throw new Error('Source changed');
      },
    },
  });
  const request = (
    op: string,
    extra: Record<string, unknown> = {},
    proxy?: ProxyHost,
  ) =>
    handleRequest(
      store,
      ROOT,
      DRIVE,
      { __atomic: true, id: 1, op, ...extra },
      ROOT,
      proxy,
      undefined,
      profile,
    );

  return {
    store,
    rows,
    resources,
    saved,
    destroyed,
    controller,
    profile,
    request,
    changeActor: () => {
      actor = { subject: 'did:ad:agent:other' };
    },
    changeServer: () => {
      server = 'https://another.test';
    },
    revokeWrite: () => {
      writable = false;
    },
    changeSource: () => {
      current = false;
    },
  };
}

describe('host-selected view authority', () => {
  it('uses user Store writes under the selected root without app-write or root-drive access', async () => {
    const ctx = setup();
    const fetch = vi.spyOn(globalThis, 'fetch');
    await ctx.request('save', {
      subject: CHILD,
      propVals: { [core.properties.name]: 'After' },
    });
    expect(ctx.rows.get(CHILD)![core.properties.name]).toBe('After');
    expect(ctx.saved).toHaveBeenCalledWith(CHILD, ctx.store.getAgent());
    const created = await ctx.request('create', {
      propVals: { [core.properties.name]: 'New' },
    });
    expect(created).toMatchObject({ subject: 'https://node.test/new' });
    expect(ctx.rows.get('https://node.test/new')![core.properties.parent]).toBe(
      ROOT,
    );
    expect(fetch).not.toHaveBeenCalled();

    await expect(
      ctx.request('save', { subject: OUTSIDE, propVals: {} }),
    ).rejects.toThrow('selected resource');
    await expect(ctx.request('create', { parent: DRIVE })).rejects.toThrow(
      'selected resource',
    );
    await expect(
      ctx.request('create', {
        parent: ROOT,
        propVals: { [core.properties.parent]: OUTSIDE },
      }),
    ).rejects.toThrow();
  });

  it('checks current rights and prevents moving or detaching resources beyond the root', async () => {
    const ctx = setup();
    await expect(
      ctx.request('save', {
        subject: CHILD,
        propVals: { [core.properties.parent]: OUTSIDE },
      }),
    ).rejects.toThrow('selected resource');
    await expect(
      ctx.request('save', {
        subject: ROOT,
        propVals: { [core.properties.parent]: CHILD },
      }),
    ).rejects.toThrow('selected root');
    await expect(
      ctx.request('save', {
        subject: CHILD,
        propVals: { [core.properties.parent]: CHILD },
      }),
    ).rejects.toThrow('selected resource');
    await expect(
      ctx.request('save', { subject: CHILD, remove: [core.properties.parent] }),
    ).rejects.toThrow('remove the resource parent');
    expect(ctx.saved).not.toHaveBeenCalled();
    ctx.revokeWrite();
    await expect(
      ctx.request('save', {
        subject: CHILD,
        propVals: { [core.properties.name]: 'Denied' },
      }),
    ).rejects.toThrow('Write access');
    expect(ctx.rows.get(CHILD)![core.properties.name]).toBe('Before');
  });

  it.each(['changeActor', 'changeServer', 'changeSource'] as const)(
    'refuses writes after %s',
    async change => {
      const ctx = setup();
      ctx[change]();
      await expect(
        ctx.request('save', {
          subject: CHILD,
          propVals: { [core.properties.name]: 'Stale' },
        }),
      ).rejects.toThrow();
      expect(ctx.saved).not.toHaveBeenCalled();
      expect(ctx.rows.get(CHILD)![core.properties.name]).toBe('Before');
    },
  );

  it('checks identity again after an awaited permission check', async () => {
    const ctx = setup();

    ctx.resources.get(CHILD)!.canWrite = async () => {
      ctx.changeActor();

      return [true, undefined];
    };

    await expect(
      ctx.request('save', {
        subject: CHILD,
        propVals: { [core.properties.name]: 'Stale' },
      }),
    ).rejects.toThrow('session');
    expect(ctx.saved).not.toHaveBeenCalled();
  });

  it('checks source cancellation between resource mutations and signing the save', async () => {
    const ctx = setup();
    ctx.resources
      .get(CHILD)!
      .set.mockImplementationOnce(async () => ctx.controller.abort());
    await expect(
      ctx.request('save', {
        subject: CHILD,
        propVals: { [core.properties.name]: 'Stale' },
      }),
    ).rejects.toThrow();
    expect(ctx.saved).not.toHaveBeenCalled();
  });

  it('refuses a delayed edit when the resource moves outside its selected root', async () => {
    const ctx = setup();
    let entered!: () => void;
    const started = new Promise<void>(resolve => {
      entered = resolve;
    });
    let release!: () => void;
    const waiting = new Promise<void>(resolve => {
      release = resolve;
    });
    ctx.resources
      .get(CHILD)!
      .set.mockImplementationOnce(
        async (property, value, _validate, _datatype, beforeMutation) => {
          entered();
          await waiting;
          beforeMutation?.();
          ctx.rows.get(CHILD)![property] = value;
        },
      );
    const pending = ctx.request('save', {
      subject: CHILD,
      propVals: { [core.properties.name]: 'Stale' },
    });
    await started;
    ctx.rows.get(CHILD)![core.properties.parent] = OUTSIDE;
    release();
    await expect(pending).rejects.toThrow('selected resource');
    expect(ctx.rows.get(CHILD)![core.properties.name]).toBe('Before');
    expect(ctx.saved).not.toHaveBeenCalled();
    expect(await ctx.request('get', { subject: CHILD })).toMatchObject({
      subject: CHILD,
      propVals: { [core.properties.parent]: OUTSIDE },
    });
  });

  it('pins context identity and queries to the mounting drive rather than the active drive', async () => {
    const ctx = setup();
    expect(await ctx.request('context')).toEqual({
      kind: 'collection',
      subject: ROOT,
      agent: ctx.store.getAgent()?.subject,
    });
    const scoped = vi.spyOn(CollectionBuilder.prototype, 'setDrive');
    vi.spyOn(CollectionBuilder.prototype, 'build').mockReturnValue({
      getMembersOnPage: async () => [CHILD],
    } as never);
    expect(
      await ctx.request('query', {
        property: core.properties.parent,
        value: ROOT,
        page: 0,
        authoritativeQueries: true,
      }),
    ).toEqual([CHILD]);
    expect(scoped).toHaveBeenCalledWith(DRIVE);
  });

  it('uses a complete hosted identity query instead of a stale empty cache under the mounting drive', async () => {
    const ctx = setup();
    Object.assign(ctx.profile, { authoritativeQueries: true });
    const cached = vi
      .spyOn(CollectionBuilder.prototype, 'build')
      .mockReturnValue({
        getMembersOnPage: async () => [],
      } as never);
    const fetch = vi.fn(async (subject: string, _options?: unknown) => {
      const url = new URL(subject);
      const members =
        url.searchParams.get('drive') === DRIVE ? [CHILD] : [OUTSIDE];

      return {
        getLoroDoc: () => {},
        get: (property: string) =>
          property === collections.properties.totalMembers
            ? members.length
            : members,
      };
    });
    ctx.store.fetchResourceFromServer = fetch as never;
    expect(
      await ctx.request('query', {
        property: core.properties.localId,
        value: 'stable-identity',
        page: 0,
        drive: OUTSIDE,
        authoritativeQueries: false,
      }),
    ).toEqual([CHILD]);
    expect(cached).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledOnce();
    const url = new URL(fetch.mock.calls[0][0]);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      drive: DRIVE,
      property: core.properties.localId,
      value: 'stable-identity',
      page_size: '100',
      current_page: '0',
      include_nested: 'false',
    });
    expect(fetch.mock.calls[0][1]).toEqual({
      noWebSocket: true,
      forceOverride: true,
    });
  });

  it.each([
    { page: 1, pageSize: 100, start: 100, end: 200 },
    { page: 2, pageSize: 3, start: 6, end: 9 },
    { page: undefined, pageSize: 100, start: 0, end: 500 },
  ])(
    'preserves page slicing after validating every hosted identity-query page (%j)',
    async ({ page, pageSize, start, end }) => {
      const ctx = setup();
      Object.assign(ctx.profile, { authoritativeQueries: true });
      const members = Array.from(
        { length: 605 },
        (_, index) => 'https://node.test/member-' + index,
      );
      const fetch = vi.fn(async (subject: string) => {
        const hostedPage = Number(
          new URL(subject).searchParams.get('current_page'),
        );

        return {
          getLoroDoc: () => {},
          get: (property: string) =>
            property === collections.properties.totalMembers
              ? members.length
              : members.slice(hostedPage * 100, hostedPage * 100 + 100),
        };
      });
      ctx.store.fetchResourceFromServer = fetch as never;
      expect(
        await ctx.request('query', {
          property: core.properties.parent,
          value: ROOT,
          page,
          pageSize,
        }),
      ).toEqual(members.slice(start, end));
      expect(fetch).toHaveBeenCalledTimes(7);
      for (const [subject] of fetch.mock.calls)
        expect(new URL(subject).searchParams.get('drive')).toBe(DRIVE);
    },
  );

  it.each(['offline', 'network', 'error', 'incomplete'])(
    'refuses to infer hosted identity absence after %s',
    async failure => {
      const ctx = setup();
      Object.assign(ctx.profile, { authoritativeQueries: true });
      vi.spyOn(CollectionBuilder.prototype, 'build').mockReturnValue({
        getMembersOnPage: async () => [],
      } as never);
      if (failure === 'offline') Object.assign(ctx.store, { noServer: true });
      ctx.store.fetchResourceFromServer = vi.fn(async () => {
        if (failure === 'network') throw new Error('Connection lost');

        return {
          error: failure === 'error' ? new Error('Query refused') : undefined,
          getLoroDoc: () => {},
          get: (property: string) =>
            property === collections.properties.totalMembers ? 1 : [],
        };
      }) as never;
      await expect(
        ctx.request('query', {
          property: core.properties.localId,
          value: 'stable',
          page: 0,
        }),
      ).rejects.toThrow();
      expect(ctx.store.newResource).not.toHaveBeenCalled();
    },
  );

  it.each(['changeActor', 'changeServer', 'changeSource', 'cancel'] as const)(
    'suppresses identity results and further pages after %s during hosted query',
    async change => {
      const ctx = setup();
      Object.assign(ctx.profile, { authoritativeQueries: true });
      ctx.store.fetchResourceFromServer = vi.fn(async () => {
        if (change === 'cancel') ctx.controller.abort();
        else ctx[change]();

        return {
          getLoroDoc: () => {},
          get: (property: string) =>
            property === collections.properties.totalMembers ? 101 : [CHILD],
        };
      }) as never;
      await expect(
        ctx.request('query', {
          property: core.properties.localId,
          value: 'stable',
          page: 0,
        }),
      ).rejects.toThrow();
      expect(ctx.store.fetchResourceFromServer).toHaveBeenCalledOnce();
    },
  );

  it.each([
    { filters: [{ property: core.properties.name, value: 'extra' }] },
    { sortBy: core.properties.name },
    { sortDesc: true },
  ])(
    'rejects unsupported hosted query constraints instead of dropping them (%j)',
    async constraint => {
      const ctx = setup();
      Object.assign(ctx.profile, { authoritativeQueries: true });
      ctx.store.fetchResourceFromServer = vi.fn() as never;
      await expect(
        ctx.request('query', {
          property: core.properties.localId,
          value: 'stable',
          page: 0,
          ...constraint,
        }),
      ).rejects.toThrow();
      expect(ctx.store.fetchResourceFromServer).not.toHaveBeenCalled();
    },
  );

  it('confines native-profile reads to its selected Drive while preserving ordinary App reads', async () => {
    const ctx = setup();
    const foreign = 'https://node.test/foreign-row';
    ctx.rows.set(foreign, {
      [core.properties.parent]: 'https://node.test/another-drive',
      [core.properties.name]: 'Other Drive secret',
    });
    const authorizeRead = vi.fn(async (subject: string) => {
      if (subject === foreign) throw new Error('Outside selected Drive');
    });
    Object.assign(ctx.profile, { authorizeRead });
    expect(await ctx.request('get', { subject: CHILD })).toMatchObject({
      subject: CHILD,
    });
    await expect(ctx.request('get', { subject: foreign })).rejects.toThrow(
      'Outside selected Drive',
    );
    expect(
      await ctx.request('getMany', { subjects: [CHILD, foreign] }),
    ).toEqual([
      expect.objectContaining({
        subject: CHILD,
        props: expect.objectContaining({ [core.properties.name]: 'Before' }),
      }),
      { subject: foreign, error: 'Outside selected Drive' },
    ]);
    expect(
      await handleRequest(ctx.store, ROOT, DRIVE, {
        __atomic: true,
        id: 2,
        op: 'get',
        subject: foreign,
      }),
    ).toMatchObject({
      propVals: { [core.properties.name]: 'Other Drive secret' },
    });
    expect(authorizeRead).toHaveBeenCalledWith(CHILD);
  });

  it('revalidates a native read after loading when its resource moved to another Drive', async () => {
    const ctx = setup();
    let allowed = true;
    Object.assign(ctx.profile, {
      authorizeRead: async () => {
        if (!allowed) throw new Error('Read resource moved');
      },
    });
    vi.mocked(ctx.store.getResource).mockImplementationOnce(async () => {
      allowed = false;

      return ctx.resources.get(CHILD)! as never;
    });
    await expect(ctx.request('get', { subject: CHILD })).rejects.toThrow(
      'Read resource moved',
    );
  });

  it('rejects unsupported search for a Drive-scoped native profile without querying another active Drive', async () => {
    const ctx = setup();
    Object.assign(ctx.profile, { authorizeRead: vi.fn() });
    ctx.store.search = vi.fn(async () => [OUTSIDE]);
    await expect(ctx.request('search', { text: 'secret' })).rejects.toThrow(
      'search',
    );
    expect(ctx.store.search).not.toHaveBeenCalled();
    expect(
      await handleRequest(ctx.store, ROOT, DRIVE, {
        __atomic: true,
        id: 2,
        op: 'search',
        ...{ text: 'secret' },
      }),
    ).toEqual([OUTSIDE]);
  });

  it.each(['changeActor', 'changeServer', 'changeSource', 'cancel'] as const)(
    'suppresses native resource reads after %s during read authorization',
    async change => {
      const ctx = setup();
      Object.assign(ctx.profile, {
        authorizeRead: async () => {
          if (change === 'cancel') ctx.controller.abort();
          else ctx[change]();
        },
      });
      await expect(ctx.request('get', { subject: CHILD })).rejects.toThrow();
      expect(ctx.store.getResource).not.toHaveBeenCalled();
    },
  );

  it('validates complete hosted query membership before page slicing and omits only proven foreign Drive rows', async () => {
    const ctx = setup();
    Object.assign(ctx.profile, {
      authoritativeQueries: true,
      queryMemberInScope: vi.fn(async (subject: string) => subject !== OUTSIDE),
    });
    ctx.store.fetchResourceFromServer = vi.fn(async () => ({
      getLoroDoc: () => {},
      get: (property: string) =>
        property === collections.properties.totalMembers
          ? 3
          : [OUTSIDE, CHILD, ROOT],
    })) as never;
    expect(
      await ctx.request('query', {
        property: core.properties.localId,
        value: 'same-id',
        page: 1,
        pageSize: 1,
      }),
    ).toEqual([ROOT]);
    expect(
      (
        ctx.profile as unknown as {
          queryMemberInScope: ReturnType<typeof vi.fn>;
        }
      ).queryMemberInScope,
    ).toHaveBeenCalledTimes(3);
  });

  it('refuses to infer query absence when a legacy member Drive cannot be proved', async () => {
    const ctx = setup();
    Object.assign(ctx.profile, {
      authoritativeQueries: true,
      queryMemberInScope: async () => {
        throw new Error('Ancestry unavailable');
      },
    });
    ctx.store.fetchResourceFromServer = vi.fn(async () => ({
      getLoroDoc: () => {},
      get: (property: string) =>
        property === collections.properties.totalMembers ? 1 : [OUTSIDE],
    })) as never;
    await expect(
      ctx.request('query', {
        property: core.properties.localId,
        value: 'same-id',
        page: 0,
      }),
    ).rejects.toThrow('Ancestry unavailable');
  });

  it('routes host proxy requests through the selected callback and suppresses stale responses', async () => {
    const ctx = setup();
    const request = vi.fn(async () => ({
      status: 200,
      headers: {},
      text: '[]',
    }));
    const proxy: ProxyHost = {
      request,
      capability: vi.fn(),
      connections: vi.fn(),
      origin: 'https://proxy.test',
    };
    expect(
      await ctx.request(
        'proxyFetch',
        { platform: 'public', path: '/items', method: 'GET' },
        proxy,
      ),
    ).toEqual({ status: 200, headers: {}, text: '[]' });
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ path: '/items' }),
      ctx.profile.access.signal,
    );
    request.mockImplementationOnce(async () => {
      ctx.changeSource();

      return { status: 200, headers: {}, text: 'private response' };
    });
    await expect(
      ctx.request('proxyFetch', { path: '/items' }, proxy),
    ).rejects.toThrow('Source changed');
  });

  it('exposes execution only when supplied by the native mount, with no frame-selected root', async () => {
    const ctx = setup();
    const execution = vi.fn(async action => ({ running: action === 'start' }));
    (ctx.profile as HostStoreProfile).execution = execution;
    expect(
      await ctx.request('execution', { action: 'start', root: OUTSIDE }),
    ).toEqual({ running: true });
    expect(execution).toHaveBeenCalledWith('start');
    await expect(
      ctx.request('execution', { action: 'delete' }),
    ).rejects.toThrow('Unknown');
    await expect(
      handleRequest(ctx.store, ROOT, DRIVE, {
        __atomic: true,
        id: 2,
        op: 'execution',
        action: 'start',
      }),
    ).rejects.toThrow('cannot manage');
  });
});
