import {
  core,
  type ExpressionFilter,
  type PropVal,
  type Aggregation,
  Resource,
  useCollection,
  UseCollectionResult,
  useResource,
  useStore,
  useSubject,
} from '@tomic/react';
import { useMemo } from 'react';
import { useTableColumns } from './useTableColumns.js';
import { effectiveViewDerivedColumns } from './Timer/timerProperties.js';
import type { DerivedColumnSpec } from './derivedColumns.js';
import { useTableView, UseTableViewResult } from './useTableView.js';
import { toAggregation } from './tableAggregates.js';
import { getTableDrive } from './tableDrive.js';
import { compileViewPredicates } from './viewQuery.js';
import type { TableExtension } from './TableExtension.js';

const PAGE_SIZE = 30;

type UseTableDataResult = {
  tableClass: Resource;
  derivedSpecs: DerivedColumnSpec[];
  queryProperty: string;
  queryValue: string;
  queryAggregation: Aggregation | undefined;
  unresolvedFilters: boolean;
  unresolvedAggregates: boolean;
  /**
   * The constraints the grid queries with (class + the view's filters). Shared
   * so the totals can be computed over exactly the rows the grid shows.
   */
  queryFilters: PropVal[];
  /** The constraints on computed values, shared with the totals query so the
   *  numbers describe the same rows. */
  queryExpressionFilters: ExpressionFilter[];
} & UseCollectionResult &
  UseTableViewResult &
  ReturnType<typeof useTableColumns>;

export function useTableData(
  resource: Resource,
  /** Which view to show, when the caller decides rather than the URL. */
  viewOverride?: string,
  embedded = false,
  extension?: TableExtension,
): UseTableDataResult {
  const tableView = useTableView(
    resource,
    viewOverride,
    embedded,
    extension?.selectViews,
  );
  const { filters, sorting } = tableView;
  const viewKind =
    extension?.viewKind?.(tableView.viewKind) ?? tableView.viewKind;
  const scope = extension?.rowScope?.(viewKind);
  const store = useStore();

  const [classSubject] = useSubject(resource, core.properties.classtype);
  const tableClass = useResource(classSubject);

  const columnState = useTableColumns(
    tableClass,
    tableView.viewColumns,
    tableView.setViewColumns,
    tableView.viewSplitLanguages,
  );
  const {
    viewDerivedColumns,
    viewDerivedColumnsSet,
    viewGroupBy,
    viewEndProp,
  } = tableView;
  const derivedSpecs = useMemo(
    () =>
      effectiveViewDerivedColumns(
        viewKind,
        viewDerivedColumns,
        viewDerivedColumnsSet,
        columnState.allColumns,
        viewGroupBy,
        viewEndProp,
      ),
    [
      viewKind,
      viewDerivedColumns,
      viewDerivedColumnsSet,
      columnState.allColumns,
      viewGroupBy,
      viewEndProp,
    ],
  );
  const predicates = compileViewPredicates(classSubject, filters, derivedSpecs);
  const queryValue =
    predicates.classReady && !predicates.hasUnresolved && scope?.ready !== false
      ? resource.subject
      : '';
  const aggregation = toAggregation(
    tableView.viewAggregates,
    tableView.viewGroupByColumn,
    tableView.viewGroupGranularity,
    derivedSpecs,
    predicates.now,
  );
  const unresolvedAggregates =
    tableView.viewAggregates.length > 0 && !aggregation;

  const queryFilter = {
    property: scope?.property ?? core.properties.parent,
    // `Collection.fetchPage` no-ops when value is undefined. Hold the
    // query until classtype is known so views don't flash as rows.
    value: queryValue || undefined,
    filters: [...predicates.filters, ...(scope?.filters ?? [])],
    expression_filters: predicates.expressionFilters,
    sort_by: sorting.prop,
    sort_desc: sorting.sortDesc,
    aggregation,
    // The table's own drive, not the active one: a deep link can open a table
    // from another drive, and the local index is keyed by drive.
    drive: getTableDrive(store, resource),
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
    viewKind,
    ...columnState,
    tableClass,
    derivedSpecs,
    queryProperty: queryFilter.property,
    queryValue,
    queryAggregation: aggregation,
    unresolvedFilters: predicates.hasUnresolved,
    unresolvedAggregates,
    queryFilters: queryFilter.filters,
    queryExpressionFilters: predicates.expressionFilters,
    collection,
    ready: !!queryValue && ready,
    invalidateCollection,
    mapAll,
  };
}
