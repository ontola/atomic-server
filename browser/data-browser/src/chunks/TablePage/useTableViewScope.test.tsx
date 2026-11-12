// @vitest-environment jsdom
// @wc-ignore-file
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import {
  Store,
  StoreContext,
  LoroLoader,
  core,
  dataBrowser,
  Datatype,
  unknownSubject,
} from '@tomic/react';
import { TableNavigationProvider } from '@tomic/table';
import { useTableView } from './useTableView';
import { useTableData } from './useTableData';

vi.mock('@tomic/react', async importOriginal => ({
  ...(await importOriginal<typeof import('@tomic/react')>()),
  useCanWrite: () => true,
}));
afterEach(cleanup);
beforeAll(async () => {
  const wasm = await readFile(
    createRequire(import.meta.url).resolve('loro-crdt/web/loro_wasm_bg.wasm'),
  );
  const web = await import('loro-crdt/web');
  await web.default({ module_or_path: wasm });
  await LoroLoader.initializeLoro();
});

async function setup({
  requested,
  defaultOnly = false,
  foreignOwner = false,
  implicit = false,
}: {
  requested?: string;
  defaultOnly?: boolean;
  foreignOwner?: boolean;
  implicit?: boolean;
} = {}) {
  const store = new Store({ serverUrl: 'https://example.com', connect: false });

  for (const [subject, type] of [
    [core.properties.parent, Datatype.ATOMIC_URL],
    [core.properties.name, Datatype.STRING],
    [core.properties.classtype, Datatype.ATOMIC_URL],
    [dataBrowser.properties.tableViews, Datatype.RESOURCEARRAY],
    [dataBrowser.properties.tableDefaultView, Datatype.ATOMIC_URL],
    [dataBrowser.properties.viewKind, Datatype.STRING],
    [dataBrowser.properties.viewFilters, Datatype.JSON],
    [dataBrowser.properties.viewSortBy, Datatype.ATOMIC_URL],
    [dataBrowser.properties.viewSortDesc, Datatype.BOOLEAN],
  ]) {
    const property = await store.newResource({ subject, noParent: true });
    await property.set(core.properties.datatype, type, false);
    await property.set(core.properties.shortname, 'test-property', false);
    await property.set(core.properties.description, 'Test metadata', false);
    await store.getProperty(subject);
  }

  const table = await store.newResource({
    subject: 'https://example.com/table',
    noParent: true,
  });
  const view = await store.newResource({
    subject: 'https://example.com/view',
    noParent: true,
  });
  await view.set(
    core.properties.parent,
    foreignOwner ? 'https://example.com/other-table' : table.subject,
    false,
  );
  await view.set(core.properties.name, 'Owned view', false);
  await view.set(dataBrowser.properties.viewKind, 'table', false);
  if (!implicit)
    await table.set(
      defaultOnly
        ? dataBrowser.properties.tableDefaultView
        : dataBrowser.properties.tableViews,
      defaultOnly ? view.subject : [view.subject],
      false,
    );
  const save = vi.spyOn(table, 'save').mockResolvedValue('persisted');
  const viewSave = vi.spyOn(view, 'save').mockResolvedValue('persisted');
  const destroy = vi.spyOn(view, 'destroy').mockResolvedValue(undefined);
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <StoreContext.Provider value={store}>
      <TableNavigationProvider
        value={{ location: { view: requested }, navigate: vi.fn() }}
      >
        {children}
      </TableNavigationProvider>
    </StoreContext.Provider>
  );
  const hook = renderHook(() => useTableView(table), { wrapper });

  return { ...hook, table, view, store, save, viewSave, destroy, wrapper };
}

it('does not resolve a foreign URL view to the default or fetch its config', async () => {
  const state = await setup({ requested: 'https://example.com/foreign-view' });
  await waitFor(() => expect(state.result.current.viewError).toBeTruthy());
  expect(state.result.current.viewReady).toBe(false);
  expect(state.result.current.activeView).toBeUndefined();
  expect(state.result.current.view.subject).toBe(unknownSubject);
});

it('preserves a legacy default-only view and verifies its owner', async () => {
  const state = await setup({ defaultOnly: true });
  await waitFor(() => expect(state.result.current.viewReady).toBe(true));
  expect(state.result.current.activeView).toBe(state.view.subject);
  expect(state.result.current.views).toEqual([state.view.subject]);
});

it('keeps a missing view query unready even when the row class is known', async () => {
  const state = await setup({ requested: 'https://example.com/foreign-view' });
  const rowClass = await state.store.newResource({
    subject: 'https://example.com/row-class',
    noParent: true,
  });
  await state.table.set(core.properties.classtype, rowClass.subject, false);
  const data = renderHook(() => useTableData(state.table), {
    wrapper: state.wrapper,
  });
  await waitFor(() => expect(data.result.current.viewError).toBeTruthy());
  expect(data.result.current.tableClass.subject).toBe(rowClass.subject);
  expect(data.result.current.query.scope.rowClass).toBeUndefined();
  expect(data.result.current.ready).toBe(false);
});

it('rejects a linked record belonging to another table before changing it', async () => {
  const state = await setup({ foreignOwner: true });
  await waitFor(() => expect(state.result.current.viewError).toBeTruthy());
  await act(async () => {
    state.result.current.renameView('Wrong scope');
    state.result.current.duplicateView(state.view.subject);
    state.result.current.deleteView(state.view.subject);
    state.result.current.setViewKind(state.view.subject, 'calendar');
    await Promise.resolve();
  });
  expect(state.viewSave).not.toHaveBeenCalled();
  expect(state.save).not.toHaveBeenCalled();
  expect(state.destroy).not.toHaveBeenCalled();
});

it('does not mutate the table when a view target or reorder is foreign', async () => {
  const state = await setup();
  await waitFor(() => expect(state.result.current.viewReady).toBe(true));
  const set = vi.spyOn(state.table, 'set');
  const create = vi.spyOn(state.store, 'newResource');
  await act(async () => {
    const foreign = 'https://example.com/foreign-view';
    state.result.current.deleteView(foreign);
    state.result.current.duplicateView(foreign);
    state.result.current.setViewKind(foreign, 'calendar');
    state.result.current.reorderViews([foreign]);
    state.result.current.reorderViews([]);
    await Promise.resolve();
  });
  expect(create).not.toHaveBeenCalled();
  expect(set).not.toHaveBeenCalled();
  expect(state.save).not.toHaveBeenCalled();
});

it('materializes one implicit view for concurrent first column/config changes', async () => {
  const state = await setup({ implicit: true });
  await waitFor(() => expect(state.result.current.viewReady).toBe(true));
  let complete!: (view: typeof state.view) => void;
  const create = vi.spyOn(state.store, 'newResource').mockImplementationOnce(
    () =>
      new Promise(resolve => {
        complete = resolve;
      }),
  );
  act(() => {
    state.result.current.setViewColumns(['https://example.com/property']);
    state.result.current.renameView('Renamed default');
  });
  await waitFor(() => expect(create).toHaveBeenCalledOnce());
  await act(async () => {
    complete(state.view);
  });
  await waitFor(() =>
    expect(state.table.get(dataBrowser.properties.tableViews)).toEqual([
      state.view.subject,
    ]),
  );
  expect(create).toHaveBeenCalledOnce();
  await waitFor(() =>
    expect(state.view.get(core.properties.name)).toBe('Renamed default'),
  );
  expect(state.view.get(dataBrowser.properties.viewColumns)).toEqual([
    'https://example.com/property',
  ]);
});

it('retains failed configuration writes and serializes later changes behind explicit retry', async () => {
  const state = await setup();
  await waitFor(() => expect(state.result.current.viewReady).toBe(true));
  state.viewSave.mockRejectedValueOnce(Error('offline'));
  act(() => state.result.current.renameView('Retained name'));
  await waitFor(() =>
    expect(state.result.current.viewSaveError).toBe('offline'),
  );
  act(() =>
    state.result.current.setViewColumns(['https://example.com/property']),
  );
  expect(state.viewSave).toHaveBeenCalledTimes(1);
  expect(state.view.get(dataBrowser.properties.viewColumns)).toBeUndefined();
  act(() => state.result.current.retryViewSave());
  await waitFor(() =>
    expect(state.result.current.viewSaveError).toBeUndefined(),
  );
  await waitFor(() => expect(state.viewSave).toHaveBeenCalledTimes(3));
  expect(state.view.get(core.properties.name)).toBe('Retained name');
  expect(state.view.get(dataBrowser.properties.viewColumns)).toEqual([
    'https://example.com/property',
  ]);
});

it('retries a failed implicit-view attachment using the same prepared resource', async () => {
  const state = await setup({ implicit: true });
  await waitFor(() => expect(state.result.current.viewReady).toBe(true));
  const create = vi
    .spyOn(state.store, 'newResource')
    .mockResolvedValueOnce(state.view);
  state.save.mockRejectedValueOnce(Error('attachment failed'));
  act(() => state.result.current.renameView('Retained default'));
  await waitFor(() =>
    expect(state.result.current.viewSaveError).toBe('attachment failed'),
  );
  act(() => state.result.current.retryViewSave());
  await waitFor(() =>
    expect(state.view.get(core.properties.name)).toBe('Retained default'),
  );
  expect(create).toHaveBeenCalledOnce();
  expect(state.table.get(dataBrowser.properties.tableViews)).toEqual([
    state.view.subject,
  ]);
  await waitFor(() =>
    expect(state.result.current.viewSaveError).toBeUndefined(),
  );
});

it('rechecks view ownership when retrying a retained configuration write', async () => {
  const state = await setup();
  await waitFor(() => expect(state.result.current.viewReady).toBe(true));
  state.viewSave.mockRejectedValueOnce(Error('offline'));
  act(() => state.result.current.renameView('Retained name'));
  await waitFor(() =>
    expect(state.result.current.viewSaveError).toBe('offline'),
  );
  await act(async () => {
    await state.view.set(
      core.properties.parent,
      'https://example.com/other-table',
      false,
    );
  });
  act(() => state.result.current.retryViewSave());
  await waitFor(() =>
    expect(state.result.current.viewSaveError).not.toBe('offline'),
  );
  expect(state.result.current.viewSaveError).toBeTruthy();
  expect(state.viewSave).toHaveBeenCalledTimes(1);
});

it('retains filter edits made while an implicit-view attachment is paused', async () => {
  const state = await setup({ implicit: true });
  await waitFor(() => expect(state.result.current.viewReady).toBe(true));
  vi.spyOn(state.store, 'newResource').mockResolvedValueOnce(state.view);
  state.save.mockRejectedValueOnce(Error('attachment failed'));
  const property = 'https://example.com/property';
  act(() => {
    state.result.current.addFilter(property);
  });
  act(() => {
    state.result.current.setFilterValue(property, 'first');
  });
  await waitFor(
    () => expect(state.result.current.viewSaveError).toBe('attachment failed'),
    { timeout: 3000 },
  );
  expect(state.result.current.filters[0].value).toBe('first');
  act(() => state.result.current.setFilterValue(property, 'latest'));
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 700));
  });
  act(() => state.result.current.retryViewSave());
  await waitFor(
    () =>
      expect(state.view.get(dataBrowser.properties.viewFilters)).toEqual([
        { property, operator: 'eq', value: 'latest' },
      ]),
    { timeout: 3000 },
  );
});
