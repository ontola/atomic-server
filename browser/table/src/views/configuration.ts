import type { JSONValue } from '../value.js';
import type { TableFilterOperator, TableQueryAggregation } from '../query.js';
type FilterOperator = TableFilterOperator;
type AggregateFunction =
  TableQueryAggregation['aggregates'][number]['function'];

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
  const entry = Object.hasOwn(LEGACY, kind) ? LEGACY[kind] : undefined;
  if (!entry) return undefined;
  const [names, formula, valueKind] = entry;
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
export function parseDerivedColumnSpecs(value: unknown): DerivedColumnSpec[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return (value as unknown[]).flatMap(item => {
    const spec = readSpec(item);

    return spec?.formula ? [spec] : [];
  });
}
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

export const ROW_ACTION_KINDS: RowActionKind[] = [
  'setNow',
  'setValue',
  'toggle',
  'increment',
];

function isSpec(value: unknown): value is RowActionSpec {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const spec = value as Record<string, unknown>;

  return (
    typeof spec.id === 'string' &&
    typeof spec.label === 'string' &&
    typeof spec.kind === 'string' &&
    ROW_ACTION_KINDS.includes(spec.kind as RowActionKind) &&
    typeof spec.property === 'string'
  );
}

/**
 * Reads the View's stored actions. Anything malformed is dropped rather than
 * thrown on: a person or an LLM writes this, and one bad entry must not take the
 * table down.
 */
export function parseRowActions(value: unknown): RowActionSpec[] {
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
    ROW_ACTION_KINDS.includes(preset.kind as RowActionKind) &&
    typeof preset.property === 'string'
  );
}

/**
 * Reads the View's stored quick-add. Anything malformed is dropped rather than
 * thrown on — a person or an LLM writes this.
 */
export function parseQuickAdd(value: unknown): QuickAddSpec | undefined {
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
export type GroupGranularity = 'exact' | 'day' | 'month';

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
export function parseAggregates(value: unknown): TableAggregate[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return (value as unknown[]).filter(isAggregate);
}

export function parseColumnOrder(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return (value as unknown[]).filter(
    (key): key is string => typeof key === 'string',
  );
}

/** The complete saved configuration consumed by built-in TablePage features.
 * Backend property names, resource handles and persistence revisions are kept in
 * adapters. A raw kind may name a built-in or an app; matching/authorization is
 * separate from reading its stored binding. Sort defaults belong to the backend. */
export interface TableViewConfiguration {
  name?: string;
  kind?: string;
  dashboard?: string;
  filters: TableFilter[];
  sortBy?: string;
  sortDesc: boolean;
  columns: string[];
  groupBy?: string;
  endProp?: string;
  timerExclusive: boolean;
  splitLanguages: string[];
  derivedColumns: DerivedColumnSpec[];
  derivedColumnsSet: boolean;
  columnOrder: string[];
  aggregates: TableAggregate[];
  rowActions: RowActionSpec[];
  quickAdd?: QuickAddSpec;
  groupByColumn?: string;
  groupGranularity: GroupGranularity;
}

export type TableViewConfigurationInput = Partial<
  Record<Exclude<keyof TableViewConfiguration, 'derivedColumnsSet'>, unknown>
>;
export interface TableViewConfigurationIssue {
  field:
    | 'filters'
    | 'sortBy'
    | 'sortDesc'
    | 'aggregates'
    | 'groupByColumn'
    | 'groupGranularity'
    | 'derivedColumns';
  index?: number;
}

const FILTER_OPERATORS: TableFilterOperator[] = [
  'eq',
  'gt',
  'gte',
  'lt',
  'lte',
  'starts_with',
  'contains',
];
const VALUE_KINDS: DerivedValueKind[] = [
  'duration',
  'days',
  'number',
  'date',
  'boolean',
];
const optionalString = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;

/** Optional display metadata retains the established tolerant codecs. Invalid
 * query-bearing metadata is reported explicitly: a host must gate its row query
 * on `issues`, never substitute the returned empty/default query fields. No
 * serialization/migration or write is performed merely by reading a view.
 * Schema references and implicit renderer columns resolve in the session, which
 * must additionally preflight the resulting backend query. */
export function readTableViewConfiguration(input: TableViewConfigurationInput) {
  const issues: TableViewConfigurationIssue[] = [];
  const filters: TableFilter[] = [];

  if (input.filters !== undefined) {
    if (!Array.isArray(input.filters)) issues.push({ field: 'filters' });
    else
      input.filters.forEach((value, index) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          issues.push({ field: 'filters', index });

          return;
        }

        const candidate = value as Record<string, unknown>;
        const property =
          typeof candidate.property === 'string' && candidate.property
            ? candidate.property
            : undefined;
        const derived =
          typeof candidate.derived === 'string' && candidate.derived
            ? candidate.derived
            : undefined;
        const operator = candidate.operator ?? 'eq';

        if (
          !!property === !!derived ||
          typeof candidate.value !== 'string' ||
          !FILTER_OPERATORS.includes(operator as TableFilterOperator)
        ) {
          issues.push({ field: 'filters', index });

          return;
        }

        filters.push({
          ...(property ? { property } : { derived }),
          operator: operator as TableFilterOperator,
          value: candidate.value,
        });
      });
  }

  const sortBy = optionalString(input.sortBy) || undefined;
  if (input.sortBy !== undefined && typeof input.sortBy !== 'string')
    issues.push({ field: 'sortBy' });
  if (input.sortDesc !== undefined && typeof input.sortDesc !== 'boolean')
    issues.push({ field: 'sortDesc' });
  const derivedColumns = parseDerivedColumnSpecs(input.derivedColumns);
  // Unknown formatting kinds cannot be handed to an exhaustive formatter.
  derivedColumns.forEach((spec, index) => {
    if (spec.valueKind !== undefined && !VALUE_KINDS.includes(spec.valueKind)) {
      issues.push({ field: 'derivedColumns', index });
      derivedColumns[index] = { ...spec, valueKind: undefined };
    }
  });
  const aggregates = parseAggregates(input.aggregates);
  if (
    input.aggregates !== undefined &&
    (!Array.isArray(input.aggregates) ||
      aggregates.length !== input.aggregates.length)
  )
    issues.push({ field: 'aggregates' });
  const groupByColumn = optionalString(input.groupByColumn) || undefined;
  if (
    input.groupByColumn !== undefined &&
    typeof input.groupByColumn !== 'string'
  )
    issues.push({ field: 'groupByColumn' });
  const groupGranularity =
    input.groupGranularity === undefined || input.groupGranularity === ''
      ? 'day'
      : input.groupGranularity;
  if (!['day', 'month', 'exact'].includes(groupGranularity as string))
    issues.push({ field: 'groupGranularity' });
  const config: TableViewConfiguration = {
    name: optionalString(input.name),
    kind: optionalString(input.kind),
    dashboard: optionalString(input.dashboard),
    filters,
    sortBy,
    sortDesc: input.sortDesc === true,
    columns: parseColumnOrder(input.columns),
    groupBy: optionalString(input.groupBy),
    endProp: optionalString(input.endProp),
    timerExclusive:
      input.timerExclusive === undefined ? true : !!input.timerExclusive,
    splitLanguages: parseColumnOrder(input.splitLanguages),
    derivedColumns,
    derivedColumnsSet: Array.isArray(input.derivedColumns),
    columnOrder: parseColumnOrder(input.columnOrder),
    aggregates,
    rowActions: parseRowActions(input.rowActions),
    quickAdd: parseQuickAdd(input.quickAdd),
    groupByColumn,
    groupGranularity: ['day', 'month', 'exact'].includes(
      groupGranularity as string,
    )
      ? (groupGranularity as GroupGranularity)
      : 'day',
  };

  return { config, issues };
}
