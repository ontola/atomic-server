// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import {
  readTableRow,
  tableRowList,
  tableRowCount,
  type TableRowSource,
} from './rows.js';
import { useTableRowSubject, useTableRowSubjects } from './useTableRows.js';

afterEach(cleanup);

it('captures a finite result without sharing mutable caller or returned arrays', async () => {
  const input = ['row:a', 'row:b'];
  const rows = tableRowList(input);
  input[0] = 'changed';
  const first = await rows.getAllMembers();
  first.length = 0;
  expect(await rows.getAllMembers()).toEqual(['row:a', 'row:b']);
  expect(await Array.fromAsync(rows)).toEqual(['row:a', 'row:b']);
  expect(await readTableRow(rows, -1)).toBeUndefined();
  expect(await readTableRow(rows, 0.5)).toBeUndefined();
  expect(await readTableRow(rows, 2)).toBeUndefined();
});

it('reads only the retained window and never treats its size as a collection total', async () => {
  const rows = { subjects: ['row:101', 'row:102'] };
  expect(tableRowCount(rows)).toBe(2);
  expect(await readTableRow(rows, 1)).toBe('row:102');
  expect(await readTableRow(rows, 2)).toBeUndefined();
  expect('getAllMembers' in rows).toBe(false);
  expect('totalMembers' in rows).toBe(false);
});

it('ignores a late indexed lookup after switching to another window', async () => {
  let resolve!: (subject: string) => void;
  const old = {
    ...tableRowList(['row:old']),
    getMemberWithIndex: () =>
      new Promise<string>(done => {
        resolve = done;
      }),
  };
  const { result, rerender } = renderHook(
    ({ source }: { source: TableRowSource }) => useTableRowSubject(source, 0),
    { initialProps: { source: old as TableRowSource } },
  );
  rerender({ source: { subjects: ['row:new'] } });
  await waitFor(() => expect(result.current.subject).toBe('row:new'));
  await act(async () => resolve('row:old'));
  expect(result.current.subject).toBe('row:new');
});

it('re-resolves when a stable window source replaces its identities without changing length', async () => {
  const source = { subjects: ['row:first'] };
  const { result, rerender } = renderHook(() => useTableRowSubject(source, 0));
  await waitFor(() => expect(result.current.subject).toBe('row:first'));
  source.subjects = ['row:next'];
  rerender();
  await waitFor(() => expect(result.current.subject).toBe('row:next'));
});

it('clears prior enumeration results on scope changes and exposes read failures', async () => {
  const { result, rerender } = renderHook(
    ({ source }) => useTableRowSubjects(source),
    { initialProps: { source: tableRowList(['row:old']) } },
  );
  await waitFor(() => expect(result.current.subjects).toEqual(['row:old']));
  const error = new Error('Backend unavailable');
  rerender({
    source: {
      ...tableRowList(['row:new']),
      getAllMembers: async () => {
        throw error;
      },
    },
  });
  expect(result.current.subjects).toEqual([]);
  await waitFor(() => expect(result.current.error).toBe(error));
  expect(result.current.loading).toBe(false);
});
