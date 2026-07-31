import { describe, it, expect } from 'vitest';
import { Datatype, type JSONValue, type Property } from '@tomic/react';
import {
  defaultGranularity,
  formatAggregateValue,
  formatGroupKey,
  isGroupableProperty,
  parseAggregates,
  propertiesForFunction,
  toAggregation,
} from './tableAggregates';

const property = (datatype: Datatype, shortname = 'x'): Property =>
  ({
    subject: `https://example.com/property/${shortname}`,
    datatype,
    shortname,
  }) as Property;

const AMOUNT = property(Datatype.INTEGER, 'amount');
const RATE = property(Datatype.FLOAT, 'rate');
const START = property(Datatype.TIMESTAMP, 'start');
const DAY = property(Datatype.DATE, 'day');
const TITLE = property(Datatype.STRING, 'title');
const STATUS = property(Datatype.RESOURCEARRAY, 'status');

describe('which columns a function accepts', () => {
  const all = [AMOUNT, RATE, START, DAY, TITLE, STATUS];

  it('sums and averages numbers only', () => {
    expect(propertiesForFunction(all, 'sum')).toEqual([AMOUNT, RATE]);
    expect(propertiesForFunction(all, 'avg')).toEqual([AMOUNT, RATE]);
  });

  it('takes the earliest/latest of dates as well as numbers', () => {
    expect(propertiesForFunction(all, 'min')).toEqual([
      AMOUNT,
      RATE,
      START,
      DAY,
    ]);
  });

  it('counts anything — it counts the rows that have a value', () => {
    expect(propertiesForFunction(all, 'count')).toEqual(all);
  });
});

describe('which columns can be broken down by', () => {
  it('offers bounded and bucketable columns', () => {
    expect(isGroupableProperty(STATUS)).toBe(true);
    expect(isGroupableProperty(START)).toBe(true);
    expect(isGroupableProperty(DAY)).toBe(true);
    // A free-text column would give one bucket per row.
    expect(isGroupableProperty(TITLE)).toBe(false);
    expect(isGroupableProperty(AMOUNT)).toBe(false);
  });

  it('buckets timestamps per day by default', () => {
    // Grouping a timestamp by its exact value is one group per row.
    expect(defaultGranularity(START)).toBe('day');
    expect(defaultGranularity(STATUS)).toBe('exact');
  });
});

describe('toAggregation', () => {
  const sumAmount = {
    id: 'sum',
    property: AMOUNT.subject,
    function: 'sum' as const,
  };

  it('is undefined with nothing to compute, so the query stays cheap', () => {
    expect(toAggregation([], undefined, 'day')).toBeUndefined();
  });

  it('passes the aggregates through, without a breakdown', () => {
    expect(toAggregation([sumAmount], undefined, 'day')).toEqual({
      aggregates: [{ property: AMOUNT.subject, function: 'sum' }],
      group_by: undefined,
    });
  });

  it('sends the local timezone offset with a breakdown', () => {
    const aggregation = toAggregation([sumAmount], START.subject, 'day');

    expect(aggregation?.group_by).toEqual({
      property: START.subject,
      granularity: 'day',
      // Days must be the user's days: a 23:30 entry belongs to the day they
      // were living, not to UTC's.
      tz_offset_minutes: -new Date().getTimezoneOffset(),
    });
  });
});

describe('parseAggregates', () => {
  const valid = { id: 'sum', property: AMOUNT.subject, function: 'sum' };

  it('reads the stored array', () => {
    expect(parseAggregates([valid])).toEqual([valid]);
  });

  it('drops malformed entries rather than throwing', () => {
    expect(
      parseAggregates([
        valid,
        { ...valid, function: 'median' },
        { property: AMOUNT.subject },
        'nonsense',
      ] as unknown as JSONValue),
    ).toEqual([valid]);
  });

  it('is empty for unset config', () => {
    expect(parseAggregates(undefined)).toEqual([]);
  });
});

describe('formatting', () => {
  it('shows nothing-to-compute as a dash, not as zero', () => {
    expect(formatAggregateValue(null, 'sum', AMOUNT)).toBe('—');
    expect(formatAggregateValue(0, 'sum', AMOUNT)).toBe('0');
  });

  it('formats the earliest of a date column as a date', () => {
    const stamp = Date.parse('2026-07-30T12:00:00Z');

    expect(formatAggregateValue(stamp, 'min', START)).toContain('2026');
    // A sum of the same numbers is a number, not a date.
    expect(formatAggregateValue(stamp, 'sum', START)).not.toContain('2026-');
  });

  it('labels the bucket that has no value', () => {
    expect(formatGroupKey('', 'exact')).toBe('(none)');
  });

  it('formats day and month buckets, and leaves other keys alone', () => {
    expect(formatGroupKey('2026-07-30', 'day')).toContain('2026');
    expect(formatGroupKey('2026-07', 'month')).toContain('2026');
    expect(formatGroupKey('true', 'exact')).toBe('true');
  });
});
