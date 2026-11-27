// @vitest-environment jsdom
// @wc-ignore-file
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import {
  core,
  dataBrowser,
  LoroLoader,
  Store,
  StoreContext,
  type Agent,
  type Resource,
} from '@tomic/react';
import { buildTheme, ThemeProvider } from '../../test/providers';
import { useTableView } from './useTableView.js';

vi.mock('@tomic/react', async importOriginal => ({
  ...(await importOriginal<typeof import('@tomic/react')>()),
  useCanWrite: () => true,
}));

beforeAll(async () => {
  const wasm = await readFile(
    createRequire(import.meta.url).resolve('loro-crdt/web/loro_wasm_bg.wasm'),
  );
  const web = await import('loro-crdt/web');
  await web.default({ module_or_path: wasm });
  await LoroLoader.initializeLoro();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function setup(deferCreation = false) {
  const store = new Store({ serverUrl: 'https://example.com', connect: false });
  vi.spyOn(store, 'getAgent').mockReturnValue({
    subject: 'https://example.com/agent',
  } as Agent);
  const makeResource = store.newResource.bind(store);
  const table = await store.newResource({
    subject: '_new:table',
    noParent: true,
  });
  const view = await store.newResource({
    subject: '_new:view',
    noParent: true,
  });
  await table.set(dataBrowser.properties.tableViews, [], false);
  await view.set(core.properties.parent, table.subject, false);
  await view.set(core.properties.name, 'Default View', false);
  const viewSave = vi.spyOn(view, 'save').mockResolvedValue('persisted');
  const created = Promise.withResolvers<Resource>();
  const newResource = vi
    .spyOn(store, 'newResource')
    .mockImplementation(() =>
      deferCreation ? created.promise : Promise.resolve(view),
    );

  const set = table.set.bind(table);
  vi.spyOn(table, 'set').mockImplementation((property, value) =>
    set(property, value, false),
  );
  vi.spyOn(table, 'push').mockImplementation(async (property, values) => {
    await set(property, [...table.getSubjects(property), ...values], false);
  });
  const linked = Promise.withResolvers<'persisted'>();
  const tableSave = vi.spyOn(table, 'save').mockReturnValue(linked.promise);

  const hook = renderHook(
    ({ table: currentTable, viewOverride }) =>
      useTableView(currentTable, viewOverride),
    {
      initialProps: { table, viewOverride: undefined as string | undefined },
      wrapper: ({ children }) => (
        <StoreContext value={store}>
          <ThemeProvider theme={buildTheme()}>{children}</ThemeProvider>
        </StoreContext>
      ),
    },
  );
  vi.useFakeTimers();

  return {
    ...hook,
    store,
    table,
    view,
    viewSave,
    newResource,
    created,
    linked,
    tableSave,
    makeResource,
  };
}

const property = 'https://example.com/age';

async function beginFilter(
  state: Awaited<ReturnType<typeof setup>>,
  value = '10',
) {
  const hook = state;
  await act(async () => {
    hook.result.current.addFilter(property);
    hook.result.current.setFilterValue(property, value);
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(600);
  });
}

it('persists the latest filter edited while the initial view is being linked', async () => {
  const state = await setup();
  const { view, linked, tableSave } = state;
  const hook = state;
  await beginFilter(state);
  expect(tableSave).toHaveBeenCalledOnce();
  expect(hook.result.current.activeView).toBe(view.subject);

  // The default View is visible locally, but its link is still being saved.
  // A later edit must not be dropped while that first save awaits its ACK.
  await act(async () => hook.result.current.setFilterValue(property, '30'));
  await act(async () => linked.resolve('persisted'));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(600);
  });
  expect(hook.result.current.filters).toEqual([
    { property, operator: 'eq', value: '30' },
  ]);
  expect(view.get(dataBrowser.properties.viewFilters)).toEqual([
    { property, operator: 'eq', value: '30' },
  ]);
});

it('shares initial view creation while later drafts wait for its resource', async () => {
  const state = await setup(true);
  await beginFilter(state);
  await act(async () => state.result.current.setFilterValue(property, '30'));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(600);
  });
  expect(state.newResource).toHaveBeenCalledOnce();
  await act(async () => state.created.resolve(state.view));
  await act(async () => state.linked.resolve('persisted'));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(600);
  });
  expect(state.table.getSubjects(dataBrowser.properties.tableViews)).toEqual([
    state.view.subject,
  ]);
  expect(state.view.get(dataBrowser.properties.viewFilters)).toEqual([
    { property, operator: 'eq', value: '30' },
  ]);
});

for (const differentTable of [false, true]) {
  it(`keeps a late creation separate from a newer ${differentTable ? 'table' : 'view'} draft`, async () => {
    const state = await setup();
    await beginFilter(state);
    const table = differentTable
      ? await state.makeResource({
          subject: '_new:other-table',
          noParent: true,
        })
      : state.table;
    const view = await state.makeResource({
      subject: '_new:other-view',
      noParent: true,
    });
    await view.set(core.properties.parent, table.subject, false);
    await view.set(core.properties.name, 'Other View', false);
    await view.set(
      dataBrowser.properties.viewFilters,
      [{ property, operator: 'eq', value: '77' }],
      false,
    );
    await table.set(
      dataBrowser.properties.tableViews,
      differentTable ? [view.subject] : [state.view.subject, view.subject],
      false,
    );
    const save = vi.spyOn(view, 'save').mockResolvedValue('persisted');
    await act(async () =>
      state.rerender({ table, viewOverride: view.subject }),
    );
    expect(state.result.current.filters[0]?.value).toBe('77');
    await act(async () => state.result.current.setFilterValue(property, '88'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    expect(save).toHaveBeenCalledOnce();
    await act(async () => state.linked.resolve('persisted'));
    await act(async () => state.result.current.setFilterValue(property, '88'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    expect(save).toHaveBeenCalledOnce();
    await act(async () => state.result.current.setFilterValue(property, '99'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    expect(view.get(dataBrowser.properties.viewFilters)).toEqual([
      { property, operator: 'eq', value: '99' },
    ]);
    expect(state.view.get(dataBrowser.properties.viewFilters)).toEqual([
      { property, operator: 'eq', value: '10' },
    ]);
  });
}

it('hydrates a different empty table instead of inheriting an implicit draft', async () => {
  const state = await setup(true);
  await beginFilter(state);
  const table = await state.makeResource({
    subject: '_new:other-empty-table',
    noParent: true,
  });
  await table.set(dataBrowser.properties.tableViews, [], false);
  await act(async () => state.rerender({ table, viewOverride: undefined }));
  expect(state.result.current.filters).toEqual([]);
  await act(async () => state.created.resolve(state.view));
  await act(async () => state.linked.resolve('persisted'));
  expect(state.result.current.filters).toEqual([]);
});

it('retains a failed draft and retries it on the next edit instead of marking it saved', async () => {
  const state = await setup();
  const failure = new Error('The save failed');
  state.viewSave
    .mockResolvedValueOnce('persisted')
    .mockRejectedValueOnce(failure);
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  await beginFilter(state);
  await act(async () => state.result.current.setFilterValue(property, '30'));
  await act(async () => state.linked.resolve('persisted'));
  expect(error).toHaveBeenCalledWith(
    'Could not persist the view configuration:',
    failure,
  );
  expect(state.result.current.filters).toEqual([
    { property, operator: 'eq', value: '30' },
  ]);
  await act(async () => state.result.current.setFilterValue(property, '30'));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(600);
  });
  expect(state.viewSave).toHaveBeenCalledTimes(3);
  expect(state.view.get(dataBrowser.properties.viewFilters)).toEqual([
    { property, operator: 'eq', value: '30' },
  ]);
});

it('retries a rejected initial table link and latest draft on the next edit', async () => {
  const state = await setup();
  const failure = new Error('The table link failed');
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  await beginFilter(state);
  expect(state.tableSave).toHaveBeenCalledOnce();
  await act(async () => state.result.current.setFilterValue(property, '30'));
  await act(async () => state.linked.reject(failure));
  expect(error).toHaveBeenCalledWith(
    'Could not persist the view configuration:',
    failure,
  );
  expect(state.result.current.filters).toEqual([
    { property, operator: 'eq', value: '30' },
  ]);
  expect(state.view.get(dataBrowser.properties.viewFilters)).toBeUndefined();
  expect(state.viewSave).toHaveBeenCalledOnce();

  state.tableSave
    .mockRejectedValueOnce(Error('The retry also failed'))
    .mockResolvedValue('persisted');
  await act(async () => state.result.current.setFilterValue(property, '40'));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(600);
  });
  expect(state.tableSave).toHaveBeenCalledTimes(2);
  expect(state.result.current.filters[0]?.value).toBe('40');
  expect(state.viewSave).toHaveBeenCalledOnce();
  expect(state.view.get(dataBrowser.properties.viewFilters)).toBeUndefined();

  await act(async () => state.result.current.setFilterValue(property, '50'));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(600);
  });
  expect(state.tableSave).toHaveBeenCalledTimes(3);
  expect(state.newResource).toHaveBeenCalledOnce();
  expect(state.viewSave).toHaveBeenCalledTimes(2);
  expect(state.view.get(dataBrowser.properties.viewFilters)).toEqual([
    { property, operator: 'eq', value: '50' },
  ]);
});

for (const differentTable of [false, true]) {
  it(`does not transfer a rejected initial link into a newer ${differentTable ? 'table' : 'view'} draft`, async () => {
    const state = await setup();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await beginFilter(state);
    const table = differentTable
      ? await state.makeResource({
          subject: '_new:later-table',
          noParent: true,
        })
      : state.table;
    const view = await state.makeResource({
      subject: '_new:later-view',
      noParent: true,
    });
    await view.set(core.properties.parent, table.subject, false);
    await view.set(core.properties.name, 'Later View', false);
    await view.set(
      dataBrowser.properties.viewFilters,
      [{ property, operator: 'eq', value: '77' }],
      false,
    );
    await table.set(
      dataBrowser.properties.tableViews,
      differentTable ? [view.subject] : [state.view.subject, view.subject],
      false,
    );
    const save = vi.spyOn(view, 'save').mockResolvedValue('persisted');
    await act(async () =>
      state.rerender({ table, viewOverride: view.subject }),
    );
    await act(async () => state.result.current.setFilterValue(property, '88'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    expect(save).toHaveBeenCalledOnce();

    await act(async () => state.linked.reject(Error('Old table link failed')));
    expect(state.result.current.filters[0]?.value).toBe('88');
    await act(async () => state.result.current.setFilterValue(property, '99'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    expect(save).toHaveBeenCalledTimes(2);
    expect(view.get(dataBrowser.properties.viewFilters)).toEqual([
      { property, operator: 'eq', value: '99' },
    ]);
    expect(state.tableSave).toHaveBeenCalledOnce();
    expect(state.view.get(dataBrowser.properties.viewFilters)).toBeUndefined();
  });
}

it('does not treat an in-memory queued initial link as persisted before retry', async () => {
  const state = await setup();
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  state.tableSave
    .mockResolvedValueOnce('queued')
    .mockResolvedValue('persisted');
  await beginFilter(state);
  expect(error).toHaveBeenCalled();
  expect(state.viewSave).toHaveBeenCalledOnce();
  expect(state.view.get(dataBrowser.properties.viewFilters)).toBeUndefined();

  await act(async () => state.result.current.setFilterValue(property, '30'));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(600);
  });
  expect(state.tableSave).toHaveBeenCalledTimes(2);
  expect(state.newResource).toHaveBeenCalledOnce();
  expect(state.view.get(dataBrowser.properties.viewFilters)).toEqual([
    { property, operator: 'eq', value: '30' },
  ]);
});
