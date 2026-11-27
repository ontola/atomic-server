import { useEffect, useRef, useState } from 'react';
import {
  core,
  useResourceSnapshot,
  useStore,
  useValue,
  type Resource,
} from '@tomic/react';
import { Button } from '@components/Button';
import { ErrorLook } from '@components/ErrorLook';
import { Row } from '@components/Row';
import { useNavigateWithTransition } from '../../hooks/useNavigateWithTransition';
import { getTableDrive } from '@tomic/table-page/TablePage/tableDrive';
import {
  resolveFlatSyncableRecordActions,
  type FlatSyncableRowAction,
} from './syncableFlatNavigation';
import { syncableRowDestination } from './useSyncableTableNavigation';

/** Native actions over stored records. Provider reads remain in the Sync app. */
export function SyncableRecordActions({ resource }: { resource: Resource }) {
  const store = useStore();
  const navigate = useNavigateWithTransition();
  const snapshot = useResourceSnapshot(resource.subject);
  const row = snapshot.resource;
  const [localId] = useValue(row, core.properties.localId);
  // An inexpensive mount hint, including adopted rows with historical IDs.
  // Only the shared stored-relationship checker can authorize an action.
  const eligible =
    typeof localId === 'string' && localId.startsWith('syncables:');
  const drive = getTableDrive(store, row) ?? store.getDrive();
  const [loaded, setLoaded] = useState<{
    snapshot: typeof snapshot;
    drive: string;
    table?: Resource;
    actions: FlatSyncableRowAction[];
    error?: string;
  }>();
  const [status, setStatus] = useState<{
    snapshot: typeof snapshot;
    action: string;
    pending: boolean;
    error?: string;
  }>();
  const generation = useRef(0);

  useEffect(() => {
    if (!eligible || !drive || !snapshot.ready || snapshot.error) return;
    let active = true;
    let revision = 0;
    let unsubscribe = () => {};

    const refresh = () => {
      revision = revision + 1;
      const current = revision;
      void resolveFlatSyncableRecordActions(store, drive, row).then(
        result => {
          if (!active || current !== revision) return;
          unsubscribe();

          unsubscribe = result
            ? store.subscribe(result.table.subject, refresh)
            : () => {};

          setLoaded({
            snapshot,
            drive,
            table: result?.table,
            actions: result?.actions ?? [],
          });
        },
        reason => {
          if (!active || current !== revision) return;
          setLoaded({
            snapshot,
            drive,
            actions: [],
            error: String(reason?.message ?? reason),
          });
        },
      );
    };

    refresh();

    return () => {
      active = false;
      unsubscribe();
    };
  }, [store, row, snapshot, drive, eligible]);

  const current =
    loaded?.snapshot === snapshot && loaded.drive === drive
      ? loaded
      : undefined;
  const actions = current?.actions ?? [];
  const actionStamp = JSON.stringify(
    actions.map(action => [action.id, action.definition]),
  );
  useEffect(
    () => () => {
      generation.current++;
    },
    [snapshot, drive, actionStamp],
  );
  if (!eligible || !snapshot.ready || snapshot.error) return null;
  const currentStatus = status?.snapshot === snapshot ? status : undefined;
  const error = currentStatus?.error ?? current?.error;
  if (!actions.length && !error) return null;

  const follow = (action: FlatSyncableRowAction) => {
    if (!drive || !current?.table) return;
    const token = ++generation.current;
    setStatus({ snapshot, action: action.id, pending: true });
    void syncableRowDestination(
      store,
      drive,
      current.table,
      row,
      undefined,
      action.id,
    )
      .then(path => {
        if (generation.current === token) return navigate(path);
      })
      .then(
        () => {
          if (generation.current === token)
            setStatus({ snapshot, action: action.id, pending: false });
        },
        reason => {
          if (generation.current !== token) return;
          setStatus({
            snapshot,
            action: action.id,
            pending: false,
            error: String(reason?.message ?? reason),
          });
        },
      );
  };

  return (
    <Row role='group' aria-label='Related collections' wrapItems>
      {actions.map(action => (
        <Button
          key={action.id}
          subtle
          onClick={() => follow(action)}
          disabled={currentStatus?.pending}
          loading={
            currentStatus?.pending && currentStatus.action === action.id
              ? action.label
              : undefined
          }
        >
          {action.label}
        </Button>
      ))}
      {error && <ErrorLook role='alert'>{error}</ErrorLook>}
    </Row>
  );
}
