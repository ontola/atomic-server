import {
  Datatype,
  type JSONValue,
  type Property,
  type Resource,
} from '@tomic/react';
import { formatClock } from './helpers/formatDuration';

/**
 * A column whose value is computed from the row rather than stored on it: a
 * duration, a days-since, an amount. Configuration, not code — the View lists
 * them in `view-derived-columns` and every view kind renders them, so a
 * mini-app that needs one is a template, not a renderer. See
 * `planning/table-templates-and-mini-apps.md`.
 *
 * Deliberately a fixed set of generators rather than a formula language: these
 * five cover every mini-app on that list, and a formula language can wait until
 * one of them doesn't.
 */
export type DerivedColumnKind =
  | 'difference'
  | 'elapsed'
  | 'daysSince'
  | 'product'
  | 'offset';

/** Either a property subject to read off the row, or a literal number. */
export type DerivedColumnArg = string | number;

export interface DerivedColumnSpec {
  /** Stable identity within the view — the grid column key. */
  id: string;
  /** Heading label. */
  label: string;
  kind: DerivedColumnKind;
  /** The generator's arguments, by the names it declares. */
  args: Record<string, DerivedColumnArg>;
  /** Column width in px. Falls back to the generator's default. */
  width?: number;
}

/**
 * One argument of a generator, described richly enough for the column dialog to
 * build its own form — which properties may fill it, whether a number can be
 * typed instead, whether it may be left empty.
 */
export interface DerivedColumnArgSpec {
  /** Field label in the column dialog. */
  label: string;
  /** Which of the class's properties can fill this argument. */
  accepts: 'instant' | 'number';
  /** True when a fixed number may be typed in instead of picking a property. */
  allowsLiteral?: boolean;
  /** True when the column still computes with this argument left empty. */
  optional?: boolean;
}

interface DerivedColumnGenerator {
  /** Name of this generator in the "add computed column" picker. */
  title: string;
  /** One line saying what it computes, shown under the picker. */
  description: string;
  /** Prefills the column name. */
  defaultLabel: string;
  /** The arguments this generator reads. */
  args: Record<string, DerivedColumnArgSpec>;
  /** Default column width in px. */
  width: number;
  /**
   * The value to show, or undefined for an empty cell. `now` is only read by
   * generators that measure against the present.
   */
  compute: (
    row: Resource,
    args: Record<string, DerivedColumnArg>,
    now: number,
  ) => number | undefined;
  format: (value: number) => string;
  /**
   * True while this row's value keeps changing on its own, so its cell
   * subscribes to the 1s ticker (and is emphasised as live).
   */
  live?: (row: Resource, args: Record<string, DerivedColumnArg>) => boolean;
}

const DAY_MS = 86_400_000;

/**
 * Reads an instant off a row: a TIMESTAMP is already a number of millis, a DATE
 * is an ISO day string — both place the row in time, so both are usable.
 */
export function readInstant(
  row: Resource,
  arg: DerivedColumnArg | undefined,
): number | undefined {
  if (typeof arg === 'number') {
    return arg;
  }

  if (typeof arg !== 'string' || arg === '') {
    return undefined;
  }

  const value = row.get(arg) as JSONValue | undefined;

  if (typeof value === 'number') {
    return value;
  }

  if (typeof value === 'string') {
    const parsed = Date.parse(value);

    return Number.isNaN(parsed) ? undefined : parsed;
  }

  return undefined;
}

/** Reads a plain number: the literal itself, or the row's value for a property. */
function readNumber(
  row: Resource,
  arg: DerivedColumnArg | undefined,
): number | undefined {
  if (typeof arg === 'number') {
    return arg;
  }

  if (typeof arg !== 'string' || arg === '') {
    return undefined;
  }

  const value = row.get(arg) as JSONValue | undefined;

  return typeof value === 'number' ? value : undefined;
}

/** `3d ago` / `today` / `in 5d` — a days-since reads as a distance, not a count. */
function formatDays(days: number): string {
  if (days === 0) {
    return 'today';
  }

  return days > 0 ? `${days}d ago` : `in ${-days}d`;
}

/** Amounts keep two decimals unless they're whole (`12` / `127.50`). */
function formatAmount(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function formatDate(instant: number): string {
  return new Date(instant).toLocaleDateString();
}

export const DERIVED_COLUMN_GENERATORS: Record<
  DerivedColumnKind,
  DerivedColumnGenerator
> = {
  /** `to − from`: a finished duration, a lead time. */
  difference: {
    title: 'Time between two dates',
    description:
      'The span from one date or time column to another, as a clock.',
    defaultLabel: 'Duration',
    args: {
      from: { label: 'From', accepts: 'instant' },
      to: { label: 'To', accepts: 'instant' },
    },
    width: 130,
    compute: (row, args) => {
      const from = readInstant(row, args.from);
      const to = readInstant(row, args.to);

      return from === undefined || to === undefined ? undefined : to - from;
    },
    format: formatClock,
  },
  /**
   * `(until ?? now) − from`: the ticking variant. A row with a `from` but no
   * `until` is still running, which is exactly what a timer entry is.
   */
  elapsed: {
    title: 'Live duration',
    description:
      'Counts up from a start until an end is filled in — a row without an end is still running.',
    defaultLabel: 'Duration',
    args: {
      from: { label: 'Start', accepts: 'instant' },
      until: { label: 'End', accepts: 'instant', optional: true },
    },
    width: 130,
    compute: (row, args, now) => {
      const from = readInstant(row, args.from);

      if (from === undefined) {
        return undefined;
      }

      return (readInstant(row, args.until) ?? now) - from;
    },
    format: formatClock,
    live: (row, args) =>
      readInstant(row, args.from) !== undefined &&
      readInstant(row, args.until) === undefined,
  },
  /** Whole days between `from` and now — "days since last contact". */
  daysSince: {
    title: 'Days since',
    description: 'Whole days between a date column and today.',
    defaultLabel: 'Days since',
    args: { from: { label: 'Date', accepts: 'instant' } },
    width: 110,
    compute: (row, args, now) => {
      const from = readInstant(row, args.from);

      return from === undefined ? undefined : Math.floor((now - from) / DAY_MS);
    },
    format: formatDays,
  },
  /** `a × b` — quantity × price, hours × rate. Either side may be a literal. */
  product: {
    title: 'Multiplication',
    description:
      'Two numbers multiplied — quantity × price, hours × rate. Either side can be a fixed number.',
    defaultLabel: 'Total',
    args: {
      a: { label: 'First value', accepts: 'number', allowsLiteral: true },
      b: { label: 'Second value', accepts: 'number', allowsLiteral: true },
    },
    width: 110,
    compute: (row, args) => {
      const a = readNumber(row, args.a);
      const b = readNumber(row, args.b);

      return a === undefined || b === undefined ? undefined : a * b;
    },
    format: formatAmount,
  },
  /** `from + days` — a next-due date from a last-done date and an interval. */
  offset: {
    title: 'Date plus days',
    description:
      'A date shifted by a number of days — a next-due date from a last-done date and an interval.',
    defaultLabel: 'Next due',
    args: {
      from: { label: 'Date', accepts: 'instant' },
      days: { label: 'Days', accepts: 'number', allowsLiteral: true },
    },
    width: 130,
    compute: (row, args) => {
      const from = readInstant(row, args.from);
      const days = readNumber(row, args.days);

      return from === undefined || days === undefined
        ? undefined
        : from + days * DAY_MS;
    },
    format: formatDate,
  },
};

/** The kinds, in the order the column dialog offers them. */
export const DERIVED_COLUMN_KINDS: DerivedColumnKind[] = [
  'elapsed',
  'difference',
  'daysSince',
  'product',
  'offset',
];

/** Whether a property can fill an argument that `accepts` this kind of value. */
export function propertyFitsArg(
  property: Property,
  accepts: DerivedColumnArgSpec['accepts'],
): boolean {
  if (accepts === 'instant') {
    return (
      property.datatype === Datatype.TIMESTAMP ||
      property.datatype === Datatype.DATE
    );
  }

  return (
    property.datatype === Datatype.INTEGER ||
    property.datatype === Datatype.FLOAT
  );
}

/** True once every argument the generator requires is filled in. */
export function isDerivedColumnComplete(spec: DerivedColumnSpec): boolean {
  const generator = DERIVED_COLUMN_GENERATORS[spec.kind];

  if (!generator) {
    return false;
  }

  return Object.entries(generator.args).every(([name, arg]) => {
    if (arg.optional) {
      return true;
    }

    const value = spec.args[name];

    return (
      typeof value === 'number' || (typeof value === 'string' && value !== '')
    );
  });
}

function isSpec(value: unknown): value is DerivedColumnSpec {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const spec = value as Partial<DerivedColumnSpec>;

  return (
    typeof spec.id === 'string' &&
    typeof spec.label === 'string' &&
    typeof spec.kind === 'string' &&
    spec.kind in DERIVED_COLUMN_GENERATORS &&
    typeof spec.args === 'object' &&
    spec.args !== null &&
    Object.values(spec.args).every(
      arg => typeof arg === 'string' || typeof arg === 'number',
    )
  );
}

/**
 * Reads the specs stored on a View. Anything malformed is dropped rather than
 * thrown: hand-edited (or assistant-written) config must not be able to take
 * the whole table down with it.
 */
export function parseDerivedColumnSpecs(
  value: JSONValue | undefined,
): DerivedColumnSpec[] {
  if (!Array.isArray(value)) {
    return [];
  }

  // Through `unknown[]`: a spec is a narrower shape than `JSONValue`, which the
  // predicate overload of `filter` won't accept directly.
  return (value as unknown[]).filter(isSpec);
}
