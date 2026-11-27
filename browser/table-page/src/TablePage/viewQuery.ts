import { core, unknownSubject, type PropVal } from '@tomic/react';
import type { DerivedColumnSpec } from './derivedColumns.js';
import {
  quantizedNow,
  splitFilters,
  type TableFilter,
} from './tableFiltering.js';

/** The table grid and dashboard blocks use identical predicates and clock semantics. */
export function compileViewPredicates(
  classSubject: string | undefined,
  filters: TableFilter[],
  derivedColumns: DerivedColumnSpec[],
  now = quantizedNow(),
) {
  const { propVals, expressionFilters, hasUnresolved } = splitFilters(
    filters,
    derivedColumns,
    now,
  );
  const classReady = !!classSubject && classSubject !== unknownSubject;
  const membership: PropVal[] = classReady
    ? [{ property: core.properties.isA, value: classSubject }]
    : [];

  return {
    filters: [...membership, ...propVals],
    expressionFilters,
    classReady,
    hasUnresolved,
    now,
  };
}
