import { saveFlatSyncableSelection } from './syncableFlatNavigation';
import { parseSyncableCollectionView } from './syncableCollection';
import { getTableDrive } from '../TablePage/tableDrive';
import { useId, useState, useSyncExternalStore } from 'react';
import { useAppExecutions } from '../AppPage/AppExecutionRuntime';
import { syncableExecutionKey } from './BuiltinSyncablesApp';
const noSubscribe = () => () => {};
const emptyRuns: never[] = [];
const emptySnapshot = () => emptyRuns;
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

/** One saved provider scope across Collection, Table and Sync renderers. */
export function SyncableFilterBar({
  table,
  state,
}: {
  table: Resource;
  state: ReturnType<typeof useSyncableFilters>;
}) {
  const store = useStore();
  const filterId = useId();
  const navigate = ShowRoute.useNavigate();
  const search = ShowRoute.useSearch();
  const canWrite = useCanWrite(table);
  const registry = useAppExecutions();
  useSyncExternalStore(
    registry?.subscribe ?? noSubscribe,
    registry?.getSnapshot ?? emptySnapshot,
    registry?.getSnapshot ?? emptySnapshot,
  );
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState<string>();
  if (!state.flat) return null;
  const selected = state.selected;
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
    const drive = getTableDrive(store, table) ?? store.getDrive();
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
  const baseView = views.find(
    subject =>
      !ruleSubjects.has(subject) &&
      store.getResourceLoading(subject).get(dataBrowser.properties.viewKind) ===
        'syncable-collection',
  );
  const status = selected?.resource.get(
    state.properties!['syncable-mirror-status'],
  ) as
    | {
        paused?: boolean;
        incomplete?: boolean;
        error?: string;
        lastSuccess?: string;
      }
    | undefined;
  const executionKey = syncableExecutionKey(
    getTableDrive(store, table) ?? store.getDrive() ?? '',
    table.subject,
    selected?.resource.subject,
  );

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
    const syncView = views.find(
      subject =>
        !ruleSubjects.has(subject) &&
        store
          .getResourceLoading(subject)
          .get(dataBrowser.properties.viewKind) === 'syncables',
    );
    if (syncView)
      void navigate({
        to: '.',
        search: {
          ...search,
          view: syncView,
          syncFilter: selected?.resource.subject,
        },
      });
  };

  return (
    <Bar aria-label='Saved collection filters'>
      <label htmlFor={filterId}>Filter</label>
      <select
        id={filterId}
        aria-label='Saved filter'
        value={selected?.resource.subject ?? ''}
        onChange={event => choose(event.target.value)}
      >
        <option value=''>All cached rows</option>
        {state.rules.map(rule => (
          <option key={rule.resource.subject} value={rule.resource.subject}>
            {String(
              rule.resource.get(core.properties.name) ?? rule.config.resource,
            )}
          </option>
        ))}
      </select>
      {selected && (
        <span role='status'>
          {status?.paused
            ? 'Paused'
            : registry?.isQueued(executionKey)
              ? 'Queued'
              : registry?.isRunning(executionKey)
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
      {renaming && (
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
      <Button subtle onClick={openSync}>
        {selected ? 'Sync settings' : 'Manage sync filters'}
      </Button>
      {(error ?? state.error) && (
        <span role='alert'>{error ?? state.error}</span>
      )}
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
