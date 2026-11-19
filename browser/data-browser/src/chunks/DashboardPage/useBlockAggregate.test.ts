import { expect, it } from 'vitest';
import { toBlockAggregation } from './useBlockAggregate';
import type { BlockQuery } from './useBlockQuery';
const query: BlockQuery = {
  property: 'parent',
  value: 'table',
  filters: [],
  expressionFilters: [],
  derivedColumns: [],
  ready: true,
  now: 123_456,
};
it('keeps block row counts independent of optional property values and omits footer measures from charts', () => {
  const result = toBlockAggregation(
    { function: 'count', property: 'optional' },
    query,
    { property: 'category', granularity: 'exact' },
  );
  expect(result?.aggregates).toEqual([
    { id: 'block', property: undefined, function: 'count' },
  ]);
  expect(result?.group_by?.property).toBe('category');
});
it('uses the query clock for live measures and refuses missing computed targets', () => {
  expect(
    toBlockAggregation({ function: 'sum', derived: 'missing' }, query),
  ).toBeUndefined();
  const result = toBlockAggregation(
    { function: 'sum', derived: 'elapsed' },
    {
      ...query,
      derivedColumns: [
        {
          id: 'elapsed',
          label: 'Elapsed',
          formula: 'now() - start',
          vars: { start: 'start-property' },
        },
      ],
    },
  );
  expect(result?.now_ms).toBe(120_000);
  expect(result?.aggregates).toHaveLength(1);
});
