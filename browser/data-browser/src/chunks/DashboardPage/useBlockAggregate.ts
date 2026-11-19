import {
  useStore,
  type AggregateOutcome,
  type Aggregation,
} from '@tomic/react';
import { useMemo } from 'react';
import { useTableAggregates } from '../TablePage/useTableAggregates';
import {
  compileTableViewQuery,
  readTableViewConfiguration,
} from '@tomic/table';
import type { BlockAggregateSpec } from './dashboardBlocks';
import type { BlockQuery } from './useBlockQuery';

/** The id every block aggregate is asked for under. One per block, so one id. */
const BLOCK_AGGREGATE_ID = 'block';

/**
 * The `aggregation` clause for one block, or undefined when there is nothing to
 * ask for — an incomplete spec must not turn into a query that answers zero.
 */
export function toBlockAggregation(
  spec: BlockAggregateSpec | undefined,
  query: BlockQuery,
  groupBy?: { property: string; granularity: 'exact' | 'day' | 'month' },
): Aggregation | undefined {
  if (!spec) {
    return undefined;
  }

  const config = readTableViewConfiguration({
    derivedColumns: query.derivedColumns,
    aggregates: [
      {
        id: BLOCK_AGGREGATE_ID,
        function: spec.function,
        derived: spec.derived,
        property: spec.function === 'count' ? undefined : spec.property,
      },
    ],
    groupByColumn: groupBy?.property,
    groupGranularity: groupBy?.granularity,
  });
  const compiled = compileTableViewQuery(config.config, {
    scope: { table: query.value },
    pageSize: 30,
    now: query.now,
  });
  if (config.issues.length || compiled.issues.length) return undefined;
  const aggregation = compiled.query.aggregation;

  // A chart needs its configured measure, not TablePage's extra row-count
  // statistic for the breakdown footer.
  return (
    aggregation && {
      ...aggregation,
      aggregates: aggregation.aggregates.filter(
        aggregate => aggregate.id === BLOCK_AGGREGATE_ID,
      ),
    }
  );
}

/**
 * One block's number(s), kept current as the data changes.
 *
 * Deliberately the table's own totals hook: a stat block asks the identical
 * question a totals footer cell does — one row plus the numbers, re-read on
 * save/delete with a debounce — so there is one implementation of "a number
 * over a filtered set" rather than two that drift.
 */
export function useBlockAggregate(
  query: BlockQuery,
  aggregation: Aggregation | undefined,
): AggregateOutcome | undefined {
  const store = useStore();
  const serverUrl = useMemo(
    () =>
      query.value.startsWith('http')
        ? new URL(query.value).origin
        : store.getServerUrl(),
    [query.value, store],
  );

  const outcomes = useTableAggregates({
    property: query.property,
    value: query.ready ? query.value : '',
    filters: query.filters,
    expressionFilters: query.expressionFilters,
    aggregation,
    server: serverUrl,
  });

  return outcomes.find(o => o.id === BLOCK_AGGREGATE_ID) ?? outcomes[0];
}
