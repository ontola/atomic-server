import { useCollection, unknownSubject } from '@tomic/react';
import type { TableQuery } from '@tomic/table';
import { toAtomicTableQuery } from './atomicTableQuery';

/** Atomic's indexed collection implementation; no full-table mirror is built. */
export function useAtomicTableQuery(query: TableQuery, server: string) {
  const queryFilter = toAtomicTableQuery(query);
  const result = useCollection(queryFilter, {
    pageSize: query.pageSize,
    server,
  });

  return {
    ...result,
    ready:
      !!query.scope.rowClass &&
      query.scope.rowClass !== unknownSubject &&
      result.ready,
    queryFilters: queryFilter.filters ?? [],
    queryExpressionFilters: query.expressionFilters,
  };
}
