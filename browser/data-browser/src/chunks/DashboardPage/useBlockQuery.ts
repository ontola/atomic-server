import {
  core,
  unknownSubject,
  useResourceSnapshot,
  useString,
  type ExpressionFilter,
  type PropVal,
} from '@tomic/react';
import {
  compileTableViewQuery,
  readTableViewConfiguration,
  timerDurationColumn,
  tableQueryNow,
} from '@tomic/table';
import type { DerivedColumnSpec } from '../TablePage/derivedColumns';
import { useAtomicViewConfiguration } from '../TablePage/atomicViewConfiguration';

export interface BlockQuery {
  property: string;
  value: string;
  filters: PropVal[];
  expressionFilters: ExpressionFilter[];
  derivedColumns: DerivedColumnSpec[];
  ready: boolean;
  error?: string;
  now?: number;
}

/** A block borrows its owned view's predicates and ANDs its own constraints.
 * Both use the actual TablePage compiler; unresolved valued constraints never
 * become an unfiltered count or chart. The block chooses its own statistic. */
export function useBlockQuery(
  sourceSubject: string | undefined,
  viewSubject: string | undefined,
  blockQuery: unknown,
): BlockQuery {
  const source = useResourceSnapshot(sourceSubject ?? unknownSubject);
  const view = useResourceSnapshot(viewSubject ?? unknownSubject);
  const [classSubject] = useString(source.resource, core.properties.classtype);
  const stored = useAtomicViewConfiguration(view.resource);
  const config = viewSubject
    ? stored.config
    : readTableViewConfiguration({}).config;
  const block = readTableViewConfiguration({
    filters: blockQuery ?? undefined,
  });
  const foreign =
    !!viewSubject && !view.loading && stored.owner !== sourceSubject;
  const malformed =
    (viewSubject && stored.issues.length) || block.issues.length;
  const defaultDerivedColumns =
    config.kind === 'timer' && config.groupBy && config.endProp
      ? [timerDurationColumn(config.groupBy, config.endProp, 'Duration')]
      : [];
  const hasClass = !!classSubject && classSubject !== unknownSubject;
  const ready =
    !!sourceSubject &&
    !source.loading &&
    hasClass &&
    (!viewSubject || !view.loading) &&
    !foreign &&
    !malformed;
  const now = tableQueryNow();
  const compiled = compileTableViewQuery(
    {
      ...config,
      filters: [...config.filters, ...block.config.filters],
      aggregates: [],
      groupByColumn: undefined,
    },
    {
      scope: {
        table: sourceSubject ?? '',
        rowClass: ready ? classSubject : undefined,
      },
      pageSize: 30,
      now,
      defaultDerivedColumns,
    },
  );
  const error = foreign
    ? 'Saved view is unavailable in this table.'
    : malformed || compiled.issues.length
      ? 'Saved view configuration is invalid.'
      : undefined;

  return {
    property: core.properties.parent,
    value: sourceSubject ?? '',
    filters: [
      ...(hasClass
        ? [{ property: core.properties.isA, value: classSubject }]
        : []),
      ...compiled.query.filters,
    ],
    expressionFilters: compiled.query.expressionFilters,
    derivedColumns: compiled.derivedColumns,
    ready: ready && !compiled.issues.length,
    error,
    now,
  };
}
