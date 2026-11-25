// @vitest-environment jsdom
// @wc-ignore-file
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { useRef } from 'react';
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from '@testing-library/react';
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
import { DropdownPortalContext } from '@tomic/ui/components/Dropdown/dropdownContext';
import { TableViewTabs } from './TableViewTabs.js';
import { useTableView } from './useTableView.js';

Element.prototype.scrollIntoView = () => undefined;

const permission = vi.hoisted(() => ({ writable: true }));
vi.mock('@tomic/react', async importOriginal => ({
  ...(await importOriginal<typeof import('@tomic/react')>()),
  useCanWrite: () => permission.writable,
}));

beforeAll(async () => {
  const wasm = await readFile(
    createRequire(import.meta.url).resolve('loro-crdt/web/loro_wasm_bg.wasm'),
  );
  const web = await import('loro-crdt/web');
  await web.default({ module_or_path: wasm });
  await LoroLoader.initializeLoro();
});
beforeEach(() => {
  permission.writable = true;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function setup(empty = false) {
  const store = new Store({ serverUrl: 'https://example.com', connect: false });
  const getAgent = vi.spyOn(store, 'getAgent').mockReturnValue({
    subject: 'https://example.com/agent',
  } as Agent);
  const table = await store.newResource({
    subject: '_new:table',
    noParent: true,
  });
  const active = await store.newResource({
    subject: '_new:active',
    noParent: true,
  });
  const inactive = await store.newResource({
    subject: '_new:inactive',
    noParent: true,
  });

  for (const [view, name] of [
    [active, 'Active'],
    [inactive, 'Inactive'],
  ] as const) {
    await view.set(core.properties.parent, table.subject, false);
    await view.set(core.properties.name, name, false);
  }

  await table.set(
    dataBrowser.properties.tableViews,
    empty ? [] : [active.subject, inactive.subject],
    false,
  );
  const activeSave = vi.spyOn(active, 'save').mockResolvedValue('persisted');
  const inactiveSave = vi
    .spyOn(inactive, 'save')
    .mockResolvedValue('persisted');
  const hook = renderHook(() => useTableView(table), {
    wrapper: ({ children }) => (
      <StoreContext value={store}>
        <ThemeProvider theme={buildTheme()}>{children}</ThemeProvider>
      </StoreContext>
    ),
  });
  await waitFor(() =>
    expect(hook.result.current.activeView).toBe(
      empty ? undefined : active.subject,
    ),
  );

  return {
    ...hook,
    store,
    table,
    active,
    inactive,
    activeSave,
    inactiveSave,
    getAgent,
  };
}

it('renames the captured inactive tab without changing the active view', async () => {
  const state = await setup();
  act(() =>
    state.result.current.renameView('  Renamed  ', state.inactive.subject),
  );
  await waitFor(() => expect(state.inactiveSave).toHaveBeenCalledOnce());
  expect(state.inactive.get(core.properties.name)).toBe('Renamed');
  expect(state.active.get(core.properties.name)).toBe('Active');
  expect(state.activeSave).not.toHaveBeenCalled();
});

it('retains the active-view rename call without an explicit target', async () => {
  const state = await setup();
  act(() => state.result.current.renameView('Renamed active'));
  await waitFor(() => expect(state.activeSave).toHaveBeenCalledOnce());
  expect(state.active.get(core.properties.name)).toBe('Renamed active');
  expect(state.inactiveSave).not.toHaveBeenCalled();
});

it('waits for the captured active view before persisting configuration', async () => {
  const state = await setup();
  const loaded = Promise.withResolvers<Resource>();
  const load = vi
    .spyOn(state.store, 'getResource')
    .mockReturnValueOnce(loaded.promise);
  await act(async () => state.result.current.setViewColumnOrder(['column']));

  expect(load).toHaveBeenCalledWith(state.active.subject);
  expect(state.activeSave).not.toHaveBeenCalled();

  await act(async () => loaded.resolve(state.active));
  await waitFor(() => expect(state.activeSave).toHaveBeenCalledOnce());
});

it('does not persist configuration to an active view owned by another table', async () => {
  const state = await setup();
  await state.active.set(core.properties.parent, '_new:foreign-table', false);
  await act(async () => state.result.current.setViewColumnOrder(['column']));

  expect(state.activeSave).not.toHaveBeenCalled();
  expect(
    state.active.get(dataBrowser.properties.viewColumnOrder),
  ).toBeUndefined();
});

it('shares the implicit default view when two configuration writes start together', async () => {
  const state = await setup(true);
  const created = Promise.withResolvers<Resource>();
  const newResource = vi
    .spyOn(state.store, 'newResource')
    .mockImplementation(() => created.promise);
  const set = state.table.set.bind(state.table);
  vi.spyOn(state.table, 'set').mockImplementation((property, value) =>
    set(property, value, false),
  );
  vi.spyOn(state.table, 'save').mockResolvedValue('persisted');
  act(() => {
    state.result.current.setViewColumnOrder(['column']);
    state.result.current.setViewGroupBy('column');
  });

  expect(newResource).toHaveBeenCalledOnce();
  await act(async () => created.resolve(state.active));
  await waitFor(() =>
    expect(state.active.get(dataBrowser.properties.viewGroupBy)).toBe('column'),
  );
  expect(state.active.get(dataBrowser.properties.viewColumnOrder)).toEqual([
    'column',
  ]);
  expect(state.table.getSubjects(dataBrowser.properties.tableViews)).toEqual([
    state.active.subject,
  ]);
});

it('captures the inactive tab identity from its context-menu rename action', async () => {
  const state = await setup();
  const rename = vi.fn();
  const select = vi.fn();

  function Tabs() {
    const portal = useRef<HTMLDivElement>(null);

    return (
      <StoreContext value={state.store}>
        <ThemeProvider theme={buildTheme()}>
          <DropdownPortalContext value={portal}>
            <TableViewTabs
              rowClass='https://example.com/row'
              views={[state.active.subject, state.inactive.subject]}
              activeView={state.active.subject}
              setActiveView={select}
              reorderViews={() => {}}
              createView={() => {}}
              setViewKind={() => {}}
              duplicateView={() => {}}
              deleteView={() => {}}
              viewName=''
              renameView={rename}
              allColumns={[]}
              columns={[]}
              derivedColumns={[]}
              showColumn={() => {}}
              hideColumn={() => {}}
              lockedColumns={new Set()}
              lockedReason=''
              canWrite
              quickAdd={undefined}
              setQuickAdd={() => {}}
            />
            <div ref={portal} />
          </DropdownPortalContext>
        </ThemeProvider>
      </StoreContext>
    );
  }

  render(<Tabs />);
  fireEvent.contextMenu(await screen.findByRole('tab', { name: 'Inactive' }));
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Rename' }));
  const input = screen.getByRole('textbox');
  fireEvent.change(input, { target: { value: 'New inactive name' } });
  fireEvent.blur(input);
  expect(rename).toHaveBeenCalledExactlyOnceWith(
    'New inactive name',
    state.inactive.subject,
  );
  expect(select).not.toHaveBeenCalled();
});

it.each(['foreign owner', 'unlisted target', 'read only', 'blank name'])(
  'does not change a captured tab with %s',
  async reason => {
    const state = await setup();

    if (reason === 'foreign owner') {
      await state.inactive.set(
        core.properties.parent,
        '_new:other-table',
        false,
      );
    } else if (reason === 'unlisted target') {
      await act(async () => {
        await state.table.set(
          dataBrowser.properties.tableViews,
          [state.active.subject],
          false,
        );
      });
    } else if (reason === 'read only') {
      permission.writable = false;
      state.rerender();
    }

    await act(async () => {
      state.result.current.renameView(
        reason === 'blank name' ? '   ' : 'Wrong',
        state.inactive.subject,
      );
    });
    expect(state.inactive.get(core.properties.name)).toBe('Inactive');
    expect(state.inactiveSave).not.toHaveBeenCalled();
  },
);

it.each(['removed', 'moved'])(
  'does not rename a tab %s while its resource is loading',
  async change => {
    const state = await setup();
    const getResource = state.store.getResource.bind(state.store);
    let finishLoading!: (resource: Resource) => void;
    const loading = new Promise<Resource>(resolve => {
      finishLoading = resolve;
    });
    const load = vi
      .spyOn(state.store, 'getResource')
      .mockImplementation(subject =>
        subject === state.inactive.subject ? loading : getResource(subject),
      );
    act(() =>
      state.result.current.renameView('Stale rename', state.inactive.subject),
    );
    await waitFor(() =>
      expect(load).toHaveBeenCalledWith(state.inactive.subject),
    );
    await act(async () => {
      if (change === 'removed') {
        await state.table.set(
          dataBrowser.properties.tableViews,
          [state.active.subject],
          false,
        );
      } else {
        await state.inactive.set(
          core.properties.parent,
          '_new:other-table',
          false,
        );
      }

      finishLoading(state.inactive);
    });
    expect(state.inactive.get(core.properties.name)).toBe('Inactive');
    expect(state.inactiveSave).not.toHaveBeenCalled();
  },
);

it.each(['permission revoked', 'account changed', 'signed out'])(
  'does not rename when %s while its resource is loading',
  async change => {
    const state = await setup();
    const getResource = state.store.getResource.bind(state.store);
    let finishLoading!: (resource: Resource) => void;
    const loading = new Promise<Resource>(resolve => {
      finishLoading = resolve;
    });
    const load = vi
      .spyOn(state.store, 'getResource')
      .mockImplementation(subject =>
        subject === state.inactive.subject ? loading : getResource(subject),
      );
    act(() =>
      state.result.current.renameView('Stale rename', state.inactive.subject),
    );
    await waitFor(() =>
      expect(load).toHaveBeenCalledWith(state.inactive.subject),
    );
    await act(async () => {
      if (change === 'permission revoked') {
        permission.writable = false;
        state.rerender();
      } else {
        state.getAgent.mockReturnValue(
          change === 'signed out'
            ? undefined
            : ({ subject: 'https://example.com/other-agent' } as Agent),
        );
      }
    });
    await act(async () => finishLoading(state.inactive));
    expect(state.inactive.get(core.properties.name)).toBe('Inactive');
    expect(state.inactiveSave).not.toHaveBeenCalled();
  },
);

it.each(['error', 'loading'])(
  'does not rename an unresolved target with %s state',
  async stateName => {
    const state = await setup();
    if (stateName === 'error')
      state.inactive.error = new Error('Unavailable view');
    else state.inactive.loading = true;
    const getResource = state.store.getResource.bind(state.store);
    vi.spyOn(state.store, 'getResource').mockImplementation(subject =>
      subject === state.inactive.subject
        ? Promise.resolve(state.inactive)
        : getResource(subject),
    );
    await act(async () =>
      state.result.current.renameView('Wrong', state.inactive.subject),
    );
    expect(state.inactive.get(core.properties.name)).toBe('Inactive');
    expect(state.inactiveSave).not.toHaveBeenCalled();
  },
);
