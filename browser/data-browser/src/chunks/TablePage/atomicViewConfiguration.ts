import {
  core,
  dataBrowser,
  ResourceEvents,
  type Resource,
  type JSONValue,
  useStore,
} from '@tomic/react';
import { useCallback, useMemo, useSyncExternalStore } from 'react';
import {
  readTableViewConfiguration,
  type TableViewConfigurationInput,
  type TableViewConfiguration,
} from '@tomic/table';

/** The backend binding is the only place shared config names become Atomic
 * property identifiers. Reads never rewrite or migrate stored metadata. */
const bindings: Record<keyof TableViewConfigurationInput, string> = {
  name: core.properties.name,
  kind: dataBrowser.properties.viewKind,
  dashboard: dataBrowser.properties.viewDashboard,
  filters: dataBrowser.properties.viewFilters,
  sortBy: dataBrowser.properties.viewSortBy,
  sortDesc: dataBrowser.properties.viewSortDesc,
  columns: dataBrowser.properties.viewColumns,
  groupBy: dataBrowser.properties.viewGroupBy,
  endProp: dataBrowser.properties.viewEndProp,
  timerExclusive: dataBrowser.properties.viewTimerExclusive,
  splitLanguages: dataBrowser.properties.viewSplitLanguages,
  derivedColumns: dataBrowser.properties.viewDerivedColumns,
  columnOrder: dataBrowser.properties.viewColumnOrder,
  aggregates: dataBrowser.properties.viewAggregates,
  rowActions: dataBrowser.properties.viewRowActions,
  quickAdd: dataBrowser.properties.viewQuickAdd,
  groupByColumn: dataBrowser.properties.viewGroupByColumn,
  groupGranularity: dataBrowser.properties.viewGroupGranularity,
};

export function readAtomicTableViewConfiguration(view: Resource) {
  return readTableViewConfiguration(
    Object.fromEntries(
      Object.entries(bindings).map(([key, property]) => [
        key,
        view.get(property),
      ]),
    ) as TableViewConfigurationInput,
  );
}

export function useAtomicViewConfiguration(view: Resource) {
  const store = useStore();
  const stable = view.stable;
  const subject = view.subject;
  const subscribe = useCallback(
    (notify: () => void) => {
      const local = stable.on(ResourceEvents.LocalChange, notify);
      const remote = store.subscribe(subject, notify);

      return () => {
        local();
        remote();
      };
    },
    [store, stable, subject],
  );
  const snapshot = useCallback(
    () =>
      JSON.stringify({
        owner: stable.get(core.properties.parent),
        input: Object.fromEntries(
          Object.entries(bindings).map(([key, property]) => [
            key,
            stable.get(property),
          ]),
        ),
      }),
    [stable],
  );
  const serialized = useSyncExternalStore(subscribe, snapshot, snapshot);

  return useMemo(() => {
    const { owner, input } = JSON.parse(serialized) as {
      owner?: string;
      input: TableViewConfigurationInput;
    };

    return { owner, ...readTableViewConfiguration(input) };
  }, [serialized]);
}

export function copyAtomicTableViewConfiguration(
  view: Resource,
): Record<string, JSONValue> {
  return Object.fromEntries(
    Object.entries(bindings)
      .filter(([key]) => key !== 'name' && key !== 'kind')
      .map(([, property]) => [property, view.get(property)])
      .filter(([, value]) => value !== undefined),
  ) as Record<string, JSONValue>;
}

/** Apply a typed patch to the unsaved Resource; the command owns when to save.
 * Quick-add objects keep Atomic's validated JSON datatype-tagging path. */
export async function writeAtomicTableViewConfiguration(
  view: Resource,
  patch: Partial<Omit<TableViewConfiguration, 'derivedColumnsSet'>>,
) {
  for (const [key, value] of Object.entries(patch)) {
    const property = bindings[key as keyof TableViewConfigurationInput];
    if (!property) throw Error('Unknown view configuration field');
    if (value === undefined) view.remove(property);
    else await view.set(property, value as never, key === 'quickAdd');
  }
}
