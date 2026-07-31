import {
  core,
  PropVal,
  Resource,
  unknownSubject,
  useCollection,
  UseCollectionResult,
  useResource,
  useStore,
  useSubject,
} from '@tomic/react';
import { useTableView, UseTableViewResult } from './useTableView';
import { toAggregation } from './tableAggregates';

const PAGE_SIZE = 30;

type UseTableDataResult = {
  tableClass: Resource;
  /**
   * The constraints the grid queries with (class + the view's filters). Shared
   * so the totals can be computed over exactly the rows the grid shows.
   */
  queryFilters: PropVal[];
} & UseCollectionResult &
  UseTableViewResult;

export function useTableData(resource: Resource): UseTableDataResult {
  const tableView = useTableView(resource);
  const { filters, sorting } = tableView;
  const store = useStore();

  const [classSubject] = useSubject(resource, core.properties.classtype);
  const tableClass = useResource(classSubject);

  // Only constraints with an actual value narrow the query; an in-progress
  // filter (empty value) stays visible as a chip but doesn't blank the table.
  const userFilters: PropVal[] = filters
    .filter(f => f.value !== '')
    .map(f => ({ property: f.property, value: f.value, operator: f.operator }));

  // Constrain rows to instances of the table's classtype. This keeps non-row
  // children — notably the table's own View resources — out of the row list.
  // Only applied once the classtype is known, to avoid a query against
  // `unknownSubject` on first render.
  const classFilter: PropVal[] =
    classSubject && classSubject !== unknownSubject
      ? [{ property: core.properties.isA, value: classSubject }]
      : [];

  // The view's statistics ride along with the query, so the store computes them
  // over every matching row (filters included, paging excluded) instead of the
  // client adding up the page it happens to have.
  const aggregation = toAggregation(
    tableView.viewAggregates,
    tableView.viewGroupByColumn,
    tableView.viewGroupGranularity,
  );

  const queryFilter = {
    property: core.properties.parent,
    value: resource.subject,
    filters: [...classFilter, ...userFilters],
    sort_by: sorting.prop,
    sort_desc: sorting.sortDesc,
    aggregation,
  };

  const { collection, ready, invalidateCollection, mapAll } = useCollection(
    queryFilter,
    {
      pageSize: PAGE_SIZE,
      server: resource.subject.startsWith('http')
        ? new URL(resource.subject).origin
        : store.getServerUrl(),
    },
  );

  return {
    ...tableView,
    tableClass,
    queryFilters: queryFilter.filters,
    collection,
    ready,
    invalidateCollection,
    mapAll,
  };
}
