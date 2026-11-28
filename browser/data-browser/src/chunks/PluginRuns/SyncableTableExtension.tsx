import { core, unknownSubject, useStore, useSubject } from '@tomic/react';
import type { ComponentProps } from 'react';
import {
  TableExtensionContext,
  type TableExtension,
} from '@tomic/table-page/TablePage/TableExtension';
import { getTableDrive } from '@tomic/table-page/TablePage/tableDrive';
import type { ViewKind } from '@tomic/table-page/TablePage/tableViewKinds';
import { Spinner } from '@components/Spinner';
import { ShowRoute } from '../../routes/ShowRoute';
import { BuiltinSyncablesApp } from './BuiltinSyncablesApp';
import { SyncableCollectionView } from './SyncableCollectionView';
import { SyncableFilterBar } from './SyncableFilterBar';
import {
  syncableCollectionTabs,
  syncableEntityViewKind,
} from './syncableCollectionCompatibility';
import {
  selectableViewKinds,
  useSyncableCollectionView,
} from './syncableCollectionViews';
import { useSyncableFilters } from './useSyncableFilters';
import { useSyncableTableNavigation } from './useSyncableTableNavigation';

type ExtensionComponent = NonNullable<
  React.ContextType<typeof TableExtensionContext>
>;

export function SyncableTableExtension({
  table,
  embedded,
  children,
}: ComponentProps<ExtensionComponent>): React.ReactNode {
  const store = useStore();
  const drive = getTableDrive(store, table) ?? store.getDrive();
  const [rowClass] = useSubject(table, core.properties.classtype);
  const filters = useSyncableFilters(table, embedded);
  const createFilter = ShowRoute.useSearch({ select: s => s.createSyncFilter });
  const columns = useSyncableTableNavigation(table, filters);
  const view = useSyncableCollectionView(
    drive,
    table.subject,
    rowClass ?? unknownSubject,
    !embedded && !filters.flat,
  );

  const selected = (kind: ViewKind) =>
    !embedded &&
    kind === 'syncables' &&
    filters.ready &&
    !createFilter &&
    !filters.requested
      ? (filters.directRule ??
        (filters.rules.length === 1 ? filters.rules[0] : undefined))
      : filters.selected;
  const properties = filters.properties;
  const entityTable = properties?.['syncable-entity-table'];
  const membership = properties?.['syncable-rule-memberships'];
  const extension: TableExtension = {
    selectViews: filters.flat
      ? ({ views, requested, explicit, getView }) => {
          const rules = new Set(
            filters.rules.map(rule => rule.resource.subject),
          );
          const tabs = syncableCollectionTabs({
            entity: true,
            views,
            activeView: requested,
            rules,
            getView,
          });

          return {
            ...tabs,
            displayedView: tabs.activeView,
            activeView:
              !explicit && requested && !rules.has(requested)
                ? tabs.activeView
                : requested,
          };
        }
      : undefined,
    viewKind: kind => syncableEntityViewKind(kind, filters.flat),
    rowScope: kind => {
      const rule = selected(kind);

      return {
        property: (filters.flat && entityTable) || core.properties.parent,
        filters:
          filters.flat && membership && rule
            ? [{ property: membership, value: rule.resource.subject }]
            : [],
        ready:
          filters.ready &&
          (!filters.flat || (!!entityTable && (!rule || !!membership))),
      };
    },
    error: filters.error,
    columns,
    builtinKinds: selectableViewKinds(view.applicable, filters.flat),
    refreshViews: view.refresh,
    renderToolbar: ({ kind, tableView, empty }) => (
      <SyncableFilterBar
        table={table}
        state={{ ...filters, selected: selected(kind) }}
        tableView={tableView}
        syncView={kind === 'syncables'}
        empty={empty}
      />
    ),
    renderView: ({ kind, collection, ready }) => {
      if (!drive) return;
      const activeRule = selected(kind)?.resource.subject;

      if (kind === 'syncables')
        return (
          <BuiltinSyncablesApp
            table={table.subject}
            ruleSubject={activeRule}
            drive={drive}
          />
        );
      if (kind !== 'syncable-collection') return;
      if (!filters.ready) return <Spinner />;

      return (
        <SyncableCollectionView
          table={table.subject}
          drive={drive}
          collection={collection}
          activeRule={activeRule}
          logicalOwnerProperty={filters.flat ? entityTable : undefined}
          ready={ready}
        />
      );
    },
  };

  return children(extension);
}
