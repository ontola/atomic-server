import {
  Datatype,
  type AggregateFunction,
  type AggregateGrouping,
  type Aggregate,
  type Aggregation,
  type JSONValue,
  type Property,
} from '@tomic/react';
import {
  DERIVED_COLUMN_GENERATORS,
  toExpression,
  type DerivedColumnSpec,
} from './derivedColumns';

/**
 * A statistic a view shows under its rows. Configuration on the View
 * (`view-aggregates`), computed by the store over **every** row the view
 * matches — filters included, paging excluded. So a "Sum of Amount" is the
 * answer for the whole table, not for the rows that happen to be loaded.
 */
export interface TableAggregate {
  /** Stable identity within the view. */
  id: string;
  /** The property whose values are aggregated. Absent for a plain row count. */
  property?: string;
  /**
   * The id of a computed column of this view, when the statistic is over a value
   * computed per row rather than stored on it — a duration, an amount. The store
   * evaluates the column's expression as it aggregates, so a sum of durations
   * covers every matching row like any other total.
   */
  derived?: string;
  function: AggregateFunction;
  /**
   * Which totals row this sits in, counting from 0. A column can carry one
   * statistic per row, so a table can show a sum and an average under the same
   * column. Absent means the first row.
   */
  row?: number;
}

/** How a date or timestamp breakdown column is bucketed. */
export type GroupGranularity = NonNullable<AggregateGrouping['granularity']>;

export const AGGREGATE_FUNCTIONS: AggregateFunction[] = [
  'sum',
  'avg',
  'min',
  'max',
  'count',
];

/** How each function reads in the UI: "Sum of Amount", "Rows". */
export const AGGREGATE_FUNCTION_LABELS: Record<AggregateFunction, string> = {
  sum: 'Sum',
  avg: 'Average',
  min: 'Minimum',
  max: 'Maximum',
  count: 'Count',
};

/** Properties worth summing or averaging. */
export function isNumericProperty(property: Property): boolean {
  return (
    property.datatype === Datatype.INTEGER ||
    property.datatype === Datatype.FLOAT
  );
}

/** Properties whose earliest/latest is meaningful. */
export function isInstantProperty(property: Property): boolean {
  return (
    property.datatype === Datatype.TIMESTAMP ||
    property.datatype === Datatype.DATE
  );
}

/** Which properties a function can be applied to. */
export function propertiesForFunction(
  properties: Property[],
  fn: AggregateFunction,
): Property[] {
  if (fn === 'sum' || fn === 'avg') {
    return properties.filter(isNumericProperty);
  }

  if (fn === 'min' || fn === 'max') {
    return properties.filter(p => isNumericProperty(p) || isInstantProperty(p));
  }

  // Counting works on anything: it counts the rows that have a value at all.
  return properties;
}

/**
 * Which statistics a computed column can carry. A date (a next-due) has no
 * meaningful sum or average; a duration or an amount has all of them.
 */
export function functionsForDerived(
  spec: DerivedColumnSpec,
): AggregateFunction[] {
  return DERIVED_COLUMN_GENERATORS[spec.kind].valueKind === 'date'
    ? ['min', 'max', 'count']
    : ['sum', 'avg', 'min', 'max', 'count'];
}

/**
 * Properties that make sense to break down by. A free-text column would give
 * one bucket per row, so only bounded or bucketable kinds are offered.
 */
export function isGroupableProperty(property: Property): boolean {
  return (
    property.datatype === Datatype.RESOURCEARRAY ||
    property.datatype === Datatype.ATOMIC_URL ||
    property.datatype === Datatype.BOOLEAN ||
    property.datatype === Datatype.SLUG ||
    isInstantProperty(property)
  );
}

/** Dates and timestamps are bucketed; everything else groups by exact value. */
export function granularityApplies(property: Property | undefined): boolean {
  return !!property && isInstantProperty(property);
}

/**
 * The default bucket for a breakdown column: a timestamp's exact values are
 * unique per row, so grouping by them is never what "per day" meant.
 */
export function defaultGranularity(
  property: Property | undefined,
): GroupGranularity {
  return granularityApplies(property) ? 'day' : 'exact';
}

function isAggregate(value: unknown): value is TableAggregate {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const spec = value as Partial<TableAggregate>;

  return (
    typeof spec.id === 'string' &&
    typeof spec.function === 'string' &&
    (AGGREGATE_FUNCTIONS as string[]).includes(spec.function) &&
    (spec.property === undefined || typeof spec.property === 'string') &&
    (spec.derived === undefined || typeof spec.derived === 'string') &&
    (spec.row === undefined ||
      (typeof spec.row === 'number' && Number.isInteger(spec.row)))
  );
}

/**
 * Reads the aggregates stored on a View. Anything malformed is dropped rather
 * than thrown — the same rule the derived columns follow: config can be written
 * by a person or the assistant, and a bad entry must not take the table down.
 */
export function parseAggregates(
  value: JSONValue | undefined,
): TableAggregate[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return (value as unknown[]).filter(isAggregate);
}

/**
 * Turns the view's config into the query's `aggregation`, or undefined when
 * there is nothing to compute (which keeps the query free of the extra pass).
 *
 * The timezone offset travels with it so day and month buckets are the user's
 * days, not UTC's — a 23:30 entry belongs to the day the user was living.
 */
export function toAggregation(
  aggregates: TableAggregate[],
  groupByColumn: string | undefined,
  granularity: GroupGranularity,
  /** The view's computed columns, for the statistics that name one. */
  derivedColumns: DerivedColumnSpec[] = [],
): Aggregation | undefined {
  if (aggregates.length === 0) {
    return undefined;
  }

  const specById = new Map(derivedColumns.map(spec => [spec.id, spec]));

  const requests: Aggregate[] = aggregates.flatMap(
    ({ id, property, derived, function: fn }): Aggregate[] => {
      if (derived === undefined) {
        return [{ id, property, function: fn }];
      }

      const spec = specById.get(derived);
      const expression = spec && toExpression(spec);

      // The column it named is gone (or still incomplete). Asking anyway would
      // return an empty number and read as a broken total, so don't ask.
      return expression ? [{ id, expression, function: fn }] : [];
    },
  );

  if (requests.length === 0) {
    return undefined;
  }

  const live = aggregates.some(aggregate => {
    const spec = aggregate.derived
      ? specById.get(aggregate.derived)
      : undefined;

    return spec ? measuresAgainstNow(spec) : false;
  });

  return {
    // Rows are a display concern; each statistic is asked for once and carries
    // its own id, which is how the outcomes are matched back to it.
    aggregates: requests,
    group_by: groupByColumn
      ? {
          property: groupByColumn,
          granularity,
          tz_offset_minutes: -new Date().getTimezoneOffset(),
        }
      : undefined,
    // Only when something actually measures against the present, and quantized:
    // this value is part of the query's identity, so a raw `Date.now()` would
    // re-run the query on every render. A minute is close enough for a total
    // while the cells themselves tick every second.
    ...(live ? { now_ms: quantizedNow() } : {}),
  };
}

/** How coarsely `now` is passed to the store — see `toAggregation`. */
const NOW_QUANTUM_MS = 60_000;

function quantizedNow(): number {
  return Math.floor(Date.now() / NOW_QUANTUM_MS) * NOW_QUANTUM_MS;
}

/** Whether a computed column's value keeps moving on its own. */
function measuresAgainstNow(spec: DerivedColumnSpec): boolean {
  return spec.kind === 'daysSince' || spec.kind === 'elapsed';
}

/** How many totals rows the configuration needs (always at least one). */
export function aggregateRowCount(aggregates: TableAggregate[]): number {
  return aggregates.reduce(
    (rows, aggregate) => Math.max(rows, (aggregate.row ?? 0) + 1),
    1,
  );
}

/**
 * Matches a configured statistic to the outcome the store returned.
 *
 * By `id` when both sides carry one — two statistics over computed columns name
 * no property, so nothing else tells them apart. The `function:property` form is
 * the fallback for a store that predates the echoed id.
 */
export function aggregateKey(spec: {
  id?: string;
  property?: string;
  function: AggregateFunction;
}): string {
  return spec.id ? `id:${spec.id}` : `${spec.function}:${spec.property ?? ''}`;
}

/**
 * Formats a computed value for display, using the datatype of the property it
 * came from: the earliest of a date column is a date, a sum of amounts is a
 * number, and a count is always a plain integer.
 */
export function formatAggregateValue(
  value: number | null | undefined,
  fn: AggregateFunction,
  property: Property | undefined,
  /** The computed column the number came from, when it wasn't a property. */
  derived?: DerivedColumnSpec,
): string {
  if (value === null || value === undefined) {
    // Nothing to compute is not zero, and must not read as zero.
    return '—';
  }

  if (fn === 'count') {
    return value.toLocaleString();
  }

  // A sum of durations is a duration: format it the way the column itself does,
  // or "5:30:00" of logged time reads as 19800000.
  if (derived) {
    return DERIVED_COLUMN_GENERATORS[derived.kind].format(value);
  }

  if (
    (fn === 'min' || fn === 'max') &&
    property &&
    isInstantProperty(property)
  ) {
    const date = new Date(value);

    return property.datatype === Datatype.DATE
      ? date.toLocaleDateString()
      : date.toLocaleString();
  }

  return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

/** Formats a bucket key for display. Subjects are resolved by the caller. */
export function formatGroupKey(
  key: string,
  granularity: GroupGranularity,
): string {
  if (key === '') {
    return '(none)';
  }

  if (granularity === 'day') {
    const parsed = Date.parse(key);

    return Number.isNaN(parsed)
      ? key
      : new Date(parsed).toLocaleDateString(undefined, {
          weekday: 'short',
          day: 'numeric',
          month: 'short',
          year: 'numeric',
        });
  }

  if (granularity === 'month') {
    const parsed = Date.parse(`${key}-01`);

    return Number.isNaN(parsed)
      ? key
      : new Date(parsed).toLocaleDateString(undefined, {
          month: 'long',
          year: 'numeric',
        });
  }

  return key;
}
