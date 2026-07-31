import { describe, it, expect } from 'vitest';
import {
  Datatype,
  type JSONValue,
  type Property,
  type Resource,
} from '@tomic/react';
import {
  DERIVED_COLUMN_GENERATORS,
  isDerivedColumnComplete,
  parseDerivedColumnSpecs,
  propertyFitsArg,
} from './derivedColumns';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const START = 'https://example.com/property/start';
const END = 'https://example.com/property/end';
const QUANTITY = 'https://example.com/property/quantity';
const PRICE = 'https://example.com/property/price';
const LAST_DONE = 'https://example.com/property/last-done';

/** A row, seen the only way a generator sees one: `get(property)`. */
function row(values: Record<string, JSONValue>): Resource {
  return {
    get: (property: string) => values[property],
  } as unknown as Resource;
}

const NOW = Date.parse('2026-07-30T12:00:00.000Z');

describe('difference', () => {
  const { compute, format } = DERIVED_COLUMN_GENERATORS.difference;

  it('is the span between the two properties', () => {
    const value = compute(
      row({ [START]: NOW - HOUR, [END]: NOW }),
      { from: START, to: END },
      NOW,
    );

    expect(value).toBe(HOUR);
    expect(format(value!)).toBe('1:00:00');
  });

  it('is empty while either end is missing', () => {
    const args = { from: START, to: END };
    expect(compute(row({ [START]: NOW }), args, NOW)).toBeUndefined();
    expect(compute(row({ [END]: NOW }), args, NOW)).toBeUndefined();
  });
});

describe('elapsed', () => {
  const { compute, live } = DERIVED_COLUMN_GENERATORS.elapsed;
  const args = { from: START, until: END };

  it('counts from `from` to now while `until` is unset', () => {
    const entry = row({ [START]: NOW - 5 * MINUTE });

    expect(compute(entry, args, NOW)).toBe(5 * MINUTE);
    expect(live!(entry, args)).toBe(true);
  });

  it('stops at `until` once it is stamped', () => {
    const entry = row({ [START]: NOW - HOUR, [END]: NOW - 30 * MINUTE });

    // Still 30 minutes an hour later: a stopped entry does not keep growing.
    expect(compute(entry, args, NOW + HOUR)).toBe(30 * MINUTE);
    expect(live!(entry, args)).toBe(false);
  });

  it('is empty, and not live, without a start', () => {
    const entry = row({});

    expect(compute(entry, args, NOW)).toBeUndefined();
    expect(live!(entry, args)).toBe(false);
  });
});

describe('daysSince', () => {
  const { compute, format } = DERIVED_COLUMN_GENERATORS.daysSince;
  const args = { from: LAST_DONE };

  it('counts whole days, and reads DATE properties too', () => {
    expect(compute(row({ [LAST_DONE]: NOW - 3 * DAY }), args, NOW)).toBe(3);
    // A DATE property stores an ISO day rather than a number of millis.
    expect(compute(row({ [LAST_DONE]: '2026-07-27' }), args, NOW)).toBe(3);
  });

  it('reads as a distance', () => {
    expect(format(0)).toBe('today');
    expect(format(3)).toBe('3d ago');
    expect(format(-5)).toBe('in 5d');
  });
});

describe('product', () => {
  const { compute, format } = DERIVED_COLUMN_GENERATORS.product;

  it('multiplies two properties', () => {
    expect(
      compute(
        row({ [QUANTITY]: 3, [PRICE]: 25 }),
        { a: QUANTITY, b: PRICE },
        NOW,
      ),
    ).toBe(75);
  });

  it('accepts a literal factor, so a rate needs no column', () => {
    expect(compute(row({ [QUANTITY]: 4 }), { a: QUANTITY, b: 85 }, NOW)).toBe(
      340,
    );
  });

  it('keeps two decimals unless the amount is whole', () => {
    expect(format(75)).toBe('75');
    expect(format(127.5)).toBe('127.50');
  });
});

describe('offset', () => {
  const { compute } = DERIVED_COLUMN_GENERATORS.offset;

  it('is the date plus the interval', () => {
    expect(
      compute(row({ [LAST_DONE]: NOW }), { from: LAST_DONE, days: 14 }, NOW),
    ).toBe(NOW + 14 * DAY);
  });

  it('is empty without an interval', () => {
    expect(
      compute(row({ [LAST_DONE]: NOW }), { from: LAST_DONE }, NOW),
    ).toBeUndefined();
  });
});

describe('the column dialog’s gates', () => {
  const property = (datatype: Datatype): Property =>
    ({ subject: START, datatype, shortname: 'x' }) as Property;

  it('offers date and time columns for an instant argument', () => {
    expect(propertyFitsArg(property(Datatype.TIMESTAMP), 'instant')).toBe(true);
    expect(propertyFitsArg(property(Datatype.DATE), 'instant')).toBe(true);
    expect(propertyFitsArg(property(Datatype.STRING), 'instant')).toBe(false);
    // A number is an instant to nobody: picking one here reads as a bug.
    expect(propertyFitsArg(property(Datatype.INTEGER), 'instant')).toBe(false);
  });

  it('offers numeric columns for a number argument', () => {
    expect(propertyFitsArg(property(Datatype.INTEGER), 'number')).toBe(true);
    expect(propertyFitsArg(property(Datatype.FLOAT), 'number')).toBe(true);
    expect(propertyFitsArg(property(Datatype.TIMESTAMP), 'number')).toBe(false);
  });

  it('only accepts a spec once its required arguments are filled', () => {
    const spec = {
      id: 'duration',
      label: 'Duration',
      kind: 'elapsed' as const,
      args: {},
    };

    // `elapsed` needs a start; its end is optional (that's what "running" is).
    expect(isDerivedColumnComplete(spec)).toBe(false);
    expect(isDerivedColumnComplete({ ...spec, args: { from: START } })).toBe(
      true,
    );
    expect(isDerivedColumnComplete({ ...spec, args: { from: '' } })).toBe(
      false,
    );
    // A literal 0 is a filled-in argument, not an empty one.
    expect(
      isDerivedColumnComplete({
        ...spec,
        kind: 'offset',
        args: { from: START, days: 0 },
      }),
    ).toBe(true);
  });
});

describe('parseDerivedColumnSpecs', () => {
  const valid = {
    id: 'duration',
    label: 'Duration',
    kind: 'elapsed',
    args: { from: START, until: END },
  };

  it('reads the stored array', () => {
    expect(parseDerivedColumnSpecs([valid])).toEqual([valid]);
  });

  it('drops malformed specs rather than throwing', () => {
    // Config can be hand-written or assistant-written; a bad entry must not be
    // able to take the whole table down.
    expect(
      parseDerivedColumnSpecs([
        valid,
        { ...valid, kind: 'formula' },
        { ...valid, args: { from: { nested: true } } },
        { label: 'No kind' },
        'nonsense',
      ] as unknown as JSONValue),
    ).toEqual([valid]);
  });

  it('is empty for unset or non-array config', () => {
    expect(parseDerivedColumnSpecs(undefined)).toEqual([]);
    expect(parseDerivedColumnSpecs('{}' as unknown as JSONValue)).toEqual([]);
  });
});
