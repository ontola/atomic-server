import {
  core,
  dataBrowser,
  Resource,
  unknownSubject,
  useArray,
  useBoolean,
  useCanWrite,
  useResource,
  useStore,
  useString,
  useValue,
} from '@tomic/react';
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { TableFilter, FilterOperator } from './tableFiltering';
import { TableSorting, DEFAULT_SORT_PROP } from './tableSorting';

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
  filters: TableFilter[];
  addFilter: (property: string) => void;
  setFilterValue: (property: string, value: string) => void;
  setFilterOperator: (property: string, operator: FilterOperator) => void;
  removeFilter: (property: string) => void;
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
  /** Switch the active view (session-scoped). */
  setActiveView: (subject: string) => void;
  /** Create a new (empty) view, link it to the table, and switch to it. */
  createView: () => void;
}

/**
 * View-backed table state. Filters + sort live on the table's default View
 * resource (`view-filters` JSON, `view-sort-by`/`view-sort-desc`) so they
 * persist across reloads. Local React state is the live source for instant UI;
 * it's hydrated once from the View and then debounce-persisted back. The View
 * is lazily created on the first change (writers only) — until then a table
 * behaves exactly as before.
 */
export function useTableView(table: Resource): UseTableViewResult {
  const store = useStore();
  const canWrite = useCanWrite(table);

  const [defaultViewSubject] = useString(
    table,
    dataBrowser.properties.tableDefaultView,
  );
  const [views] = useArray(table, dataBrowser.properties.tableViews);

  // The active view is session-scoped; it defaults to the table's
  // `default-view` (or the first view) once they load.
  const [activeViewOverride, setActiveViewOverride] = useState<
    string | undefined
  >(undefined);
  const activeView =
    activeViewOverride ?? defaultViewSubject ?? views[0] ?? undefined;
  const view = useResource(activeView ?? unknownSubject);

  // Reactive reads of the View's persisted config.
  const [viewName] = useString(view, core.properties.name);
  const [storedFilters] = useValue(view, dataBrowser.properties.viewFilters);
  const [storedSortBy] = useString(view, dataBrowser.properties.viewSortBy);
  const [storedSortDesc] = useBoolean(
    view,
    dataBrowser.properties.viewSortDesc,
  );
  const [storedColumns] = useArray(view, dataBrowser.properties.viewColumns);

  const [filters, setFilters] = useState<TableFilter[]>([]);
  const [sorting, dispatchSort] = useReducer(sortReducer, DEFAULT_SORT);

  // --- Hydrate from the active View; re-hydrates whenever it changes. ---
  // Tracks which view's config the local state currently mirrors.
  const hydratedForRef = useRef<string | null>(null);
  const lastPersistedRef = useRef<string>('');

  useEffect(() => {
    const key = activeView ?? '__none__';

    if (hydratedForRef.current === key) {
      return;
    }

    // No View yet — start from defaults. Seed `lastPersistedRef` with the
    // empty baseline so merely opening the table does NOT eagerly create a
    // View; only a real filter/sort change does.
    if (!activeView) {
      setFilters([]);
      dispatchSort({
        type: 'hydrate',
        prop: DEFAULT_SORT.prop,
        sortDesc: DEFAULT_SORT.sortDesc,
      });
      lastPersistedRef.current = JSON.stringify({
        filters: [],
        sort: DEFAULT_SORT,
      });
      hydratedForRef.current = key;

      return;
    }

    // Read straight from the resource, not the `useValue`/`useString` hook
    // results: those update a render LATE when the active view switches, so a
    // switch-back would hydrate from the previous view's (stale) values and
    // then lock out the correct re-hydration. `view.get` reflects the resource
    // synchronously, and resources load atomically (so a present `name` means
    // every prop is loaded). The hook results stay in the dep array to re-run
    // this effect once the view's data arrives.
    const loadedName = view.get(core.properties.name);

    if (loadedName === undefined) {
      return;
    }

    const rawFilters = view.get(dataBrowser.properties.viewFilters);
    const rawSortBy = view.get(dataBrowser.properties.viewSortBy) as
      | string
      | undefined;
    const rawSortDesc = view.get(dataBrowser.properties.viewSortDesc) as
      | boolean
      | undefined;

    const initialFilters = Array.isArray(rawFilters)
      ? (rawFilters as unknown as TableFilter[])
      : [];
    const initialSort: TableSorting = rawSortBy
      ? { prop: rawSortBy, sortDesc: !!rawSortDesc }
      : DEFAULT_SORT;

    setFilters(initialFilters);
    dispatchSort({
      type: 'hydrate',
      prop: initialSort.prop,
      sortDesc: initialSort.sortDesc,
    });
    lastPersistedRef.current = JSON.stringify({
      filters: initialFilters,
      sort: initialSort,
    });
    hydratedForRef.current = key;
  }, [activeView, viewName, storedFilters, storedSortBy, storedSortDesc]);

  // --- View creation / linking. ---
  const createViewResource = useCallback(
    async (name: string): Promise<Resource> => {
      const isFirst = views.length === 0 && !defaultViewSubject;
      const created = await store.newResource({
        parent: table.subject,
        isA: dataBrowser.classes.view,
        propVals: {
          [core.properties.name]: name,
          [dataBrowser.properties.viewKind]: 'table',
        },
      });
      await created.save();
      await table.push(
        dataBrowser.properties.tableViews,
        [created.subject],
        true,
      );

      if (isFirst) {
        await table.set(
          dataBrowser.properties.tableDefaultView,
          created.subject,
        );
      }

      await table.save();

      return created;
    },
    [views.length, defaultViewSubject, store, table],
  );

  const setActiveView = useCallback((subject: string) => {
    setActiveViewOverride(subject);
  }, []);

  const createView = useCallback(() => {
    void (async () => {
      const created = await createViewResource(`View ${views.length + 1}`);
      setActiveViewOverride(created.subject);
    })().catch(() => undefined);
  }, [createViewResource, views.length]);

  // --- Persist (debounced) whenever the local config changes post-hydration. ---
  const ensureView = useCallback(async (): Promise<Resource | undefined> => {
    if (activeView) {
      return store.getResourceLoading(activeView);
    }

    return createViewResource('Default View');
  }, [activeView, store, createViewResource]);

  useEffect(() => {
    if (hydratedForRef.current !== (activeView ?? '__none__') || !canWrite) {
      return;
    }

    const snapshot = JSON.stringify({ filters, sort: sorting });

    if (snapshot === lastPersistedRef.current) {
      return;
    }

    const timer = setTimeout(() => {
      void (async () => {
        const v = await ensureView();

        if (!v) {
          return;
        }

        // `false` = skip the client-side property fetch; the server validates
        // the commit against its (locally-seeded) property definitions.
        await v.set(dataBrowser.properties.viewFilters, filters, false);
        await v.set(dataBrowser.properties.viewSortBy, sorting.prop, false);
        await v.set(
          dataBrowser.properties.viewSortDesc,
          sorting.sortDesc,
          false,
        );
        await v.save();
        lastPersistedRef.current = snapshot;
      })().catch(() => undefined);
    }, 600);

    return () => clearTimeout(timer);
  }, [filters, sorting, canWrite, ensureView, store, activeView]);

  // --- Filter mutators (same shape as the old `useTableFilters`). ---
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

  const setSortBy = useCallback((property: string) => {
    dispatchSort({ type: 'cycle', property });
  }, []);

  // --- Column order/visibility + name. Persisted immediately (discrete
  // actions), lazy-creating the View like the filter/sort path. ---
  const setViewColumns = useCallback(
    (columns: string[]) => {
      void (async () => {
        const v = await ensureView();

        if (!v) {
          return;
        }

        await v.set(dataBrowser.properties.viewColumns, columns, false);
        await v.save();
      })().catch(() => undefined);
    },
    [ensureView],
  );

  const renameView = useCallback(
    (name: string) => {
      void (async () => {
        const v = await ensureView();

        if (!v) {
          return;
        }

        await v.set(core.properties.name, name, false);
        await v.save();
      })().catch(() => undefined);
    },
    [ensureView],
  );

  return {
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
  };
}
