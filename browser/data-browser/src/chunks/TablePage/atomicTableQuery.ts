import { core, unknownSubject, type QueryFilter } from '@tomic/lib';
import type { TableQuery, TableQueryCapabilities } from '@tomic/table';

export const atomicTableQueryCapabilities: TableQueryCapabilities = {
  filterOperators: ['eq', 'gt', 'gte', 'lt', 'lte', 'starts_with', 'contains'],
  expressions: true,
  aggregates: true,
  grouping: true,
  sorting: true,
};

/** Atomic-specific vocabulary and wire names stay at the backend boundary. */
export function toAtomicTableQuery(query: TableQuery): QueryFilter {
  const classReady =
    !!query.scope.rowClass && query.scope.rowClass !== unknownSubject;

  return {
    property: core.properties.parent,
    // Collection.fetchPage no-ops until the schema supplies a row class.
    value: classReady ? query.scope.table : undefined,
    filters: [
      ...(classReady
        ? [{ property: core.properties.isA, value: query.scope.rowClass }]
        : []),
      ...query.filters,
    ],
    expression_filters: query.expressionFilters,
    sort_by: query.sort?.property,
    sort_desc: query.sort?.descending,
    aggregation: query.aggregation,
    drive: query.scope.drive,
  };
}

/** Totals use the same scope and predicates as rows, never their page window. */
export function toAtomicTableAggregateOptions(
  query: TableQuery,
  server?: string,
) {
  const request = toAtomicTableQuery(query);

  return {
    property: core.properties.parent,
    value: request.value ?? '',
    filters: request.filters ?? [],
    expressionFilters: request.expression_filters,
    aggregation: request.aggregation,
    drive: request.drive,
    server,
  };
}
