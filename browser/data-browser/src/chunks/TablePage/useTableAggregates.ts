import {
  CollectionBuilder,
  StoreEvents,
  useStore,
  type AggregateOutcome,
  type Aggregation,
  type ExpressionFilter,
  type PropVal,
} from '@tomic/react';
import { useEffect, useState } from 'react';

/** How long to wait after the last edit before re-reading the totals. */
const REFRESH_DEBOUNCE_MS = 500;

/**
 * The totals for a table's rows, kept up to date as the data changes.
 *
 * A separate query from the one that renders the rows, on purpose. Totals are
 * computed over every matching row, so they have to be re-read whenever a value
 * changes — and doing that by refreshing the row collection would clear its
 * pages and churn the grid under the user's cursor. This asks for a single row
 * and the numbers, which is the cheapest thing that can answer the question.
 */
export function useTableAggregates(opts: {
  /** Which rows to aggregate: the same constraints the grid queries with. */
  property: string;
  value: string;
  filters: PropVal[];
  /** Constraints on computed values, so the totals cover the same rows the grid
   *  shows rather than every row the index hit. */
  expressionFilters?: ExpressionFilter[];
  drive?: string;
  server?: string;
  /** Undefined when the view asks for no totals — then nothing is fetched. */
  aggregation: Aggregation | undefined;
}): AggregateOutcome[] {
  const store = useStore();
  const [outcomes, setOutcomes] = useState<AggregateOutcome[]>([]);

  // Serialized deps: these are rebuilt every render, and the fetch must only
  // re-run when the question actually changed.
  const aggregationKey = JSON.stringify(opts.aggregation ?? null);
  const filtersKey = JSON.stringify(opts.filters ?? []);
  const expressionFiltersKey = JSON.stringify(opts.expressionFilters ?? []);
  const { property, value, drive, server } = opts;

  useEffect(() => {
    const aggregation = JSON.parse(aggregationKey) as Aggregation | null;

    if (!aggregation?.aggregates.length || !property || !value) {
      setOutcomes([]);

      return;
    }

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const read = async () => {
      const builder = new CollectionBuilder(store, server);
      builder.setProperty(property);
      builder.setValue(value);
      builder.setFilters(JSON.parse(filtersKey) as PropVal[]);
      builder.setExpressionFilters(
        JSON.parse(expressionFiltersKey) as ExpressionFilter[],
      );
      // One member is enough — the rows come from the grid's own query. The
      // totals cover every matching row regardless of this page size.
      builder.setPageSize(1);
      builder.setAggregation(aggregation);

      if (drive) {
        builder.setDrive(drive);
      }

      const collection = await builder.buildAndFetch();

      if (!cancelled) {
        setOutcomes(collection.aggregates);
      } else {
        // TEMPORARY [agg] diagnostics for the CI-only em-dash totals: a read
        // whose result was thrown away looks identical to one that never ran.
        console.info('[agg] read done but cancelled — outcomes dropped');
      }
    };

    const refresh = () => {
      clearTimeout(timer);
      // Debounced: typing in a cell saves on every keystroke, and each save
      // would otherwise be a round trip.
      timer = setTimeout(() => {
        // TEMPORARY [agg]: a failed refresh leaves the totals frozen at
        // whatever they showed before — nothing retries until the next save.
        // Say so instead of swallowing it.
        void read().catch(e =>
          console.warn('[agg] refresh read failed:', String(e).slice(0, 200)),
        );
      }, REFRESH_DEBOUNCE_MS);
    };

    void read().catch(e =>
      console.warn('[agg] initial read failed:', String(e).slice(0, 200)),
    );

    // Any save or delete can change a total — including one made in another
    // tab, which arrives through the same events.
    const offSaved = store.on(StoreEvents.ResourceSaved, refresh);
    const offRemoved = store.on(StoreEvents.ResourceRemoved, refresh);

    return () => {
      cancelled = true;
      clearTimeout(timer);
      offSaved();
      offRemoved();
    };
  }, [
    store,
    property,
    value,
    filtersKey,
    expressionFiltersKey,
    aggregationKey,
    drive,
    server,
  ]);

  return outcomes;
}
