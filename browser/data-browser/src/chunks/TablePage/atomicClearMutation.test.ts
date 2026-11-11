import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { beforeAll, expect, it, vi } from 'vitest';
import { core, Datatype, Store, LoroLoader } from '@tomic/react';
import { clearTableFields, executeTableRowMutation } from '@tomic/table';
import { atomicClearMutationBackend } from './atomicClearMutation';
import type { HistoryItemBatch } from './helpers/useTableHistory';

beforeAll(async () => {
  const wasm = await readFile(
    createRequire(import.meta.url).resolve('loro-crdt/web/loro_wasm_bg.wasm'),
  );
  const web = await import('loro-crdt/web');
  await web.default({ module_or_path: wasm });
  await LoroLoader.initializeLoro();
});

async function setup() {
  const store = new Store({ serverUrl: 'https://example.com', connect: false });
  const property = await store.newResource({
    subject: '_new:label',
    noParent: true,
  });
  await property.set(core.properties.datatype, Datatype.LOCALIZEDTEXT, false);
  await property.set(core.properties.shortname, 'label', false);
  await property.set(
    core.properties.description,
    'Localized test label',
    false,
  );
  await store.getProperty(property.subject);
  const cls = await store.newResource({
    subject: '_new:class',
    noParent: true,
  });
  await cls.set(core.properties.requires, ['_new:label'], false);
  const row = await store.newResource({ subject: '_new:row', noParent: true });
  await row.set(core.properties.isA, [cls.subject], false);
  await row.set(core.properties.parent, '_new:table', false);
  await row.set('_new:label', { en: 'Hello', nl: 'Hallo', de: 'Hallo' }, false);
  const save = vi.spyOn(row, 'save').mockResolvedValue('persisted');
  const history: HistoryItemBatch = [];
  const backend = atomicClearMutationBackend(store, cls, history);
  const target = {
    subject: row.subject,
    scope: { collection: '_new:table', rowClass: cls.subject },
  };

  return { row, cls, save, history, backend, target };
}

it('applies a multi-language clear through the shared command and preserves undo history', async () => {
  const { row, save, history, backend, target } = await setup();
  await executeTableRowMutation(
    {
      target,
      kind: 'update',
      changes: values =>
        clearTableFields(values, [
          { id: '_new:label', language: 'en' },
          { id: '_new:label', language: 'nl' },
        ]),
    },
    backend,
  );
  expect(row.get('_new:label')).toEqual({ de: 'Hallo' });
  expect(save).toHaveBeenCalledTimes(1);
  expect(history).toHaveLength(1);
  expect(history[0]).toMatchObject({
    property: '_new:label',
    previousValue: { en: 'Hello', nl: 'Hallo', de: 'Hallo' },
  });
});

it('rejects a row that left the table before any mutation is applied', async () => {
  const { row, save, backend, target } = await setup();
  await row.set(core.properties.parent, '_new:other-table', false);
  await expect(
    executeTableRowMutation(
      { target, kind: 'update', changes: { '_new:label': undefined } },
      backend,
    ),
  ).rejects.toMatchObject({ code: 'scope' });
  expect(save).not.toHaveBeenCalled();
  expect(row.get('_new:label')).toEqual({
    en: 'Hello',
    nl: 'Hallo',
    de: 'Hallo',
  });
});

it('rejects a field absent from the class schema', async () => {
  const { save, backend, target } = await setup();
  await expect(
    executeTableRowMutation(
      { target, kind: 'update', changes: { '_new:unknown': undefined } },
      backend,
    ),
  ).rejects.toMatchObject({ code: 'field' });
  expect(save).not.toHaveBeenCalled();
});

it('protects table membership even if the row class declares it as a column', async () => {
  const { row, cls, save, backend, target } = await setup();
  await cls.set(core.properties.recommends, [core.properties.parent], false);
  await expect(
    executeTableRowMutation(
      {
        target,
        kind: 'update',
        changes: { [core.properties.parent]: undefined },
      },
      backend,
    ),
  ).rejects.toMatchObject({ code: 'field' });
  expect(save).not.toHaveBeenCalled();
  expect(row.get(core.properties.parent)).toBe('_new:table');
});
