import type { JSONValue } from '../value.js';
import type { TableFilterOperator, TableQueryAggregation } from '../query.js';
type FilterOperator = TableFilterOperator;
type AggregateFunction =
  TableQueryAggregation['aggregates'][number]['function'];

export type GroupGranularity = 'exact' | 'day' | 'month';
export const ROW_ACTION_KINDS: RowActionKind[] = [
  'setNow',
  'setValue',
  'toggle',
  'increment',
];
const ROW_ACTION_GENERATORS = Object.fromEntries(
  ROW_ACTION_KINDS.map(kind => [kind, true]),
);

/**
 * A single table filter: an extra `(property, operator, value)` constraint
 * ANDed onto the table's `parent = <table>` query. One filter per property
 * (keyed by `property` subject). `value === ''` means "not set yet" — such
 * filters are kept in the UI (so the chip stays visible while editing) but
 * skipped by the query.
 */
export interface TableFilter {
  /** The stored property this constrains. Absent for a computed column. */
  property?: string;
  /**
   * The id of a computed column of this view, when the constraint is on a value
   * computed per row — "logged more than an hour", "due". The store evaluates the
   * column's expression over the rows the index narrows to, so paging and the
   * totals describe the filtered set.
   */
  derived?: string;
  operator: FilterOperator;
  value: string;
}

/**
 * How a filter is identified while it's being edited: a property subject, or a
 * computed column as `derived:<id>` — the same convention `view-column-order`
 * uses for the columns that aren't properties.
 *
 * A single key keeps the chips, the setters and the "already filtered" check
 * working for both kinds without every one of them growing a branch.
 */
export function filterKey(filter: TableFilter): string {
  return filter.derived
    ? derivedFilterKey(filter.derived)
    : (filter.property ?? '');
}

export function derivedFilterKey(id: string): string {
  return `derived:${id}`;
}

/** The target a key names: a stored property, or a computed column. */
export function parseFilterKey(
  key: string,
): Pick<TableFilter, 'property' | 'derived'> {
  return key.startsWith('derived:')
    ? { derived: key.slice('derived:'.length) }
    : { property: key };
}

export interface TableSorting {
  prop: string;
  sortDesc: boolean;
}

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
export interface DerivedColumnSpec {
  /** Stable identity within the view — the grid column key. */
  id: string;
  /** Heading label. */
  label: string;
  formula: string;
  /** Identifier used in the formula → property subject. */
  vars: Record<string, string>;
  /** Column width in px. */
  width?: number;
  /** What the number means, for formatting. Defaults to a plain number. */
  valueKind?: DerivedValueKind;
}

/**
 * What kind of number a formula produces. Decides how a value and a total over
 * the column are formatted, which statistics are offered for it, and (for a
 * filter) what the value input asks for.
 */
export type DerivedValueKind =
  | 'duration'
  | 'days'
  | 'number'
  | 'date'
  | 'boolean';

export const DEFAULT_DERIVED_WIDTH = 120;

// --- Reading what is stored -------------------------------------------------

type LegacyArgs = Record<string, string | number | undefined>;

/** The five fixed generators this replaced: their arguments and the formula each meant. */
const LEGACY: Record<
  string,
  [
    args: string[],
    formula: (v: string[]) => string,
    valueKind: DerivedValueKind,
  ]
> = {
  difference: [['from', 'to'], v => `${v[1]} - ${v[0]}`, 'duration'],
  elapsed: [
    ['from', 'until'],
    v => (v[1] ? `coalesce(${v[1]}, now()) - ${v[0]}` : `now() - ${v[0]}`),
    'duration',
  ],
  daysSince: [['from'], v => `days(now() - ${v[0]})`, 'days'],
  product: [['a', 'b'], v => `${v[0]} * ${v[1]}`, 'number'],
  offset: [['from', 'days'], v => `${v[0]} + ${v[1]} * 86400000.0`, 'date'],
};

/** A spec stored as `{ kind, args }`, as the same formula the store converts it to. */
function fromLegacy(kind: string, args: LegacyArgs) {
  const [names, formula, valueKind] = LEGACY[kind] ?? [];
  const vars: Record<string, string> = {};
  const operands = names?.map(name => {
    const arg = args[name];

    if (typeof arg === 'number') {
      return `(${Number.isInteger(arg) ? arg.toFixed(1) : arg})`;
    }

    if (typeof arg === 'string' && arg) {
      vars[`v${Object.keys(vars).length}`] = arg;

      return `v${Object.keys(vars).length - 1}`;
    }
  });

  // Only a running duration may leave an argument (the end) empty.
  if (!operands?.slice(0, kind === 'elapsed' ? 1 : undefined).every(Boolean)) {
    return undefined;
  }

  return { formula: formula(operands as string[]), vars, valueKind };
}

function readSpec(value: unknown): DerivedColumnSpec | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }

  const spec = value as Record<string, unknown>;

  if (typeof spec.id !== 'string' || typeof spec.label !== 'string') {
    return undefined;
  }

  const base = {
    id: spec.id,
    label: spec.label,
    ...(typeof spec.width === 'number' ? { width: spec.width } : {}),
  };

  if (typeof spec.formula === 'string') {
    const vars = spec.vars ?? {};
    const isVars =
      typeof vars === 'object' &&
      vars !== null &&
      Object.values(vars).every(v => typeof v === 'string');

    return isVars
      ? {
          ...base,
          formula: spec.formula,
          vars: vars as Record<string, string>,
          ...(typeof spec.valueKind === 'string'
            ? { valueKind: spec.valueKind as DerivedValueKind }
            : {}),
        }
      : undefined;
  }

  const args = spec.args as LegacyArgs | undefined;

  return typeof spec.kind === 'string' && typeof args === 'object' && args
    ? ({ ...base, ...fromLegacy(spec.kind, args) } as DerivedColumnSpec)
    : undefined;
}

/**
 * Reads the specs stored on a View, converting the older `{ kind, args }` form
 * to formulas. Anything malformed is dropped rather than thrown: hand-edited (or
 * assistant-written) config must not be able to take the whole table down with
 * it.
 */
export function parseDerivedColumnSpecs(
  value: JSONValue | undefined,
): DerivedColumnSpec[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return (value as unknown[]).flatMap(item => {
    const spec = readSpec(item);

    return spec?.formula ? [spec] : [];
  });
}

/**
 * The verbs a row action can perform.
 *
 * A closed set, on purpose, and the same rule the derived-column generators
 * follow: a person can edit one in a dialog and an LLM can write one, because it
 * is configuration rather than code. The moment an action can run arbitrary code
 * it stops being config and becomes the plugin platform, which is a different
 * document ([[llm-wasm-gui-plugins]]).
 *
 * These four came out of walking the thirteen table templates (see
 * `planning/dashboards.md`): "Watered" and "Log contact" stamp now, "Mark done"
 * and "Yes/No" set a value, a grocery list toggles, and an inventory counts up
 * and down. Nothing in the catalogue needed a fifth *per-row* verb.
 */
export type RowActionKind = 'setNow' | 'setValue' | 'toggle' | 'increment';

/** One configured action, stored on the View in `view-row-actions`. */
export interface RowActionSpec {
  /** Stable identity within the view — part of the grid column key. */
  id: string;
  /** The button's label, and its column heading. */
  label: string;
  kind: RowActionKind;
  /** The property this action writes. */
  property: string;
  /**
   * What to write, for the verbs that need it: the literal for `setValue` (a tag
   * subject for a select column), the step for `increment`.
   */
  value?: string | number;
}

function isSpec(value: unknown): value is RowActionSpec {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const spec = value as Record<string, unknown>;

  return (
    typeof spec.id === 'string' &&
    typeof spec.label === 'string' &&
    typeof spec.kind === 'string' &&
    spec.kind in ROW_ACTION_GENERATORS &&
    typeof spec.property === 'string'
  );
}

/**
 * Reads the View's stored actions. Anything malformed is dropped rather than
 * thrown on: a person or an LLM writes this, and one bad entry must not take the
 * table down.
 */
export function parseRowActions(value: JSONValue | undefined): RowActionSpec[] {
  const parsed =
    typeof value === 'string'
      ? (() => {
          try {
            return JSON.parse(value) as JSONValue;
          } catch {
            return undefined;
          }
        })()
      : value;

  if (!Array.isArray(parsed)) {
    return [];
  }

  return (parsed as unknown[]).filter(isSpec);
}

/**
 * One value a new row starts with.
 *
 * Deliberately the *same* patch vocabulary a row action uses, applied to a row
 * that does not exist yet: `setNow` stamps the moment you pressed the button,
 * `setValue` presets a status, `toggle` starts it ticked, `increment` starts it at
 * the step. Reusing the verbs keeps the closed set closed — there is no second
 * vocabulary to learn, to document, or to write a second dialog for.
 */
export interface QuickAddPreset {
  kind: RowActionKind;
  property: string;
  value?: string | number;
}

/**
 * A button above the grid that creates a row: "Log a feed", "Add item", "Log
 * set". The timer's "what are you working on?" bar, generalised — for a personal
 * app this is usually the widget the whole thing exists for.
 */
export interface QuickAddSpec {
  /** What the button says. */
  label: string;
  /**
   * A property to type into before creating, almost always the row's name.
   * Absent means the button creates immediately, with no field at all — which is
   * what "Log a feed" wants.
   */
  field?: string;
  /** Placeholder for that field. */
  placeholder?: string;
  /** Values every new row starts with. */
  presets?: QuickAddPreset[];
}

function isPreset(value: unknown): value is QuickAddPreset {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const preset = value as Record<string, unknown>;

  return (
    typeof preset.kind === 'string' &&
    preset.kind in ROW_ACTION_GENERATORS &&
    typeof preset.property === 'string'
  );
}

/**
 * Reads the View's stored quick-add. Anything malformed is dropped rather than
 * thrown on — a person or an LLM writes this.
 */
export function parseQuickAdd(
  value: JSONValue | undefined,
): QuickAddSpec | undefined {
  const parsed =
    typeof value === 'string'
      ? (() => {
          try {
            return JSON.parse(value) as JSONValue;
          } catch {
            return undefined;
          }
        })()
      : value;

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }

  const spec = parsed as Record<string, unknown>;

  if (typeof spec.label !== 'string' || spec.label === '') {
    return undefined;
  }

  return {
    label: spec.label,
    ...(typeof spec.field === 'string' && spec.field !== ''
      ? { field: spec.field }
      : {}),
    ...(typeof spec.placeholder === 'string'
      ? { placeholder: spec.placeholder }
      : {}),
    presets: Array.isArray(spec.presets)
      ? (spec.presets as unknown[]).filter(isPreset)
      : [],
  };
}

/**
 * A statistic a view shows under its rows. Configuration on the View
 * (`view-aggregates`), computed by the store over **every** row the view
 * matches — filters included, paging excluded. So a "Sum of Amount" is the
 * answer for the whole table, not for the rows that happen to be loaded.
 * A quick filter narrows it to the rows that match (`aggregateRows`).
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

export const AGGREGATE_FUNCTIONS: AggregateFunction[] = [
  'sum',
  'avg',
  'min',
  'max',
  'count',
];

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

/** Reads a stored order, ignoring anything that isn't a list of keys. */
export function parseColumnOrder(value: JSONValue | undefined): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return (value as unknown[]).filter(
    (key): key is string => typeof key === 'string',
  );
}
