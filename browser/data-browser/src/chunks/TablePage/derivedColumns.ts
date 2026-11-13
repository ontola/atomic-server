import { bindTableFormula as bindFormula } from '@tomic/table';

export {
  bindTableFormula as bindFormula,
  tableFormulaColumnSlugs as columnSlugs,
  tableFormulaColumnSlug as columnSlug,
  tableFormulaIdentifiers as formulaIdentifiers,
  inferTableDerivedValueKind as inferValueKind,
} from '@tomic/table';
import {
  Datatype,
  type JSONValue,
  type Property,
  type Resource,
} from '@tomic/react';
import { calendarDateToLocalDate } from '@helpers/dates/calendarDate';
import { stringToSlug } from '@helpers/stringToSlug';
import { evaluateFormula, localOffsetMinutes } from './formulaEngine';
import { formatClock } from './helpers/formatDuration';

/**
 * A column whose value is computed from the row rather than stored on it: a
 * duration, a days-since, an amount, "birthday within two weeks". Configuration,
 * not code — the View lists them in `view-derived-columns` and every view kind
 * renders them. See `planning/table-templates-and-mini-apps.md`.
 *
 * The value is a formula (evaluated by the Rust `evalexpr` crate, in the browser
 * and in the store alike) over `vars`, which bind the identifiers it uses to
 * property subjects: `coalesce(until, now()) - start`.
 */
import { type DerivedColumnSpec, type DerivedValueKind } from '@tomic/table';

export {
  DEFAULT_DERIVED_WIDTH,
  parseDerivedColumnSpecs,
  type DerivedColumnSpec,
  type DerivedValueKind,
} from '@tomic/table';

/** `3d ago` / `today` / `in 5d` — a days-since reads as a distance, not a count. */
function formatDays(days: number): string {
  if (days === 0) {
    return 'today';
  }

  return days > 0 ? `${days}d ago` : `in ${-days}d`;
}

const FORMATTERS: Record<DerivedValueKind, (value: number) => string> = {
  duration: formatClock,
  days: formatDays,
  // Amounts keep two decimals unless they're whole (`12` / `127.50`).
  number: value => (Number.isInteger(value) ? String(value) : value.toFixed(2)),
  // A formula reads a DATE as midnight at the zone's *current* offset
  // (`localOffsetMinutes`), so it is shown through the same offset: through the
  // browser's own zone a January date read in summer would show a day early.
  date: instant =>
    new Date(instant + localOffsetMinutes() * 60_000).toLocaleDateString(
      undefined,
      { timeZone: 'UTC' },
    ),
  boolean: value => (value ? '✓' : ''),
};

export function formatDerivedValue(
  spec: Pick<DerivedColumnSpec, 'valueKind'>,
  value: number,
): string {
  return FORMATTERS[spec.valueKind ?? 'number'](value);
}

export {
  tableDerivedExpression as toExpression,
  tableDerivedDependsOnNow as dependsOnNow,
} from '@tomic/table';
import { tableDerivedExpression as toExpression } from '@tomic/table';

/**
 * True while a cell's value ticks on its own every second: a running duration.
 * A days count changes once a day, so it does not subscribe to the ticker.
 */
export function isLive(spec: DerivedColumnSpec): boolean {
  return spec.valueKind === 'duration' && /\bnow\s*\(/.test(spec.formula);
}

/** The value for one row, from the current values of its properties. */
export function computeDerived(
  spec: DerivedColumnSpec,
  values: Record<string, JSONValue | undefined>,
  now: number,
): number | undefined {
  const expression = toExpression(spec);

  if (!expression) {
    return undefined;
  }

  return evaluateFormula(expression, values, now);
}

/** The property subjects a spec reads. */
export function specProperties(spec: DerivedColumnSpec): string[] {
  return [...new Set(Object.values(spec.vars))];
}

/** Pulls a spec's inputs off a row — for callers outside of render. */
export function rowValuesOf(
  row: Resource,
  spec: DerivedColumnSpec,
): Record<string, JSONValue | undefined> {
  return Object.fromEntries(
    specProperties(spec).map(property => [
      property,
      row.get(property) as JSONValue | undefined,
    ]),
  );
}

/**
 * Reads an instant: a TIMESTAMP is already a number of millis, a DATE is an ISO
 * day string — both place the row in time, so both are usable.
 */
export function readInstant(
  values: Record<string, JSONValue | undefined>,
  property: string,
): number | undefined {
  const value = values[property];

  if (typeof value === 'number') {
    return value;
  }

  if (typeof value === 'string') {
    // A civil date has no zone: read it as local midnight, like the local
    // date-and-time inputs, not as the UTC midnight `Date.parse` gives.
    const local = calendarDateToLocalDate(value);

    if (local) {
      return local.getTime();
    }

    const parsed = Date.parse(value);

    return Number.isNaN(parsed) ? undefined : parsed;
  }

  return undefined;
}

// --- Naming columns in a formula -------------------------------------------

/** Whether a property holds something a formula can read as a number. */
export function isFormulaProperty(property: Property): boolean {
  return [
    Datatype.INTEGER,
    Datatype.FLOAT,
    Datatype.TIMESTAMP,
    Datatype.DATE,
    Datatype.BOOLEAN,
  ].includes(property.datatype);
}

/** Builds a spec from a name and a formula that names columns by slug. */
export function specFromFormula(
  label: string,
  formula: string,
  slugs: Record<string, string>,
  rest: Partial<Pick<DerivedColumnSpec, 'id' | 'valueKind' | 'width'>> = {},
): DerivedColumnSpec {
  return {
    id: rest.id ?? stringToSlug(label),
    label,
    formula,
    vars: bindFormula(formula, slugs).vars,
    ...(rest.valueKind ? { valueKind: rest.valueKind } : {}),
    ...(rest.width ? { width: rest.width } : {}),
  };
}
