import { describe, expect, it } from 'vitest';
import {
  GRID_COLUMNS,
  defaultSizeFor,
  isBlockKind,
  measureKeepingTarget,
  parseBlockAggregate,
  parseBlockChartSpec,
  parseLayout,
  staleOnTableChange,
} from './dashboardBlocks';

/**
 * Every one of these functions reads configuration a person or an LLM wrote, so
 * the contract under test is the same throughout: understand what fits, drop what
 * doesn't, and never throw. One bad block must not take a page down.
 */
describe('block kinds', () => {
  it('accepts the four kinds and nothing else', () => {
    expect(isBlockKind('stat')).toBe(true);
    expect(isBlockKind('chart')).toBe(true);
    expect(isBlockKind('view')).toBe(true);
    expect(isBlockKind('text')).toBe(true);
    expect(isBlockKind('gauge')).toBe(false);
    expect(isBlockKind(undefined)).toBe(false);
    expect(isBlockKind(42)).toBe(false);
  });

  it('sizes a number smaller than a table', () => {
    expect(defaultSizeFor('stat').w).toBeLessThan(defaultSizeFor('view').w);
    expect(defaultSizeFor('view').w).toBe(GRID_COLUMNS);
  });
});

describe('parseBlockAggregate', () => {
  it('reads a function and a property', () => {
    expect(
      parseBlockAggregate({ function: 'sum', property: 'https://x/amount' }),
    ).toEqual({ function: 'sum', property: 'https://x/amount' });
  });

  it('lets count stand alone, because counting rows needs no column', () => {
    expect(parseBlockAggregate({ function: 'count' })).toEqual({
      function: 'count',
    });
  });

  it('drops a sum with nothing to sum', () => {
    // Asking anyway would answer null, which reads as a broken statistic
    // rather than as unfinished configuration.
    expect(parseBlockAggregate({ function: 'sum' })).toBeUndefined();
  });

  it('reads a computed column as the target', () => {
    expect(
      parseBlockAggregate({ function: 'sum', derived: 'duration' }),
    ).toEqual({ function: 'sum', derived: 'duration' });
  });

  it('drops an unknown function and any non-object', () => {
    expect(
      parseBlockAggregate({ function: 'median', property: 'x' }),
    ).toBeUndefined();
    expect(parseBlockAggregate('sum')).toBeUndefined();
    expect(parseBlockAggregate([])).toBeUndefined();
    expect(parseBlockAggregate(undefined)).toBeUndefined();
  });
});

describe('measureKeepingTarget', () => {
  it('changes the function and keeps the column', () => {
    // `configure_block` touches only the fields it is given, and that applies
    // inside `measure` too: "average instead of sum" names no column.
    expect(
      measureKeepingTarget(
        { function: 'sum', property: 'https://x/amount' },
        'avg',
      ),
    ).toEqual({ function: 'avg', property: 'https://x/amount' });
  });

  it('keeps a computed column just the same', () => {
    expect(
      measureKeepingTarget({ function: 'sum', derived: 'duration' }, 'max'),
    ).toEqual({ function: 'max', derived: 'duration' });
  });

  it('lets count stand alone, whatever was there before', () => {
    expect(
      measureKeepingTarget(
        { function: 'sum', property: 'https://x/a' },
        'count',
      ),
    ).toEqual({ function: 'count' });
    expect(measureKeepingTarget(undefined, 'count')).toEqual({
      function: 'count',
    });
  });

  it('refuses when there is nothing to keep', () => {
    // Writing `{ function: 'sum' }` alone produces a spec every reader rejects,
    // which empties the block silently instead of reporting the instruction was
    // incomplete.
    expect(() => measureKeepingTarget(undefined, 'sum')).toThrow(
      /needs a column/,
    );
    expect(() => measureKeepingTarget({ function: 'count' }, 'avg')).toThrow(
      /needs a column/,
    );
  });
});

describe('parseBlockChartSpec', () => {
  it('reads the flat shape a config dialog writes', () => {
    expect(
      parseBlockChartSpec({ field: 'https://x/category', granularity: 'day' }),
    ).toEqual({
      mark: 'bar',
      field: 'https://x/category',
      granularity: 'day',
    });
  });

  it('reads the Vega-Lite shape an LLM writes', () => {
    expect(
      parseBlockChartSpec({
        mark: 'bar',
        encoding: { x: { field: 'https://x/date', granularity: 'month' } },
      }),
    ).toEqual({ mark: 'bar', field: 'https://x/date', granularity: 'month' });
  });

  it('accepts timeUnit as a spelling of the bucket, since Vega-Lite calls it that', () => {
    expect(
      parseBlockChartSpec({ encoding: { x: { field: 'f', timeUnit: 'day' } } }),
    ).toEqual({ mark: 'bar', field: 'f', granularity: 'day' });
  });

  it('refuses a mark it cannot draw rather than drawing bars anyway', () => {
    // Silently substituting bars for a requested line would misrepresent the
    // stored spec.
    expect(parseBlockChartSpec({ mark: 'line', field: 'f' })).toBeUndefined();
  });

  it('drops a bucket it does not know', () => {
    expect(
      parseBlockChartSpec({ field: 'f', granularity: 'fortnight' }),
    ).toEqual({ mark: 'bar', field: 'f' });
  });
});

describe('staleOnTableChange', () => {
  it('drops everything that named the old table', () => {
    // A view belongs to one table, a measure names one of its columns, a chart
    // buckets by one. None survives being repointed.
    expect(staleOnTableChange({})).toEqual(['view', 'measure', 'chart']);
  });

  it('leaves alone whatever the same change replaces', () => {
    expect(staleOnTableChange({ view: true })).toEqual(['measure', 'chart']);
    expect(
      staleOnTableChange({ view: true, measure: true, chart: true }),
    ).toEqual([]);
  });
});

describe('parseLayout', () => {
  it('reads sizes and rounds them onto the grid', () => {
    expect(parseLayout([{ subject: 'a', w: 3.6, h: 2 }])).toEqual([
      { subject: 'a', w: 4, h: 2 },
    ]);
  });

  it('clamps a size larger than the grid instead of dropping it', () => {
    // Half a decision is still a decision; the grid can honour what fits.
    expect(parseLayout([{ subject: 'a', w: 40, h: 0 }])).toEqual([
      { subject: 'a', w: GRID_COLUMNS, h: 1 },
    ]);
  });

  it('reads past coordinates an older dashboard carries', () => {
    // `x`/`y` were stored before anything read them. The sizes beside them are
    // still what their author chose, so the entry is kept and they are dropped.
    expect(parseLayout([{ subject: 'a', x: 3, y: 1, w: 6, h: 2 }])).toEqual([
      { subject: 'a', w: 6, h: 2 },
    ]);
  });

  it('drops entries that are not sizes, and non-arrays entirely', () => {
    expect(parseLayout([{ subject: 'a' }, 'nope'])).toEqual([]);
    expect(parseLayout({ subject: 'a' })).toEqual([]);
    expect(parseLayout(undefined)).toEqual([]);
  });
});
