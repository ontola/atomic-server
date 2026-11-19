import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { beforeAll, expect, it, vi } from 'vitest';
import { Store, LoroLoader, core, Datatype } from '@tomic/react';
import {
  createAtomicTableHistory,
  createValueChangedHistoryItem,
  createResourceCreatedHistoryItem,
  createResourceDeletedHistoryItem,
  undoAtomicTableHistoryItem,
} from './useTableHistory';

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
  await property.set(core.properties.description, 'Test label', false);
  await store.getProperty(property.subject);
  const row = await store.newResource({ subject: '_new:row', noParent: true });
  const save = vi.spyOn(row, 'save').mockResolvedValue('persisted');
  const history = createAtomicTableHistory();
  const undo = () =>
    history.undo(async item => {
      await undoAtomicTableHistoryItem(item, store);
    });

  return { store, row, save, history, undo };
}

it('coalesces repeated cell edits and restores the first value', async () => {
  const { row, history, undo } = await setup();
  await row.set('_new:quantity', 0, false);
  history.record(createValueChangedHistoryItem(row, '_new:quantity'));
  await row.set('_new:quantity', 1, false);
  history.record(createValueChangedHistoryItem(row, '_new:quantity'));
  await row.set('_new:quantity', 2, false);
  await undo();
  expect(row.get('_new:quantity')).toBe(0);
  expect(history.getSnapshot().canUndo).toBe(false);
});

it('captures localized values independently of later mutations', async () => {
  const { row, history, undo } = await setup();
  await row.set('_new:label', { en: 'Before', nl: 'Hallo' }, false);
  history.record(createValueChangedHistoryItem(row, '_new:label'));
  await row.set('_new:label', { en: 'After' }, false);
  await undo();
  expect(row.get('_new:label')).toEqual({ en: 'Before', nl: 'Hallo' });
});

it('undoes edits to a newly created row before destroying it', async () => {
  const { row, history, undo } = await setup();
  const destroy = vi.spyOn(row, 'destroy').mockResolvedValue(undefined);
  history.recordBatch([
    createResourceCreatedHistoryItem(row),
    createValueChangedHistoryItem(row, '_new:value'),
  ]);
  await row.set('_new:value', 'pasted', false);
  await undo();
  expect(row.get('_new:value')).toBeUndefined();
  expect(destroy).toHaveBeenCalledOnce();
});

it('retains failed undo and restores a deleted resource from its snapshot', async () => {
  const { row, history, undo, save } = await setup();
  await row.set('_new:quantity', 0, false);
  await row.set('_new:complete', false, false);
  history.record(createResourceDeletedHistoryItem(row));
  await row.set('_new:quantity', 9, false);
  save.mockRejectedValueOnce(Error('Offline failure'));
  await expect(undo()).rejects.toThrow('Offline failure');
  expect(history.getSnapshot().canUndo).toBe(true);
  await undo();
  expect(row.get('_new:quantity')).toBe(0);
  expect(row.get('_new:complete')).toBe(false);
  expect(history.getSnapshot().canUndo).toBe(false);
});
