import { useCollection, unknownSubject } from '@tomic/react';
import type {
  TableQuery,
  IndexedTableRows,
  TableQueryFilter,
  TableExpressionFilter,
} from '@tomic/table';
import { toAtomicTableQuery } from './atomicTableQuery';

/** Atomic's indexed collection implementation; no full-table mirror is built. */
export function useAtomicTableQuery(query: TableQuery, server: string) {
  const queryFilter = toAtomicTableQuery(query);
  const result = useCollection(queryFilter, {
    pageSize: query.pageSize,
    server,
  });

  const collection: IndexedTableRows = result.collection;
  const answeredQuery: {
    filters: TableQueryFilter[];
    expressionFilters: TableExpressionFilter[];
    sortBy?: string;
    sortDesc: boolean;
  } = {
    filters: result.collection.filters,
    expressionFilters: result.collection.expressionFilters,
    sortBy: result.collection.sortBy,
    sortDesc: result.collection.sortDesc,
  };

  return {
    collection,
    answeredQuery,
    invalidateCollection: result.invalidateCollection,
    ready:
      !!query.scope.rowClass &&
      query.scope.rowClass !== unknownSubject &&
      result.ready,
    queryFilters: queryFilter.filters ?? [],
    queryExpressionFilters: query.expressionFilters,
  };
}
