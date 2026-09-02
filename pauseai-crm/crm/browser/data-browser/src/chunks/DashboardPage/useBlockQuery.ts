import {
  core,
  dataBrowser,
  unknownSubject,
  useResource,
  useString,
  useValue,
  type ExpressionFilter,
  type PropVal,
} from '@tomic/react';
import { useMemo } from 'react';
import {
  parseDerivedColumnSpecs,
  type DerivedColumnSpec,
} from '../TablePage/derivedColumns';
import {
  quantizedNow,
  splitFilters,
  type TableFilter,
} from '../TablePage/tableFiltering';

export interface BlockQuery {
  /** The `parent = <table>` constraint every block query starts from. */
  property: string;
  value: string;
  /** Indexed constraints: the class, the view's filters, the block's own. */
  filters: PropVal[];
  /** Constraints the store has to evaluate per row. */
  expressionFilters: ExpressionFilter[];
  /** The view's computed columns, for a statistic that names one. */
  derivedColumns: DerivedColumnSpec[];
  /** True once the source's classtype is known — before that the query would
   *  ask about `unknownSubject`. */
  ready: boolean;
}

function parseFilters(value: unknown): TableFilter[] {
  return Array.isArray(value) ? (value as TableFilter[]) : [];
}

/**
 * The constraints a block's numbers cover.
 *
 * A block borrows its view's configuration rather than restating it: point a
 * stat block at the "Low stock" view and it counts exactly the rows that view
 * lists, filters and computed columns included. `block-query` then ANDs
 * whatever else the block narrows by on top, so "low stock **in this room**" is
 * config rather than a second view.
 */
export function useBlockQuery(
  sourceSubject: string | undefined,
  viewSubject: string | undefined,
  blockQuery: unknown,
): BlockQuery {
  const source = useResource(sourceSubject ?? unknownSubject);
  const view = useResource(viewSubject ?? unknownSubject);

  const [classSubject] = useString(source, core.properties.classtype);
  const [storedFilters] = useValue(view, dataBrowser.properties.viewFilters);
  const [storedDerived] = useValue(
    view,
    dataBrowser.properties.viewDerivedColumns,
  );

  // Serialized deps throughout: parsing JSON hands back a fresh array every
  // render, and these reach a query's identity.
  const derivedKey = JSON.stringify(storedDerived ?? null);
  const viewFiltersKey = JSON.stringify(storedFilters ?? null);
  const blockFiltersKey = JSON.stringify(blockQuery ?? null);

  const derivedColumns = useMemo(
    () => parseDerivedColumnSpecs(JSON.parse(derivedKey)),
    [derivedKey],
  );

  const { filters, expressionFilters } = useMemo(() => {
    const combined = [
      ...parseFilters(JSON.parse(viewFiltersKey)),
      ...parseFilters(JSON.parse(blockFiltersKey)),
    ];

    // Quantized, like the table's: this value is part of the query's identity,
    // so a raw `Date.now()` would re-run it on every render.
    const split = splitFilters(combined, derivedColumns, quantizedNow());

    return {
      filters: split.propVals,
      expressionFilters: split.expressionFilters,
    };
  }, [viewFiltersKey, blockFiltersKey, derivedColumns]);

  const hasClass = !!classSubject && classSubject !== unknownSubject;

  // Rows only: without this a block would count the table's own View resources
  // alongside its rows.
  const classFilter: PropVal[] = hasClass
    ? [{ property: core.properties.isA, value: classSubject }]
    : [];

  return {
    property: core.properties.parent,
    value: sourceSubject ?? '',
    filters: [...classFilter, ...filters],
    expressionFilters,
    derivedColumns,
    ready: !!sourceSubject && hasClass,
  };
}
