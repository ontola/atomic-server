import { core, Datatype, type Property } from '@tomic/react';
import { expect, it } from 'vitest';
import { toBlockAggregation } from '../DashboardPage/useBlockAggregate.js';
import { effectiveViewDerivedColumns } from './Timer/timerProperties.js';
import { toAggregation } from './tableAggregates.js';
import { compileViewPredicates } from './viewQuery.js';

const columns: Property[] = [
  {
    subject: 'start-prop',
    datatype: Datatype.TIMESTAMP,
    shortname: 'start',
    description: '',
  },
  {
    subject: 'end-prop',
    datatype: Datatype.TIMESTAMP,
    shortname: 'finished',
    description: '',
  },
];
const now = 2_100_000;

it('uses the inferred timer Duration for filtering, totals, and dashboard measures', () => {
  const derivedColumns = effectiveViewDerivedColumns(
    'timer',
    [],
    false,
    columns,
  );
  const predicates = compileViewPredicates(
    'row-class',
    [{ derived: 'duration', operator: 'gte', value: '1.5' }],
    derivedColumns,
    now,
  );
  expect(predicates.filters).toEqual([
    { property: core.properties.isA, value: 'row-class' },
  ]);
  expect(predicates.hasUnresolved).toBe(false);
  expect(predicates.expressionFilters).toMatchObject([
    {
      value: 5_400_000,
      now_ms: now,
      expression: { vars: { start: 'start-prop', end: 'end-prop' } },
    },
  ]);

  const total = toAggregation(
    [{ id: 'sum', derived: 'duration', function: 'sum' }],
    undefined,
    'exact',
    derivedColumns,
    now,
  );
  const measure = toBlockAggregation(
    { derived: 'duration', function: 'sum' },
    {
      property: core.properties.parent,
      value: 'table',
      derivedColumns,
      ready: true,
      unavailable: false,
      ...predicates,
    },
  );
  expect(total?.now_ms).toBe(now);
  expect(measure?.now_ms).toBe(now);
  expect(measure?.aggregates[0].expression).toEqual(
    total?.aggregates[0].expression,
  );
});

it('preserves an explicitly empty list and requires repair of a saved Duration filter', () => {
  const stored = effectiveViewDerivedColumns('timer', [], true, columns);
  expect(stored).toEqual([]);
  const result = compileViewPredicates(
    'row-class',
    [{ derived: 'duration', operator: 'gte', value: '2' }],
    stored,
    now,
  );
  expect(result.hasUnresolved).toBe(true);
});
