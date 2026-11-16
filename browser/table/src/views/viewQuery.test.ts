import { expect, it } from 'vitest';
import { readTableViewConfiguration } from './configuration.js';
import { compileTableViewQuery } from './viewQuery.js';

const options = {
  scope: { table: 'table', rowClass: 'class' },
  pageSize: 30,
  now: 123_456,
  timezoneOffsetMinutes: 120,
};
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
