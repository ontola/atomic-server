import {
  core,
  dataBrowser,
  unknownSubject,
  useResource,
  useString,
  useStore,
  useValue,
  type ExpressionFilter,
  type JSONValue,
  type PropVal,
} from '@tomic/react';
import { useMemo } from 'react';
import {
  parseDerivedColumnSpecs,
  type DerivedColumnSpec,
} from '../TablePage/derivedColumns.js';
import { quantizedNow, type TableFilter } from '../TablePage/tableFiltering.js';
import { effectiveViewDerivedColumns } from '../TablePage/Timer/timerProperties.js';
import { normalizeViewKind } from '../TablePage/tableViewKinds.js';
import { compileViewPredicates } from '../TablePage/viewQuery.js';
import { getTableDrive } from '../TablePage/tableDrive.js';
import { useClassProperties } from './useClassProperties.js';

export interface BlockQuery {
  property: string;
  value: string;
  filters: PropVal[];
  expressionFilters: ExpressionFilter[];
  derivedColumns: DerivedColumnSpec[];
  drive?: string;
  now: number;
  ready: boolean;
  unavailable: boolean;
}

function parseFilters(value: unknown): TableFilter[] {
  return Array.isArray(value) ? (value as TableFilter[]) : [];
}

/** Borrow the selected view's filters, ANDed with the block's own filters. */
export function useBlockQuery(
  sourceSubject: string | undefined,
  viewSubject: string | undefined,
  blockQuery: unknown,
): BlockQuery {
  const store = useStore();
  const source = useResource(sourceSubject ?? unknownSubject);
  const view = useResource(viewSubject ?? unknownSubject);
  const [classSubject] = useString(source, core.properties.classtype);
  const [owner] = useString(view, core.properties.parent);
  const [viewKind] = useString(view, dataBrowser.properties.viewKind);
  const [start] = useString(view, dataBrowser.properties.viewGroupBy);
  const [end] = useString(view, dataBrowser.properties.viewEndProp);
  const [storedFilters] = useValue(view, dataBrowser.properties.viewFilters);
  const [storedDerived] = useValue(
    view,
    dataBrowser.properties.viewDerivedColumns,
  );
  const timer = normalizeViewKind(viewKind) === 'timer';
  const columns = useClassProperties(timer ? classSubject : undefined);

  const derivedKey = JSON.stringify(storedDerived ?? null);
  const viewFiltersKey = JSON.stringify(storedFilters ?? null);
  const blockFiltersKey = JSON.stringify(blockQuery ?? null);
  const derivedColumns = useMemo(() => {
    const stored = JSON.parse(derivedKey) as JSONValue;

    return effectiveViewDerivedColumns(
      timer ? 'timer' : 'table',
      parseDerivedColumnSpecs(stored),
      Array.isArray(stored),
      columns,
      start,
      end,
    );
  }, [derivedKey, timer, columns, start, end]);

  const now = quantizedNow();
  const predicates = useMemo(
    () =>
      compileViewPredicates(
        classSubject,
        [
          ...parseFilters(JSON.parse(viewFiltersKey)),
          ...parseFilters(JSON.parse(blockFiltersKey)),
        ],
        derivedColumns,
        now,
      ),
    [classSubject, viewFiltersKey, blockFiltersKey, derivedColumns, now],
  );
  const viewReady = !viewSubject || (view.isReady() && owner === sourceSubject);
  const unavailable =
    !!sourceSubject &&
    ((!!viewSubject && !view.loading && !viewReady) ||
      (viewReady && predicates.hasUnresolved));

  return {
    property: core.properties.parent,
    value: sourceSubject ?? '',
    filters: predicates.filters,
    expressionFilters: predicates.expressionFilters,
    derivedColumns,
    drive: sourceSubject ? getTableDrive(store, source) : undefined,
    now,
    ready:
      !!sourceSubject && predicates.classReady && viewReady && !unavailable,
    unavailable,
  };
}
