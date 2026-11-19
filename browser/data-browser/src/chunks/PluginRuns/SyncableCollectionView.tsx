import { useEffect, useMemo, useState } from 'react';
import {
  core,
  dataBrowser,
  findSchema,
  subjectsReferToSameResource,
  useResource,
  useResourceSnapshot,
  useValue,
  useStore,
  type Collection,
  type Resource,
  type Store,
} from '@tomic/react';
import { styled } from 'styled-components';
import { AtomicLink } from '@components/AtomicLink';
import { Button } from '@components/Button';
import { TableList } from '@components/TableList';
import { useNavigateWithTransition } from '@hooks/useNavigateWithTransition';
import { constructOpenURL } from '@helpers/navigation';
import { normalizeViewKind } from '@chunks/TablePage/tableViewKinds';
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
  ready,
  activeRule,
  logicalOwnerProperty,
}: {
  table: string;
  drive: string;
  collection: Collection;
  ready: boolean;
  activeRule?: string;
  logicalOwnerProperty?: string;
}) {
  const store = useStore();
  const resource = useResource(table);
  const key = JSON.stringify([
    drive,
    table,
    resource.get(core.properties.parent),
    resource.get(core.properties.classtype),
    collection.filters,
    collection.expressionFilters,
    collection.sortBy,
    collection.sortDesc,
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
                activeRule={activeRule}
                logicalOwnerProperty={logicalOwnerProperty}
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
  activeRule?: string,
) {
  const target = await openSyncableCollectionRow(
    store,
    drive,
    table,
    subject,
    activeRule,
  );
  if ('view' in target && target.view && target.syncFilter)
    return constructOpenURL(target.subject, {
      view: target.view,
      syncFilter: target.syncFilter,
    });
  const resource = await store.getResource(target.subject);
  const views = resource.getSubjects(dataBrowser.properties.tableViews);
  const defaultView = resource.get(dataBrowser.properties.tableDefaultView);
  const terms = await findSchema(store, drive, syncableHierarchySchema());
  const configProperty = terms.properties?.['syncable-source-config'];
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
    const config = configProperty ? view.get(configProperty) : undefined;
    if (
      config &&
      typeof config === 'object' &&
      (config as { kind?: string }).kind === 'rule'
    )
      continue;
    const storedKind = view.get(dataBrowser.properties.viewKind);
    if (
      typeof storedKind === 'string' &&
      normalizeViewKind(storedKind) === 'syncable-collection'
    )
      if (!preferred || viewSubject === defaultView) preferred = viewSubject;
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
  activeRule,
  logicalOwnerProperty,
}: {
  subject: string;
  table: string;
  drive: string;
  descriptor: SyncableCollectionDescriptor;
  activeRule?: string;
  logicalOwnerProperty?: string;
}) {
  const store = useStore();
  const snapshot = useResourceSnapshot(subject);
  const resource = snapshot.resource;
  const navigate = useNavigateWithTransition();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const current = useMemo(() => {
    if (!snapshot.ready || snapshot.error) return false;
    const row = snapshot.resource;
    const stampedDrive = row.get(driveProperty);
    const logicalOwner = logicalOwnerProperty
      ? row.get(logicalOwnerProperty)
      : undefined;

    return (
      (isSyncableCollectionRow(row, table, descriptor) ||
        (typeof logicalOwner === 'string' &&
          subjectsReferToSameResource(logicalOwner, table) &&
          row.hasClasses(descriptor.rowClass))) &&
      (stampedDrive === undefined ||
        (typeof stampedDrive === 'string' &&
          subjectsReferToSameResource(stampedDrive, drive)))
    );
  }, [snapshot, table, drive, descriptor, logicalOwnerProperty]);
  if (!current) return null;

  const open = () => {
    setBusy(true);
    setError(undefined);
    void destination(store, drive, table, subject, activeRule)
      .then(path => navigate(path))
      .catch(reason => setError(String(reason?.message ?? reason)))
      .finally(() => setBusy(false));
  };

  return (
    <tr>
      {descriptor.columns.map((column, index) => (
        <CollectionCell
          key={column.property}
          resource={resource}
          column={column}
          first={index === 0}
        />
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

/** Property subscriptions keep visible cached rows current while the worker runs. */
function CollectionCell({
  resource,
  column,
  first,
}: {
  resource: Resource;
  column: SyncableCollectionDescriptor['columns'][number];
  first: boolean;
}) {
  const [value] = useValue(resource, column.property);
  const text = syncableCollectionValue(value, column);

  return (
    <td>
      {first ? (
        <AtomicLink subject={resource.subject}>{text}</AtomicLink>
      ) : (
        text
      )}
    </td>
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
