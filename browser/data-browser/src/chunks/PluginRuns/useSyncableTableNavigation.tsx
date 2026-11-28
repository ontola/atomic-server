import { useEffect, useMemo, useRef, useState, type JSX } from 'react';
import {
  core,
  unknownSubject,
  useResourceSnapshot,
  useStore,
  useValue,
  type Resource,
  type Store,
} from '@tomic/react';
import { styled } from 'styled-components';
import { Button } from '@components/Button';
import { constructOpenURL } from '@helpers/navigation';
import { useNavigateWithTransition } from '../../hooks/useNavigateWithTransition';
import type { TableColumn } from '@tomic/table-page/TablePage/useTableColumns';
import { getTableDrive } from '@tomic/table-page/TablePage/tableDrive';
import { openFlatSyncableRow } from './syncableFlatNavigation';
import { parseSyncableCollectionView } from './syncableCollection';
import type { useSyncableFilters } from './useSyncableFilters';

/** Native data navigation only; this virtual column neither runs nor refreshes an app. */
export function useSyncableTableNavigation(
  table: Resource,
  state: ReturnType<typeof useSyncableFilters>,
  enabled = true,
): TableColumn[] {
  const store = useStore();
  const tableSnapshot = useResourceSnapshot(table.subject);
  const [rawDescriptor] = useValue(
    table,
    state.properties?.['syncable-collection-view'] ?? unknownSubject,
  );
  const [rowClass] = useValue(table, core.properties.classtype);
  const drive = getTableDrive(store, table) ?? store.getDrive();
  const signature = useMemo(
    () =>
      JSON.stringify({
        rawDescriptor:
          tableSnapshot.ready && !tableSnapshot.error
            ? rawDescriptor
            : undefined,
        rowClass,
        source: state.source,
        properties: state.properties,
        activeRule: state.selected?.resource.subject,
      }),
    [
      tableSnapshot,
      rawDescriptor,
      rowClass,
      state.source,
      state.properties,
      state.selected?.resource.subject,
    ],
  );
  const ready =
    enabled &&
    !!drive &&
    tableSnapshot.ready &&
    !tableSnapshot.error &&
    state.ready &&
    !state.error &&
    state.flat &&
    state.table === table.subject &&
    state.source?.kind === 'collection';

  return useMemo(() => {
    if (!ready || !drive) return [];
    const saved = JSON.parse(signature) as {
      rawDescriptor: unknown;
      rowClass: unknown;
      activeRule?: string;
    };
    const descriptor = parseSyncableCollectionView(
      saved.rawDescriptor,
      saved.rowClass,
    );
    if (!descriptor?.relationships?.length) return [];
    const Cell = ({ subject }: { subject: string }): JSX.Element => (
      <NavigationCell
        subject={subject}
        table={table}
        drive={drive}
        activeRule={saved.activeRule}
      />
    );

    return [
      {
        key: 'syncable-navigation',
        virtual: { label: 'Open', width: 110, Cell },
      },
    ];
  }, [ready, drive, table, signature]);
}

// @wc-ignore
/** Resolve and open a stored action through the shared native checker. */
export async function syncableRowDestination(
  store: Store,
  drive: string,
  table: Resource,
  row: Resource,
  activeRule?: string,
  actionId?: string,
): Promise<string> {
  const actor = store.getAgent()?.subject;
  const server = store.getServerUrl();

  const assertSession = () => {
    if (store.getAgent()?.subject !== actor || store.getServerUrl() !== server)
      throw new Error(
        'The active account or server changed; reopen this resource',
      );
  };

  const target = await openFlatSyncableRow(
    store,
    drive,
    table,
    row,
    activeRule,
    actionId,
  );
  assertSession();
  if (!target) return constructOpenURL(row.subject);
  const url = new URL(constructOpenURL(target.subject), window.location.href);
  if ('view' in target && target.view)
    url.searchParams.set('view', target.view);
  if ('syncFilter' in target && target.syncFilter)
    url.searchParams.set('syncFilter', target.syncFilter);

  return url.pathname + url.search + url.hash;
}

function NavigationCell({
  subject,
  table,
  drive,
  activeRule,
}: {
  subject: string;
  table: Resource;
  drive: string;
  activeRule?: string;
}): JSX.Element {
  const store = useStore();
  const navigate = useNavigateWithTransition();
  const snapshot = useResourceSnapshot(subject);
  const row = snapshot.resource;
  const parent = row.get(core.properties.parent);
  // A committed snapshot refresh can reach this cell while Open saves its
  // filter. Track the target, while the native action revalidates its evidence
  // and access before completing.
  const target = useMemo(
    () => ({
      row,
      parent,
      ready: snapshot.ready,
      error: snapshot.error,
      table,
      drive,
      activeRule,
      store,
    }),
    [
      row,
      parent,
      snapshot.ready,
      snapshot.error,
      table,
      drive,
      activeRule,
      store,
    ],
  );
  const [status, setStatus] = useState<{
    target: typeof target;
    pending: boolean;
    error?: string;
  }>();
  const generation = useRef(0);
  useEffect(
    () => () => {
      generation.current++;
    },
    [target],
  );
  const currentStatus = status?.target === target ? status : undefined;
  const busy = currentStatus?.pending;
  const error = currentStatus?.error;
  if (!snapshot.ready || snapshot.error) return <CellBox />;

  const open = (event: React.MouseEvent) => {
    event.stopPropagation();
    const token = ++generation.current;
    setStatus({ target, pending: true });
    void syncableRowDestination(store, drive, table, row, activeRule)
      .then(path => {
        if (generation.current === token) return navigate(path);
      })
      .then(
        () => {
          if (generation.current === token)
            setStatus({ target, pending: false });
        },
        reason => {
          if (generation.current === token)
            setStatus({
              target,
              pending: false,
              error: String(reason?.message ?? reason),
            });
        },
      );
  };

  return (
    <CellBox>
      <Button
        subtle
        onClick={open}
        disabled={busy}
        loading={busy ? 'Open' : undefined}
      >
        Open
      </Button>
      {error && <span role='alert'>{error}</span>}
    </CellBox>
  );
}

const CellBox = styled.div`
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  justify-content: center;
  min-width: 0;
`;
