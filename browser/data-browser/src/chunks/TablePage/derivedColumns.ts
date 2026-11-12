import {
  Datatype,
  type Expression,
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

/**
 * How to show a formula's result, guessed from its shape so a typed formula
 * needs no setting: a comparison is true or false, a span between two instants
 * is a duration, `days(..)` counts days, `addDays(..)` is a date.
 */
export function inferValueKind(
  formula: string,
  /** Whether every column the formula reads is a date or a datetime. */
  readsInstants: boolean,
): DerivedValueKind | undefined {
  const operand = String.raw`(?:coalesce\((?:[^()]|\(\))*\)|\w+|now\(\))`;

  if (/[<>]=?|[!=]=|&&|\|\|/.test(formula)) {
    return 'boolean';
  }

  if (
    readsInstants &&
    new RegExp(`^\\s*${operand}\\s*-\\s*${operand}\\s*$`).test(formula)
  ) {
    return 'duration';
  }

  return /^\s*days\(.*\)\s*$/.test(formula)
    ? 'days'
    : /^\s*addDays\(.*\)\s*$/.test(formula)
      ? 'date'
      : undefined;
}

/** The store's form of a column, so a total or a filter can be computed over it. */
export function toExpression(spec: DerivedColumnSpec): Expression | undefined {
  return spec.formula.trim() === ''
    ? undefined
    : { kind: 'formula', formula: spec.formula, vars: spec.vars };
}

/** Whether the formula reads the clock, so its value (and a query on it) moves. */
export function dependsOnNow(
  spec: Pick<DerivedColumnSpec, 'formula'>,
): boolean {
  return /\b(now|daysUntilAnniversary)\s*\(/.test(spec.formula);
}

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

/** A column's label as a formula identifier: lowercase a-z, 0-9 and `_`. */
export const columnSlug = (label: string): string =>
  label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/^(\d)/, 'c$1') || 'column';

/**
 * Identifier → property subject for columns given as `[label, subject]`. Two
 * labels that slug alike get a numeric suffix (`price`, `price_2`); the same
 * column listed twice (say by name and by shortname) keeps one entry.
 */
export function columnSlugs(
  columns: Array<[label: string, subject: string]>,
): Record<string, string> {
  const slugs: Record<string, string> = {};

  for (const [label, subject] of columns) {
    const base = columnSlug(label);
    let slug = base;

    for (let n = 2; slugs[slug] !== undefined && slugs[slug] !== subject; n++) {
      slug = `${base}_${n}`;
    }

    slugs[slug] = subject;
  }

  return slugs;
}

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

/** `evalexpr` names that are not columns: literals, and anything called. */
const NOT_COLUMNS = new Set(['true', 'false']);

/** The column identifiers a formula reads — not function names or literals. */
export function formulaIdentifiers(formula: string): string[] {
  // The character before is matched as a group, not a lookbehind: Safari
  // before 16.4 rejects a lookbehind literal, and the whole bundle with it.
  const identifiers = formula
    .replace(/"[^"]*"/g, '')
    .matchAll(/(^|[^\w:])([A-Za-z_]\w*)(?!\s*\(|\w|::)/g);

  return [...new Set([...identifiers].map(m => m[2]))].filter(
    name => !NOT_COLUMNS.has(name),
  );
}

/**
 * Binds the identifiers a formula uses to property subjects. An identifier that
 * names no column comes back in `unknown`, with the closest column to suggest.
 */
export function bindFormula(
  formula: string,
  slugs: Record<string, string>,
): { vars: Record<string, string>; unknown: Array<[string, string?]> } {
  const vars: Record<string, string> = {};
  const unknown: Array<[string, string?]> = [];

  for (const name of formulaIdentifiers(formula)) {
    if (slugs[name]) {
      vars[name] = slugs[name];
    } else {
      unknown.push([name, closest(name, Object.keys(slugs))]);
    }
  }

  return { vars, unknown };
}

function closest(name: string, candidates: string[]): string | undefined {
  const distance = (a: string, b: string): number => {
    let row = Array.from({ length: b.length + 1 }, (_, i) => i);

    for (let i = 1; i <= a.length; i++) {
      const next = [i];

      for (let j = 1; j <= b.length; j++) {
        next[j] = Math.min(
          row[j] + 1,
          next[j - 1] + 1,
          row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
        );
      }

      row = next;
    }

    return row[b.length];
  };

  const [best] = candidates.sort(
    (x, y) => distance(name, x) - distance(name, y),
  );

  return best && distance(name, best) <= Math.max(2, name.length / 2)
    ? best
    : undefined;
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
