import { useEffect, useMemo, useRef, useState, type JSX } from 'react';
import {
  core,
  dataBrowser,
  subjectsReferToSameResource,
  unknownSubject,
  useCanWrite,
  useResourceSnapshot,
  useStore,
  useValue,
  type Resource,
  type Store,
} from '@tomic/react';
import { parseReadSelection } from 'syncables/browser';
import { styled } from 'styled-components';
import { Button } from '@components/Button';
import { constructOpenURL } from '@helpers/navigation';
import { useNavigateWithTransition } from '../../hooks/useNavigateWithTransition';
import type { TableColumn } from '../TablePage/useTableColumns';
import { getTableDrive } from '../TablePage/tableDrive';
import { canonicalValue } from './builtinSyncIdentity.js';
import { openFlatSyncableRow } from './syncableFlatNavigation';
import {
  parseSyncableCollectionView,
  type SyncableCollectionDescriptor,
} from './syncableCollection';
import {
  parseSyncableSourceConfig,
  parseSyncableSourceKey,
  sourceConfigMatchesKey,
  type SyncableSourceConfigV3,
} from './syncableSource';
import type { useSyncableFilters } from './useSyncableFilters';

type Properties = Record<string, string>;
const same = (a: unknown, b: unknown) =>
  JSON.stringify(canonicalValue(a)) === JSON.stringify(canonicalValue(b));
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

/** Rendering a stored summary never supplies evidence to create a child scope. */
function hasNavigationEvidence(
  row: Resource,
  table: Resource,
  drive: string,
  source: SyncableSourceConfigV3,
  descriptor: SyncableCollectionDescriptor,
  properties: Properties,
  configValue: unknown,
  keyValue: unknown,
  intentsValue: unknown,
  membershipsValue: unknown,
  activeRule?: string,
): boolean {
  try {
    const config = parseSyncableSourceConfig(configValue);
    const key = parseSyncableSourceKey(keyValue);
    const assignedDrive = row.get('https://atomicdata.dev/properties/drive');
    if (
      typeof keyValue !== 'string' ||
      key.version !== 3 ||
      key.kind !== 'record' ||
      config.version !== 3 ||
      config.kind !== 'record' ||
      !sourceConfigMatchesKey(config, key, keyValue) ||
      !config.record ||
      !config.read ||
      config.read.resource !== config.resource ||
      !config.entityIdentity ||
      config.resource !== source.resource ||
      config.platform !== source.platform ||
      config.proxyOrigin !== source.proxyOrigin ||
      !same(config.principal, source.principal) ||
      !row.hasClasses(descriptor.rowClass) ||
      !subjectsReferToSameResource(
        row.get(properties['syncable-entity-table']),
        table.subject,
      ) ||
      (assignedDrive !== undefined &&
        (typeof assignedDrive !== 'string' ||
          !subjectsReferToSameResource(assignedDrive, drive))) ||
      !Array.isArray(intentsValue) ||
      !intentsValue.length ||
      (activeRule &&
        (!Array.isArray(membershipsValue) ||
          !membershipsValue.some(
            subject =>
              typeof subject === 'string' &&
              subjectsReferToSameResource(subject, activeRule),
          )))
    )
      return false;
    const intent = intentsValue[0];
    if (
      !object(intent) ||
      intent.version !== 1 ||
      intent.sourceEntityKey !== keyValue
    )
      return false;
    const definition = parseReadSelection(intent.definition);

    return (
      definition.source.kind === 'related' &&
      definition.source.origin.entity.key === config.entityIdentity.key &&
      intent.resource === definition.resource &&
      !!descriptor.relationships?.some(
        relationship =>
          relationship.resource === intent.resource &&
          same(
            relationship.via,
            definition.source.kind === 'related'
              ? definition.source.via
              : undefined,
          ),
      )
    );
  } catch {
    return false;
  }
}

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
  const writable = useCanWrite(table);
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
      source: SyncableSourceConfigV3;
      properties: Properties;
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
        source={saved.source}
        descriptor={descriptor}
        properties={saved.properties}
        activeRule={saved.activeRule}
        writable={writable}
      />
    );

    return [
      {
        key: 'syncable-navigation',
        virtual: { label: 'Open', width: 110, Cell },
      },
    ];
  }, [ready, drive, table, signature, writable]);
}

// @wc-ignore
async function destination(
  store: Store,
  drive: string,
  table: Resource,
  row: Resource,
  allowScope: boolean,
  activeRule?: string,
): Promise<string> {
  if (!allowScope) return constructOpenURL(row.subject);
  const target = await openFlatSyncableRow(
    store,
    drive,
    table,
    row,
    activeRule,
  );
  if (!target) return constructOpenURL(row.subject);
  const url = new URL(constructOpenURL(target.subject), window.location.href);
  let preferred = 'view' in target ? target.view : undefined;

  if (!subjectsReferToSameResource(target.subject, row.subject)) {
    const targetTable = await store.getResource(target.subject);

    if (targetTable.hasClasses(dataBrowser.classes.table)) {
      for (const subject of targetTable.getSubjects(
        dataBrowser.properties.tableViews,
      )) {
        const view = await store.getResource(subject);

        if (
          !view.error &&
          view.hasClasses(dataBrowser.classes.view) &&
          subjectsReferToSameResource(
            view.get(core.properties.parent),
            target.subject,
          ) &&
          view.get(dataBrowser.properties.viewKind) === 'table'
        ) {
          preferred = subject;
          break;
        }
      }
    }
  }

  if (preferred) url.searchParams.set('view', preferred);
  if ('syncFilter' in target && target.syncFilter)
    url.searchParams.set('syncFilter', target.syncFilter);

  return url.pathname + url.search + url.hash;
}

function NavigationCell({
  subject,
  table,
  drive,
  source,
  descriptor,
  properties,
  activeRule,
  writable,
}: {
  subject: string;
  table: Resource;
  drive: string;
  source: SyncableSourceConfigV3;
  descriptor: SyncableCollectionDescriptor;
  properties: Properties;
  activeRule?: string;
  writable: boolean;
}): JSX.Element {
  const store = useStore();
  const navigate = useNavigateWithTransition();
  const snapshot = useResourceSnapshot(subject);
  const row = snapshot.resource;
  const [config] = useValue(
    row,
    properties['syncable-source-config'] ?? unknownSubject,
  );
  const [key] = useValue(
    row,
    properties['syncable-source-key'] ?? unknownSubject,
  );
  const [intents] = useValue(
    row,
    properties['syncable-navigation-intents'] ?? unknownSubject,
  );
  const [memberships] = useValue(
    row,
    properties['syncable-rule-memberships'] ?? unknownSubject,
  );
  const [status, setStatus] = useState<{
    subject: string;
    pending: boolean;
    error?: string;
  }>();
  const generation = useRef(0);
  useEffect(
    () => () => {
      generation.current++;
    },
    [subject],
  );
  const evidence = useMemo(
    () =>
      snapshot.ready &&
      !snapshot.error &&
      hasNavigationEvidence(
        row,
        table,
        drive,
        source,
        descriptor,
        properties,
        config,
        key,
        intents,
        memberships,
        activeRule,
      ),
    [
      snapshot,
      row,
      table,
      drive,
      source,
      descriptor,
      properties,
      config,
      key,
      intents,
      memberships,
      activeRule,
    ],
  );
  const busy = status?.subject === subject && status.pending;
  const error = status?.subject === subject ? status.error : undefined;
  if (!snapshot.ready || snapshot.error) return <CellBox />;

  const open = (event: React.MouseEvent) => {
    event.stopPropagation();
    const token = ++generation.current;
    setStatus({ subject, pending: true });
    void destination(store, drive, table, row, writable && evidence, activeRule)
      .then(path => {
        if (generation.current === token) return navigate(path);
      })
      .catch(reason => {
        if (generation.current === token)
          setStatus({
            subject,
            pending: false,
            error: String(reason?.message ?? reason),
          });
      })
      .finally(() => {
        if (generation.current === token)
          setStatus(current =>
            current ? { ...current, pending: false } : current,
          );
      });
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
