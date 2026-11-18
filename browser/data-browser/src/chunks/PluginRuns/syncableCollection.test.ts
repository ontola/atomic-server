import { describe, expect, it } from 'vitest';
import {
  core,
  dataBrowser,
  Datatype,
  ensureSchema,
  type Store,
} from '@tomic/lib';
import { fakeSchemaStore } from '../../../../lib/src/test-schema-store.js';
import { syncableHierarchySchema } from './syncableHierarchy';
import {
  openSyncableCollectionRow,
  parseSyncableCollectionView,
  resolveSyncableCollectionView,
  syncableCollectionValue,
} from './syncableCollection';
import { selectableViewKinds } from './syncableCollectionViews';

const rowClass = 'https://tasks.example/types/workspace';
const name = 'https://tasks.example/properties/display-name';
const target = 'https://tasks.example/properties/board-table';
const table = 'https://drive.example/workspaces';
const row = 'https://drive.example/team';
const child = 'https://drive.example/boards';
const driveProperty = 'https://atomicdata.dev/properties/drive';
const descriptor = {
  version: 1,
  rowClass,
  title: 'Workspaces',
  columns: [{ property: name, label: 'Workspace' }],
  openTargetProperty: target,
};

async function setup() {
  const { store: fake, resources } = fakeSchemaStore();
  resources.set(core.properties.name, {
    [core.properties.isA]: [core.classes.property],
    [core.properties.datatype]: Datatype.STRING,
    [core.properties.shortname]: 'name',
  });
  const terms = await ensureSchema(fake, 'drive', syncableHierarchySchema());
  const descriptorProperty = terms.properties['syncable-collection-view'];
  resources.set(table, {
    [core.properties.parent]: 'drive',
    [core.properties.isA]: [dataBrowser.classes.table],
    [core.properties.classtype]: rowClass,
    [descriptorProperty]: descriptor,
  });
  resources.set(row, {
    [core.properties.parent]: table,
    [core.properties.isA]: [rowClass],
    [name]: 'Research',
    [target]: child,
  });
  resources.set(child, {
    [core.properties.parent]: row,
    [core.properties.isA]: [dataBrowser.classes.table],
  });

  const store = Object.assign(fake, {
    isForeignOriginSubject: (subject: string) =>
      subject.startsWith('http') &&
      new URL(subject).origin !== new URL(table).origin,
  }) as unknown as Store;

  return { store, resources, descriptorProperty };
}

describe('generic stored collection descriptors', () => {
  it('accepts an unrelated provider class and exact property bindings without source configuration', async () => {
    const { store, resources } = await setup();
    const before = resources.size;
    await expect(
      resolveSyncableCollectionView(store, 'drive', table),
    ).resolves.toEqual(descriptor);
    await expect(
      openSyncableCollectionRow(store, 'drive', table, row),
    ).resolves.toEqual({ subject: child });
    expect(resources.size).toBe(before);
  });

  it('accepts real Atomic identifiers for classes, properties, and child targets', async () => {
    const { store, resources, descriptorProperty } = await setup();
    const atomicClass = 'atomic:workspace-schema';
    const atomicName = 'atomic:prop:workspace-heading';
    const atomicTarget = 'atomic:prop:open-boards';
    const atomicChild = 'atomic:boards-table';
    resources.get(table)![core.properties.classtype] = atomicClass;
    resources.get(table)![descriptorProperty] = {
      ...descriptor,
      rowClass: atomicClass,
      columns: [{ property: atomicName, label: 'Workspace' }],
      openTargetProperty: atomicTarget,
    };
    resources.get(row)![core.properties.isA] = ['did:ad:workspace-schema'];
    resources.get(row)![atomicTarget] = atomicChild;
    resources.set(atomicChild, resources.get(child)!);
    await expect(
      openSyncableCollectionRow(store, 'drive', table, row),
    ).resolves.toEqual({ subject: atomicChild });
  });

  it.each([
    { version: 2 },
    { rowClass: 'https://tasks.example/types/other' },
    { rowClass: 'workspace' },
    { title: '' },
    { columns: [] },
    { columns: [{ property: name, label: 'Name', format: 'javascript' }] },
    { columns: [{ property: 'javascript:alert(1)', label: 'Name' }] },
    {
      columns: [
        { property: name, label: 'Kind', format: 'enum', labels: { x: 5 } },
      ],
    },
    {
      columns: [
        { property: name, label: 'A' },
        { property: name, label: 'B' },
      ],
    },
    { openTargetProperty: 'board-table' },
  ])('rejects an invalid descriptor %j', invalid => {
    expect(
      parseSyncableCollectionView({ ...descriptor, ...invalid }, rowClass),
    ).toBeUndefined();
  });

  it('keeps missing or invalid saved values unknown', () => {
    const count = { property: name, label: 'Count', format: 'count' as const };
    expect(syncableCollectionValue(0, count)).toBe('0');
    for (const value of [-1, '0', NaN, undefined, null])
      expect(syncableCollectionValue(value, count)).toBe('—');
    const kind = {
      property: name,
      label: 'State',
      format: 'enum' as const,
      labels: { false: 'Visible' },
    };
    expect(syncableCollectionValue(false, kind)).toBe('Visible');
    expect(syncableCollectionValue(undefined, kind)).toBe('—');
    expect(syncableCollectionValue('toString', kind)).toBe('—');
    expect(
      syncableCollectionValue({ token: 'hidden' }, descriptor.columns[0]),
    ).toBe('—');
  });

  it('rejects a descriptor for a different table row class or a foreign table', async () => {
    const { store, resources } = await setup();
    resources.get(table)![core.properties.classtype] =
      'https://tasks.example/types/project';
    await expect(
      resolveSyncableCollectionView(store, 'drive', table),
    ).rejects.toThrow('valid stored collection view');
    resources.get(table)![core.properties.classtype] = rowClass;
    resources.get(table)![driveProperty] = 'another-drive';
    await expect(
      resolveSyncableCollectionView(store, 'drive', table),
    ).rejects.toThrow('outside the current drive');
  });

  it('falls back to the row for absent, moved, foreign, or non-table targets', async () => {
    const { store, resources } = await setup();

    for (const invalid of [
      {},
      {
        [core.properties.parent]: 'another-row',
        [core.properties.isA]: [dataBrowser.classes.table],
      },
      {
        [core.properties.parent]: row,
        [core.properties.isA]: [dataBrowser.classes.table],
        [driveProperty]: 'another-drive',
      },
      {
        [core.properties.parent]: row,
        [core.properties.isA]: [dataBrowser.classes.folder],
      },
    ]) {
      resources.set(child, invalid);
      await expect(
        openSyncableCollectionRow(store, 'drive', table, row),
      ).resolves.toEqual({ subject: row });
    }

    delete resources.get(row)![target];
    await expect(
      openSyncableCollectionRow(store, 'drive', table, row),
    ).resolves.toEqual({ subject: row });
  });

  it('refuses a foreign HTTP target before fetching it', async () => {
    const { store, resources } = await setup();
    const remote = 'https://api.provider.example/boards';
    resources.get(row)![target] = remote;
    const getResource = store.getResource.bind(store);

    store.getResource = async subject => {
      expect(subject).not.toBe(remote);

      return getResource(subject);
    };

    await expect(
      openSyncableCollectionRow(store, 'drive', table, row),
    ).resolves.toEqual({ subject: row });
  });

  it('rechecks row and table authority on every Open, after successful navigation', async () => {
    const { store, resources, descriptorProperty } = await setup();
    await openSyncableCollectionRow(store, 'drive', table, row);

    for (const [property, invalid] of [
      [core.properties.parent, 'elsewhere'],
      [core.properties.isA, ['https://tasks.example/types/other']],
      [driveProperty, 'another-drive'],
    ] as const) {
      const saved = resources.get(row)![property];
      resources.get(row)![property] = invalid as string | string[];
      await expect(
        openSyncableCollectionRow(store, 'drive', table, row),
      ).rejects.toThrow('does not belong');
      if (saved === undefined) delete resources.get(row)![property];
      else resources.get(row)![property] = saved;
    }

    delete resources.get(table)![descriptorProperty];
    await expect(
      openSyncableCollectionRow(store, 'drive', table, row),
    ).rejects.toThrow('valid stored collection view');
  });

  it('offers one generic view only for applicable tables, leaving Sync host-provisioned', () => {
    expect(selectableViewKinds(false)).not.toContain('syncable-collection');
    expect(selectableViewKinds(true)).toContain('syncable-collection');
    expect(selectableViewKinds(true)).not.toContain('syncables');
    expect(selectableViewKinds(false)).toContain('table');
  });
});
