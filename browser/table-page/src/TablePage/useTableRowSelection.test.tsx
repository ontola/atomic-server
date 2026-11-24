// @vitest-environment jsdom
// @wc-ignore-file
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { useTableRowSelection } from './useTableRowSelection.js';

afterEach(cleanup);

const scope = {
  table: 'first',
  rowClass: 'rows',
  queryKey: 'all',
  quickQuery: '',
  writable: true,
};

it.each([
  { table: 'second' },
  { quickQuery: 'birds' },
  { queryKey: 'filtered' },
  { writable: false },
])(
  'clears selection and rejects a callback from the old scope when %j changes',
  patch => {
    const { result, rerender } = renderHook(useTableRowSelection, {
      initialProps: scope,
    });
    const before = result.current;
    act(() => before.toggleRowSelected('row-a'));
    expect([...result.current.selectedRows]).toEqual(['row-a']);

    rerender({ ...scope, ...patch });
    expect(result.current.selectedRows.size).toBe(0);
    act(() => {
      if (patch.writable !== false) result.current.toggleRowSelected('row-b');
      before.toggleRowSelected('row-c');
      before.clearRowSelection();
    });
    expect([...result.current.selectedRows]).toEqual(
      patch.writable === false ? [] : ['row-b'],
    );

    rerender(scope);
    act(() => before.toggleRowSelected('row-d'));
    expect(result.current.selectedRows.size).toBe(0);
  },
);
