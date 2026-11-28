import { describe, expect, it, vi } from 'vitest';
import {
  core,
  dataBrowser,
  Datatype,
  findSchema,
  pluginSchema,
} from '@tomic/lib';
import { fakeSchemaStore } from '../../../../lib/src/test-schema-store.js';
import {
  ensureSyncablePlatform,
  syncablePlatformSchema,
} from '@chunks/PluginRuns/syncablePlatform';
import { resolveBuiltinApp } from './builtinApp';

async function installed(platform = 'github-issues') {
  const fixture = fakeSchemaStore();
  fixture.resources.set(core.properties.name, {
    [core.properties.isA]: [core.classes.property],
    [core.properties.datatype]: Datatype.STRING,
    [core.properties.shortname]: 'name',
  });
  const subject = await ensureSyncablePlatform(fixture.store, {
    drive: 'drive',
    proxyOrigin: 'https://proxy.example',
    platform,
    name: 'Provider App',
  });
  const app = await findSchema(fixture.store, 'drive', pluginSchema());
  const terms = await findSchema(
    fixture.store,
    'drive',
    syncablePlatformSchema(),
  );
  const table = fixture.resources.get(subject)![
    app.properties!['app-data']
  ] as string;

  return { ...fixture, subject, table, app, terms };
}

describe('built-in App registration', () => {
  it.each(['github-issues', 'calendar-service'])(
    'opens the App source root for %s without writes',
    async provider => {
      const f = await installed(provider);
      const create = vi.spyOn(f.store, 'newResource');
      const before = JSON.stringify([...f.resources]);
      expect(await resolveBuiltinApp(f.store, 'drive', f.subject)).toEqual({
        kind: 'syncables',
        table: f.table,
      });
      expect(create).not.toHaveBeenCalled();
      expect(JSON.stringify([...f.resources])).toBe(before);
    },
  );

  it('leaves ordinary and unknown built-in Apps on the regular entrypoint path', async () => {
    const f = await installed();
    f.resources.get(f.subject)![f.terms.properties!['builtin-app']] =
      'future-unknown-app';
    expect(
      await resolveBuiltinApp(f.store, 'drive', f.subject),
    ).toBeUndefined();
    delete f.resources.get(f.subject)![f.terms.properties!['builtin-app']];
    expect(
      await resolveBuiltinApp(f.store, 'drive', f.subject),
    ).toBeUndefined();
  });

  it('rejects a marker on a resource that is not an App', async () => {
    const f = await installed();
    f.resources.get(f.subject)![core.properties.isA] = [
      dataBrowser.classes.table,
    ];
    await expect(
      resolveBuiltinApp(f.store, 'drive', f.subject),
    ).rejects.toThrow('not an App');
  });

  async function legacyInstalled() {
    const f = await installed();
    f.resources.set('legacy-accounts', {
      [core.properties.parent]: f.subject,
      [core.properties.localId]: 'syncables:accounts',
      [core.properties.isA]: [dataBrowser.classes.table],
      [f.terms.properties!['syncable-platform-id']]: 'github-issues',
      [f.terms.properties!['syncable-proxy-origin']]: 'https://proxy.example',
    });
    f.resources.get(f.subject)![f.app.properties!['app-data']] =
      'legacy-accounts';

    return f;
  }

  it('reads legacy App bindings without migrating or provisioning', async () => {
    const f = await legacyInstalled();
    const before = JSON.stringify([...f.resources]);
    const create = vi.spyOn(f.store, 'newResource');
    expect(await resolveBuiltinApp(f.store, 'drive', f.subject)).toEqual({
      kind: 'syncables',
      table: f.subject,
    });
    expect(JSON.stringify([...f.resources])).toBe(before);
    expect(create).not.toHaveBeenCalled();
  });

  it.each(['parent', 'source', 'class', 'outside', 'local-id', 'pointer'])(
    'rejects a forged legacy Accounts %s binding without writes',
    async attack => {
      const f = await legacyInstalled();
      const table = f.resources.get('legacy-accounts')!;
      if (attack === 'parent') table[core.properties.parent] = 'other-app';
      if (attack === 'source')
        table[f.terms.properties!['syncable-proxy-origin']] =
          'https://other.example';
      if (attack === 'class') table[core.properties.isA] = [f.app.classes!.app];
      if (attack === 'outside')
        table['https://atomicdata.dev/properties/drive'] = 'other-drive';
      if (attack === 'local-id') table[core.properties.localId] = 'user-table';
      if (attack === 'pointer')
        f.resources.get(f.subject)![
          f.terms.properties!['syncable-legacy-accounts']
        ] = 'other-table';
      const before = JSON.stringify([...f.resources]);
      await expect(
        resolveBuiltinApp(f.store, 'drive', f.subject),
      ).rejects.toThrow('matching legacy Accounts');
      expect(JSON.stringify([...f.resources])).toBe(before);
    },
  );

  it('accepts a migrated self binding only while its retained Accounts reference remains valid', async () => {
    const f = await legacyInstalled();
    f.resources.get(f.subject)![f.app.properties!['app-data']] = f.subject;
    f.resources.get(f.subject)![
      f.terms.properties!['syncable-legacy-accounts']
    ] = 'legacy-accounts';
    const before = JSON.stringify([...f.resources]);
    expect(await resolveBuiltinApp(f.store, 'drive', f.subject)).toEqual({
      kind: 'syncables',
      table: f.subject,
    });
    expect(JSON.stringify([...f.resources])).toBe(before);
    f.resources.get('legacy-accounts')![core.properties.parent] = 'other-app';
    await expect(
      resolveBuiltinApp(f.store, 'drive', f.subject),
    ).rejects.toThrow('matching legacy Accounts');
  });

  it('rejects a moved App despite a stale drive stamp', async () => {
    const f = await installed();
    f.resources.get(f.subject)![core.properties.parent] = 'other-drive';
    f.resources.get(f.subject)!['https://atomicdata.dev/properties/drive'] =
      'drive';
    await expect(
      resolveBuiltinApp(f.store, 'drive', f.subject),
    ).rejects.toThrow('outside');
  });

  it('keeps the binding valid when the App is renamed and moved within its drive', async () => {
    const f = await installed();
    f.resources.set('folder', { [core.properties.parent]: 'drive' });
    f.resources.get(f.subject)![core.properties.parent] = 'folder';
    f.resources.get(f.subject)![core.properties.name] = 'My integration';
    expect(await resolveBuiltinApp(f.store, 'drive', f.subject)).toEqual({
      kind: 'syncables',
      table: f.table,
    });
  });
});
