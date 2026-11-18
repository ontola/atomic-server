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
import { GitHubDirectoryView } from './GitHubDirectoryView';

const state = vi.hoisted(() => ({
  store: {} as object,
  navigate: vi.fn(),
  target: '',
  resources: new Map<string, unknown>(),
  terms: {
    classes: {
      'syncable-owner': 'owner-class',
      'syncable-repository': 'repo-class',
    },
    properties: {
      'syncable-source-config': 'config',
      'syncable-owner-kind': 'owner-kind',
      'syncable-repository-count': 'repo-count',
      'syncable-repository-private': 'private',
      'syncable-repository-has-issues': 'has-issues',
      'syncable-repository-open-issues': 'open-issues',
    },
  },
}));
vi.mock('@tomic/react', async original => ({
  ...(await original<typeof import('@tomic/react')>()),
  useStore: () => state.store,
  useResource: (subject: string) => state.resources.get(subject),
  findSchema: async () => state.terms,
}));
vi.mock('@components/AtomicLink', () => ({
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

vi.mock('./githubDirectory', async original => ({
  ...(await original<typeof import('./githubDirectory')>()),
  openGithubDirectoryRow: async () => ({ subject: state.target }),
}));

function row(
  subject: string,
  parent: string,
  klass: string,
  metadata: Record<string, unknown>,
) {
  const props: Record<string, unknown> = {
    [core.properties.parent]: parent,
    [core.properties.isA]: [klass],
    ...metadata,
  };

  return {
    subject,
    title: subject,
    get: (p: string) => props[p],
    getSubjects: (p: string) => (Array.isArray(props[p]) ? props[p] : []),
  };
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

function view(
  data: Collection,
  kind: 'github-organizations' | 'github-repositories' = 'github-organizations',
) {
  return (
    <ThemeProvider theme={buildTheme(false, '#1b50d8')}>
      <GitHubDirectoryView
        table='table'
        drive='drive'
        kind={kind}
        collection={data}
        ready
      />
    </ThemeProvider>
  );
}

beforeEach(() => {
  state.store = {
    getResource: async (subject: string) => state.resources.get(subject),
  };
  state.navigate.mockReset();
  state.target = '';
  state.resources.clear();
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

describe('native stored GitHub views', () => {
  it('shows stored owner counts with no iframe or refresh on opening and return', async () => {
    state.resources.set(
      'ontola',
      row('ontola', 'table', 'owner-class', {
        'owner-kind': 'organization',
        'repo-count': 17,
      }),
    );
    const data = collection(['ontola']);
    const mounted = render(view(data));
    await screen.findByRole('link', { name: 'ontola' });
    expect(screen.getByText('17')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Refresh/ })).toBeNull();
    expect(mounted.container.querySelector('iframe')).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
    mounted.unmount();
    vi.mocked(data.getAllMembers).mockImplementation(
      () => new Promise(() => undefined),
    );
    const returned = render(view(data));
    expect(screen.getByRole('link', { name: 'ontola' })).toBeTruthy();
    expect(screen.queryByRole('status')).toBeNull();
    expect(returned.container.querySelector('iframe')).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('preserves the supplied collection order and keeps filtered snapshots separate', async () => {
    for (const name of ['alpha', 'beta']) {
      state.resources.set(name, row(name, 'table', 'owner-class', {}));
    }

    const descending = collection(['beta', 'alpha']);
    Object.assign(descending, { sortBy: core.properties.name, sortDesc: true });
    const mounted = render(view(descending));
    await screen.findByRole('link', { name: 'beta' });
    expect(screen.getAllByRole('link').map(link => link.textContent)).toEqual([
      'beta',
      'alpha',
    ]);
    const filtered = collection(['alpha']);
    Object.assign(filtered, {
      filters: [{ property: core.properties.name, value: 'alpha' }],
    });
    mounted.rerender(view(filtered));
    await waitFor(() =>
      expect(screen.queryByRole('link', { name: 'beta' })).toBeNull(),
    );
    expect(screen.getAllByRole('link').map(link => link.textContent)).toEqual([
      'alpha',
    ]);
    vi.mocked(descending.getAllMembers).mockImplementation(
      () => new Promise(() => undefined),
    );
    mounted.rerender(view(descending));
    expect(screen.getAllByRole('link').map(link => link.textContent)).toEqual([
      'beta',
      'alpha',
    ]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('renders saved repository flags and counts and keeps missing values unknown', async () => {
    state.resources.set(
      'private-repo',
      row('private-repo', 'table', 'repo-class', {
        config: { ownerLogin: 'ontola' },
        private: true,
        'has-issues': true,
        'open-issues': 0,
      }),
    );
    state.resources.set(
      'unknown-repo',
      row('unknown-repo', 'table', 'repo-class', {}),
    );
    render(
      view(collection(['private-repo', 'unknown-repo']), 'github-repositories'),
    );
    await screen.findByRole('link', { name: 'private-repo' });
    expect(screen.getByText('Private')).toBeTruthy();
    expect(screen.getByText('0')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Sync issues' })).toBeTruthy();
    expect(screen.getAllByText('Unknown')).toHaveLength(2);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('opens an owner in its installed native repository view on the local server', async () => {
    state.resources.set('ontola', row('ontola', 'table', 'owner-class', {}));
    state.target = location.origin + '/repositories';
    state.resources.set(
      state.target,
      row(state.target, 'ontola', 'table-class', {
        [dataBrowser.properties.tableViews]: ['native-repositories'],
      }),
    );
    state.resources.set(
      'native-repositories',
      row('native-repositories', state.target, 'view-class', {
        [dataBrowser.properties.viewKind]: 'github-repositories',
      }),
    );
    render(view(collection(['ontola'])));
    fireEvent.click(await screen.findByRole('button', { name: 'Open' }));
    await waitFor(() =>
      expect(state.navigate).toHaveBeenCalledWith(
        '/repositories?view=native-repositories',
      ),
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it('selects a stored repository in Sync before any provider import', async () => {
    state.resources.set(
      'repo',
      row('repo', 'table', 'repo-class', { 'has-issues': true }),
    );
    state.target = 'repo';
    state.resources.set(
      'table',
      row('table', 'owner', 'table-class', {
        [dataBrowser.properties.tableViews]: ['sync-view'],
      }),
    );
    state.resources.set(
      'sync-view',
      row('sync-view', 'table', 'view-class', {
        [dataBrowser.properties.viewKind]: 'syncables',
      }),
    );
    render(view(collection(['repo']), 'github-repositories'));
    fireEvent.click(await screen.findByRole('button', { name: 'Sync issues' }));
    await waitFor(() => expect(state.navigate).toHaveBeenCalled());
    const target = new URL(state.navigate.mock.calls[0][0], location.origin);
    expect(target.searchParams.get('subject')).toBe('table');
    expect(target.searchParams.get('view')).toBe('sync-view');
    expect(target.searchParams.get('syncRow')).toBe('repo');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('excludes rows with a different parent or row class', async () => {
    state.resources.set('moved', row('moved', 'elsewhere', 'owner-class', {}));
    state.resources.set(
      'other-class',
      row('other-class', 'table', 'repo-class', {}),
    );
    const data = collection(['moved', 'other-class']);
    render(view(data));
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
    expect(screen.queryByRole('link')).toBeNull();
  });
});
