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
import { resolveEntityIdentity, prepareDocument } from 'syncables/browser';
import { buildTheme } from '../../styling';
import { entitySourceKey, entityTableKey } from './builtinSyncIdentity.js';
import { useSyncableTableNavigation } from './useSyncableTableNavigation';
import type { useSyncableFilters } from './useSyncableFilters';

const state = vi.hoisted(() => ({
  writable: true,
  actor: 'atomic:agent:person',
  server: 'https://node.example',
  values: new Map<string, Record<string, unknown>>(),
  resources: new Map<string, Resource>(),
  listeners: new Set<() => void>(),
  open: vi.fn(
    async (
      ..._args: unknown[]
    ): Promise<
      { subject: string; view?: string; syncFilter?: string } | undefined
    > => ({
      subject: 'atomic:children',
      view: 'atomic:table-view',
      syncFilter: 'atomic:child-filter',
    }),
  ),
  navigate: vi.fn(async (..._args: unknown[]) => undefined),
}));
vi.mock('@tomic/react', async original => {
  const React = await import('react');

  const subscribe = (changed: () => void) => {
    state.listeners.add(changed);

    return () => {
      state.listeners.delete(changed);
    };
  };

  return {
    ...(await original<typeof import('@tomic/react')>()),
    useStore: () => store,
    useCanWrite: () => state.writable,
    useValue: (row: Resource, property: string) => [
      React.useSyncExternalStore(
        subscribe,
        () => row.get(property),
        () => row.get(property),
      ),
    ],
    useResourceSnapshot: (subject: string) => {
      const revision = React.useSyncExternalStore(
        subscribe,
        () => JSON.stringify(state.values.get(subject)),
        () => JSON.stringify(state.values.get(subject)),
      );

      return React.useMemo(
        () => ({
          resource: state.resources.get(subject)!,
          ready: state.values.get(subject)?.loading !== true,
          error: undefined,
          revision,
        }),
        [subject, revision],
      );
    },
  };
});
vi.mock('./syncableFlatNavigation', () => ({
  openFlatSyncableRow: (...args: unknown[]) => state.open(...args),
}));
vi.mock('../../hooks/useNavigateWithTransition', () => ({
  useNavigateWithTransition: () => state.navigate,
}));

const TABLE = 'atomic:items',
  ROW = 'atomic:item-7',
  DRIVE = 'atomic:drive',
  CLASS = 'atomic:item-class';
const p = {
  'syncable-collection-view': 'atomic:descriptor',
  'syncable-source-config': 'atomic:config',
  'syncable-source-key': 'atomic:key',
  'syncable-navigation-intents': 'atomic:intents',
  'syncable-entity-table': 'atomic:entity-table',
  'syncable-rule-memberships': 'atomic:memberships',
};
const resource = (subject: string): Resource =>
  ({
    subject,
    get: (property: string) => state.values.get(subject)?.[property],
    getSubjects: (property: string) =>
      state.values.get(subject)?.[property] ?? [],
    hasClasses: (...classes: string[]) =>
      classes.every(klass =>
        (
          (state.values.get(subject)?.[core.properties.isA] ?? []) as string[]
        ).includes(klass),
      ),
  }) as unknown as Resource;
const store = {
  getAgent: () => ({ subject: state.actor }),
  getServerUrl: () => state.server,
  getDrive: () => DRIVE,
  driveOfSubject: () => DRIVE,
  getResource: vi.fn(async (subject: string) => state.resources.get(subject)!),
} as unknown as Store;
let filters: ReturnType<typeof useSyncableFilters>;

function add(subject: string, values: Record<string, unknown>) {
  state.values.set(subject, values);
  state.resources.set(subject, resource(subject));
}

function setup() {
  const source = {
    version: 3 as const,
    kind: 'collection' as const,
    proxyOrigin: 'https://proxy.test',
    platform: 'example',
    principal: { kind: 'public' as const },
    resource: 'item',
  };
  const document = prepareDocument({
    openapi: '3.0.3',
    info: { title: 'Example', version: '1' },
    paths: {},
    components: {
      crudResources: {
        item: {
          identity: {
            urlTemplate: '/items/{id}',
            bindings: { id: { field: 'id' } },
          },
        },
      },
    },
  });
  const entity = resolveEntityIdentity(document, {
    resource: 'item',
    record: { id: 7 },
  });
  const read = {
    collection: 'items',
    resource: 'item',
    pathParams: {},
    path: '/items',
    method: 'GET' as const,
    query: {},
    body: {},
  };
  const config = {
    ...source,
    kind: 'record',
    entityIdentity: entity,
    record: { id: 7 },
    context: {},
    read,
  };
  const key = entitySourceKey(config);
  const via = { collection: 'children', kind: 'identity' as const };
  add(TABLE, {
    [core.properties.isA]: [dataBrowser.classes.table],
    [core.properties.classtype]: CLASS,
    ['https://atomicdata.dev/properties/drive']: DRIVE,
    [p['syncable-source-key']]: entityTableKey(source),
    [p['syncable-source-config']]: source,
    [p['syncable-collection-view']]: {
      version: 1,
      rowClass: CLASS,
      title: 'Items',
      columns: [{ property: core.properties.name, label: 'Name' }],
      relationships: [{ resource: 'child', title: 'Children', via }],
    },
  });
  add(ROW, {
    [core.properties.parent]: TABLE,
    [core.properties.isA]: [CLASS],
    [p['syncable-entity-table']]: TABLE,
    [p['syncable-source-config']]: config,
    [p['syncable-source-key']]: key,
    [p['syncable-rule-memberships']]: ['atomic:active-filter'],
    [p['syncable-navigation-intents']]: [
      {
        version: 1,
        sourceEntityKey: key,
        resource: 'child',
        label: 'Children',
        definition: {
          version: 1,
          resource: 'child',
          source: {
            kind: 'related',
            origin: { entity, record: { id: 7 }, context: {}, read },
            via,
          },
        },
      },
    ],
  });
  add('atomic:children', {
    [core.properties.isA]: [dataBrowser.classes.table],
    [dataBrowser.properties.tableViews]: [
      'atomic:child-filter',
      'atomic:table-view',
    ],
  });
  add('atomic:child-filter', {
    [core.properties.parent]: 'atomic:children',
    [core.properties.isA]: [dataBrowser.classes.view],
    [dataBrowser.properties.viewKind]: 'syncable-collection',
  });
  add('atomic:table-view', {
    [core.properties.parent]: 'atomic:children',
    [core.properties.isA]: [dataBrowser.classes.view],
    [dataBrowser.properties.viewKind]: 'table',
  });
  filters = {
    table: TABLE,
    properties: p,
    source,
    rules: [],
    selected: { resource: resource('atomic:active-filter'), config: {} },
    ready: true,
    flat: true,
  } as unknown as ReturnType<typeof useSyncableFilters>;
}

function Grid({ enabled = true }: { enabled?: boolean }) {
  const columns = useSyncableTableNavigation(
    state.resources.get(TABLE)!,
    filters,
    enabled,
  );

  return (
    <div data-testid='columns' data-count={columns.length}>
      {columns.map(column => {
        const Cell = column.virtual!.Cell;

        return (
          <Cell key={column.key} subject={ROW} rowIndex={0} columnIndex={0} />
        );
      })}
    </div>
  );
}

function show(enabled = true) {
  return render(
    <ThemeProvider theme={buildTheme(false, '#1b50d8')}>
      <Grid enabled={enabled} />
    </ThemeProvider>,
  );
}

function notify() {
  for (const listener of state.listeners) listener();
}

beforeEach(() => {
  vi.clearAllMocks();
  state.writable = true;
  state.actor = 'atomic:agent:person';
  state.server = 'https://node.example';
  state.values.clear();
  state.resources.clear();
  setup();
  state.open.mockResolvedValue({
    subject: 'atomic:children',
    view: 'atomic:table-view',
    syncFilter: 'atomic:child-filter',
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  state.listeners.clear();
});

it.each(['ordinary', 'disabled', 'unready', 'no relationships'] as const)(
  'adds no virtual action for %s tables',
  reason => {
    if (reason === 'ordinary') filters = { ...filters, flat: false };
    if (reason === 'unready') filters = { ...filters, ready: false };
    if (reason === 'no relationships')
      (
        state.values.get(TABLE)![p['syncable-collection-view']] as {
          relationships: unknown[];
        }
      ).relationships = [];
    show(reason !== 'disabled');
    expect(screen.getByTestId('columns').getAttribute('data-count')).toBe('0');
  },
);
it('opens a declared stored child scope in the ordinary Table renderer while retaining its selected filter', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch');
  show();
  expect(document.querySelector('iframe')).toBeNull();
  expect(fetch).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Open' }));
  await waitFor(() => expect(state.navigate).toHaveBeenCalledOnce());
  expect(state.open).toHaveBeenCalledWith(
    store,
    DRIVE,
    state.resources.get(TABLE),
    state.resources.get(ROW),
    'atomic:active-filter',
    undefined,
  );
  const url = new URL(
    state.navigate.mock.calls[0][0] as string,
    window.location.href,
  );
  expect(url.searchParams.get('subject')).toBe('atomic:children');
  expect(url.searchParams.get('view')).toBe('atomic:table-view');
  expect(url.searchParams.get('syncFilter')).toBe('atomic:child-filter');
  expect(store.getResource).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});
it('waits for a cold row and reacts to loaded stored navigation data', async () => {
  state.values.get(ROW)!.loading = true;
  show();
  expect(screen.queryByRole('button', { name: 'Open' })).toBeNull();
  await act(async () => {
    state.values.get(ROW)!.loading = false;
    notify();
  });
  expect(
    (screen.getByRole('button', { name: 'Open' }) as HTMLButtonElement)
      .disabled,
  ).toBe(false);
});
it('opens the stored row when the shared checker has no available action', async () => {
  state.open.mockResolvedValueOnce(undefined);
  show();
  fireEvent.click(screen.getByRole('button', { name: 'Open' }));
  await waitFor(() => expect(state.navigate).toHaveBeenCalledOnce());
  expect(
    new URL(
      state.navigate.mock.calls[0][0] as string,
      window.location.href,
    ).searchParams.get('subject'),
  ).toBe(ROW);
  expect(state.open).toHaveBeenCalledOnce();
});
it('delegates read-only source navigation to the shared checker so existing target filters remain usable', async () => {
  state.writable = false;
  show();
  fireEvent.click(screen.getByRole('button', { name: 'Open' }));
  await waitFor(() => expect(state.navigate).toHaveBeenCalledOnce());
  expect(state.open).toHaveBeenCalledOnce();
  expect(
    new URL(
      state.navigate.mock.calls[0][0] as string,
      window.location.href,
    ).searchParams.get('subject'),
  ).toBe('atomic:children');
});
it('reacts when actual row navigation evidence changes without replacing its Resource object', async () => {
  show();
  await act(async () => {
    (
      state.values.get(ROW)![p['syncable-navigation-intents']] as Record<
        string,
        unknown
      >[]
    )[0].sourceEntityKey = 'changed';
    notify();
  });
  state.open.mockResolvedValueOnce(undefined);
  fireEvent.click(screen.getByRole('button', { name: 'Open' }));
  await waitFor(() => expect(state.navigate).toHaveBeenCalledOnce());
  expect(state.open).toHaveBeenCalledOnce();
});
it('announces pending navigation and errors without creating an iframe', async () => {
  let reject!: (reason: Error) => void;
  state.open.mockImplementationOnce(
    () =>
      new Promise((_resolve, fail) => {
        reject = fail;
      }),
  );
  show();
  fireEvent.click(screen.getByRole('button', { name: 'Open' }));
  expect(
    (screen.getByRole('button', { name: 'Open' }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  await act(async () => {
    reject(new Error('Saved collection moved'));
  });
  expect(screen.getByRole('alert').textContent).toContain(
    'Saved collection moved',
  );
  expect(state.navigate).not.toHaveBeenCalled();
  expect(
    (screen.getByRole('button', { name: 'Open' }) as HTMLButtonElement)
      .disabled,
  ).toBe(false);
});

it('keeps pending cells mounted across an equivalent managed-table state refresh', async () => {
  let resolve!: (value: {
    subject: string;
    view?: string;
    syncFilter?: string;
  }) => void;
  state.open.mockImplementationOnce(
    () =>
      new Promise(done => {
        resolve = done;
      }),
  );
  const page = show();
  fireEvent.click(screen.getByRole('button', { name: 'Open' }));
  filters = {
    ...filters,
    source: { ...filters.source! },
    properties: { ...filters.properties },
  };
  page.rerender(
    <ThemeProvider theme={buildTheme(false, '#1b50d8')}>
      <Grid />
    </ThemeProvider>,
  );
  expect(
    (screen.getByRole('button', { name: 'Open' }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  await act(async () => {
    resolve({
      subject: 'atomic:children',
      view: 'atomic:table-view',
      syncFilter: 'atomic:child-filter',
    });
  });
  expect(state.navigate).toHaveBeenCalledOnce();
});

it('does not navigate after a pending Open cell unmounts', async () => {
  let resolve!: (value: {
    subject: string;
    view?: string;
    syncFilter?: string;
  }) => void;
  state.open.mockImplementationOnce(
    () =>
      new Promise(done => {
        resolve = done;
      }),
  );
  const page = show();
  fireEvent.click(screen.getByRole('button', { name: 'Open' }));
  page.unmount();
  await act(async () => {
    resolve({ subject: 'atomic:children', syncFilter: 'atomic:child-filter' });
  });
  expect(state.navigate).not.toHaveBeenCalled();
});

it('keeps a pending Open action across unrelated row updates', async () => {
  let resolve!: (value: { subject: string }) => void;
  state.open.mockImplementationOnce(
    () =>
      new Promise(done => {
        resolve = done;
      }),
  );
  show();
  fireEvent.click(screen.getByRole('button', { name: 'Open' }));
  await act(async () => {
    state.values.get(ROW)![core.properties.name] = 'Updated row title';
    notify();
  });
  expect(
    (screen.getByRole('button', { name: 'Open' }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  await act(async () => {
    resolve({ subject: 'atomic:children' });
  });
  expect(state.navigate).toHaveBeenCalledOnce();
});

it('suppresses pending navigation when the same row resource moves', async () => {
  let resolve!: (value: { subject: string }) => void;
  state.open.mockImplementationOnce(
    () =>
      new Promise(done => {
        resolve = done;
      }),
  );
  show();
  fireEvent.click(screen.getByRole('button', { name: 'Open' }));
  await act(async () => {
    state.values.get(ROW)![core.properties.parent] = 'atomic:moved-folder';
    notify();
  });
  await act(async () => {
    resolve({ subject: 'atomic:children' });
  });
  expect(state.navigate).not.toHaveBeenCalled();
  expect(
    (screen.getByRole('button', { name: 'Open' }) as HTMLButtonElement)
      .disabled,
  ).toBe(false);
});

it('rechecks the active account after asynchronous action resolution', async () => {
  let resolve!: (value: { subject: string }) => void;
  state.open.mockImplementationOnce(
    () =>
      new Promise(done => {
        resolve = done;
      }),
  );
  show();
  fireEvent.click(screen.getByRole('button', { name: 'Open' }));
  state.actor = 'atomic:agent:another';
  await act(async () => {
    resolve({ subject: 'atomic:children' });
  });
  expect(state.navigate).not.toHaveBeenCalled();
  expect(screen.getByRole('alert').textContent).toContain(
    'active account or server changed',
  );
});
