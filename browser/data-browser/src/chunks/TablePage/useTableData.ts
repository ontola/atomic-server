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
import { toAggregation } from './tableAggregates';
import { getTableDrive } from './tableDrive';
import { quantizedNow, splitFilters } from './tableFiltering';
import { useAtomicTableQuery } from './useAtomicTableQuery';
import type { TableQuery } from '@tomic/table';

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
  const { filters, sorting } = tableView;
  const store = useStore();

  const [classSubject] = useSubject(resource, core.properties.classtype);
  const tableClass = useResource(classSubject);

  // Only constraints with an actual value narrow the query; an in-progress
  // filter (empty value) stays visible as a chip but doesn't blank the table.
  // A constraint on a computed column can't be indexed, so it travels separately
  // and the store evaluates it over the rows the index narrows to.
  const { propVals: userFilters, expressionFilters } = splitFilters(
    filters,
    tableView.viewDerivedColumns,
    quantizedNow(),
  );

  // The view's statistics ride along with the query, so the store computes them
  // over every matching row (filters included, paging excluded) instead of the
  // client adding up the page it happens to have.
  const aggregation = toAggregation(
    tableView.viewAggregates,
    tableView.viewGroupByColumn,
    tableView.viewGroupGranularity,
    tableView.viewDerivedColumns,
  );

  const query: TableQuery = {
    scope: {
      table: resource.subject,
      rowClass: classSubject,
      // Deep links query the table's drive rather than the active workspace.
      drive: getTableDrive(store, resource),
    },
    filters: userFilters,
    expressionFilters,
    sort: { property: sorting.prop, descending: sorting.sortDesc },
    aggregation,
    pageSize: PAGE_SIZE,
  };
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
  };
}
