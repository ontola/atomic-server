import { useEffect, useState } from 'react';
import {
  core,
  dataBrowser,
  findSchema,
  useResource,
  useStore,
  type Collection,
  type Store,
} from '@tomic/react';
import { styled } from 'styled-components';
import { AtomicLink } from '@components/AtomicLink';
import { Button } from '@components/Button';
import { TableList } from '@components/TableList';
import { useNavigateWithTransition } from '@hooks/useNavigateWithTransition';
import { constructOpenURL } from '@helpers/navigation';
import { syncableHierarchySchema } from './syncableHierarchy';
import {
  githubDirectoryValues,
  openGithubDirectoryRow,
} from './githubDirectory';

type Terms = Awaited<ReturnType<typeof findSchema>>;
type Snapshot = { key: string; subjects: string[]; terms: Terms };
const snapshots = new WeakMap<Store, Map<string, Snapshot>>();

/** Ordinary Atomic rows: opening this view never talks to GitHub. */
export function GitHubDirectoryView({
  table,
  drive,
  kind,
  collection,
  ready,
}: {
  table: string;
  drive: string;
  kind: 'github-organizations' | 'github-repositories';
  collection: Collection;
  ready: boolean;
}) {
  const store = useStore();
  const key = JSON.stringify([
    drive,
    table,
    collection.filters,
    collection.expressionFilters,
    collection.sortBy,
    collection.sortDesc,
  ]);
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [error, setError] = useState<string>();
  const current =
    snapshot?.key === key ? snapshot : snapshots.get(store)?.get(key);
  const count = collection.totalMembers;

  useEffect(() => {
    if (!ready) return;
    let active = true;
    void Promise.all([
      collection.getAllMembers(),
      findSchema(store, drive, syncableHierarchySchema()),
    ])
      .then(([subjects, terms]) => {
        if (!active) return;
        const next = { key, subjects, terms };
        let cache = snapshots.get(store);

        if (!cache) {
          cache = new Map();
          snapshots.set(store, cache);
        }

        cache.set(key, next);
        setSnapshot(next);
        setError(undefined);
      })
      .catch(reason => {
        if (active) setError(String(reason?.message ?? reason));
      });

    return () => {
      active = false;
    };
  }, [store, drive, collection, key, ready, count]);

  const owners = kind === 'github-organizations';

  return (
    <Directory
      aria-label={owners ? 'GitHub Organizations' : 'GitHub Repositories'}
    >
      {error && <p role='alert'>{error}</p>}
      {!current ? (
        <p role='status'>Loading stored rows…</p>
      ) : (
        <TableList>
          <thead>
            <tr>
              <th>{owners ? 'Owner namespace' : 'Repository'}</th>
              {!owners && <th>Owner</th>}
              <th>Kind</th>
              <th>{owners ? 'Repositories' : 'Open issues + PRs'}</th>
              {!owners && <th>Issues</th>}
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {current.subjects.map(subject => (
              <DirectoryRow
                key={subject}
                subject={subject}
                table={table}
                drive={drive}
                owners={owners}
                terms={current.terms}
              />
            ))}
          </tbody>
        </TableList>
      )}
      {current?.subjects.length === 0 && (
        <p>No stored rows yet. Use Sync to refresh GitHub.</p>
      )}
    </Directory>
  );
}

async function viewOf(store: Store, table: string, kind: string) {
  const resource = await store.getResource(table);
  const views = resource.getSubjects(dataBrowser.properties.tableViews);

  for (const subject of views) {
    const view = await store.getResource(subject);
    if (view.get(dataBrowser.properties.viewKind) === kind) return subject;
  }

  return undefined;
}

// constructOpenURL keeps local resource paths; apply view options to those too.
function openURL(subject: string, options: Record<string, string> = {}) {
  const url = new URL(constructOpenURL(subject), window.location.href);
  for (const [key, value] of Object.entries(options))
    url.searchParams.set(key, value);

  return url.pathname + url.search + url.hash;
}

async function destination(
  store: Store,
  drive: string,
  table: string,
  subject: string,
  owners: boolean,
  sync: boolean,
) {
  const target = await openGithubDirectoryRow(store, drive, table, subject);

  if (sync && target.subject === subject) {
    const view = await viewOf(store, table, 'syncables');

    return openURL(table, {
      ...(view ? { view } : {}),
      syncRow: subject,
    });
  }

  const view = await viewOf(
    store,
    target.subject,
    sync ? 'syncables' : owners ? 'github-repositories' : 'table',
  );
  const fallback = view ?? (await viewOf(store, target.subject, 'table'));

  return openURL(target.subject, fallback ? { view: fallback } : {});
}

function DirectoryRow({
  subject,
  table,
  drive,
  owners,
  terms,
}: {
  subject: string;
  table: string;
  drive: string;
  owners: boolean;
  terms: Terms;
}) {
  const store = useStore();
  const resource = useResource(subject);
  const navigate = useNavigateWithTransition();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const rowClass =
    terms.classes?.[owners ? 'syncable-owner' : 'syncable-repository'];
  const values = githubDirectoryValues(resource, terms.properties);
  const parent = resource.get(core.properties.parent);
  const classes = resource.getSubjects(core.properties.isA);
  if (
    resource.error ||
    parent !== table ||
    !rowClass ||
    !classes.includes(rowClass)
  )
    return null;

  const open = (sync = false) => {
    setBusy(true);
    setError(undefined);
    void destination(store, drive, table, subject, owners, sync)
      .then(path => navigate(path))
      .catch(reason => setError(String(reason?.message ?? reason)))
      .finally(() => setBusy(false));
  };

  return (
    <tr>
      <td>
        <AtomicLink subject={subject}>{resource.title}</AtomicLink>
      </td>
      {!owners && <td>{values.ownerLogin ?? '—'}</td>}
      <td>
        {owners
          ? values.ownerKind === 'organization'
            ? 'Organization'
            : values.ownerKind === 'personal'
              ? 'Personal owner'
              : 'Unknown'
          : values.private === true
            ? 'Private'
            : values.private === false
              ? 'Public'
              : 'Unknown'}
      </td>
      <td>{(owners ? values.repositories : values.openIssues) ?? '—'}</td>
      {!owners && (
        <td>
          {values.hasIssues === true
            ? 'Available'
            : values.hasIssues === false
              ? 'Disabled in GitHub'
              : 'Unknown'}
        </td>
      )}
      <td>
        <Button subtle onClick={() => void open()} disabled={busy}>
          Open
        </Button>
        {!owners && values.hasIssues === true && (
          <Button subtle onClick={() => void open(true)} disabled={busy}>
            Sync issues
          </Button>
        )}
        {error && <span role='alert'>{error}</span>}
      </td>
    </tr>
  );
}

const Directory = styled.div`
  overflow-x: auto;
  th {
    text-align: start;
    padding: ${p => p.theme.size(2)};
  }
  td {
    vertical-align: middle;
  }
`;
