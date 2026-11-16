import {
  core,
  dataBrowser,
  JSONValue,
  Resource,
  unknownSubject,
  useArray,
  useCanWrite,
  useResourceSnapshot,
  useStore,
  useString,
} from '@tomic/react';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import {
  type TableViewWriteContext,
  type TableViewConfiguration,
  useTableNavigation,
  createTableViewWriteQueues,
  createTableViewDraftSession,
  createTableViewInitializer,
  selectTableView,
  tableViewReferences,
  assertTableViewTarget,
  assertTableViewOrder,
  assertTableViewOwner,
} from '@tomic/table';
import { enqueueAtomicViewFilters } from './atomicViewFilterWriter';
import {
  atomicViewFilterSource,
  rebaseAtomicViewFilters,
  type AtomicViewFilterDraft,
  useAtomicViewConfiguration,
  writeAtomicTableViewConfiguration,
  copyAtomicTableViewConfiguration,
} from './atomicViewConfiguration';
import {
  filterKey,
  parseFilterKey,
  type FilterOperator,
  type TableFilter,
} from './tableFiltering';
import { type DerivedColumnSpec } from './derivedColumns';
import { type GroupGranularity, type TableAggregate } from './tableAggregates';
import { type RowActionSpec } from './rowActions';
import { type QuickAddSpec } from './quickAdd';
import { TableSorting, DEFAULT_SORT_PROP } from './tableSorting';
import {
  ViewKind,
  DEFAULT_VIEW_KIND,
  appViewOf,
  normalizeViewKind,
  VIEW_KIND_LABELS,
} from './tableViewKinds';
import {
  canChangeViewType,
  canDeleteView,
  nameAfterTypeChange,
  viewTypeKey,
} from './viewTypeChoice';

interface ViewCreationOptions {
  prepared?: ReturnType<typeof createTableViewInitializer<Resource>>;
  intent?: TableViewWriteContext;
}

function readViewReferences(table: Resource): string[] {
  const views = table.get(dataBrowser.properties.tableViews);
  const defaultView = table.get(dataBrowser.properties.tableDefaultView);

  return tableViewReferences(
    Array.isArray(views) ? (views as string[]) : [],
    typeof defaultView === 'string' ? defaultView : undefined,
  );
}

const DEFAULT_SORT: TableSorting = { prop: DEFAULT_SORT_PROP, sortDesc: false };

type SortAction =
  | { type: 'cycle'; property: string }
  | { type: 'hydrate'; prop: string; sortDesc: boolean };

/** Same 3-click cycle as the old `useTableSorting`, plus a hydrate action. */
function sortReducer(state: TableSorting, action: SortAction): TableSorting {
  if (action.type === 'hydrate') {
    return { prop: action.prop, sortDesc: action.sortDesc };
  }

  if (state.prop === action.property && state.sortDesc) {
    return DEFAULT_SORT;
  }

  if (state.prop === action.property) {
    return { ...state, sortDesc: true };
  }

  return { prop: action.property, sortDesc: false };
}

export interface UseTableViewResult {
  viewConfiguration: TableViewConfiguration;
  viewReady: boolean;
  viewSaving: boolean;
  viewSaveError?: string;
  retryViewSave: () => void;
  viewError?: string;
  filters: TableFilter[];
  /** Adds an empty filter for a target (`filterKey`: a property subject, or
   *  `derived:<id>` for a computed column). No-op if one already exists. */
  addFilter: (key: string) => void;
  setFilterValue: (key: string, value: string) => void;
  setFilterOperator: (key: string, operator: FilterOperator) => void;
  removeFilter: (key: string) => void;
  clearFilters: () => void;
  sorting: TableSorting;
  setSortBy: (property: string) => void;
  /** The active View resource (or an unknown resource until one exists). */
  view: Resource;
  /** Configured column order (visible property subjects); empty = class default. */
  viewColumns: string[];
  /** Persist the column order/visibility to the active View (lazy-creates it). */
  setViewColumns: (columns: string[]) => void;
  /** The active View's name ('Default View' until renamed / created). */
  viewName: string;
  renameView: (name: string) => void;
  /** All saved View subjects of the table, in order (the tabs). */
  views: string[];
  /** The active View subject (undefined until one exists). */
  activeView: string | undefined;
  /** Switch the active view, via the `?view=` search param. */
  setActiveView: (subject: string) => void;
  /** Create a new (empty) view of the given kind, link it, and switch to it. */
  createView: (kind?: ViewKind | string, label?: string) => void;
  /**
   * Change a view's renderer kind in place — only when another view of its
   * current type remains (#1806); otherwise a new view is added instead. A
   * default name ("All pieces", "Table") becomes the new type's `label`.
   */
  setViewKind: (
    subject: string,
    kind: ViewKind | string,
    label?: string,
  ) => void;
  /** Copy a view (its config) into a new "<name> copy" view and switch to it. */
  duplicateView: (subject: string) => void;
  /** Put the table's views in a new order (the tab order). */
  reorderViews: (views: string[]) => void;
  /** Remove a view from the table and destroy its resource. */
  deleteView: (subject: string) => void;
  /** Which renderer the active view uses ('table' until a View exists). */
  viewKind: ViewKind;
  /** Set when this view is rendered by an app rather than a built-in kind. */
  appView: string | undefined;
  /** For dashboard views: the Dashboard resource the tab shows. */
  viewDashboard: string | undefined;
  /**
   * The property this view arranges rows by: a SelectProperty (kanban), a date
   * property (calendar), or the start timestamp (timer).
   */
  viewGroupBy: string | undefined;
  /** Persist the group-by property to the active View (lazy-creates it). */
  setViewGroupBy: (property: string) => void;
  /** For timer views: the timestamp property holding each entry's end. */
  viewEndProp: string | undefined;
  /** Persist the end property to the active View (lazy-creates it). */
  setViewEndProp: (property: string) => void;
  /**
   * For timer views: whether starting an entry stops whatever else is running.
   * Defaults to true (one timer at a time) when the View has no stored value.
   */
  viewTimerExclusive: boolean;
  /** Persist the exclusivity toggle to the active View (lazy-creates it). */
  setViewTimerExclusive: (exclusive: boolean) => void;
  /** LocalizedText properties split into one column per language tag. */
  viewSplitLanguages: string[];
  /** Persist the split-language property list to the active View (lazy-creates it). */
  setViewSplitLanguages: (properties: string[]) => void;
  /**
   * The computed columns this view shows next to its stored ones — a duration,
   * a days-since. Pure configuration: see `derivedColumns.ts`.
   */
  viewDerivedColumns: DerivedColumnSpec[];
  /**
   * Whether the View has a derived-column list at all. An empty list is a
   * decision ("I removed the last one"); an absent one is silence, which is what
   * lets a timer view supply its Duration without ever writing config.
   */
  viewDerivedColumnsSet: boolean;
  /** Persist the derived columns to the active View (lazy-creates it). */
  setViewDerivedColumns: (specs: DerivedColumnSpec[]) => void;
  /**
   * The display order of this view's columns, by key — property subjects for
   * stored columns, `derived:<id>` / `timer-action` for the ones a view adds.
   * Empty = the default order for the view kind.
   */
  viewColumnOrder: string[];
  /** Persist the column order to the active View (lazy-creates it). */
  setViewColumnOrder: (order: string[]) => void;
  /**
   * The statistics shown under the rows. The store computes them over every row
   * the view matches, so they are exact regardless of paging.
   */
  viewAggregates: TableAggregate[];
  /** Persist the statistics to the active View (lazy-creates it). */
  setViewAggregates: (aggregates: TableAggregate[]) => void;
  /**
   * The buttons this view puts on each row — "Watered", "Mark done", "+1".
   * Configuration, like the computed columns: a closed set of patches the store
   * can execute, never code. See `rowActions.ts`.
   */
  viewRowActions: RowActionSpec[];
  /** Persist the row actions to the active View (lazy-creates it). */
  setViewRowActions: (actions: RowActionSpec[]) => void;
  /**
   * The button this view offers for creating a row — "Log a feed", "Add item".
   * Undefined when the view offers none.
   */
  viewQuickAdd: QuickAddSpec | undefined;
  /** Persist the quick-add (undefined removes it). */
  setViewQuickAdd: (spec: QuickAddSpec | undefined) => void;
  /** The property the statistics are broken down by, if any. */
  viewGroupByColumn: string | undefined;
  /** Persist the breakdown property (empty string clears it). */
  setViewGroupByColumn: (property: string) => void;
  /** How a date/timestamp breakdown column is bucketed. */
  viewGroupGranularity: GroupGranularity;
  /** Persist the bucket size of the breakdown. */
  setViewGroupGranularity: (granularity: GroupGranularity) => void;
}

/**
 * View-backed table state. Filters + sort live on the table's default View
 * resource (`view-filters` JSON, `view-sort-by`/`view-sort-desc`) so they
 * persist across reloads. Local React state is the live source for instant UI;
 * its scoped draft is debounce-persisted back. Pristine state follows the View.
 * A View is lazily created on the first change (writers only) — until then a table
 * behaves exactly as before.
 */
export function useTableView(
  table: Resource,
  /**
   * Which view to show, when the caller decides rather than the URL. A dashboard
   * embeds a table per block, so `?view=` — one param for the whole page —
   * cannot say which view each of them shows.
   */
  viewOverride?: string,
  /**
   * An embedded table never reads the host page's `?view=`: that param names a
   * view of the host's table, and for a dashboard block of its own table it is
   * the dashboard itself, which would render itself inside itself.
   */
  embedded = false,
): UseTableViewResult {
  const store = useStore();
  const canWrite = useCanWrite(table);
  const [writeQueues] = useState(createTableViewWriteQueues);
  const writes = writeQueues.get(table.subject);
  useEffect(
    () => () => writeQueues.release(table.subject),
    [writeQueues, table.subject],
  );
  const [filterSession] = useState(() =>
    createTableViewDraftSession<AtomicViewFilterDraft>({
      allowEditsWhileSaving: true,
      concurrentScopes: true,
      rebase: rebaseAtomicViewFilters,
    }),
  );
  const filterDrafts = useSyncExternalStore(
    filterSession.subscribe,
    filterSession.getSnapshot,
    filterSession.getSnapshot,
  );
  const writeState = useSyncExternalStore(
    writes.subscribe,
    writes.getSnapshot,
    writes.getSnapshot,
  );

  const [defaultViewSubject] = useString(
    table,
    dataBrowser.properties.tableDefaultView,
  );
  const [storedViews] = useArray(table, dataBrowser.properties.tableViews);
  const views = useMemo(
    () => tableViewReferences(storedViews, defaultViewSubject),
    [storedViews, defaultViewSubject],
  );

  // The active view lives in the URL (`?view=`), so a tab is linkable, survives
  // a reload, and lands in browser history — back/forward moves between views
  // instead of leaving the page. Absent = the table's `default-view` (or the
  // first one) once they load.
  const { location, navigate } = useTableNavigation();
  const activeViewParam = location.view;
  const selection = selectTableView({
    views,
    defaultView: defaultViewSubject,
    requested: embedded ? undefined : activeViewParam,
    override: viewOverride,
    loading: table.loading,
  });
  const activeView =
    selection.status === 'selected' ? selection.subject : undefined;
  const viewSnapshot = useResourceSnapshot(activeView ?? unknownSubject);
  const view = viewSnapshot.resource;
  const viewLoading = viewSnapshot.loading;
  const configuration = useAtomicViewConfiguration(view);
  const ownerMatches = configuration.owner === table.subject;
  const viewError =
    selection.status === 'missing' ||
    (selection.status === 'selected' && !viewLoading && !ownerMatches)
      ? 'Saved view is unavailable in this table.'
      : configuration.issues.length
        ? 'Saved view configuration is invalid.'
        : undefined;
  const viewReady =
    (selection.status === 'implicit' ||
      (selection.status === 'selected' && !viewLoading && ownerMatches)) &&
    !configuration.issues.length;

  // The `?view=` the URL carries *now*, rather than as of the render that a
  // long-running action started in. Creating or duplicating a view writes to the
  // server before it switches tabs, and by the time that switch lands the person
  // may have picked a different tab themselves. Measured on a loaded machine:
  // adding an app view to a fresh table costs two sequential commits, a tab
  // click arrived while they were in flight, and the switch undid it 250ms
  // later, which is the one thing adding a way to look at rows must not do.
  const liveViewParam = useRef(activeViewParam);

  useEffect(() => {
    liveViewParam.current = activeViewParam;
  }, [activeViewParam]);

  const {
    name: viewName,
    columns: storedColumns,
    kind: storedKind,
    dashboard: viewDashboard,
    groupBy: viewGroupBy,
    endProp: viewEndProp,
    timerExclusive: storedTimerExclusive,
    splitLanguages: storedSplitLanguages,
    derivedColumns: viewDerivedColumns,
    derivedColumnsSet,
    columnOrder: viewColumnOrder,
    aggregates: viewAggregates,
    rowActions: viewRowActions,
    quickAdd: viewQuickAdd,
    groupByColumn: storedGroupByColumn,
    groupGranularity: storedGroupGranularity,
  } = configuration.config;

  const viewScope = JSON.stringify([table.subject, activeView ?? null]);
  const filterSource = useMemo(
    () => atomicViewFilterSource(configuration.config),
    [configuration.config],
  );
  const workingFilters = filterSession.read(viewScope, filterSource);
  const { filters, sorting } = workingFilters.value;
  const filterDraft = filterDrafts.drafts.get(viewScope);
  const editFilters = useCallback(
    (change: (value: AtomicViewFilterDraft) => AtomicViewFilterDraft) => {
      filterSession.edit(viewScope, filterSource, change);
    },
    [filterSession, viewScope, filterSource],
  );

  // --- View creation / linking. ---
  /**
   * The Dashboard a dashboard view shows. A child of the table, so the two
   * travel together; a first-class resource, so a Drive page can still embed
   * it. Empty on creation: the page itself is the editor.
   */
  const createDashboardResource = useCallback(
    async (name: string, intent?: TableViewWriteContext): Promise<Resource> => {
      const prepare = () =>
        store.newResource({
          parent: table.subject,
          isA: dataBrowser.classes.dashboard,
          propVals: { [core.properties.name]: name },
        });
      const dashboard = await (intent
        ? intent.checkpoint('dashboard:prepared', prepare)
        : prepare());
      assertTableViewOwner(
        { table: table.subject },
        { table: dashboard.get(core.properties.parent) as string },
      );
      if (intent)
        await intent.checkpoint('dashboard:saved', () => dashboard.save());
      else await dashboard.save();

      return dashboard;
    },
    [store, table],
  );

  /** Save a View under the table, link it, and optionally make it the default. */
  const saveNewView = useCallback(
    async (
      propVals: Record<string, string>,
      makeDefault: boolean,
      { prepared, intent }: ViewCreationOptions = {},
    ): Promise<Resource> => {
      const prepare = () =>
        store.newResource({
          parent: table.subject,
          isA: dataBrowser.classes.view,
          propVals,
        });
      const created = await (prepared
        ? prepared.ensure(prepare)
        : intent
          ? intent.checkpoint(
              'view:prepared:' + propVals[dataBrowser.properties.viewKind],
              prepare,
            )
          : prepare());
      assertTableViewOwner(
        { table: table.subject },
        { table: created.get(core.properties.parent) as string },
      );

      if (intent)
        await intent.checkpoint('view:saved:' + created.subject, () =>
          created.save(),
        );
      else await created.save();

      if (prepared)
        filterSession.alias(
          viewScope,
          JSON.stringify([table.subject, created.subject]),
        );

      const attach = async () => {
        assertTableViewOwner(
          { table: table.subject },
          { table: created.get(core.properties.parent) as string },
        );
        await table.push(
          dataBrowser.properties.tableViews,
          [created.subject],
          true,
        );

        if (makeDefault) {
          await table.set(
            dataBrowser.properties.tableDefaultView,
            created.subject,
          );
        }

        await table.save();
      };

      if (intent)
        await intent.checkpoint('view:attached:' + created.subject, attach);
      else await attach();

      return created;
    },
    [store, table, filterSession, viewScope],
  );

  const createViewResource = useCallback(
    async (
      name: string,
      kind: ViewKind | string = DEFAULT_VIEW_KIND,
      options: ViewCreationOptions = {},
    ): Promise<Resource> => {
      let isFirst = readViewReferences(table).length === 0;

      if (kind === 'dashboard' && isFirst) {
        // The first saved view replaces the implicit "Default View" tab and
        // becomes what the table opens on. A dashboard must be neither: the
        // rows keep their tab and stay the default, so materialize that view
        // first, exactly as adding a filter to it would have.
        await saveNewView(
          {
            [core.properties.name]: 'Default View',
            [dataBrowser.properties.viewKind]: DEFAULT_VIEW_KIND,
          },
          true,
          options,
        );
        isFirst = false;
      }

      const propVals: Record<string, string> = {
        [core.properties.name]: name,
        [dataBrowser.properties.viewKind]: kind,
      };

      if (kind === 'dashboard') {
        const tableName = (table.get(core.properties.name) as string) ?? '';
        const dashboard = await createDashboardResource(
          tableName ? `${tableName} dashboard` : name,
          options.intent,
        );
        propVals[dataBrowser.properties.viewDashboard] = dashboard.subject;
      }

      return saveNewView(propVals, isFirst, options);
    },
    [table, createDashboardResource, saveNewView],
  );

  /**
   * Switches the active view by rewriting `?view=`. Picking a tab is a
   * navigation, so it pushes history; the programmatic switches below (after
   * creating or deleting a view) replace instead, so Back doesn't return to a
   * view that no longer exists or that the user never chose.
   */
  const goToView = useCallback(
    (subject: string | undefined, replace: boolean) => {
      void navigate({ view: subject }, { replace });
    },
    [navigate],
  );

  const setActiveView = useCallback(
    (subject: string) => {
      // Written here, in the tick the tab was clicked in. The effect above only
      // lands on the next render, and a switch queued before this click may
      // resolve in between and has to be able to see that it lost.
      liveViewParam.current = subject;
      goToView(subject, false);
    },
    [goToView],
  );

  /**
   * Switch to a view this code has just made, unless the person has chosen
   * another tab while it was being written. Theirs is the later intent, and a
   * `replace` navigation would take it away without a trace in history.
   *
   * `from` is the `?view=` read before the writes started, so "unchanged" and
   * "changed back to where it was" are deliberately the same case.
   */
  const goToCreatedView = useCallback(
    (subject: string, from: string | undefined) => {
      if (liveViewParam.current !== from) {
        return;
      }

      goToView(subject, true);
    },
    [goToView],
  );

  const createView = useCallback(
    (kind: ViewKind | string = DEFAULT_VIEW_KIND, label?: string) => {
      const from = liveViewParam.current;
      void writes.enqueue(async intent => {
        // A table with no saved views shows one implicit Table tab, and that
        // tab disappears the moment a real view exists. So adding a Calendar,
        // a Kanban or an app to a fresh table would take the table away — the
        // one thing an extra way of looking at rows must never do. Give it back
        // explicitly first. A dashboard does this itself in `createViewResource`.
        if (
          kind !== DEFAULT_VIEW_KIND &&
          kind !== 'dashboard' &&
          readViewReferences(table).length === 0
        ) {
          await createViewResource(
            VIEW_KIND_LABELS[DEFAULT_VIEW_KIND],
            DEFAULT_VIEW_KIND,
            { intent },
          );
        }

        // Named after its kind ("Table" / "Kanban" / …), or after the app,
        // whose subject would be a meaningless tab title.
        const created = await createViewResource(
          label ?? VIEW_KIND_LABELS[kind as ViewKind],
          kind,
          { intent },
        );
        goToCreatedView(created.subject, from);
      });
    },
    [createViewResource, table, goToCreatedView, writes],
  );

  // --- Persist (debounced) whenever the local config changes post-hydration. ---
  const viewInitializer = useMemo(
    () =>
      createTableViewInitializer<Resource>(
        JSON.stringify([table.subject, activeView]),
      ),
    [table.subject, activeView],
  );

  const preparedDefault = useMemo(
    () =>
      createTableViewInitializer<Resource>(
        JSON.stringify([table.subject, activeView]),
      ),
    [table.subject, activeView],
  );

  const ensureView = useCallback(async (): Promise<Resource | undefined> => {
    if (!viewReady) return undefined;

    if (activeView) {
      const selected = await store.getResource(activeView);
      assertTableViewOwner(
        { table: table.subject },
        { table: selected.get(core.properties.parent) as string },
      );

      return selected;
    }

    // Preparation aliases the working draft before attachment exposes the new
    // identity. Once attached, the implicit scope stops owning that draft.
    return viewInitializer
      .ensure(() =>
        createViewResource('Default View', DEFAULT_VIEW_KIND, {
          prepared: preparedDefault,
        }),
      )
      .then(created => {
        filterSession.move(
          viewScope,
          JSON.stringify([table.subject, created.subject]),
        );

        return created;
      });
  }, [
    activeView,
    store,
    createViewResource,
    viewReady,
    viewInitializer,
    preparedDefault,
    filterSession,
    viewScope,
    table.subject,
  ]);

  const flushFilters = useCallback(() => {
    if (!viewReady || !canWrite || writeState.error) return;
    const draft = filterSession.getSnapshot().drafts.get(viewScope);
    if (!draft || filterSession.read(viewScope, filterSource).saving) return;

    if (
      !writeState.busy &&
      JSON.stringify(draft.value) === JSON.stringify(filterSource.value)
    ) {
      filterSession.discard(viewScope);

      return;
    }

    enqueueAtomicViewFilters({
      session: filterSession,
      writes,
      scope: viewScope,
      source: filterSource,
      table,
      ensureView,
    });
  }, [
    viewReady,
    canWrite,
    writeState.error,
    writeState.busy,
    filterSession,
    viewScope,
    filterSource,
    writes,
    table,
    ensureView,
  ]);
  useEffect(() => {
    if (!filterDraft || workingFilters.saving || writeState.error) return;
    const timer = setTimeout(flushFilters, 600);

    return () => clearTimeout(timer);
  }, [filterDraft, workingFilters.saving, writeState.error, flushFilters]);

  // Leaving a view flushes its latest scoped draft, rather than cancelling the
  // debounce and losing the edit. The callback registry is updated in effects,
  // so cleanup retains the old view's backend target after a new render.
  const filterFlushes = useRef(new Map<string, () => void>());
  useEffect(() => {
    filterFlushes.current.set(viewScope, flushFilters);
  }, [viewScope, flushFilters]);
  useEffect(
    () => () => {
      filterFlushes.current.get(viewScope)?.();
      filterFlushes.current.delete(viewScope);
    },
    [viewScope],
  );

  // --- Filter mutators (same shape as the old `useTableFilters`). ---
  // Keyed by `filterKey`: a property subject, or `derived:<id>` for a constraint
  // on a computed column. One key keeps every setter working for both kinds.
  const addFilter = useCallback(
    (key: string) => {
      editFilters(value => ({
        ...value,
        filters: value.filters.some(filter => filterKey(filter) === key)
          ? value.filters
          : [
              ...value.filters,
              {
                ...parseFilterKey(key),
                operator: key.startsWith('derived:') ? 'gte' : 'eq',
                value: '',
              },
            ],
      }));
    },
    [editFilters],
  );
  const setFilterValue = useCallback(
    (key: string, text: string) => {
      editFilters(value => ({
        ...value,
        filters: value.filters.map(filter =>
          filterKey(filter) === key ? { ...filter, value: text } : filter,
        ),
      }));
    },
    [editFilters],
  );
  const setFilterOperator = useCallback(
    (key: string, operator: FilterOperator) => {
      editFilters(value => ({
        ...value,
        filters: value.filters.map(filter =>
          filterKey(filter) === key ? { ...filter, operator } : filter,
        ),
      }));
    },
    [editFilters],
  );
  const removeFilter = useCallback(
    (key: string) => {
      editFilters(value => ({
        ...value,
        filters: value.filters.filter(filter => filterKey(filter) !== key),
      }));
    },
    [editFilters],
  );
  const clearFilters = useCallback(
    () => editFilters(value => ({ ...value, filters: [] })),
    [editFilters],
  );
  const setSortBy = useCallback(
    (property: string) => {
      editFilters(value => ({
        ...value,
        sorting: sortReducer(value.sorting, { type: 'cycle', property }),
      }));
    },
    [editFilters],
  );

  // --- Column order/visibility + name. Persisted immediately (discrete
  // actions), lazy-creating the View like the filter/sort path. ---
  /**
   * Run `write` against the active View (lazy-creating it) and save. Fire and
   * forget: failed operations remain queued for an explicit retry.
   */
  const withView = useCallback(
    (write: (view: Resource) => void | Promise<void>) => {
      void writes.enqueue(async () => {
        const v = await ensureView();

        if (!v) {
          return;
        }

        await write(v);
        await v.save();
      });
    },
    [ensureView, writes],
  );

  const setViewColumns = useCallback(
    (columns: string[]) =>
      withView(v => writeAtomicTableViewConfiguration(v, { columns: columns })),
    [withView],
  );

  const renameView = useCallback(
    (name: string) =>
      withView(v => writeAtomicTableViewConfiguration(v, { name: name })),
    [withView],
  );

  const setViewGroupBy = useCallback(
    (property: string) =>
      withView(v =>
        writeAtomicTableViewConfiguration(v, { groupBy: property }),
      ),
    [withView],
  );

  const setViewEndProp = useCallback(
    (property: string) =>
      withView(v =>
        writeAtomicTableViewConfiguration(v, { endProp: property }),
      ),
    [withView],
  );

  const setViewTimerExclusive = useCallback(
    (exclusive: boolean) =>
      withView(v =>
        writeAtomicTableViewConfiguration(v, { timerExclusive: exclusive }),
      ),
    [withView],
  );

  const setViewSplitLanguages = useCallback(
    (splitProperties: string[]) =>
      withView(v =>
        writeAtomicTableViewConfiguration(v, {
          splitLanguages: splitProperties,
        }),
      ),
    [withView],
  );

  const setViewDerivedColumns = useCallback(
    (specs: DerivedColumnSpec[]) =>
      withView(v =>
        writeAtomicTableViewConfiguration(v, { derivedColumns: specs }),
      ),
    [withView],
  );

  const setViewColumnOrder = useCallback(
    (order: string[]) =>
      withView(v =>
        writeAtomicTableViewConfiguration(v, { columnOrder: order }),
      ),
    [withView],
  );

  const setViewAggregates = useCallback(
    (aggregates: TableAggregate[]) =>
      withView(v =>
        writeAtomicTableViewConfiguration(v, { aggregates: aggregates }),
      ),
    [withView],
  );

  const setViewRowActions = useCallback(
    (actions: RowActionSpec[]) =>
      withView(v =>
        writeAtomicTableViewConfiguration(v, { rowActions: actions }),
      ),
    [withView],
  );

  const setViewQuickAdd = useCallback(
    (spec: QuickAddSpec | undefined) =>
      withView(v => writeAtomicTableViewConfiguration(v, { quickAdd: spec })),
    [withView],
  );

  const setViewGroupByColumn = useCallback(
    (property: string) =>
      withView(v =>
        writeAtomicTableViewConfiguration(v, { groupByColumn: property }),
      ),
    [withView],
  );

  const setViewGroupGranularity = useCallback(
    (granularity: GroupGranularity) =>
      withView(v =>
        writeAtomicTableViewConfiguration(v, { groupGranularity: granularity }),
      ),
    [withView],
  );

  /** Each saved view's type, read as the tabs show it right now. */
  const readViewTypes = useCallback(
    (): Map<string, string> =>
      new Map(
        readViewReferences(table).map((s): [string, string] => {
          const target = store.getResourceLoading(s);

          return [
            s,
            target.get(core.properties.parent) === table.subject
              ? viewTypeKey(
                  target.get(dataBrowser.properties.viewKind) as
                    | string
                    | undefined,
                )
              : 'unavailable:' + s,
          ];
        }),
      ),
    [table, store],
  );

  const setViewKind = useCallback(
    (subject: string, kind: ViewKind | string, label?: string) => {
      if (!views.includes(subject)) return;
      const from = liveViewParam.current;
      void writes.enqueue(async intent => {
        const v = await store.getResource(subject);
        assertTableViewOwner(
          { table: table.subject },
          { table: v.get(core.properties.parent) as string },
        );
        assertTableViewTarget(subject, [...readViewTypes().keys()]);
        const decision = await intent.checkpoint('type:decision', async () => {
          const typesBySubject = readViewTypes();
          const fromType = typesBySubject.get(subject)!;
          const fromApp = appViewOf(fromType);

          return {
            change: canChangeViewType(subject, typesBySubject),
            newName: nameAfterTypeChange(
              v.get(core.properties.name) as string | undefined,
              fromType,
              label ?? VIEW_KIND_LABELS[normalizeViewKind(kind)],
              fromApp ? store.getResourceLoading(fromApp).title : undefined,
            ),
          };
        });

        if (!decision.change) {
          const created = await createViewResource(
            label ?? VIEW_KIND_LABELS[normalizeViewKind(kind)],
            kind,
            { intent },
          );
          goToCreatedView(created.subject, from);

          return;
        }

        const newName = decision.newName;

        await writeAtomicTableViewConfiguration(v, { kind });

        if (newName !== undefined) {
          await writeAtomicTableViewConfiguration(v, { name: newName });
        }

        // Switching an existing tab to a dashboard needs one to show; keep
        // any it already names, so switching away and back loses nothing.
        if (
          kind === 'dashboard' &&
          !v.get(dataBrowser.properties.viewDashboard)
        ) {
          const tableName = (table.get(core.properties.name) as string) ?? '';
          const dashboard = await createDashboardResource(
            tableName ? `${tableName} dashboard` : 'Dashboard',
            intent,
          );
          await writeAtomicTableViewConfiguration(v, {
            dashboard: dashboard.subject,
          });
        }

        await v.save();
      });
    },
    [
      store,
      table,
      createDashboardResource,
      createViewResource,
      readViewTypes,
      views,
      writes,
      goToCreatedView,
    ],
  );

  const duplicateView = useCallback(
    (subject: string) => {
      const from = liveViewParam.current;
      void writes.enqueue(async intent => {
        assertTableViewTarget(subject, [...readViewTypes().keys()]);
        const src = await store.getResource(subject);
        assertTableViewOwner(
          { table: table.subject },
          { table: src.get(core.properties.parent) as string },
        );
        const srcName = (src.get(core.properties.name) as string) ?? 'View';

        // Copy the source config; only include props that are actually set so
        // we don't write `undefined` values onto the copy.
        const propVals: Record<string, JSONValue> = {
          [core.properties.name]: `${srcName} copy`,
          [dataBrowser.properties.viewKind]:
            (src.get(dataBrowser.properties.viewKind) as string) ??
            DEFAULT_VIEW_KIND,
        };

        Object.assign(propVals, copyAtomicTableViewConfiguration(src));

        const created = await intent.checkpoint('copy:prepared', () =>
          store.newResource({
            parent: table.subject,
            isA: dataBrowser.classes.view,
            propVals,
          }),
        );
        assertTableViewOwner(
          { table: table.subject },
          { table: created.get(core.properties.parent) as string },
        );
        await intent.checkpoint('copy:saved', () => created.save());
        await intent.checkpoint('copy:attached', async () => {
          assertTableViewOwner(
            { table: table.subject },
            { table: created.get(core.properties.parent) as string },
          );
          await table.push(
            dataBrowser.properties.tableViews,
            [created.subject],
            true,
          );
          await table.save();
        });
        goToCreatedView(created.subject, from);
      });
    },
    [store, table, goToCreatedView, readViewTypes, writes],
  );

  const deleteView = useCallback(
    (subject: string) => {
      // The last table view stays while other views exist: without it the
      // rows' own layout is gone (#1806). The tab menu disables this too.
      if (
        !views.includes(subject) ||
        !canDeleteView(subject, readViewTypes())
      ) {
        return;
      }

      void writes.enqueue(async intent => {
        const target = await intent.checkpoint('delete:target', () =>
          store.getResource(subject),
        );
        assertTableViewOwner(
          { table: table.subject },
          { table: target.get(core.properties.parent) as string },
        );
        const next = await intent.checkpoint('delete:detached', async () => {
          const current = readViewTypes();
          if (current.has(subject) && !canDeleteView(subject, current))
            throw Error('Keep a Table view available.');
          const remaining = [...current.keys()].filter(v => v !== subject);
          await table.set(dataBrowser.properties.tableViews, remaining, false);

          if (table.get(dataBrowser.properties.tableDefaultView) === subject) {
            await table.set(
              dataBrowser.properties.tableDefaultView,
              remaining[0] ?? '',
              false,
            );
          }

          await table.save();

          return remaining;
        });
        // A retry must not take navigation away from a later tab choice.
        if (liveViewParam.current === subject) goToView(next[0], true);

        await target.destroy();
        filterSession.discard(JSON.stringify([table.subject, subject]));
      });
    },
    [views, table, store, readViewTypes, goToView, writes, filterSession],
  );

  const reorderViews = useCallback(
    (next: string[]) => {
      const order = [...next];
      void writes.enqueue(async () => {
        const current = readViewReferences(table);
        assertTableViewOrder(current, order);
        await table.set(dataBrowser.properties.tableViews, order, false);
        await table.save();
      });
    },
    [table, writes],
  );

  return {
    viewConfiguration: {
      ...configuration.config,
      filters,
      sortBy: sorting.prop,
      sortDesc: sorting.sortDesc,
    },
    viewReady,
    viewSaving: writeState.busy,
    viewSaveError: writeState.error?.message ?? workingFilters.error?.message,
    retryViewSave: () => {
      void writes.retry();
    },
    viewError,
    filters,
    addFilter,
    setFilterValue,
    setFilterOperator,
    removeFilter,
    clearFilters,
    sorting,
    setSortBy,
    view,
    viewColumns: Array.isArray(storedColumns)
      ? (storedColumns as string[])
      : [],
    setViewColumns,
    viewName: viewName ?? 'Default View',
    renameView,
    views: views as string[],
    activeView,
    setActiveView,
    createView,
    setViewKind,
    duplicateView,
    reorderViews,
    deleteView,
    viewKind: normalizeViewKind(storedKind),
    appView: appViewOf(storedKind),
    viewDashboard,
    viewGroupBy,
    setViewGroupBy,
    viewEndProp,
    setViewEndProp,
    viewTimerExclusive:
      storedTimerExclusive === undefined ? true : !!storedTimerExclusive,
    setViewTimerExclusive,
    viewSplitLanguages: Array.isArray(storedSplitLanguages)
      ? (storedSplitLanguages as string[])
      : [],
    setViewSplitLanguages,
    viewDerivedColumns,
    viewDerivedColumnsSet: derivedColumnsSet,
    setViewDerivedColumns,
    viewColumnOrder,
    setViewColumnOrder,
    viewAggregates,
    setViewAggregates,
    viewRowActions,
    setViewRowActions,
    viewQuickAdd,
    setViewQuickAdd,
    viewGroupByColumn: storedGroupByColumn || undefined,
    setViewGroupByColumn,
    viewGroupGranularity: (storedGroupGranularity as GroupGranularity) || 'day',
    setViewGroupGranularity,
  };
}
