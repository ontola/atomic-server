// @vitest-environment jsdom
// @wc-ignore-file
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ThemeProvider } from 'styled-components';
import { core, dataBrowser, type Resource, type Store } from '@tomic/react';
import { buildTheme } from '../../styling';
import type { FlatSyncableRowAction } from './syncableFlatNavigation';
import { SyncableRecordActions } from './SyncableRecordActions';

const h = vi.hoisted(() => ({
  values: new Map<string, Record<string, unknown>>(),
  resources: new Map<string, Resource>(),
  listeners: new Map<string, Set<() => void>>(),
  resolve:
    vi.fn<
      (
        ...args: unknown[]
      ) => Promise<
        { table: Resource; actions: FlatSyncableRowAction[] } | undefined
      >
    >(),
  open: vi.fn<
    (
      ...args: unknown[]
    ) => Promise<
      { subject: string; view?: string; syncFilter?: string } | undefined
    >
  >(),
  navigate: vi.fn(async (..._args: unknown[]) => undefined),
}));
vi.mock('./syncableFlatNavigation', () => ({
  resolveFlatSyncableRecordActions: h.resolve,
  openFlatSyncableRow: h.open,
}));
vi.mock('../../hooks/useNavigateWithTransition', () => ({
  useNavigateWithTransition: () => h.navigate,
}));
vi.mock('@tomic/react', async original => {
  const React = await import('react');

  return {
    ...(await original<typeof import('@tomic/react')>()),
    useStore: () => store,
    useValue: (row: Resource, property: string) => [
      React.useSyncExternalStore(
        changed => store.subscribe(row.subject, changed),
        () => row.get(property),
        () => row.get(property),
      ),
    ],
    useResourceSnapshot: (subject: string) => {
      const revision = React.useSyncExternalStore(
        changed => store.subscribe(subject, changed),
        () => JSON.stringify(h.values.get(subject)),
        () => JSON.stringify(h.values.get(subject)),
      );

      return React.useMemo(
        () => ({
          resource: h.resources.get(subject)!,
          ready: h.values.get(subject)?.loading !== true,
          error: undefined,
          revision,
        }),
        [subject, revision],
      );
    },
  };
});
const DRIVE = 'atomic:drive';
const ROW = 'atomic:organization';
const TABLE = 'atomic:organizations';
const TARGET = 'atomic:issues';
const make = (subject: string): Resource =>
  ({
    subject,
    get: (property: string) => h.values.get(subject)?.[property],
    getSubjects: (property: string) => h.values.get(subject)?.[property] ?? [],
    hasClasses: (...classes: string[]) =>
      classes.every(klass =>
        (
          (h.values.get(subject)?.[core.properties.isA] ?? []) as string[]
        ).includes(klass),
      ),
  }) as unknown as Resource;
const store = {
  getAgent: () => ({ subject: 'atomic:agent:person' }),
  getServerUrl: () => 'https://node.example',
  getDrive: () => DRIVE,
  driveOfSubject: () => DRIVE,
  getResource: vi.fn(async (subject: string) => h.resources.get(subject)!),
  subscribe: (subject: string, changed: () => void) => {
    const callbacks = h.listeners.get(subject) ?? new Set();
    h.listeners.set(subject, callbacks);
    callbacks.add(changed);

    return () => {
      callbacks.delete(changed);
    };
  },
} as unknown as Store;
const action = (id: string, label: string): FlatSyncableRowAction => ({
  id,
  label,
  targetResource: id,
  definition: {} as FlatSyncableRowAction['definition'],
});
const repositories = action('repositories', 'Repositories');
const issues = action('issues', 'Issues via Repositories');

function add(subject: string, values: Record<string, unknown>) {
  h.values.set(subject, values);
  h.resources.set(subject, make(subject));
}

function notify(subject: string) {
  for (const changed of h.listeners.get(subject) ?? []) changed();
}

function show(subject = ROW) {
  return render(
    <ThemeProvider theme={buildTheme(false, '#1b50d8')}>
      <SyncableRecordActions resource={h.resources.get(subject)!} />
    </ThemeProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  h.values.clear();
  h.resources.clear();
  add(ROW, {
    [core.properties.localId]: 'syncables:node:stored',
    [core.properties.parent]: 'atomic:moved-folder',
    'https://atomicdata.dev/properties/drive': DRIVE,
  });
  add(TABLE, {});
  add(TARGET, {
    [core.properties.isA]: [dataBrowser.classes.table],
    [dataBrowser.properties.tableViews]: [
      'atomic:issues-filter',
      'atomic:issues-table',
    ],
  });
  add('atomic:issues-filter', {
    [core.properties.parent]: TARGET,
    [core.properties.isA]: [dataBrowser.classes.view],
    [dataBrowser.properties.viewKind]: 'syncable-collection',
  });
  add('atomic:issues-table', {
    [core.properties.parent]: TARGET,
    [core.properties.isA]: [dataBrowser.classes.view],
    [dataBrowser.properties.viewKind]: 'table',
  });
  h.resolve.mockResolvedValue({
    table: h.resources.get(TABLE)!,
    actions: [repositories, issues],
  });
  h.open.mockResolvedValue({
    subject: TARGET,
    view: 'atomic:issues-table',
    syncFilter: 'atomic:issues-filter',
  });
});
afterEach(() => {
  cleanup();
  h.listeners.clear();
  vi.restoreAllMocks();
});

it('shows all stored catalog actions on an ordinary moved record without a frame or provider refresh', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch');
  show();
  expect(
    await screen.findByRole('button', { name: 'Repositories' }),
  ).toBeTruthy();
  expect(
    screen.getByRole('button', { name: 'Issues via Repositories' }),
  ).toBeTruthy();
  expect(
    screen.getByRole('group', { name: 'Related collections' }),
  ).toBeTruthy();
  expect(h.resolve).toHaveBeenCalledWith(store, DRIVE, h.resources.get(ROW));
  expect(h.open).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
  expect(document.querySelector('iframe')).toBeNull();
});
it('opens the chosen action through its stored logical table and retains the filter in ordinary Table', async () => {
  show();
  fireEvent.click(
    await screen.findByRole('button', { name: 'Issues via Repositories' }),
  );
  await waitFor(() => expect(h.navigate).toHaveBeenCalledOnce());
  expect(h.open).toHaveBeenCalledWith(
    store,
    DRIVE,
    h.resources.get(TABLE),
    h.resources.get(ROW),
    undefined,
    issues.id,
  );
  const url = new URL(
    h.navigate.mock.calls[0][0] as string,
    window.location.href,
  );
  expect(url.searchParams.get('subject')).toBe(TARGET);
  expect(url.searchParams.get('view')).toBe('atomic:issues-table');
  expect(url.searchParams.get('syncFilter')).toBe('atomic:issues-filter');
});
it('does no discovery or resource lookup for an ordinary resource', async () => {
  h.values.get(ROW)![core.properties.localId] = 'custom-local-id';
  show();
  await act(async () => {});
  expect(h.resolve).not.toHaveBeenCalled();
  expect(store.getResource).not.toHaveBeenCalled();
  expect(screen.queryByRole('group')).toBeNull();
});
it('keeps adopted records with historical Syncables local IDs eligible', async () => {
  h.values.get(ROW)![core.properties.localId] =
    'syncables:github-issue:retained';
  show();
  expect(
    await screen.findByRole('button', { name: 'Repositories' }),
  ).toBeTruthy();
});
it('reacts to changed stored table descriptors without recreating the row resource', async () => {
  show();
  await screen.findByRole('button', { name: 'Repositories' });
  h.resolve.mockResolvedValue({
    table: h.resources.get(TABLE)!,
    actions: [issues],
  });
  await act(async () => {
    notify(TABLE);
  });
  await waitFor(() =>
    expect(screen.queryByRole('button', { name: 'Repositories' })).toBeNull(),
  );
  expect(
    screen.getByRole('button', { name: 'Issues via Repositories' }),
  ).toBeTruthy();
});
it('shows pending and errors while leaving the chosen action available to retry', async () => {
  h.open.mockRejectedValueOnce(new Error('The destination is read-only'));
  show();
  fireEvent.click(await screen.findByRole('button', { name: 'Repositories' }));
  expect(
    (screen.getByRole('button', { name: 'Repositories' }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect((await screen.findByRole('alert')).textContent).toContain('read-only');
  expect(
    (screen.getByRole('button', { name: 'Repositories' }) as HTMLButtonElement)
      .disabled,
  ).toBe(false);
  expect(h.navigate).not.toHaveBeenCalled();
});
it('keeps a pending action through equivalent stored table updates', async () => {
  let finish!: (value: { subject: string }) => void;
  h.open.mockImplementationOnce(
    () =>
      new Promise(done => {
        finish = done;
      }),
  );
  show();
  fireEvent.click(await screen.findByRole('button', { name: 'Repositories' }));
  h.resolve.mockResolvedValue({
    table: h.resources.get(TABLE)!,
    actions: [{ ...repositories }, { ...issues }],
  });
  await act(async () => {
    notify(TABLE);
  });
  expect(
    (screen.getByRole('button', { name: 'Repositories' }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  await act(async () => {
    finish({ subject: TARGET });
  });
  expect(h.navigate).toHaveBeenCalledOnce();
});
it('announces a rejected route transition without leaving the action busy', async () => {
  h.navigate.mockRejectedValueOnce(new Error('The navigation was canceled'));
  show();
  fireEvent.click(await screen.findByRole('button', { name: 'Repositories' }));
  expect((await screen.findByRole('alert')).textContent).toContain('canceled');
  expect(
    (screen.getByRole('button', { name: 'Repositories' }) as HTMLButtonElement)
      .disabled,
  ).toBe(false);
});
it('discards late action discovery after the displayed record changes', async () => {
  let finish!: (value: {
    table: Resource;
    actions: FlatSyncableRowAction[];
  }) => void;
  h.resolve.mockImplementationOnce(
    () =>
      new Promise(done => {
        finish = done;
      }),
  );
  const page = show();
  add('atomic:other-row', {
    [core.properties.localId]: 'syncables:node:other',
    'https://atomicdata.dev/properties/drive': DRIVE,
  });
  h.resolve.mockResolvedValue({
    table: h.resources.get(TABLE)!,
    actions: [issues],
  });
  page.rerender(
    <ThemeProvider theme={buildTheme(false, '#1b50d8')}>
      <SyncableRecordActions resource={h.resources.get('atomic:other-row')!} />
    </ThemeProvider>,
  );
  await screen.findByRole('button', { name: 'Issues via Repositories' });
  await act(async () => {
    finish({ table: h.resources.get(TABLE)!, actions: [repositories] });
  });
  expect(screen.queryByRole('button', { name: 'Repositories' })).toBeNull();
});
it.each(['unmount', 'move'] as const)(
  'suppresses pending navigation after %s',
  async change => {
    let finish!: (value: { subject: string }) => void;
    h.open.mockImplementationOnce(
      () =>
        new Promise(done => {
          finish = done;
        }),
    );
    const page = show();
    fireEvent.click(
      await screen.findByRole('button', { name: 'Repositories' }),
    );
    if (change === 'unmount') page.unmount();
    else
      await act(async () => {
        h.values.get(ROW)![core.properties.parent] = 'atomic:another-folder';
        notify(ROW);
      });
    await act(async () => {
      finish({ subject: TARGET });
    });
    expect(h.navigate).not.toHaveBeenCalled();
  },
);
