import {
  Datatype,
  type AggregateFunction,
  type AggregateGrouping,
  type Aggregation,
  type JSONValue,
  type Property,
} from '@tomic/react';

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
): Aggregation | undefined {
  if (aggregates.length === 0) {
    return undefined;
  }

  return {
    // Rows are a display concern; the store is asked for each distinct
    // (property, function) once, and two rows asking the same thing share it.
    aggregates: aggregates.map(({ property, function: fn }) => ({
      property,
      function: fn,
    })),
    group_by: groupByColumn
      ? {
          property: groupByColumn,
          granularity,
          tz_offset_minutes: -new Date().getTimezoneOffset(),
        }
      : undefined,
  };
}

/** How many totals rows the configuration needs (always at least one). */
export function aggregateRowCount(aggregates: TableAggregate[]): number {
  return aggregates.reduce(
    (rows, aggregate) => Math.max(rows, (aggregate.row ?? 0) + 1),
    1,
  );
}

/** `sum:<property>` — matches a stored spec to the outcome the store returned. */
export function aggregateKey(spec: {
  property?: string;
  function: AggregateFunction;
}): string {
  return `${spec.function}:${spec.property ?? ''}`;
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
): string {
  if (value === null || value === undefined) {
    // Nothing to compute is not zero, and must not read as zero.
    return '—';
  }

  if (fn === 'count') {
    return value.toLocaleString();
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
