import {
  commits,
  CollectionBuilder,
  StoreEvents,
  useStore,
  type AggregateOutcome,
  type Aggregation,
  type ExpressionFilter,
  type PropVal,
  type Resource,
} from '@tomic/react';
import { useEffect, useState } from 'react';

/** How long to wait after the last edit before re-reading the totals. */
const REFRESH_DEBOUNCE_MS = 500;

/**
 * The longest a pending re-read may be pushed back by further triggers. A
 * debounce alone starves under a continuous stream (the post-reload drain
 * fires events more often than the debounce window for seconds on end), and a
 * starved totals row shows stale numbers exactly when the data is changing
 * most.
 */
const REFRESH_MAX_WAIT_MS = 1_500;

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
      }
    };

    // When the first not-yet-served refresh request came in. The debounce
    // resets on every trigger, and triggers are NOT guaranteed to be sparse:
    // the post-reload drain/re-sync emits a save or member-update every
    // ~50–150ms for many seconds on a loaded machine, so a plain debounce
    // never fires at all during it — the totals sat frozen for the whole
    // storm (the CI trace shows 15s of triggers with not one read between
    // them). The max-wait turns "quiet for 500ms" into "quiet for 500ms, or
    // overdue" so a continuous stream still gets a read periodically.
    let pendingSince: number | undefined;

    const runRead = () => {
      pendingSince = undefined;
      // A failed read leaves the totals frozen at whatever they showed
      // before — nothing retries until the next trigger — so say so rather
      // than swallowing it.
      void read().catch(e =>
        console.warn('[Aggregates] read failed:', String(e).slice(0, 200)),
      );
    };

    const refresh = () => {
      const now = performance.now();
      pendingSince ??= now;
      clearTimeout(timer);
      // Debounced: typing in a cell saves on every keystroke, and each save
      // would otherwise be a round trip.
      const overdue = now - pendingSince >= REFRESH_MAX_WAIT_MS;
      timer = setTimeout(runRead, overdue ? 0 : REFRESH_DEBOUNCE_MS);
    };

    void read().catch(e =>
      console.warn(
        '[Aggregates] initial read failed:',
        String(e).slice(0, 200),
      ),
    );

    // Any save or delete can change a total — including one made in another
    // tab, which arrives through the same events.
    const offSaved = store.on(StoreEvents.ResourceSaved, refresh);
    const offRemoved = store.on(StoreEvents.ResourceRemoved, refresh);

    // ...but a member can also change WITHOUT a local save: a live push from
    // another client, or the drive re-sync repairing a stale local-db copy
    // after a reload. Those only fire `ResourceUpdated` — the same signal that
    // keeps the grid's own membership live. Without this subscription the
    // totals keep whatever the last read returned; the CI-only "em-dash
    // totals" was exactly that, a read racing (and losing to) the member's
    // newest value arriving in the local db, with nothing ever re-asking.
    //
    // Two guards keep this from looping: `read()` itself hydrates every
    // member it fetches, which re-emits `ResourceUpdated` for each — so a
    // bare refresh here would poll forever. Only a member whose `lastCommit`
    // ADVANCED since we last saw it warrants a re-read; a replay of known
    // state does not.
    const memberStamps = new Map<string, string>();
    const offUpdated = store.on(StoreEvents.ResourceUpdated, changed => {
      const subject = changed.subject;

      // Placeholders and commit resources are never members (mirrors the
      // membership filter in Collection).
      if (changed.new || subject.startsWith('_new:')) return;
      if (subject.startsWith('did:ad:commit:')) return;

      // Only resources this query covers. The primary property/value pair is
      // the membership constraint (`parent` = the table); extra filters only
      // narrow it, so matching just the pair at worst refreshes a little too
      // often — and a refresh is one cheap read.
      const propVal = (changed as Resource).get(property);
      const matches = Array.isArray(propVal)
        ? propVal.some(v => `${v}` === value)
        : `${propVal}` === value;

      if (!matches) return;

      const stamp = `${(changed as Resource).get(commits.properties.lastCommit) ?? ''}`;

      if (memberStamps.get(subject) === stamp) return;

      memberStamps.set(subject, stamp);
      refresh();
    });

    return () => {
      cancelled = true;
      clearTimeout(timer);
      offSaved();
      offRemoved();
      offUpdated();
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
