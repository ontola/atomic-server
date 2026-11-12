import { expect, it } from 'vitest';
import {
  parseDerivedColumnSpecs,
  parseRowActions,
  parseQuickAdd,
  readTableViewConfiguration,
} from './configuration.js';

it('keeps unset-derived defaults distinct from an explicitly empty configuration', () => {
  const initial = readTableViewConfiguration({});
  expect(initial.issues).toEqual([]);
  expect(initial.config).toMatchObject({
    derivedColumnsSet: false,
    timerExclusive: true,
    groupGranularity: 'day',
  });
  const explicit = readTableViewConfiguration({
    derivedColumns: [],
    timerExclusive: false,
  });
  expect(explicit.config).toMatchObject({
    derivedColumnsSet: true,
    timerExclusive: false,
  });
});

it('reads every built-in view binding without rewriting stored data', () => {
  const input = {
    name: 'Working board',
    kind: 'kanban',
    dashboard: 'dashboard-one',
    filters: [{ property: 'status', value: 'open', operator: 'eq' }],
    sortBy: 'position',
    sortDesc: false,
    columns: ['title', 'status'],
    columnOrder: ['derived:total', 'title'],
    groupBy: 'status',
    endProp: 'ended',
    timerExclusive: false,
    splitLanguages: ['title'],
    derivedColumns: [
      {
        id: 'total',
        label: 'Total',
        formula: 'amount * 2.0',
        vars: { amount: 'amount' },
        width: 140,
      },
    ],
    aggregates: [
      { id: 'total-sum', derived: 'total', function: 'sum', row: 0 },
    ],
    rowActions: [
      {
        id: 'done',
        label: 'Done',
        kind: 'setValue',
        property: 'status',
        value: 'done',
      },
    ],
    quickAdd: {
      label: 'New item',
      field: 'title',
      presets: [{ kind: 'increment', property: 'count', value: 0 }],
    },
    groupByColumn: 'status',
    groupGranularity: 'exact',
  };
  const before = JSON.stringify(input);
  const { config, issues } = readTableViewConfiguration(input);
  expect(issues).toEqual([]);
  expect(config).toEqual({ ...input, derivedColumnsSet: true });
  expect(JSON.stringify(input)).toBe(before);
});

it('preserves legacy generator bindings and default equality', () => {
  expect(
    parseDerivedColumnSpecs([
      {
        id: 'duration',
        label: 'Duration',
        kind: 'elapsed',
        args: { from: 'started' },
      },
    ]),
  ).toEqual([
    {
      id: 'duration',
      label: 'Duration',
      formula: 'now() - v0',
      vars: { v0: 'started' },
      valueKind: 'duration',
    },
  ]);
  expect(
    readTableViewConfiguration({
      filters: [{ property: 'name', value: 'one' }],
    }).config.filters,
  ).toEqual([{ property: 'name', value: 'one', operator: 'eq' }]);
});

it('does not accept inherited object names as a stored action or generator', () => {
  for (const kind of ['toString', 'constructor', '__proto__']) {
    expect(
      parseRowActions([{ id: 'bad', label: 'Bad', property: 'name', kind }]),
    ).toEqual([]);
    expect(
      parseQuickAdd({ label: 'Add', presets: [{ property: 'name', kind }] })
        ?.presets,
    ).toEqual([]);
    expect(
      parseDerivedColumnSpecs([{ id: 'bad', label: 'Bad', kind, args: {} }]),
    ).toEqual([]);
  }
});

it('reports malformed or missing query bindings instead of returning a successful fallback', () => {
  const values = [
    { filters: 'not filters' },
    { filters: [{ property: 'name', value: 'one', operator: 'unsupported' }] },
    {
      filters: [
        { property: 'name', derived: 'sum', value: 'one', operator: 'eq' },
      ],
    },
    { aggregates: [{ id: 'bad', function: 'unsupported' }] },
    { sortBy: 3 },
    { sortDesc: 'false' },
    { groupByColumn: 3 },
    { groupGranularity: 'year' },
  ];
  for (const value of values)
    expect(readTableViewConfiguration(value).issues.length).toBeGreaterThan(0);
});

it('returns safe presentation values while reporting unknown formatting and grouping', () => {
  const result = readTableViewConfiguration({
    derivedColumns: [
      { id: 'one', label: 'One', formula: '1.0', valueKind: 'unknown' },
    ],
    groupGranularity: 'year',
  });
  expect(result.issues.map(issue => issue.field)).toEqual([
    'derivedColumns',
    'groupGranularity',
  ]);
  expect(result.config.derivedColumns[0].valueKind).toBeUndefined();
  expect(result.config.groupGranularity).toBe('day');
});

it('retains derived references for the session to resolve against implicit renderer defaults', () => {
  const result = readTableViewConfiguration({
    kind: 'timer',
    filters: [{ derived: 'duration', value: '1', operator: 'gt' }],
    aggregates: [{ id: 'duration-sum', function: 'sum', derived: 'duration' }],
  });
  expect(result.issues).toEqual([]);
  expect(result.config.filters[0].derived).toBe('duration');
  expect(result.config.aggregates[0].derived).toBe('duration');
  expect(result.config.derivedColumnsSet).toBe(false);
});
