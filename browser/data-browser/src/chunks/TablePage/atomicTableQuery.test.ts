import { expect, it } from 'vitest';
import { core, unknownSubject } from '@tomic/lib';
import { tableQueryIssues, type TableQuery } from '@tomic/table';
import {
  atomicTableQueryCapabilities,
  toAtomicTableQuery,
  toAtomicTableAggregateOptions,
} from './atomicTableQuery';

const query: TableQuery = {
  scope: { table: 'table:one', rowClass: 'class:shared', drive: 'drive:other' },
  filters: [{ property: 'property:quantity', operator: 'gte', value: '0' }],
  expressionFilters: [
    {
      expression: {
        kind: 'formula',
        formula: 'a * 2',
        vars: { a: 'property:quantity' },
      },
      operator: 'gt',
      value: 5,
      now_ms: 123,
      tz_offset_minutes: 60,
    },
  ],
  sort: { property: 'property:title', descending: true },
  aggregation: {
    aggregates: [{ id: 'sum', function: 'sum', property: 'property:quantity' }],
    group_by: {
      property: 'property:date',
      granularity: 'day',
      tz_offset_minutes: 60,
      limit: 50,
    },
    now_ms: 123,
    tz_offset_minutes: 60,
  },
  pageSize: 30,
};

it('preserves complete query semantics while translating backend scope and wire names', () => {
  const result = toAtomicTableQuery(query);
  expect(result).toEqual({
    property: core.properties.parent,
    value: 'table:one',
    drive: 'drive:other',
    filters: [
      { property: core.properties.isA, value: 'class:shared' },
      ...query.filters,
    ],
    expression_filters: query.expressionFilters,
    sort_by: 'property:title',
    sort_desc: true,
    aggregation: query.aggregation,
  });
  expect(tableQueryIssues(query, atomicTableQueryCapabilities)).toEqual([]);
  // Paging is passed separately to the collection, never into totals semantics.
  expect(toAtomicTableQuery({ ...query, pageSize: 1 })).toEqual(result);
});

it.each([undefined, '', unknownSubject])(
  'holds the query until the row class is known (%s)',
  rowClass => {
    const result = toAtomicTableQuery({
      ...query,
      scope: { ...query.scope, rowClass },
    });
    expect(result.value).toBeUndefined();
    expect(result.filters).toEqual(query.filters);
  },
);

it('isolates same-class tables and preserves explicit drive scope', () => {
  const first = toAtomicTableQuery(query);
  const second = toAtomicTableQuery({
    ...query,
    scope: { ...query.scope, table: 'table:two', drive: 'drive:two' },
  });
  expect(first.value).toBe('table:one');
  expect(first.drive).toBe('drive:other');
  expect(second.value).toBe('table:two');
  expect(second.drive).toBe('drive:two');
  expect(second.filters).toEqual(first.filters);
});

it('keeps totals on the identical class/table/drive scope and holds them while schema loads', () => {
  const rows = toAtomicTableQuery(query);
  const totals = toAtomicTableAggregateOptions(query, 'https://host.example');
  expect(totals).toEqual({
    property: rows.property,
    value: rows.value,
    filters: rows.filters,
    expressionFilters: rows.expression_filters,
    aggregation: rows.aggregation,
    drive: rows.drive,
    server: 'https://host.example',
  });
  expect(
    toAtomicTableAggregateOptions(
      { ...query, pageSize: 100 },
      'https://host.example',
    ),
  ).toEqual(totals);
  expect(
    toAtomicTableAggregateOptions({
      ...query,
      scope: { ...query.scope, rowClass: undefined },
    }).value,
  ).toBe('');
});
