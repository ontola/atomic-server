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
    'opens the saved Accounts table for %s without writes',
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

  it.each(['parent', 'source', 'class', 'outside', 'stale-stamp'])(
    'rejects a forged Accounts %s binding',
    async attack => {
      const f = await installed();
      const table = f.resources.get(f.table)!;

      switch (attack) {
        case 'parent':
          table[core.properties.parent] = 'other-app';
          break;
        case 'source':
          table[f.terms.properties!['syncable-proxy-origin']] =
            'https://other.example';
          break;
        case 'class':
          table[core.properties.isA] = [f.app.classes!.app];
          break;
        case 'outside':
          table['https://atomicdata.dev/properties/drive'] = 'other-drive';
          break;
        case 'stale-stamp':
          f.resources.get(f.subject)![core.properties.parent] = 'other-drive';
          f.resources.get(f.subject)![
            'https://atomicdata.dev/properties/drive'
          ] = 'drive';
          table['https://atomicdata.dev/properties/drive'] = 'drive';
          break;
      }

      await expect(
        resolveBuiltinApp(f.store, 'drive', f.subject),
      ).rejects.toThrow('matching Accounts');
    },
  );

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
