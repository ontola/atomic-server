import { expect, it, vi } from 'vitest';
import { createTableHistory } from './history.js';

it('undoes a batch in reverse dependency order', async () => {
  const history = createTableHistory<string>();
  const apply = vi.fn(async (_: string) => {});
  history.recordBatch(['row-created', 'field-changed', 'field-changed-again']);
  await history.undo(apply);
  expect(apply.mock.calls.flat()).toEqual([
    'field-changed-again',
    'field-changed',
    'row-created',
  ]);
  expect(history.getSnapshot()).toEqual({
    canUndo: false,
    busy: false,
    depth: 0,
  });
});

it('retains failed and unattempted items but never repeats confirmed undo steps', async () => {
  const history = createTableHistory<number>();
  history.recordBatch([1, 2, 3]);
  const calls: number[] = [];
  await expect(
    history.undo(async item => {
      calls.push(item);
      if (item === 2) throw Error('Conflict');
    }),
  ).rejects.toThrow('Conflict');
  expect(calls).toEqual([3, 2]);
  expect(history.getSnapshot()).toEqual({
    canUndo: true,
    busy: false,
    depth: 1,
  });
  await history.undo(async item => {
    calls.push(item);
  });
  expect(calls).toEqual([3, 2, 2, 1]);
});

it('serializes undo and blocks recording/clearing during an in-flight write', async () => {
  const history = createTableHistory<number>();
  history.record(1);
  let finish!: () => void;
  const apply = vi.fn(
    () =>
      new Promise<void>(resolve => {
        finish = resolve;
      }),
  );
  const running = history.undo(apply);
  expect(history.getSnapshot().busy).toBe(true);
  await history.undo(apply);
  expect(apply).toHaveBeenCalledOnce();
  expect(() => history.record(2)).toThrow('Wait for undo');
  expect(() => history.clear()).toThrow('Wait for undo');
  finish();
  await running;
  expect(history.getSnapshot().busy).toBe(false);
});

it('coalesces single keystrokes while preserving their first previous value', async () => {
  type Edit = { field: string; before: number };
  const history = createTableHistory<Edit>({
    merge: (previous, next) =>
      previous.field === next.field ? previous : undefined,
  });
  history.record({ field: 'quantity', before: 0 });
  history.record({ field: 'quantity', before: 1 });
  history.record({ field: 'title', before: 2 });
  const apply = vi.fn(async (_: Edit) => {});
  await history.undo(apply);
  await history.undo(apply);
  expect(apply.mock.calls.map(([item]) => item.before)).toEqual([2, 0]);
});

it('keeps explicit batches separate from single-edit coalescing', async () => {
  const history = createTableHistory<number>({ merge: previous => previous });
  history.record(0);
  history.recordBatch([1]);
  history.record(2);
  expect(history.getSnapshot().depth).toBe(3);
});

it('captures snapshots and does not record empty batches', async () => {
  const history = createTableHistory<{ values: { en: string } }>({
    capture: item => structuredClone(item),
  });
  history.recordBatch([]);
  expect(history.getSnapshot().canUndo).toBe(false);
  const item = { values: { en: 'Before' } };
  history.record(item);
  item.values.en = 'After';
  const apply = vi.fn(async (_: typeof item) => {});
  await history.undo(apply);
  expect(apply.mock.calls[0][0].values.en).toBe('Before');
});

it('publishes stable snapshots and supports unsubscribing', async () => {
  const history = createTableHistory<number>();
  expect(history.getSnapshot()).toBe(history.getSnapshot());
  const notify = vi.fn();
  const unsubscribe = history.subscribe(notify);
  history.record(1);
  expect(notify).toHaveBeenCalledOnce();
  unsubscribe();
  history.clear();
  expect(notify).toHaveBeenCalledOnce();
  await history.undo(async () => {
    throw Error('No item');
  });
});
