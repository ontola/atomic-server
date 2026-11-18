import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { beforeAll, expect, it, vi } from 'vitest';
import {
  core,
  commits,
  dataBrowser,
  Datatype,
  Store,
  LoroLoader,
  type Resource,
} from '@tomic/react';
import { createAtomicTableRow } from './atomicCreateRow';
import { createQuickAddRow } from './quickAdd';

beforeAll(async () => {
  const wasm = await readFile(
    createRequire(import.meta.url).resolve('loro-crdt/web/loro_wasm_bg.wasm'),
  );
  const web = await import('loro-crdt/web');
  await web.default({ module_or_path: wasm });
  await LoroLoader.initializeLoro();
});

async function setup(failSave = false) {
  const store = new Store({ serverUrl: 'https://example.com', connect: false });
  const fields = [
    [core.properties.isA, Datatype.RESOURCEARRAY],
    [core.properties.parent, Datatype.ATOMIC_URL],
    [core.properties.name, Datatype.STRING],
    [commits.properties.createdAt, Datatype.TIMESTAMP],
    [dataBrowser.properties.tableRowDefaults, Datatype.JSON],
    ['https://example.com/quantity', Datatype.INTEGER],
    ['https://example.com/complete', Datatype.BOOLEAN],
    ['https://example.com/status', Datatype.STRING],
  ];

  for (const [subject, datatype] of fields) {
    const property = await store.newResource({ subject, noParent: true });
    await property.set(core.properties.datatype, datatype, false);
    await property.set(core.properties.shortname, 'test-column', false);
    await property.set(core.properties.description, 'Test column', false);
    await store.getProperty(subject);
  }

  const table = await store.newResource({
    subject: 'https://example.com/table',
    noParent: true,
  });
  const cls = await store.newResource({
    subject: 'https://example.com/class',
    noParent: true,
  });
  await table.set(
    dataBrowser.properties.tableRowDefaults,
    {
      [core.properties.name]: 'Default name',
      'https://example.com/quantity': 12,
      'https://example.com/status': 'todo',
    },
    false,
  );
  const allocate = store.newResource.bind(store);
  let created: Resource;
  vi.spyOn(store, 'newResource').mockImplementation(async opts => {
    created = await allocate({
      ...opts,
      subject: 'https://example.com/created',
    });
    const save = vi.spyOn(created, 'save').mockResolvedValue('persisted');
    if (failSave) save.mockRejectedValue(Error('Save failed'));

    return created;
  });
  const notify = vi
    .spyOn(store, 'notifyResourceManuallyCreated')
    .mockImplementation(async () => {});

  return {
    store,
    table,
    cls,
    notify,
    get created() {
      return created;
    },
  };
}

it('applies table defaults under explicit values and suppresses an explicitly unset default', async () => {
  const { store, table, cls, notify } = await setup();
  const row = await createAtomicTableRow(store, table.subject, cls.subject, {
    [core.properties.name]: 'Named',
    'https://example.com/quantity': 0,
    'https://example.com/complete': false,
    'https://example.com/status': undefined,
  });
  expect(row.get(core.properties.name)).toBe('Named');
  expect(row.get('https://example.com/quantity')).toBe(0);
  expect(row.get('https://example.com/complete')).toBe(false);
  expect(row.get('https://example.com/status')).toBeUndefined();
  expect(row.get(core.properties.parent)).toBe(table.subject);
  expect(row.hasClasses(cls.subject)).toBe(true);
  expect(notify).toHaveBeenCalledWith(row);
});

it('quick-add uses the shared persisted creation path and retains defaults', async () => {
  const { store, table, cls, notify } = await setup();
  const row = await createQuickAddRow(store, {
    table: table.subject,
    rowClass: cls.subject,
    spec: { label: 'Add', field: core.properties.name },
    typed: 'Typed',
    properties: [],
  });
  expect(row.get(core.properties.name)).toBe('Typed');
  expect(row.get('https://example.com/quantity')).toBe(12);
  expect(row.save).toHaveBeenCalledOnce();
  expect(notify).toHaveBeenCalledOnce();
});

it('does not announce a row when save fails', async () => {
  const fixture = await setup(true);
  await expect(
    createAtomicTableRow(
      fixture.store,
      fixture.table.subject,
      fixture.cls.subject,
      {},
    ),
  ).rejects.toThrow('Save failed');
  expect(fixture.notify).not.toHaveBeenCalled();
});

it('rejects defaults that move the new row outside its table before save', async () => {
  const fixture = await setup();
  await fixture.table.set(
    dataBrowser.properties.tableRowDefaults,
    { [core.properties.parent]: 'https://example.com/other' },
    false,
  );
  await expect(
    createAtomicTableRow(
      fixture.store,
      fixture.table.subject,
      fixture.cls.subject,
      {},
    ),
  ).rejects.toMatchObject({ code: 'scope' });
  expect(fixture.created.save).not.toHaveBeenCalled();
  expect(fixture.notify).not.toHaveBeenCalled();
});
