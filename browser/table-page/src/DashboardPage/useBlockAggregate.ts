import {
  useStore,
  type Aggregate,
  type AggregateOutcome,
  type Aggregation,
} from '@tomic/react';
import { useMemo } from 'react';
import { localOffsetMinutes } from '../TablePage/formulaEngine.js';
import { useTableAggregates } from '../TablePage/useTableAggregates.js';
import { dependsOnNow, toExpression } from '../TablePage/derivedColumns.js';
import type { BlockAggregateSpec } from './dashboardBlocks.js';
import type { BlockQuery } from './useBlockQuery.js';

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

  let aggregate: Aggregate | undefined;

  if (spec.derived !== undefined) {
    const column = query.derivedColumns.find(c => c.id === spec.derived);
    const expression = column && toExpression(column);

    // The computed column it names is gone or still incomplete. Asking anyway
    // returns an empty number, which reads as a broken statistic.
    if (!expression) {
      return undefined;
    }

    aggregate = {
      id: BLOCK_AGGREGATE_ID,
      expression,
      function: spec.function,
    };
  } else if (spec.function === 'count') {
    aggregate = { id: BLOCK_AGGREGATE_ID, function: spec.function };
  } else if (spec.property) {
    aggregate = {
      id: BLOCK_AGGREGATE_ID,
      property: spec.property,
      function: spec.function,
    };
  }

  if (!aggregate) {
    return undefined;
  }

  const measuresNow =
    spec.derived !== undefined &&
    query.derivedColumns.some(c => c.id === spec.derived && dependsOnNow(c));

  return {
    aggregates: [aggregate],
    group_by: groupBy
      ? {
          property: groupBy.property,
          granularity: groupBy.granularity,
          tz_offset_minutes: -new Date().getTimezoneOffset(),
        }
      : undefined,
    ...(measuresNow ? { now_ms: query.now } : {}),
    ...(aggregate.expression
      ? { tz_offset_minutes: localOffsetMinutes() }
      : {}),
  };
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
    drive: query.drive,
    server: serverUrl,
  });

  return query.ready
    ? (outcomes.find(o => o.id === BLOCK_AGGREGATE_ID) ?? outcomes[0])
    : undefined;
}
