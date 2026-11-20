import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import {
  core,
  server,
  dataBrowser,
  collections,
  LoroLoader,
  findSchema,
  ensureSchema,
  pluginSchema,
  type Store,
  type JSONValue,
} from '@tomic/lib';
import { fakeSchemaStore } from '../../../../lib/src/test-schema-store.js';
import {
  ensureSyncablePlatform,
  findSyncablePlatform,
  platformLocalId,
  syncablePlatformSchema,
} from './syncablePlatform';
import { syncableHierarchySchema } from './syncableHierarchy';
import {
  sourceKey,
  sourceConfigFingerprint,
  type SyncablePrincipal,
} from './builtinSyncIdentity.js';
import { resolveBuiltinApp } from '../AppPage/builtinApp';
import {
  ensureSyncablePrincipalApp,
  listSyncablePrincipalApps,
  findRegisteredSyncablePrincipalApp,
} from './syncablePrincipalApp';

beforeAll(() => {
  (LoroLoader as unknown as { _Loro: unknown })._Loro = createRequire(
    import.meta.url,
  )('loro-crdt');
});

const drive = 'atomic:drive';
const scope = {
  drive,
  proxyOrigin: 'https://proxy.example',
  platform: 'calendar-service',
};
const principal: SyncablePrincipal = {
  kind: 'authenticated',
  namespace: 'https://api.example/users',
  subject: 7,
};
const connectionId = 'a'.repeat(43);

async function fixture() {
  const f = fakeSchemaStore();
  const originalDrive = f.resources.get('drive')!;
  const originalOntology = f.resources.get('drive-ontology')!;
  f.resources.delete('drive');
  f.resources.delete('drive-ontology');
  f.resources.set(drive, {
    ...originalDrive,
    [server.properties.defaultOntology]: 'atomic:drive-ontology',
  });
  f.resources.set('atomic:drive-ontology', {
    ...originalOntology,
    [core.properties.parent]: drive,
  });
  f.resources.set(core.properties.name, {
    [core.properties.isA]: [core.classes.property],
    [core.properties.datatype]: 'https://atomicdata.dev/datatypes/string',
    [core.properties.shortname]: 'name',
  });
  const originalGet = f.store.getResource.bind(f.store);
  const originalNew = f.store.newResource.bind(f.store);
  const cache = new Map<string, Awaited<ReturnType<typeof originalGet>>>();
  const persisted = new Set(f.resources.keys());
  const actor = {
    current: 'actor',
    server: 'http://localhost:9988',
    denied: new Set<string>(),
    beforeSet: undefined as undefined | (() => void),
    afterSave: undefined as undefined | ((subject: string) => void),
  };

  const wrap = async (subject: string) => {
    if (!cache.has(subject)) {
      const row = await originalGet(subject);
      const set = row.set.bind(row);
      const updated = {
        ...row,
        canWrite: async () => [!actor.denied.has(subject), undefined],
        set: async (
          property: string,
          value: JSONValue,
          _validate?: boolean,
          _datatype?: unknown,
          guard?: () => void,
        ) => {
          actor.beforeSet?.();
          guard?.();

          return set(property, value);
        },
        save: async () => {
          const own = f.resources.get(subject)!;
          const duplicate = [...f.resources].find(
            ([key, props]) =>
              persisted.has(key) &&
              key !== subject &&
              props[core.properties.parent] === own[core.properties.parent] &&
              own[core.properties.localId] &&
              props[core.properties.localId] === own[core.properties.localId],
          );
          if (duplicate) throw new Error('localId already exists');
          persisted.add(subject);
          actor.afterSave?.(subject);
        },
      };
      cache.set(subject, updated);
    }

    return cache.get(subject)!;
  };

  f.store.getResource = wrap;

  f.store.newResource = async opts => {
    const row = await originalNew(opts);
    const subject = row.subject.replace('local:', 'atomic:');
    const properties = f.resources.get(row.subject)!;
    f.resources.delete(row.subject);
    f.resources.set(subject, properties);

    return wrap(subject);
  };

  const beneath = (subject: string) => {
    const seen = new Set<string>();
    let current: unknown = subject;

    while (typeof current === 'string' && !seen.has(current)) {
      if (current === drive) return true;
      seen.add(current);
      current = f.resources.get(current)?.[core.properties.parent];
    }

    return false;
  };

  const query = vi.fn(async (url: string) => {
    const u = new URL(url);
    const p = u.searchParams.get('property')!;
    const value = u.searchParams.get('value');
    const members = [...f.resources]
      .filter(
        ([s, values]) =>
          persisted.has(s) &&
          beneath(s) &&
          (value === null
            ? values[p] !== undefined
            : Array.isArray(values[p])
              ? values[p].includes(value)
              : values[p] === value),
      )
      .map(([s]) => s);

    return {
      error: undefined,
      getLoroDoc: () => ({}),
      get: (field: string) =>
        field === collections.properties.totalMembers
          ? members.length
          : field === collections.properties.members
            ? members
            : undefined,
    };
  });
  Object.assign(f.store, {
    getAgent: () => ({ subject: actor.current }),
    getServerUrl: () => actor.server,
    fetchResourceFromServer: query,
  });
  const store = f.store as unknown as Store;
  const setup = await ensureSyncablePlatform(store, {
    ...scope,
    name: 'Calendar',
  });
  const h = await ensureSchema(store, drive, syncableHierarchySchema());
  const p = await findSchema(store, drive, syncablePlatformSchema());
  const app = await findSchema(store, drive, pluginSchema());

  const add = async (
    identity: SyncablePrincipal = principal,
    name = 'Person',
  ) => {
    const key = sourceKey({ ...scope, principal: identity, kind: 'principal' });
    const row = await store.newResource({
      parent: setup,
      isA: [dataBrowser.classes.table, h.classes['syncable-principal']],
      propVals: {
        [core.properties.name]: name,
        [core.properties.localId]: 'retained-' + name,
        [h.properties['syncable-node-kind']]: 'principal',
        [h.properties['syncable-source-key']]: key,
        [h.properties['syncable-source-config']]: {
          version: 2,
          proxyOrigin: scope.proxyOrigin,
          platform: scope.platform,
          principal: identity,
          ...(identity.kind === 'authenticated' ? { connectionId } : {}),
        } as unknown as JSONValue,
        [core.properties.classtype]: dataBrowser.classes.table,
        [dataBrowser.properties.tableViews]: ['existing-view'],
      },
    });
    await row.save();

    return row;
  };

  const promote = (
    subject: string,
    identity: SyncablePrincipal = principal,
    extra = {},
  ) =>
    ensureSyncablePrincipalApp(store, {
      ...scope,
      setup,
      subject,
      principal: identity,
      providerName: 'Calendar',
      assertCurrent: () => {},
      ...extra,
    });

  return {
    ...f,
    store,
    setup,
    h,
    p: p.properties!,
    app,
    add,
    promote,
    actor,
    query,
    persisted,
  };
}

describe('one native Syncables App per typed principal', () => {
  it('promotes in place and preserves children, IDs, views and source identity', async () => {
    const f = await fixture();
    const row = await f.add();
    f.resources.set('atomic:records', {
      [core.properties.parent]: row.subject,
      [core.properties.name]: 'Saved rows',
    });
    f.resources.get(f.setup)![f.p['syncable-api-document']] = {
      openapi: '3.0.0',
    };
    f.resources.get(f.setup)![f.p['syncable-api-selection']] = { saved: true };
    const before = { ...f.resources.get(row.subject)! };
    expect(await f.promote(row.subject)).toBe(row.subject);
    const saved = f.resources.get(row.subject)!;
    for (const field of [
      core.properties.localId,
      core.properties.classtype,
      dataBrowser.properties.tableViews,
      f.h.properties['syncable-source-key'],
      f.h.properties['syncable-source-config'],
    ])
      expect(saved[field]).toEqual(before[field]);
    expect(saved[core.properties.parent]).toBe(drive);
    expect(saved[core.properties.isA]).toEqual(
      expect.arrayContaining([
        dataBrowser.classes.table,
        f.h.classes['syncable-principal'],
        f.app.classes!.app,
      ]),
    );
    expect(saved[f.app.properties!['app-data']]).toBe(row.subject);
    expect(saved[f.p['syncable-api-document']]).toEqual({ openapi: '3.0.0' });
    expect(saved[f.p['syncable-api-selection']]).toEqual({ saved: true });
    expect(saved[core.properties.name]).toBe('Calendar · Person');
    const snapshot = JSON.stringify([...f.resources]);
    expect(await resolveBuiltinApp(f.store, drive, row.subject)).toEqual({
      kind: 'syncables',
      table: row.subject,
      principal: true,
    });
    expect(JSON.stringify([...f.resources])).toBe(snapshot);
    expect(f.resources.get('atomic:records')![core.properties.parent]).toBe(
      row.subject,
    );
    expect(await listSyncablePrincipalApps(f.store, scope)).toEqual([
      {
        subject: row.subject,
        name: 'Calendar · Person',
        principal,
        connectionId,
      },
    ]);
  });
  it('reuses after renaming, moving, losing the index and a new verified slot', async () => {
    const f = await fixture();
    const row = await f.add();
    await f.promote(row.subject);
    f.resources.set('atomic:folder', { [core.properties.parent]: drive });
    await row.set(core.properties.parent, 'atomic:folder');
    await row.set(core.properties.name, 'My account');
    await row.set(dataBrowser.properties.icon, 'chosen-icon');
    f.resources.get(drive)![f.p['syncable-principal-app-index']] = {};
    const size = f.resources.size;
    expect(
      await f.promote(row.subject, principal, { connectionId: 'b'.repeat(43) }),
    ).toBe(row.subject);
    expect(f.resources.size).toBe(size);
    expect(row.get(core.properties.parent)).toBe('atomic:folder');
    expect(row.get(core.properties.name)).toBe('My account');
    expect(row.get(dataBrowser.properties.icon)).toBe('chosen-icon');
    expect(
      (
        await findRegisteredSyncablePrincipalApp(f.store, {
          ...scope,
          principal,
        })
      )?.connectionId,
    ).toBe('b'.repeat(43));
  });
  it('keeps typed identities, client contexts and Public separate', async () => {
    const f = await fixture();
    const identities: SyncablePrincipal[] = [
      principal,
      { ...principal, subject: '7' },
      { ...principal, clientContext: 'other-client' },
      { kind: 'public' },
    ];
    const subjects = [];

    for (const [i, identity] of identities.entries()) {
      const row = await f.add(identity, 'Person' + i);
      subjects.push(await f.promote(row.subject, identity));
    }

    expect(new Set(subjects).size).toBe(4);
    expect(await listSyncablePrincipalApps(f.store, scope)).toHaveLength(4);
  });
  it('serializes repeated promotion without duplicate registrations', async () => {
    const f = await fixture();
    const row = await f.add();
    expect(
      await Promise.all([f.promote(row.subject), f.promote(row.subject)]),
    ).toEqual([row.subject, row.subject]);
    expect(
      [...f.resources.values()].filter(
        v => v[f.p['syncable-principal-app-key']],
      ),
    ).toHaveLength(1);
  });
  it('rejects conflicting sources without promoting or deleting either', async () => {
    const f = await fixture();
    const first = await f.add(principal, 'One');
    const second = await f.add(principal, 'Two');
    const before = JSON.stringify([...f.resources]);
    await expect(f.promote(first.subject)).rejects.toThrow('conflicting');
    expect(JSON.stringify([...f.resources])).toBe(before);
    expect(f.resources.has(second.subject)).toBe(true);
  });
  it.each(['principal', 'source', 'outside', 'permission', 'session'])(
    'rejects %s changes',
    async attack => {
      const f = await fixture();
      const row = await f.add();
      if (attack === 'source')
        await row.set(f.h.properties['syncable-source-key'], 'forged');
      if (attack === 'outside')
        await row.set(core.properties.parent, 'another-drive');
      if (attack === 'permission') f.actor.denied.add(drive);

      if (attack === 'session')
        f.actor.beforeSet = () => {
          f.actor.current = 'another-actor';
        };

      await expect(
        f.promote(
          row.subject,
          attack === 'principal' ? { ...principal, subject: 8 } : principal,
        ),
      ).rejects.toThrow();
      expect(row.get(core.properties.isA)).not.toContain(f.app.classes!.app);
    },
  );
  it('recovers an acknowledged registration whose response was lost', async () => {
    const f = await fixture();
    const row = await f.add();

    f.actor.afterSave = subject => {
      if (
        String(f.resources.get(subject)?.[core.properties.localId]).startsWith(
          'syncables:principal-app:',
        )
      ) {
        f.actor.afterSave = undefined;
        throw new Error('Response lost after commit');
      }
    };

    expect(await f.promote(row.subject)).toBe(row.subject);
    expect(
      [...f.resources].filter(
        ([s, v]) => f.persisted.has(s) && v[f.p['syncable-principal-app-key']],
      ),
    ).toHaveLength(1);
  });
  it('resumes promotion interrupted between App metadata and the parent change', async () => {
    const f = await fixture();
    const row = await f.add();

    f.actor.afterSave = subject => {
      if (
        subject === row.subject &&
        (row.get(core.properties.isA) as string[]).includes(
          f.app.classes!.app,
        ) &&
        row.get(core.properties.parent) === f.setup
      ) {
        f.actor.afterSave = undefined;
        throw new Error('Interrupted promotion');
      }
    };

    await expect(f.promote(row.subject)).rejects.toThrow('Interrupted');
    expect(row.get(core.properties.parent)).toBe(f.setup);
    expect(await f.promote(row.subject)).toBe(row.subject);
    expect(row.get(core.properties.parent)).toBe(drive);
    expect(row.get(core.properties.name)).toBe('Calendar · Person');
  });
  it('does not restore a user-removed icon or change the cached App name on reuse', async () => {
    const f = await fixture();
    const row = await f.add();
    await f.promote(row.subject);
    f.resources.get(f.setup)![dataBrowser.properties.icon] = 'provider-icon';
    await row.set(core.properties.name, 'My title');
    expect(await f.promote(row.subject)).toBe(row.subject);
    expect(row.get(core.properties.name)).toBe('My title');
    expect(row.get(dataBrowser.properties.icon)).toBeUndefined();
  });
  it('finds a moved setup after its index is lost and excludes a principal App from setup lookup', async () => {
    const f = await fixture();
    const row = await f.add();
    await f.promote(row.subject);
    f.resources.set('atomic:folder', { [core.properties.parent]: drive });
    f.resources.get(f.setup)![core.properties.parent] = 'atomic:folder';
    f.resources.get(drive)![f.p['syncable-platform-index']] = {};
    expect(await findSyncablePlatform(f.store, scope)).toBe(f.setup);
    f.resources.get(drive)![f.p['syncable-platform-index']] = {
      [platformLocalId(scope.proxyOrigin, scope.platform)]: row.subject,
    };
    expect(await findSyncablePlatform(f.store, scope)).toBe(f.setup);
  });
  it.each(['index', 'query', 'setup', 'principal', 'ontology', 'claim'])(
    'rejects poisoned external %s subjects before fetching them',
    async attack => {
      const f = await fixture();
      const row = await f.add();
      const foreign = 'https://outside.example/private';
      if (attack === 'index' || attack === 'claim')
        await f.promote(row.subject);

      if (attack === 'index') {
        const key = sourceKey({ ...scope, principal, kind: 'principal' });
        f.resources.get(drive)![f.p['syncable-principal-app-index']] = {
          [sourceConfigFingerprint(key)]: foreign,
        };
      }

      if (attack === 'ontology')
        f.resources.get(drive)![server.properties.defaultOntology] = foreign;

      if (attack === 'query') {
        const original = f.query.getMockImplementation()!;
        f.query.mockImplementation(async url => {
          if (
            new URL(url).searchParams.get('property') !==
            f.h.properties['syncable-source-key']
          )
            return original(url);

          return {
            error: undefined,
            getLoroDoc: () => ({}),
            get: (p: string) =>
              p === collections.properties.totalMembers ? 1 : [foreign],
          };
        });
      }

      if (attack === 'claim') {
        const claim = [...f.resources.values()].find(
          v => v[f.p['syncable-principal-app-key']],
        );
        claim![f.p['syncable-principal-app-target']] = foreign;
      }

      const get = vi.spyOn(f.store, 'getResource');
      const action =
        attack === 'index'
          ? findRegisteredSyncablePrincipalApp(f.store, { ...scope, principal })
          : ensureSyncablePrincipalApp(f.store, {
              ...scope,
              setup: attack === 'setup' ? foreign : f.setup,
              subject: attack === 'principal' ? foreign : row.subject,
              principal,
              providerName: 'Calendar',
              assertCurrent: () => {},
            });
      await expect(action).rejects.toThrow();
      expect(get.mock.calls.some(([subject]) => subject === foreign)).toBe(
        false,
      );
    },
  );
  it('finds the same registered App through a fresh host Store with no memory index', async () => {
    const f = await fixture();
    const row = await f.add();
    await f.promote(row.subject);
    f.resources.get(drive)![f.p['syncable-principal-app-index']] = {};
    const fresh = { ...f.store, resources: new Map() } as unknown as Store;
    const size = f.resources.size;
    expect(
      await ensureSyncablePrincipalApp(fresh, {
        ...scope,
        setup: f.setup,
        subject: row.subject,
        principal,
        providerName: 'Renamed provider',
        assertCurrent: () => {},
      }),
    ).toBe(row.subject);
    expect(f.resources.size).toBe(size);
  });
  it('refuses incomplete server lookup rather than allocating another App', async () => {
    const f = await fixture();
    const row = await f.add();
    f.query.mockResolvedValue({
      error: undefined,
      getLoroDoc: () => ({}),
      get: (p: string) => (p === collections.properties.totalMembers ? 1 : []),
    });
    const before = JSON.stringify([...f.resources]);
    await expect(f.promote(row.subject)).rejects.toThrow('Incomplete');
    expect(JSON.stringify([...f.resources])).toBe(before);
  });
});
