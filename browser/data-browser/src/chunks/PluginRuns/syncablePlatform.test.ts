import { describe, expect, it } from 'vitest';
import { core, dataBrowser, Datatype, findSchema } from '@tomic/lib';
import { fakeSchemaStore as createFakeSchemaStore } from '../../../../lib/src/test-schema-store.js';
import {
  ensureSyncablePlatform,
  findSyncablePlatform,
  platformLocalId,
  syncablePlatformSchema,
} from './syncablePlatform';

function fakeSchemaStore() {
  const fixture = createFakeSchemaStore();
  fixture.resources.set(core.properties.name, {
    [core.properties.isA]: [core.classes.property],
    [core.properties.datatype]: Datatype.STRING,
    [core.properties.shortname]: 'name',
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
  it('creates one ordinary root-level table and reuses it on reinstall', async () => {
    const { store, resources } = fakeSchemaStore();
    const options = {
      drive: 'drive',
      proxyOrigin: 'https://proxy.example',
      platform: 'github-issues',
      name: 'GitHub',
    };

    const first = await ensureSyncablePlatform(store, options);
    const rowClass = await store.getResource(
      resources.get(first)?.[core.properties.classtype] as string,
    );
    expect(rowClass.get(core.properties.recommends)).toEqual([
      core.properties.name,
    ]);
    await rowClass.set(core.properties.recommends, []);
    await rowClass.save();
    const second = await ensureSyncablePlatform(store, {
      ...options,
      name: 'Renamed GitHub',
    });

    expect(second).toBe(first);
    expect(rowClass.get(core.properties.recommends)).toEqual([
      core.properties.name,
    ]);
    const props = resources.get(first);
    expect(props?.[core.properties.parent]).toBe('drive');
    expect(props?.[core.properties.name]).toBe('GitHub');
    expect(props?.[core.properties.isA]).toContain(dataBrowser.classes.table);
    expect(typeof props?.[core.properties.classtype]).toBe('string');
    expect(props?.[core.properties.localId]).toBe(
      platformLocalId(options.proxyOrigin, options.platform),
    );
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

  it('adds the missing Sync tab without changing existing tabs or their default', async () => {
    const { store, resources } = fakeSchemaStore();
    const input = {
      drive: 'drive',
      proxyOrigin: 'https://proxy.example',
      platform: 'github-issues',
      name: 'GitHub',
    };
    const subject = await ensureSyncablePlatform(store, input);
    const table = await store.getResource(subject);
    const viewList = dataBrowser.properties.tableViews;
    const defaultView = dataBrowser.properties.tableDefaultView;
    const [standard, oldSync] = table.get(viewList) as string[];
    resources.delete(oldSync);
    resources.set('custom', {
      [core.properties.parent]: subject,
      [core.properties.isA]: [dataBrowser.classes.view],
      [dataBrowser.properties.viewKind]: 'kanban',
    });
    await table.set(viewList, ['custom', standard]);
    await table.set(defaultView, 'custom');

    expect(await ensureSyncablePlatform(store, input)).toBe(subject);
    const nextViews = table.get(viewList) as string[];
    expect(nextViews).toEqual(['custom', standard, expect.any(String)]);
    expect(resources.get(nextViews[2])?.[dataBrowser.properties.viewKind]).toBe(
      'syncables',
    );
    expect(table.get(defaultView)).toBe('custom');

    await ensureSyncablePlatform(store, input);
    expect(table.get(viewList)).toEqual(nextViews);
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
});
