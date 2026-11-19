import type { IndexedTableRows, TableQuery } from '@tomic/table';
import { useEffect, useState } from 'react';
import {
  core,
  dataBrowser,
  findSchema,
  subjectsReferToSameResource,
  useResource,
  useStore,
  type Store,
} from '@tomic/react';
import { styled } from 'styled-components';
import { AtomicLink } from '@tomic/resource-ui/components/AtomicLink';
import { Button } from '@tomic/ui/components/Button';
import { TableList } from '@components/TableList';
import { useNavigateWithTransition } from '@hooks/useNavigateWithTransition';
import { constructOpenURL } from '@helpers/navigation';
import { normalizeViewKind } from '@tomic/table-page/TablePage/tableViewKinds';
import { syncableHierarchySchema } from './syncableHierarchy';
import {
  isSyncableCollectionRow,
  openSyncableCollectionRow,
  parseSyncableCollectionView,
  resolveSyncableCollectionView,
  syncableCollectionValue,
  type SyncableCollectionDescriptor,
} from './syncableCollection';

type Snapshot = {
  key: string;
  subjects: string[];
  descriptor: SyncableCollectionDescriptor;
  descriptorProperty: string;
};
const snapshots = new WeakMap<Store, Map<string, Snapshot>>();
const driveProperty = 'https://atomicdata.dev/properties/drive';

/** Ordinary stored Atomic data; this renderer has no provider transport. */
export function SyncableCollectionView({
  table,
  drive,
  collection,
  query,
  ready,
}: {
  table: string;
  drive: string;
  collection: IndexedTableRows;
  query?: TableQuery;
  ready: boolean;
}) {
  const store = useStore();
  const resource = useResource(table);
  const key = JSON.stringify([
    drive,
    table,
    resource.get(core.properties.parent),
    resource.get(core.properties.classtype),
    query ?? ('filters' in collection ? collection.filters : undefined),
    'expressionFilters' in collection
      ? collection.expressionFilters
      : undefined,
    'sortBy' in collection ? collection.sortBy : undefined,
    'sortDesc' in collection ? collection.sortDesc : undefined,
  ]);
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [error, setError] = useState<string>();
  const cached =
    snapshot?.key === key ? snapshot : snapshots.get(store)?.get(key);
  const descriptor = cached
    ? parseSyncableCollectionView(
        resource.get(cached.descriptorProperty),
        resource.get(core.properties.classtype),
      )
    : undefined;
  const stampedDrive = resource.get(driveProperty);
  const current =
    !resource.error &&
    resource
      .getSubjects(core.properties.isA)
      .includes(dataBrowser.classes.table) &&
    descriptor &&
    (stampedDrive === undefined ||
      (typeof stampedDrive === 'string' &&
        subjectsReferToSameResource(stampedDrive, drive)))
      ? cached
      : undefined;
  const count = collection.totalMembers;

  useEffect(() => {
    if (!ready) return;
    let active = true;
    void Promise.all([
      collection.getAllMembers(),
      resolveSyncableCollectionView(store, drive, table),
      findSchema(store, drive, syncableHierarchySchema()),
    ])
      .then(([subjects, description, terms]) => {
        if (!active) return;
        const descriptorProperty =
          terms.properties?.['syncable-collection-view'];
        if (!descriptorProperty) return;
        const next = {
          key,
          subjects,
          descriptor: description,
          descriptorProperty,
        };
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
        if (active) {
          snapshots.get(store)?.delete(key);
          setSnapshot(undefined);
          setError(String(reason?.message ?? reason));
        }
      });

    return () => {
      active = false;
    };
  }, [store, drive, table, collection, key, ready, count]);

  return (
    <Directory aria-label={descriptor?.title ?? 'Syncable Collection'}>
      {error && <p role='alert'>{error}</p>}
      {!current || !descriptor ? (
        !error && <p role='status'>Loading stored rows…</p>
      ) : (
        <TableList>
          <thead>
            <tr>
              {descriptor.columns.map(column => (
                <th key={column.property}>{column.label}</th>
              ))}
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {current.subjects.map(subject => (
              <CollectionRow
                key={subject}
                subject={subject}
                table={table}
                drive={drive}
                descriptor={descriptor}
              />
            ))}
          </tbody>
        </TableList>
      )}
      {current?.subjects.length === 0 && <p>No stored rows yet.</p>}
    </Directory>
  );
}

async function destination(
  store: Store,
  drive: string,
  table: string,
  subject: string,
) {
  const target = await openSyncableCollectionRow(store, drive, table, subject);
  const resource = await store.getResource(target.subject);
  const views = resource.getSubjects(dataBrowser.properties.tableViews);
  let fallback: string | undefined;
  let preferred: string | undefined;

  for (const viewSubject of views) {
    const view = await store.getResource(viewSubject);
    if (
      view.error ||
      typeof view.get(core.properties.parent) !== 'string' ||
      !subjectsReferToSameResource(
        view.get(core.properties.parent) as string,
        target.subject,
      ) ||
      !view.getSubjects(core.properties.isA).includes(dataBrowser.classes.view)
    )
      continue;
    const storedKind = view.get(dataBrowser.properties.viewKind);
    if (
      typeof storedKind === 'string' &&
      normalizeViewKind(storedKind) === 'syncable-collection'
    )
      preferred = viewSubject;
    if (storedKind === 'table') fallback = viewSubject;
  }

  const url = new URL(constructOpenURL(target.subject), window.location.href);
  const view = preferred ?? fallback;
  if (view) url.searchParams.set('view', view);

  return url.pathname + url.search + url.hash;
}

function CollectionRow({
  subject,
  table,
  drive,
  descriptor,
}: {
  subject: string;
  table: string;
  drive: string;
  descriptor: SyncableCollectionDescriptor;
}) {
  const store = useStore();
  const resource = useResource(subject);
  const navigate = useNavigateWithTransition();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const stampedDrive = resource.get(driveProperty);
  if (
    !isSyncableCollectionRow(resource, table, descriptor) ||
    (stampedDrive !== undefined &&
      (typeof stampedDrive !== 'string' ||
        !subjectsReferToSameResource(stampedDrive, drive)))
  )
    return null;

  const open = () => {
    setBusy(true);
    setError(undefined);
    void destination(store, drive, table, subject)
      .then(path => navigate(path))
      .catch(reason => setError(String(reason?.message ?? reason)))
      .finally(() => setBusy(false));
  };

  return (
    <tr>
      {descriptor.columns.map((column, index) => (
        <td key={column.property}>
          {index === 0 ? (
            <AtomicLink subject={subject}>
              {syncableCollectionValue(resource.get(column.property), column)}
            </AtomicLink>
          ) : (
            syncableCollectionValue(resource.get(column.property), column)
          )}
        </td>
      ))}
      <td>
        <Button subtle onClick={open} disabled={busy}>
          Open
        </Button>
        {error && <span role='alert'>{error}</span>}
      </td>
    </tr>
  );
}

const Directory = styled.div`
  min-width: 0;
  max-width: 100%;
  overflow-x: auto;
  th {
    text-align: start;
    padding: ${p => p.theme.size(2)};
  }
  td {
    vertical-align: middle;
  }
  th:last-child,
  td:last-child {
    position: sticky;
    right: 0;
    z-index: 1;
    width: 1%;
    white-space: nowrap;
    background-color: ${p => p.theme.colors.bg};
  }
  th:last-child {
    z-index: 2;
  }
  td:last-child button {
    height: 2rem;
    min-height: 2rem;
    padding: 0.25rem 0.6rem;
    white-space: nowrap;
    overflow-wrap: normal;
  }
`;
