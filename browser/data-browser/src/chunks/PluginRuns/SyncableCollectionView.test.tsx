// @vitest-environment jsdom
// @wc-ignore-file
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { ThemeProvider } from 'styled-components';
import { core, dataBrowser, type Collection } from '@tomic/react';
import { buildTheme } from '../../styling';
import { SyncableCollectionView } from './SyncableCollectionView';

const state = vi.hoisted(() => ({
  store: {} as object,
  navigate: vi.fn(),
  resources: new Map<string, ReturnType<typeof resource>>(),
  terms: {
    properties: {
      'syncable-collection-view': 'https://drive.example/view-descriptor',
    },
  },
}));
vi.mock('@tomic/react', async original => ({
  ...(await original<typeof import('@tomic/react')>()),
  useStore: () => state.store,
  useResource: (subject: string) => state.resources.get(subject),
  findSchema: async () => state.terms,
}));
vi.mock('@tomic/lib', async original => ({
  ...(await original<typeof import('@tomic/lib')>()),
  findSchema: async () => state.terms,
}));
vi.mock('@tomic/resource-ui/components/AtomicLink', () => ({
  AtomicLink: ({
    subject,
    children,
  }: {
    subject: string;
    children: React.ReactNode;
  }) => <a href={subject}>{children}</a>,
}));
vi.mock('@hooks/useNavigateWithTransition', () => ({
  useNavigateWithTransition: () => state.navigate,
}));

const rowClass = 'https://boards.example/types/workspace';
const nameProperty = 'https://boards.example/properties/heading';
const stateProperty = 'https://boards.example/properties/visibility';
const countProperty = 'https://boards.example/properties/boards';
const targetProperty = 'https://boards.example/properties/open-boards';
const descriptorProperty = 'https://drive.example/view-descriptor';
const table = location.origin + '/workspaces';
const child = location.origin + '/boards';
const descriptor = {
  version: 1,
  rowClass,
  title: 'Saved workspaces',
  columns: [
    { property: nameProperty, label: 'Workspace' },
    {
      property: stateProperty,
      label: 'Visibility',
      format: 'enum',
      labels: { shared: 'Shared workspace' },
    },
    { property: countProperty, label: 'Boards', format: 'count' },
  ],
  openTargetProperty: targetProperty,
};

function resource(subject: string, props: Record<string, unknown>) {
  return {
    subject,
    error: undefined,
    props,
    get: (p: string) => props[p],
    getSubjects: (p: string) => (Array.isArray(props[p]) ? props[p] : []),
  };
}

function row(subject: string, metadata: Record<string, unknown> = {}) {
  return resource(subject, {
    [core.properties.parent]: table,
    [core.properties.isA]: [rowClass],
    [nameProperty]: subject,
    ...metadata,
  });
}

function collection(subjects: string[]) {
  return {
    totalMembers: subjects.length,
    filters: [],
    expressionFilters: [],
    sortDesc: false,
    getAllMembers: vi.fn(async () => subjects),
  } as unknown as Collection;
}

function view(data: Collection) {
  return (
    <ThemeProvider theme={buildTheme(false, '#1b50d8')}>
      <SyncableCollectionView
        table={table}
        drive='drive'
        collection={data}
        ready
      />
    </ThemeProvider>
  );
}

beforeEach(() => {
  state.store = {
    getResource: async (subject: string) => state.resources.get(subject),
    isForeignOriginSubject: (subject: string) =>
      subject.startsWith('http') && new URL(subject).origin !== location.origin,
  };
  state.navigate.mockReset();
  state.resources.clear();
  state.resources.set(
    table,
    resource(table, {
      [core.properties.parent]: 'drive',
      [core.properties.isA]: [dataBrowser.classes.table],
      [core.properties.classtype]: rowClass,
      [descriptorProperty]: structuredClone(descriptor),
    }),
  );
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('Browsing must not contact a provider');
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('native stored collections', () => {
  it('renders a second provider using saved descriptor labels and values, with no iframe or refresh on return', async () => {
    state.resources.set(
      'research',
      row('research', { [stateProperty]: 'shared', [countProperty]: 17 }),
    );
    const data = collection(['research']);
    const mounted = render(view(data));
    await screen.findByRole('link', { name: 'research' });
    expect(screen.getByLabelText('Saved workspaces')).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: 'Boards' })).toBeTruthy();
    expect(screen.getByText('Shared workspace')).toBeTruthy();
    expect(screen.getByText('17')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Sync|Refresh/ })).toBeNull();
    expect(mounted.container.querySelector('iframe')).toBeNull();
    mounted.unmount();
    vi.mocked(data.getAllMembers).mockImplementation(
      () => new Promise(() => undefined),
    );
    const returned = render(view(data));
    expect(screen.getByRole('link', { name: 'research' })).toBeTruthy();
    expect(screen.queryByRole('status')).toBeNull();
    expect(returned.container.querySelector('iframe')).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('preserves collection order and separates filtered snapshots', async () => {
    for (const subject of ['alpha', 'beta'])
      state.resources.set(subject, row(subject));
    const descending = collection(['beta', 'alpha']);
    Object.assign(descending, { sortBy: nameProperty, sortDesc: true });
    const mounted = render(view(descending));
    await screen.findByRole('link', { name: 'beta' });
    expect(screen.getAllByRole('link').map(link => link.textContent)).toEqual([
      'beta',
      'alpha',
    ]);
    const filtered = collection(['alpha']);
    Object.assign(filtered, {
      filters: [{ property: nameProperty, value: 'alpha' }],
    });
    mounted.rerender(view(filtered));
    await waitFor(() =>
      expect(screen.queryByRole('link', { name: 'beta' })).toBeNull(),
    );
    vi.mocked(descending.getAllMembers).mockImplementation(
      () => new Promise(() => undefined),
    );
    mounted.rerender(view(descending));
    expect(screen.getAllByRole('link').map(link => link.textContent)).toEqual([
      'beta',
      'alpha',
    ]);
  });

  it('opens a saved child in its installed generic view on the local server', async () => {
    state.resources.set(
      'research',
      row('research', { [targetProperty]: child }),
    );
    state.resources.set(
      child,
      resource(child, {
        [core.properties.parent]: 'research',
        [core.properties.isA]: [dataBrowser.classes.table],
        [dataBrowser.properties.tableViews]: ['native-view'],
      }),
    );
    state.resources.set(
      'native-view',
      resource('native-view', {
        [core.properties.parent]: child,
        [core.properties.isA]: [dataBrowser.classes.view],
        [dataBrowser.properties.viewKind]: 'syncable-collection',
      }),
    );
    render(view(collection(['research'])));
    fireEvent.click(await screen.findByRole('button', { name: 'Open' }));
    await waitFor(() =>
      expect(state.navigate).toHaveBeenCalledWith('/boards?view=native-view'),
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it('excludes rows with another parent, class, or assigned drive', async () => {
    state.resources.set(
      'moved',
      row('moved', { [core.properties.parent]: 'elsewhere' }),
    );
    state.resources.set(
      'other-class',
      row('other-class', {
        [core.properties.isA]: ['https://boards.example/types/project'],
      }),
    );
    state.resources.set(
      'foreign',
      row('foreign', {
        'https://atomicdata.dev/properties/drive': 'another-drive',
      }),
    );
    render(view(collection(['moved', 'other-class', 'foreign'])));
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('never selects an app iframe or unknown view as the raw Table fallback', async () => {
    state.resources.set(
      'research',
      row('research', { [targetProperty]: child }),
    );
    state.resources.set(
      child,
      resource(child, {
        [core.properties.parent]: 'research',
        [core.properties.isA]: [dataBrowser.classes.table],
        [dataBrowser.properties.tableViews]: [
          'table-view',
          'app-view',
          'unknown-view',
        ],
      }),
    );
    for (const [subject, kind] of [
      ['table-view', 'table'],
      ['app-view', 'atomic:some-app'],
      ['unknown-view', 'unknown'],
    ])
      state.resources.set(
        subject,
        resource(subject, {
          [core.properties.parent]: child,
          [core.properties.isA]: [dataBrowser.classes.view],
          [dataBrowser.properties.viewKind]: kind,
        }),
      );
    render(view(collection(['research'])));
    fireEvent.click(await screen.findByRole('button', { name: 'Open' }));
    await waitFor(() =>
      expect(state.navigate).toHaveBeenCalledWith('/boards?view=table-view'),
    );
  });

  it('does not let a cached row authorize navigation after its authority changes', async () => {
    state.resources.set('research', row('research'));
    const data = collection(['research']);
    const mounted = render(view(data));
    await screen.findByRole('button', { name: 'Open' });
    mounted.unmount();
    vi.mocked(data.getAllMembers).mockImplementation(
      () => new Promise(() => undefined),
    );
    render(view(data));
    state.resources.get('research')!.props[core.properties.parent] =
      'elsewhere';
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Open' })).toBeNull(),
    );
    expect(state.navigate).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('invalidates a cached descriptor when the table row class changes', async () => {
    state.resources.set('research', row('research'));
    const data = collection(['research']);
    const mounted = render(view(data));
    await screen.findByRole('link', { name: 'research' });
    mounted.unmount();
    state.resources.get(table)!.props[core.properties.classtype] =
      'https://boards.example/types/project';
    render(view(data));
    expect(screen.queryByRole('link')).toBeNull();
    expect(await screen.findByRole('alert')).toBeTruthy();
  });
});
