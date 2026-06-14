import { Datatype, type FilterOperator } from '@tomic/react';
import { useCallback, useState } from 'react';

export type { FilterOperator };

/**
 * A single table filter: an extra `(property, operator, value)` constraint
 * ANDed onto the table's `parent = <table>` query. One filter per property
 * (keyed by `property` subject). `value === ''` means "not set yet" — such
 * filters are kept in the UI (so the chip stays visible while editing) but
 * skipped by the query.
 */
export interface TableFilter {
  property: string;
  operator: FilterOperator;
  value: string;
}

export interface UseTableFiltersResult {
  filters: TableFilter[];
  /** Add an empty filter for a property (no-op if one already exists). */
  addFilter: (property: string) => void;
  setFilterValue: (property: string, value: string) => void;
  setFilterOperator: (property: string, operator: FilterOperator) => void;
  removeFilter: (property: string) => void;
  clearFilters: () => void;
}

export function useTableFilters(): UseTableFiltersResult {
  const [filters, setFilters] = useState<TableFilter[]>([]);

  const addFilter = useCallback((property: string) => {
    setFilters(prev =>
      prev.some(f => f.property === property)
        ? prev
        : [...prev, { property, operator: 'eq', value: '' }],
    );
  }, []);

  const setFilterValue = useCallback((property: string, value: string) => {
    setFilters(prev =>
      prev.map(f => (f.property === property ? { ...f, value } : f)),
    );
  }, []);

  const setFilterOperator = useCallback(
    (property: string, operator: FilterOperator) => {
      setFilters(prev =>
        prev.map(f => (f.property === property ? { ...f, operator } : f)),
      );
    },
    [],
  );

  const removeFilter = useCallback((property: string) => {
    setFilters(prev => prev.filter(f => f.property !== property));
  }, []);

  const clearFilters = useCallback(() => setFilters([]), []);

  return {
    filters,
    addFilter,
    setFilterValue,
    setFilterOperator,
    removeFilter,
    clearFilters,
  };
}

const OPERATOR_LABELS: Record<FilterOperator, string> = {
  eq: 'is',
  gt: 'greater than',
  gte: 'at least',
  lt: 'less than',
  lte: 'at most',
  starts_with: 'starts with',
  contains: 'contains',
};

export function operatorLabel(operator: FilterOperator): string {
  return OPERATOR_LABELS[operator] ?? 'is';
}

/**
 * The operators offered for a property, by datatype. Only operators the query
 * index can currently honor are exposed (equality/membership, value
 * comparisons, prefix/substring). See `planning/table-view-filters.md`.
 */
export function operatorsForDatatype(datatype: Datatype): FilterOperator[] {
  switch (datatype) {
    case Datatype.INTEGER:
    case Datatype.FLOAT:
    case Datatype.DATE:
    case Datatype.TIMESTAMP:
      return ['eq', 'gt', 'gte', 'lt', 'lte'];
    case Datatype.STRING:
    case Datatype.MARKDOWN:
    case Datatype.SLUG:
      return ['eq', 'starts_with', 'contains'];
    case Datatype.RESOURCEARRAY:
      // Membership reads as "contains" but is the `eq` operator on the server.
      return ['eq'];
    default:
      // References, booleans, etc.: equality only.
      return ['eq'];
  }
}

/** For resource-array columns, `eq` reads as "contains" (membership). */
export function operatorLabelForColumn(
  operator: FilterOperator,
  datatype: Datatype,
): string {
  if (operator === 'eq' && datatype === Datatype.RESOURCEARRAY) {
    return 'contains';
  }

  return operatorLabel(operator);
}
