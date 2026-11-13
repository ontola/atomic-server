// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import {
  createTableRowSelection,
  useTableRowSelection,
} from './rowSelectionState.js';
afterEach(cleanup);
it('publishes new identity snapshots without changing retained snapshots', () => {
  const selection = createTableRowSelection('query:first');
  const notify = vi.fn();
  const unsubscribe = selection.subscribe(notify);
  selection.toggle('row:one');
  const first = selection.getSnapshot();
  selection.toggle('row:two');
  expect([...first]).toEqual(['row:one']);
  expect([...selection.getSnapshot()]).toEqual(['row:one', 'row:two']);
  selection.toggle('row:one');
  expect([...selection.getSnapshot()]).toEqual(['row:two']);
  selection.clear();
  expect(selection.getSnapshot().size).toBe(0);
  const calls = notify.mock.calls.length;
  selection.clear();
  expect(notify).toHaveBeenCalledTimes(calls);
  unsubscribe();
  selection.toggle('row:three');
  expect(notify).toHaveBeenCalledTimes(calls);
});
it('resets across query scopes and keeps stale callbacks from clearing the newer selection', () => {
  const { result, rerender } = renderHook(
    ({ scope }) => useTableRowSelection(scope),
    { initialProps: { scope: 'first' } },
  );
  act(() => result.current.toggleRowSelected('row:one'));
  const old = result.current;
  rerender({ scope: 'second' });
  expect(result.current.selectedRows.size).toBe(0);
  act(() => result.current.toggleRowSelected('row:two'));
  act(() => {
    old.clearRowSelection();
    old.toggleRowSelected('row:old');
  });
  expect([...result.current.selectedRows]).toEqual(['row:two']);
  rerender({ scope: 'first' });
  expect(result.current.selectedRows.size).toBe(0);
});
