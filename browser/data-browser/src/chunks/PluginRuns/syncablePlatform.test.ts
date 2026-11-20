import { describe, expect, it, vi } from 'vitest';
import {
  AtomicError,
  ErrorType,
  core,
  server,
  dataBrowser,
  Datatype,
  findSchema,
  ensureSchema,
  pluginSchema,
} from '@tomic/lib';
import { fakeSchemaStore as createFakeSchemaStore } from '../../../../lib/src/test-schema-store.js';
import {
  ensureSyncablePlatform,
  findSyncablePlatform,
  findSyncableLegacyAccounts,
  platformLocalId,
  syncablePlatformSchema,
  classifySyncableResourceDrive,
  isSyncableResourceInDrive,
} from './syncablePlatform';
import { syncableHierarchySchema } from './syncableHierarchy';

function fakeSchemaStore() {
  const fixture = createFakeSchemaStore();
  fixture.resources.set(core.properties.name, {
    [core.properties.isA]: [core.classes.property],
    [core.properties.datatype]: Datatype.STRING,
    [core.properties.shortname]: 'name',
  });

  const get = fixture.store.getResource.bind(fixture.store);
  fixture.store.getResource = async subject => ({
    ...(await get(subject)),
    getChildrenCollection: async () => ({
      getAllMembers: async () =>
        [...fixture.resources]
          .filter(([, values]) => values[core.properties.parent] === subject)
          .map(([id]) => id),
    }),
    remove: (property: string) => {
      delete fixture.resources.get(subject)?.[property];
    },
  });

  return fixture;
}

describe('platformLocalId', () => {
  it('is scoped to the configured proxy and stable across display names', () => {
    expect(platformLocalId('https://proxy.example', 'github-issues')).toBe(
      platformLocalId('https://proxy.example', 'github-issues'),
    );
    expect(platformLocalId('https://proxy.example', 'github-issues')).not.toBe(
      platformLocalId('https://other.example', 'github-issues'),
    );
    expect(() =>
      platformLocalId('https://proxy.example/path', 'github-issues'),
    ).toThrow('must be an origin');
    expect(() => platformLocalId('https://proxy.example', '../unsafe')).toThrow(
      'Invalid integration platform ID',
    );
  });
});

describe('ensureSyncablePlatform', () => {
  it('creates one root App without an Accounts container and reuses it', async () => {
    const { store, resources } = fakeSchemaStore();
    const options = {
      drive: 'drive',
      proxyOrigin: 'https://proxy.example',
      platform: 'calendar-service',
      name: 'Calendar',
    };
    const first = await ensureSyncablePlatform(store, options);
    const app = await findSchema(store, options.drive, pluginSchema());
    const size = resources.size;
    expect(resources.get(first)?.[app.properties!['app-data']]).toBe(first);
    expect(
      [...resources.values()].some(
        values => values[core.properties.localId] === 'syncables:accounts',
      ),
    ).toBe(false);
    expect(
      await ensureSyncablePlatform(store, { ...options, name: 'Renamed' }),
    ).toBe(first);
    expect(resources.size).toBe(size);
    expect(resources.get(first)?.[core.properties.name]).toBe('Calendar');
    expect(resources.get(first)?.[core.properties.isA]).toEqual([
      app.classes!.app,
    ]);
  });

  it('still recognizes a table after the user moves it', async () => {
    const { store, resources } = fakeSchemaStore();
    const input = {
      drive: 'drive',
      proxyOrigin: 'https://proxy.example',
      platform: 'github-issues',
      name: 'GitHub',
    };
    const first = await ensureSyncablePlatform(store, input);
    resources.set('other-folder', { [core.properties.parent]: 'drive' });
    const table = await store.getResource(first);
    await table.set(core.properties.parent, 'other-folder');
    await table.save();

    expect(await findSyncablePlatform(store, input)).toBe(first);
    expect(await ensureSyncablePlatform(store, input)).toBe(first);
  });

  it('does not adopt an unrelated resource with the platform local ID', async () => {
    const { store, resources } = fakeSchemaStore();
    const input = {
      drive: 'drive',
      proxyOrigin: 'https://proxy.example',
      platform: 'github-issues',
      name: 'GitHub',
    };
    const initial = await ensureSyncablePlatform(store, input);
    const schema = await findSchema(store, 'drive', syncablePlatformSchema());
    const property = schema.properties!['syncable-platform-index'];
    const root = await store.getResource('drive');
    await root.set(property, {});
    resources.delete(initial);
    resources.set('unrelated-resource', {
      [core.properties.parent]: 'drive',
      [core.properties.localId]: platformLocalId(
        input.proxyOrigin,
        input.platform,
      ),
    });

    expect(await findSyncablePlatform(store, input)).toBeUndefined();
  });

  it('keeps installations from different proxy origins distinct', async () => {
    const { store } = fakeSchemaStore();
    const input = {
      drive: 'drive',
      platform: 'github-issues',
      name: 'GitHub',
    };
    const a = await ensureSyncablePlatform(store, {
      ...input,
      proxyOrigin: 'https://a.example',
    });
    const b = await ensureSyncablePlatform(store, {
      ...input,
      proxyOrigin: 'https://b.example',
    });
    expect(a).not.toBe(b);
  });

  it('lifts only source-owned principal/Public rows and keeps legacy data and moved descendants', async () => {
    const { store, resources } = fakeSchemaStore();
    const input = {
      drive: 'drive',
      proxyOrigin: 'https://proxy.example',
      platform: 'calendar-service',
      name: 'Calendar',
    };
    const root = await ensureSyncablePlatform(store, input);
    const app = await findSchema(store, input.drive, pluginSchema());
    const p = await findSchema(store, input.drive, syncablePlatformSchema());
    const h = await ensureSchema(store, input.drive, syncableHierarchySchema());
    resources.set('accounts', {
      [core.properties.parent]: root,
      [core.properties.localId]: 'syncables:accounts',
      [core.properties.isA]: [dataBrowser.classes.table],
      [p.properties!['syncable-platform-id']]: input.platform,
      [p.properties!['syncable-proxy-origin']]: input.proxyOrigin,
      [dataBrowser.properties.tableViews]: ['view'],
      [dataBrowser.properties.tableDefaultView]: 'view',
    });
    resources.get(root)![app.properties!['app-data']] = 'accounts';
    resources.get(root)![p.properties!['syncable-api-document']] = {
      cached: true,
    };
    resources.get(root)![core.properties.write] = ['owner'];
    resources.get(root)![core.properties.read] = ['reader'];

    const addNode = (
      subject: string,
      kind: string,
      parent = 'accounts',
      origin = input.proxyOrigin,
    ) => {
      const key = JSON.stringify([origin, input.platform, kind, subject, '']);
      resources.set(subject, {
        [core.properties.parent]: parent,
        [core.properties.isA]: [
          kind === 'account'
            ? p.classes!['syncable-account']
            : dataBrowser.classes.table,
        ],
        [core.properties.localId]: 'syncables:node:' + encodeURIComponent(key),
        [h.properties['syncable-source-key']]: key,
        [h.properties['syncable-node-kind']]: kind,
      });
    };

    addNode('account', 'account');
    addNode('public', 'public');
    resources.set('elsewhere', { [core.properties.parent]: 'drive' });
    addNode('moved', 'account', 'elsewhere');
    addNode('foreign', 'account', 'accounts', 'https://other.example');
    resources.set('view', {
      [core.properties.parent]: 'accounts',
      [core.properties.isA]: [dataBrowser.classes.view],
      [dataBrowser.properties.viewKind]: 'kanban',
    });
    resources.set('note', {
      [core.properties.parent]: 'accounts',
      [core.properties.name]: 'keep',
    });
    resources.set('descendant', { [core.properties.parent]: 'account' });
    const legacy = JSON.stringify(resources.get('accounts'));
    const view = JSON.stringify(resources.get('view'));
    const key = resources.get('account')![h.properties['syncable-source-key']];
    expect(await ensureSyncablePlatform(store, input)).toBe(root);
    expect(resources.get(root)![app.properties!['app-data']]).toBe(root);
    expect(resources.get(root)![core.properties.write]).toEqual(['owner']);
    expect(resources.get(root)![core.properties.read]).toEqual(['reader']);
    expect(
      resources.get(root)![p.properties!['syncable-legacy-accounts']],
    ).toBe('accounts');
    expect(resources.get('account')![core.properties.parent]).toBe(root);
    expect(resources.get('public')![core.properties.parent]).toBe(root);
    expect(resources.get('account')![h.properties['syncable-source-key']]).toBe(
      key,
    );
    expect(resources.get('descendant')![core.properties.parent]).toBe(
      'account',
    );
    expect(resources.get('moved')![core.properties.parent]).toBe('elsewhere');
    expect(resources.get('foreign')![core.properties.parent]).toBe('accounts');
    expect(resources.get('note')![core.properties.parent]).toBe('accounts');
    expect(JSON.stringify(resources.get('accounts'))).toBe(legacy);
    expect(JSON.stringify(resources.get('view'))).toBe(view);
    expect(
      resources.get(root)![p.properties!['syncable-api-document']],
    ).toEqual({ cached: true });
    const after = JSON.stringify([...resources]);
    expect(await findSyncableLegacyAccounts(store, input.drive, root)).toBe(
      'accounts',
    );
    expect(JSON.stringify([...resources])).toBe(after);
    await ensureSyncablePlatform(store, input);
    expect(JSON.stringify([...resources])).toBe(after);
    // An interrupted migration may already have rebound the runtime root.
    resources.get('account')![core.properties.parent] = 'accounts';
    await ensureSyncablePlatform(store, input);
    expect(resources.get('account')![core.properties.parent]).toBe(root);
  });

  it('converts a legacy root Table in place and preserves its rows and view links', async () => {
    const { store, resources } = fakeSchemaStore();
    const input = {
      drive: 'drive',
      proxyOrigin: 'https://proxy.example',
      platform: 'calendar-service',
      name: 'Calendar',
    };
    const root = await ensureSyncablePlatform(store, input);
    const app = await findSchema(store, input.drive, pluginSchema());
    const p = await findSchema(store, input.drive, syncablePlatformSchema());
    const values = resources.get(root)!;
    values[core.properties.isA] = [dataBrowser.classes.table];
    values[dataBrowser.properties.tableViews] = ['view', 'foreign-view'];
    values[dataBrowser.properties.tableDefaultView] = 'view';
    delete values[app.properties!['app-data']];
    delete values[p.properties!['builtin-app']];
    resources.set('row', { [core.properties.parent]: root });
    resources.set('view', {
      [core.properties.parent]: root,
      [core.properties.isA]: [dataBrowser.classes.view],
    });
    resources.set('foreign-view', {
      [core.properties.parent]: 'elsewhere',
      [core.properties.isA]: [dataBrowser.classes.view],
    });
    await ensureSyncablePlatform(store, input);
    expect(resources.get(root)![core.properties.isA]).toEqual([
      app.classes!.app,
    ]);
    expect(resources.get(root)![dataBrowser.properties.tableViews]).toEqual([
      'view',
      'foreign-view',
    ]);
    expect(resources.get(root)![dataBrowser.properties.tableDefaultView]).toBe(
      'view',
    );
    expect(resources.get('row')![core.properties.parent]).toBe(root);
    expect(resources.get('view')![core.properties.parent]).toBe(root);
    expect(resources.get('foreign-view')![core.properties.parent]).toBe(
      'elsewhere',
    );
  });

  it.each(['source', 'parent', 'local-id', 'class', 'outside'])(
    'rejects a forged legacy %s binding before writes',
    async attack => {
      const { store, resources } = fakeSchemaStore();
      const input = {
        drive: 'drive',
        proxyOrigin: 'https://proxy.example',
        platform: 'calendar-service',
        name: 'Calendar',
      };
      const root = await ensureSyncablePlatform(store, input);
      const app = await findSchema(store, input.drive, pluginSchema());
      const p = await findSchema(store, input.drive, syncablePlatformSchema());
      resources.set('legacy', {
        [core.properties.parent]: root,
        [core.properties.localId]: 'syncables:accounts',
        [core.properties.isA]: [dataBrowser.classes.table],
        [p.properties!['syncable-platform-id']]: input.platform,
        [p.properties!['syncable-proxy-origin']]: input.proxyOrigin,
      });
      resources.get(root)![app.properties!['app-data']] = 'legacy';
      const values = resources.get('legacy')!;
      if (attack === 'source')
        values[p.properties!['syncable-proxy-origin']] =
          'https://other.example';
      if (attack === 'parent') values[core.properties.parent] = 'elsewhere';
      if (attack === 'local-id') values[core.properties.localId] = 'user-table';
      if (attack === 'class') values[core.properties.isA] = [app.classes!.app];
      if (attack === 'outside')
        values['https://atomicdata.dev/properties/drive'] = 'other-drive';
      const before = JSON.stringify([...resources]);
      expect(
        await findSyncableLegacyAccounts(store, input.drive, root),
      ).toBeUndefined();
      expect(JSON.stringify([...resources])).toBe(before);
      await expect(ensureSyncablePlatform(store, input)).rejects.toThrow(
        'Accounts',
      );
      expect(JSON.stringify([...resources])).toBe(before);
    },
  );
});

describe('strict query Drive membership', () => {
  const drive = 'atomic:drive-a';
  const otherDrive = 'atomic:drive-b';
  const row = 'atomic:row';
  const folder = 'atomic:folder';
  const driveProperty = 'https://atomicdata.dev/properties/drive';

  function fixture() {
    const result = fakeSchemaStore();
    for (const subject of [drive, otherDrive])
      result.resources.set(subject, {
        [core.properties.isA]: [server.classes.drive],
      });
    result.resources.set(row, { [core.properties.parent]: folder });
    result.resources.set(folder, { [core.properties.parent]: drive });

    return result;
  }

  it('includes an unstamped legacy row only after walking its selected Drive ancestry', async () => {
    const { store } = fixture();
    expect(await classifySyncableResourceDrive(store, drive, row)).toBe(true);
    expect(await classifySyncableResourceDrive(store, drive, drive)).toBe(true);
  });

  it('omits an unstamped foreign row only after reaching its other Drive root', async () => {
    const { store, resources } = fixture();
    resources.get(folder)![core.properties.parent] = otherDrive;
    expect(await classifySyncableResourceDrive(store, drive, row)).toBe(false);
    expect(await classifySyncableResourceDrive(store, drive, otherDrive)).toBe(
      false,
    );
  });

  it('accepts consistent stamps but rejects a stamp contradicted by ancestry', async () => {
    const { store, resources } = fixture();
    resources.get(row)![driveProperty] = drive;
    expect(await classifySyncableResourceDrive(store, drive, row)).toBe(true);
    resources.get(folder)![core.properties.parent] = otherDrive;
    await expect(
      classifySyncableResourceDrive(store, drive, row),
    ).rejects.toThrow('stamp conflicts');
    resources.get(row)![driveProperty] = otherDrive;
    expect(await classifySyncableResourceDrive(store, drive, row)).toBe(false);
  });

  it('does not mistake an unproven foreign stamp for permission to omit a result', async () => {
    const { store, resources } = fixture();
    resources.set(row, { [driveProperty]: otherDrive });
    await expect(
      classifySyncableResourceDrive(store, drive, row),
    ).rejects.toThrow('could not be proven');
    expect(await isSyncableResourceInDrive(store, drive, row)).toBe(false);
  });

  it.each([
    'missing',
    'malformed-parent',
    'cycle',
    'malformed-classes',
    'malformed-stamp',
  ])(
    'fails closed on %s ancestry while retaining the ordinary boolean lookup',
    async mode => {
      const { store, resources } = fixture();
      if (mode === 'missing') resources.delete(folder);
      if (mode === 'malformed-parent')
        resources.get(folder)![core.properties.parent] = 7;
      if (mode === 'cycle')
        resources.get(folder)![core.properties.parent] = row;
      if (mode === 'malformed-classes')
        resources.get(folder)![core.properties.isA] = 'not-an-array';
      if (mode === 'malformed-stamp') resources.get(folder)![driveProperty] = 7;
      await expect(
        classifySyncableResourceDrive(store, drive, row),
      ).rejects.toThrow();
    },
  );

  it.each([ErrorType.NotFound, ErrorType.Unauthorized, ErrorType.Client])(
    'propagates load failures instead of treating them as foreign Drive results (%s)',
    async type => {
      const { store } = fixture();
      const get = store.getResource.bind(store);
      const failure = new AtomicError('Cannot establish ancestry', type);

      store.getResource = async subject => {
        if (subject === folder) throw failure;

        return get(subject);
      };

      await expect(
        classifySyncableResourceDrive(store, drive, row),
      ).rejects.toBe(failure);
      if (type !== ErrorType.Client)
        expect(await isSyncableResourceInDrive(store, drive, row)).toBe(false);
    },
  );

  it('rejects external ancestry before fetching it', async () => {
    const { store, resources } = fixture();
    const external = 'https://other.example/private';
    resources.get(folder)![core.properties.parent] = external;
    const get = vi.spyOn(store, 'getResource');
    await expect(
      classifySyncableResourceDrive(store, drive, row),
    ).rejects.toThrow('another server');
    expect(get).not.toHaveBeenCalledWith(external);
  });
});
