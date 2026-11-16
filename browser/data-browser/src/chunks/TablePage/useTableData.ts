import {
  core,
  type ExpressionFilter,
  PropVal,
  Resource,
  useResource,
  useStore,
  useSubject,
} from '@tomic/react';
import { useTableView, UseTableViewResult } from './useTableView';
import { getTableDrive } from './tableDrive';
import { useAtomicTableQuery } from './useAtomicTableQuery';
import {
  compileTableViewQuery,
  timerDurationColumn,
  type TableQuery,
} from '@tomic/table';

const PAGE_SIZE = 30;

type UseTableDataResult = {
  tableClass: Resource;
  query: TableQuery;
  /**
   * The constraints the grid queries with (class + the view's filters). Shared
   * so the totals can be computed over exactly the rows the grid shows.
   */
  queryFilters: PropVal[];
  /** The constraints on computed values, shared with the totals query so the
   *  numbers describe the same rows. */
  queryExpressionFilters: ExpressionFilter[];
  collection: import('@tomic/table').IndexedTableRows;
  answeredQuery: ReturnType<typeof useAtomicTableQuery>['answeredQuery'];
  ready: boolean;
  invalidateCollection: () => Promise<void>;
} & UseTableViewResult;

export function useTableData(
  resource: Resource,
  /** Which view to show, when the caller decides rather than the URL. */
  viewOverride?: string,
  embedded = false,
): UseTableDataResult {
  const tableView = useTableView(resource, viewOverride, embedded);
  const store = useStore();

  const [classSubject] = useSubject(resource, core.properties.classtype);
  const tableClass = useResource(classSubject);

  const defaultDerivedColumns =
    tableView.viewKind === 'timer' &&
    tableView.viewGroupBy &&
    tableView.viewEndProp
      ? [
          timerDurationColumn(
            tableView.viewGroupBy,
            tableView.viewEndProp,
            'Duration',
          ),
        ]
      : [];
  const { query, issues } = compileTableViewQuery(tableView.viewConfiguration, {
    scope: {
      table: resource.subject,
      rowClass: tableView.viewReady ? classSubject : undefined,
      drive: getTableDrive(store, resource),
    },
    pageSize: PAGE_SIZE,
    defaultDerivedColumns,
  });
  const rows = useAtomicTableQuery(
    query,
    resource.subject.startsWith('http')
      ? new URL(resource.subject).origin
      : store.getServerUrl(),
  );

  return {
    ...tableView,
    tableClass,
    query,
    ...rows,
    viewReady: tableView.viewReady && !issues.length,
    viewError:
      tableView.viewError ??
      (issues.length ? 'Saved view configuration is invalid.' : undefined),
  };
}
