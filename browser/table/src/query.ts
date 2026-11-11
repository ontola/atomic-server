/** A query describes the whole selected table, independently of loaded pages. */
export type TableFilterOperator =
  | 'eq'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'starts_with'
  | 'contains';

export interface TableQueryFilter {
  property?: string;
  value?: string;
  operator?: TableFilterOperator;
}

export interface TableFormula {
  kind: 'formula';
  formula: string;
  vars: Record<string, string>;
}

export interface TableExpressionFilter {
  expression: TableFormula;
  operator?: 'eq' | 'gt' | 'gte' | 'lt' | 'lte';
  value: number;
  now_ms?: number;
  tz_offset_minutes?: number;
}

export interface TableQueryAggregation {
  aggregates: {
    id?: string;
    property?: string;
    expression?: TableFormula;
    function: 'sum' | 'count' | 'avg' | 'min' | 'max';
  }[];
  group_by?: {
    property: string;
    granularity?: 'exact' | 'day' | 'month';
    tz_offset_minutes?: number;
    limit?: number;
  };
  now_ms?: number;
  tz_offset_minutes?: number;
}

export interface TableQuery {
  scope: {
    /** Collection identity, never inferred from the active host workspace. */
    table: string;
    /** Undefined while schema loads: the adapter must not query all children. */
    rowClass?: string;
    drive?: string;
  };
  filters: TableQueryFilter[];
  expressionFilters: TableExpressionFilter[];
  sort?: { property: string; descending: boolean };
  aggregation?: TableQueryAggregation;
  pageSize: number;
}

export interface TableQueryCapabilities {
  filterOperators: readonly TableFilterOperator[];
  expressions: boolean;
  aggregates: boolean;
  grouping: boolean;
  sorting: boolean;
}

export type TableQueryIssue =
  | { feature: 'filter'; index: number; operator: TableFilterOperator }
  | { feature: 'expressions' | 'aggregates' | 'grouping' | 'sorting' };

/** Preflight for hosts to explain unsupported operations before opening a query.
 * Never drops a filter or substitutes page-local computations for backend work.
 * Property-specific constraints (e.g. optional sort keys) stay with the adapter. */
export function tableQueryIssues(
  query: TableQuery,
  capabilities: TableQueryCapabilities,
): TableQueryIssue[] {
  const issues: TableQueryIssue[] = [];
  query.filters.forEach((filter, index) => {
    const operator = filter.operator ?? 'eq';
    if (!capabilities.filterOperators.includes(operator))
      issues.push({ feature: 'filter', index, operator });
  });
  if (
    !capabilities.expressions &&
    (query.expressionFilters.length > 0 ||
      query.aggregation?.aggregates.some(aggregate => aggregate.expression))
  )
    issues.push({ feature: 'expressions' });
  if (!capabilities.aggregates && query.aggregation?.aggregates.length)
    issues.push({ feature: 'aggregates' });
  if (!capabilities.grouping && query.aggregation?.group_by)
    issues.push({ feature: 'grouping' });
  if (!capabilities.sorting && query.sort) issues.push({ feature: 'sorting' });

  return issues;
}
