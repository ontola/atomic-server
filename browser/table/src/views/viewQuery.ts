import type {
  TableQuery,
  TableFormula,
  TableQueryAggregation,
} from '../query.js';
import type {
  DerivedColumnSpec,
  TableViewConfiguration,
} from './configuration.js';

export const TABLE_BREAKDOWN_ROWS_ID = '__breakdown_rows';
export const TABLE_QUERY_NOW_QUANTUM_MS = 60_000;
export const tableQueryNow = (now = Date.now()) =>
  Math.floor(now / TABLE_QUERY_NOW_QUANTUM_MS) * TABLE_QUERY_NOW_QUANTUM_MS;
export const tableDerivedDependsOnNow = (
  spec: Pick<DerivedColumnSpec, 'formula'>,
) => /\b(now|daysUntilAnniversary)\s*\(/.test(spec.formula);
export const tableDerivedExpression = (
  spec: DerivedColumnSpec,
): TableFormula | undefined =>
  spec.formula.trim()
    ? { kind: 'formula', formula: spec.formula, vars: spec.vars }
    : undefined;

/** Renderer defaults are inputs, not persisted configuration. Explicit [] wins. */
export function effectiveTableDerivedColumns(
  config: Pick<TableViewConfiguration, 'derivedColumns' | 'derivedColumnsSet'>,
  defaults: readonly DerivedColumnSpec[] = [],
): DerivedColumnSpec[] {
  return config.derivedColumnsSet
    ? config.derivedColumns
    : [...config.derivedColumns, ...defaults];
}

export function timerDurationColumn(
  start: string,
  end: string,
  label: string,
): DerivedColumnSpec {
  return {
    id: 'duration',
    label,
    formula: 'coalesce(end, now()) - start',
    vars: { start, end },
    valueKind: 'duration',
    width: 130,
  };
}

export function tableDerivedFilterNumber(
  spec: DerivedColumnSpec,
  value: string,
  now: number,
): number | undefined {
  if (spec.valueKind === 'date') {
    if (value === 'now') return now;
    const parsed = Date.parse(value);

    return Number.isNaN(parsed) ? undefined : parsed;
  }

  if (
    spec.valueKind !== undefined &&
    !['number', 'boolean', 'days', 'duration'].includes(spec.valueKind)
  )
    throw new TypeError('Unknown derived value kind');
  const number = Number(value);

  return Number.isFinite(number)
    ? number * (spec.valueKind === 'duration' ? 3_600_000 : 1)
    : undefined;
}

export interface TableViewQueryIssue {
  field: 'filters' | 'aggregates';
  index: number;
  reason: 'target' | 'expression' | 'operator' | 'value';
}

/** Compile a complete view request once for rows and collection-wide totals.
 * A valued constraint that cannot resolve makes the entire request unavailable;
 * it is never silently dropped. Schema/type/capability checks stay with adapters.
 * Formula evaluation and aggregation always remain backend operations. */
export function compileTableViewQuery(
  config: TableViewConfiguration,
  options: {
    scope: TableQuery['scope'];
    pageSize: number;
    now?: number;
    timezoneOffsetMinutes?: number;
    defaultDerivedColumns?: readonly DerivedColumnSpec[];
  },
) {
  const now = tableQueryNow(options.now);
  const timezone =
    options.timezoneOffsetMinutes ?? -new Date().getTimezoneOffset();
  const derivedColumns = config.derivedColumns;
  const byId = new Map(derivedColumns.map(spec => [spec.id, spec]));
  const issues: TableViewQueryIssue[] = [];
  const filters: TableQuery['filters'] = [];
  const expressionFilters: TableQuery['expressionFilters'] = [];
  config.filters.forEach(filter => {
    if (filter.value === '') return;

    if (filter.derived === undefined) {
      if (filter.property)
        filters.push({
          property: filter.property,
          value: filter.value,
          operator: filter.operator,
        });

      return;
    }

    const spec = byId.get(filter.derived);
    const expression = spec && tableDerivedExpression(spec);
    if (!spec || !expression) return;
    const value = tableDerivedFilterNumber(spec, filter.value, now);
    if (value === undefined) return;
    expressionFilters.push({
      expression,
      operator: filter.operator as 'eq' | 'gt' | 'gte' | 'lt' | 'lte',
      value,
      ...(tableDerivedDependsOnNow(spec) || value === now
        ? { now_ms: now }
        : {}),
      tz_offset_minutes: timezone,
    });
  });
  const aggregates: TableQueryAggregation['aggregates'] = [];
  let live = false;
  config.aggregates.forEach(aggregate => {
    if (aggregate.derived === undefined) {
      aggregates.push({
        id: aggregate.id,
        property: aggregate.property,
        function: aggregate.function,
      });

      return;
    }

    const spec = byId.get(aggregate.derived);
    const expression = spec && tableDerivedExpression(spec);

    if (!expression) {
      return;
    }

    aggregates.push({
      id: aggregate.id,
      expression,
      function: aggregate.function,
    });
    live ||= tableDerivedDependsOnNow(spec!);
  });
  const aggregation: TableQueryAggregation | undefined = aggregates.length
    ? {
        aggregates: config.groupByColumn
          ? [...aggregates, { id: TABLE_BREAKDOWN_ROWS_ID, function: 'count' }]
          : aggregates,
        ...(config.groupByColumn
          ? {
              group_by: {
                property: config.groupByColumn,
                granularity: config.groupGranularity,
                tz_offset_minutes: timezone,
              },
            }
          : {}),
        ...(live ? { now_ms: now } : {}),
        ...(aggregates.some(aggregate => aggregate.expression)
          ? { tz_offset_minutes: timezone }
          : {}),
      }
    : undefined;
  const query: TableQuery = {
    scope: {
      ...options.scope,
      rowClass: options.scope.rowClass,
    },
    filters,
    expressionFilters,
    ...(config.sortBy
      ? { sort: { property: config.sortBy, descending: config.sortDesc } }
      : {}),
    aggregation,
    pageSize: options.pageSize,
  };

  return { query, issues, derivedColumns };
}
