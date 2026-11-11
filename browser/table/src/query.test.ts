import { expect, it } from 'vitest';
import {
  tableQueryIssues,
  type TableQuery,
  type TableQueryCapabilities,
} from './query.js';

const equalityBackend: TableQueryCapabilities = {
  filterOperators: ['eq'],
  expressions: false,
  aggregates: false,
  grouping: false,
  sorting: true,
};
const base: TableQuery = {
  scope: { table: 'collection:one', rowClass: 'class:row', drive: 'graph:one' },
  filters: [{ property: 'property:title', value: 'Exact' }],
  expressionFilters: [],
  pageSize: 100,
};

it('accepts equality and sorting without inventing aggregate support', () => {
  expect(
    tableQueryIssues(
      { ...base, sort: { property: 'property:title', descending: false } },
      equalityBackend,
    ),
  ).toEqual([]);
});

it('reports every unsupported feature without weakening the query', () => {
  const query: TableQuery = {
    ...base,
    filters: [
      ...base.filters,
      { property: 'property:quantity', operator: 'gt', value: '0' },
      { property: 'property:title', operator: 'contains', value: 'needle' },
    ],
    expressionFilters: [
      {
        expression: {
          kind: 'formula',
          formula: 'a * 2',
          vars: { a: 'property:quantity' },
        },
        operator: 'gte',
        value: 10,
      },
    ],
    sort: { property: 'property:title', descending: true },
    aggregation: {
      aggregates: [{ function: 'sum', property: 'property:quantity' }],
      group_by: { property: 'property:category' },
    },
  };
  const before = structuredClone(query);
  expect(
    tableQueryIssues(query, { ...equalityBackend, sorting: false }),
  ).toEqual([
    { feature: 'filter', index: 1, operator: 'gt' },
    { feature: 'filter', index: 2, operator: 'contains' },
    { feature: 'expressions' },
    { feature: 'aggregates' },
    { feature: 'grouping' },
    { feature: 'sorting' },
  ]);
  expect(query).toEqual(before);
});

it('checks expressions inside totals even when no expression filter is selected', () => {
  expect(
    tableQueryIssues(
      {
        ...base,
        aggregation: {
          aggregates: [
            {
              function: 'sum',
              expression: {
                kind: 'formula',
                formula: 'a',
                vars: { a: 'property:quantity' },
              },
            },
          ],
        },
      },
      { ...equalityBackend, aggregates: true },
    ),
  ).toEqual([{ feature: 'expressions' }]);
});
