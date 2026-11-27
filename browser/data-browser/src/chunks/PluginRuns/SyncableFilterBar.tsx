import { saveFlatSyncableSelection } from './syncableFlatNavigation';
import { parseSyncableCollectionView } from './syncableCollection';
import { getTableDrive } from '../TablePage/tableDrive';
import { useEffect, useId, useState, useSyncExternalStore } from 'react';
import { useAppExecutions } from '../AppPage/AppExecutionRuntime';
import { appProfile, syncableExecutionKey } from './BuiltinSyncablesApp';
import { readSyncableRuleStatus } from './syncableRules';
import {
  core,
  dataBrowser,
  useCanWrite,
  useStore,
  type Resource,
} from '@tomic/react';
import { styled } from 'styled-components';
import { ShowRoute } from '../../routes/ShowRoute';
import { Button } from '@components/Button';
import { useSyncableFilters } from './useSyncableFilters';

const noSubscribe = () => () => {};
const idleExecution = () => 'idle' as const;

function canHydrateRule(rule: Resource, statusProperty: string): boolean {
  try {
    const status = readSyncableRuleStatus(rule.get(statusProperty));

    return (
      !status.paused &&
      status.enabled !== false &&
      !status.lastSuccess &&
      !status.run &&
      !status.error
    );
  } catch {
    return false;
  }
}

/** One saved provider scope across the native data views and Sync controls. */
export function SyncableFilterBar({
  table,
  state,
  tableView,
  syncView,
  empty,
}: {
  table: Resource;
  state: ReturnType<typeof useSyncableFilters>;
  tableView: boolean;
  syncView: boolean;
  empty: boolean;
}) {
  const store = useStore();
  const filterId = useId();
  const navigate = ShowRoute.useNavigate();
  const search = ShowRoute.useSearch();
  const canWrite = useCanWrite(table);
  const registry = useAppExecutions();
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState<string>();
  const [hydrationError, setHydrationError] = useState<{
    key: string;
    message: string;
  }>();
  const selected = state.selected;
  const drive = state.flat
    ? (getTableDrive(store, table) ?? store.getDrive())
    : undefined;
  const tableSubject = table.subject;
  const direct = state.directRule?.resource;
  const directRule =
    tableView &&
    direct &&
    (!selected || selected.resource.subject === direct.subject)
      ? direct
      : undefined;
  const statusProperty = state.properties?.['syncable-mirror-status'];
  const hydrationKey =
    drive && directRule
      ? syncableExecutionKey(drive, tableSubject, directRule.subject)
      : undefined;
  const automaticError =
    hydrationError?.key === hydrationKey ? hydrationError?.message : undefined;
  const hydrate = state.flat && state.ready && empty && canWrite;
  const statusRule = selected?.resource ?? directRule;
  const executionKey = syncableExecutionKey(
    drive ?? '',
    tableSubject,
    statusRule?.subject,
  );
  const execution = useSyncExternalStore(
    registry?.subscribe ?? noSubscribe,
    () =>
      registry?.isQueued(executionKey)
        ? 'queued'
        : registry?.isRunning(executionKey)
          ? 'running'
          : 'idle',
    idleExecution,
  );
  const queued = execution === 'queued';
  const running = execution === 'running';

  useEffect(() => {
    if (
      !hydrate ||
      !registry ||
      !drive ||
      !directRule ||
      !statusProperty ||
      !hydrationKey ||
      automaticError !== undefined
    )
      return;
    const actor = store.getAgent();
    if (!actor?.subject) return;

    const controller = new AbortController();
    const canStart = () =>
      !controller.signal.aborted &&
      store.getAgent() === actor &&
      !registry.isRunning(hydrationKey) &&
      canHydrateRule(directRule, statusProperty);

    if (!canStart()) return;

    void directRule
      .canWrite(actor.subject)
      .then(async ([canWriteRule]) => {
        if (!canWriteRule || !canStart()) return;
        const spec = await appProfile(
          store,
          drive,
          tableSubject,
          registry,
          controller.signal,
          false,
          undefined,
          directRule.subject,
        );
        if (canStart()) return spec.profile.execution?.('start');
      })
      .catch(reason => {
        if (!controller.signal.aborted)
          setHydrationError({
            key: hydrationKey,
            message: String(reason?.message ?? reason),
          });
      });

    // The registry owns an accepted worker after this Table view closes.
    return () => controller.abort();
  }, [
    automaticError,
    directRule,
    drive,
    hydrate,
    hydrationKey,
    registry,
    statusProperty,
    store,
    tableSubject,
  ]);

  if (!state.flat) return null;
  const descriptor = parseSyncableCollectionView(
    table.get(state.properties!['syncable-collection-view']),
    table.get(core.properties.classtype),
  );

  const follow = async (
    relationship: NonNullable<
      NonNullable<typeof descriptor>['relationships']
    >[number],
  ) => {
    if (!selected) return;
    if (!drive) return;
    const target = await saveFlatSyncableSelection(
      store,
      drive,
      table,
      {
        version: 1,
        resource: relationship.resource,
        source: {
          kind: 'fanout',
          from: selected.config.definition,
          via: relationship.via,
        },
      },
      `${String(selected.resource.get(core.properties.name) ?? selected.config.resource)} · ${relationship.title}`,
    );
    void navigate({ to: '.', search: target });
  };

  const ruleSubjects = new Set(state.rules.map(rule => rule.resource.subject));
  const views = table.getSubjects(dataBrowser.properties.tableViews);
  const baseView = ['table', 'syncable-collection'].flatMap(kind =>
    views.filter(
      subject =>
        !ruleSubjects.has(subject) &&
        store
          .getResourceLoading(subject)
          .get(dataBrowser.properties.viewKind) === kind,
    ),
  )[0];
  const status = (
    statusProperty ? statusRule?.get(statusProperty) : undefined
  ) as
    | {
        paused?: boolean;
        incomplete?: boolean;
        error?: string;
        lastSuccess?: string;
      }
    | undefined;
  const alert =
    error ??
    state.error ??
    automaticError ??
    (!selected && typeof status?.error === 'string' ? status.error : undefined);
  const showFilter = !syncView || state.rules.length > 0;
  const showStatus =
    !!selected || queued || running || !!status?.error || status?.incomplete;

  if (!showFilter && !showStatus && !alert) return null;

  const choose = (subject: string) => {
    setRenaming(false);
    void navigate({
      to: '.',
      search: prev => ({
        ...prev,
        syncFilter: subject || undefined,
        view: prev.view && ruleSubjects.has(prev.view) ? baseView : prev.view,
      }),
    });
  };

  const rename = async () => {
    if (!selected || !name.trim()) return;
    await selected.resource.set(core.properties.name, name.trim());
    await selected.resource.save();
    setRenaming(false);
  };

  const openSync = () => {
    const syncViewSubject = views.find(
      subject =>
        !ruleSubjects.has(subject) &&
        store
          .getResourceLoading(subject)
          .get(dataBrowser.properties.viewKind) === 'syncables',
    );
    if (syncViewSubject)
      void navigate({
        to: '.',
        search: {
          ...search,
          view: syncViewSubject,
          syncFilter: selected?.resource.subject,
        },
      });
  };

  return (
    <Bar aria-label='Saved collection filters'>
      {showFilter && (
        <>
          <label htmlFor={filterId}>Filter</label>
          <select
            id={filterId}
            aria-label='Saved filter'
            value={selected?.resource.subject ?? ''}
            onChange={event => choose(event.target.value)}
          >
            {!syncView && <option value=''>All cached rows</option>}
            {syncView && !selected && (
              <option disabled value=''>
                Select a saved filter
              </option>
            )}
            {state.rules.map(rule => (
              <option key={rule.resource.subject} value={rule.resource.subject}>
                {String(
                  rule.resource.get(core.properties.name) ??
                    rule.config.resource,
                )}
              </option>
            ))}
          </select>
        </>
      )}
      {showStatus && (
        <span role='status'>
          {status?.paused
            ? 'Paused'
            : queued
              ? 'Queued'
              : running
                ? 'Syncing'
                : status?.error
                  ? 'Needs attention'
                  : status?.incomplete
                    ? 'Partially synced'
                    : status?.lastSuccess
                      ? 'Synced'
                      : 'Ready to sync'}
        </span>
      )}
      {!syncView && selected && !status?.lastSuccess && (
        <span>
          This filter has no completed sync yet. Choose All cached rows to
          browse data stored by other filters or earlier imports.
        </span>
      )}
      {selected && canWrite && (
        <Button
          subtle
          onClick={() => {
            setName(String(selected.resource.get(core.properties.name) ?? ''));
            setRenaming(true);
          }}
        >
          Rename filter
        </Button>
      )}
      {selected && renaming && (
        <form
          onSubmit={event => {
            event.preventDefault();
            void rename().catch(reason => setError(String(reason)));
          }}
        >
          <input
            aria-label='Filter name'
            value={name}
            onChange={event => setName(event.target.value)}
            maxLength={200}
          />
          <Button type='submit'>Save name</Button>
        </form>
      )}
      {selected &&
        canWrite &&
        descriptor?.relationships?.map(relationship => (
          <Button
            subtle
            key={JSON.stringify(relationship.via)}
            onClick={() => {
              void follow(relationship).catch(reason =>
                setError(String(reason)),
              );
            }}
          >{`Open ${relationship.title}`}</Button>
        ))}
      {!syncView && (
        <Button subtle onClick={openSync}>
          {selected ? 'Sync settings' : 'Manage sync filters'}
        </Button>
      )}
      {alert && <span role='alert'>{alert}</span>}
    </Bar>
  );
}

const Bar = styled.div`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: ${p => p.theme.size(2)};
  padding: ${p => p.theme.size(2)};
  select,
  input {
    max-width: 100%;
    padding: 0.4rem;
    font: inherit;
  }
  form {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }
`;
