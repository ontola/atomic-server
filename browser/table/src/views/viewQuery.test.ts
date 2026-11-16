import { expect, it } from 'vitest';
import { readTableViewConfiguration } from './configuration.js';
import { compileTableViewQuery, timerDurationColumn } from './viewQuery.js';

const options = {
  scope: { table: 'table', rowClass: 'class' },
  pageSize: 30,
  now: 123_456,
  timezoneOffsetMinutes: 120,
};
it('uses the same resolved defaults for derived filters and whole-result totals', () => {
  const config = readTableViewConfiguration({
    filters: [{ derived: 'duration', operator: 'gt', value: '2' }],
    aggregates: [{ id: 'sum', derived: 'duration', function: 'sum' }],
    groupByColumn: 'category',
  }).config;
  const result = compileTableViewQuery(config, {
    ...options,
    defaultDerivedColumns: [timerDurationColumn('start', 'end', 'Duration')],
  });
  expect(result.issues).toEqual([]);
  expect(result.query.scope.rowClass).toBe('class');
  expect(result.query.expressionFilters[0]).toMatchObject({
    value: 7_200_000,
    now_ms: 120_000,
    tz_offset_minutes: 120,
  });
  expect(result.query.aggregation).toMatchObject({
    now_ms: 120_000,
    group_by: { property: 'category' },
  });
  expect(result.query.aggregation?.aggregates[0].expression).toEqual(
    result.query.expressionFilters[0].expression,
  );
  expect(result.query.aggregation?.aggregates[1]).toEqual({
    id: '__breakdown_rows',
    function: 'count',
  });
  expect(config.derivedColumns).toEqual([]);
});
it('blocks all rows for unresolved valued filters, explicit empty defaults and invalid numeric values', () => {
  for (const input of [
    { filters: [{ derived: 'missing', operator: 'gt', value: '1' }] },
    {
      derivedColumns: [],
      filters: [{ derived: 'duration', operator: 'gt', value: '1' }],
    },
    { filters: [{ derived: 'duration', operator: 'gt', value: 'invalid' }] },
    { filters: [{ derived: 'duration', operator: 'gt', value: '1e308' }] },
    { filters: [{ derived: 'duration', operator: 'contains', value: '1' }] },
    { aggregates: [{ id: 'bad', derived: 'missing', function: 'sum' }] },
  ]) {
    const result = compileTableViewQuery(
      readTableViewConfiguration(input).config,
      {
        ...options,
        defaultDerivedColumns: [
          timerDurationColumn('start', 'end', 'Duration'),
        ],
      },
    );
    expect(result.issues).toHaveLength(1);
    expect(result.query.scope.rowClass).toBeUndefined();
  }
});
it('keeps empty filter chips inactive and preserves zero and false text', () => {
  const config = readTableViewConfiguration({
    derivedColumns: [{ id: 'n', label: 'Number', formula: '1' }],
    filters: [
      { derived: 'missing', operator: 'eq', value: '' },
      { derived: 'n', operator: 'eq', value: '0' },
      { property: 'complete', operator: 'eq', value: 'false' },
    ],
  }).config;
  const result = compileTableViewQuery(config, options);
  expect(result.issues).toEqual([]);
  expect(result.query.expressionFilters[0].value).toBe(0);
  expect(result.query.filters[0].value).toBe('false');
});

it('uses the supplied clock for now comparisons and does not mark fixed dates as live', () => {
  const config = readTableViewConfiguration({
    derivedColumns: [
      {
        id: 'date',
        label: 'Date',
        formula: 'date',
        vars: { date: 'stored-date' },
        valueKind: 'date',
      },
    ],
    filters: [{ derived: 'date', operator: 'lte', value: 'now' }],
  }).config;
  const live = compileTableViewQuery(config, options).query
    .expressionFilters[0];
  expect(live).toMatchObject({
    value: 120_000,
    now_ms: 120_000,
    tz_offset_minutes: 120,
  });
  config.filters[0].value = '2026-11-12';
  const fixed = compileTableViewQuery(config, options).query
    .expressionFilters[0];
  expect(fixed.value).toBe(Date.parse('2026-11-12'));
  expect(fixed.now_ms).toBeUndefined();
});
