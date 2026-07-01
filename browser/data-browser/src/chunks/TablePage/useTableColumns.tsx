import { Resource, useStore, urls, useArray, Property } from '@tomic/react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { reorderArray } from '@chunks/TableEditor';

type UseTableColumnsReturnType = {
  /** The columns shown in the grid: visible, in the view's display order. */
  columns: Property[];
  /** Every property of the table's class (for the column-visibility menu). */
  allColumns: Property[];
  reorderColumns: (
    sourceIndex: number,
    destinationIndex: number,
  ) => Promise<void>;
  hideColumn: (subject: string) => void;
  showColumn: (subject: string) => void;
};

const valueOpts = {
  commit: true,
};

/**
 * Derives the table's columns from the class's `requires` + `recommends`, then
 * layers the active View's `view-columns` on top for per-view ordering and
 * visibility. Reorder/hide/show write to the View (via `setViewColumns`), not
 * the class, so they're scoped to the view.
 */
export function useTableColumns(
  tableClass: Resource,
  viewColumns: string[],
  setViewColumns: (columns: string[]) => void,
): UseTableColumnsReturnType {
  const store = useStore();

  const [requiredProps] = useArray(
    tableClass,
    urls.properties.requires,
    valueOpts,
  );
  const [recommendedProps] = useArray(
    tableClass,
    urls.properties.recommends,
    valueOpts,
  );

  const [allColumns, setAllColumns] = useState<Property[]>([]);

  useEffect(() => {
    const props = [...requiredProps, ...recommendedProps];

    Promise.all(props.map(prop => store.getProperty(prop))).then(newColumns => {
      setAllColumns(newColumns);
    });
  }, [requiredProps, recommendedProps]);

  // Visible, ordered columns: the view's `view-columns` order filtered to
  // properties that still exist on the class. Empty config → all class columns.
  const columns = useMemo(() => {
    if (viewColumns.length === 0) {
      return allColumns;
    }

    const bySubject = new Map(allColumns.map(c => [c.subject, c]));

    return viewColumns
      .map(subject => bySubject.get(subject))
      .filter((c): c is Property => c !== undefined);
  }, [allColumns, viewColumns]);

  const visibleSubjects = useMemo(() => columns.map(c => c.subject), [columns]);

  const reorderColumns = useCallback(
    async (sourceIndex: number, destinationIndex: number): Promise<void> => {
      const next = reorderArray(visibleSubjects, sourceIndex, destinationIndex);
      setViewColumns(next);
    },
    [visibleSubjects, setViewColumns],
  );

  const hideColumn = useCallback(
    (subject: string) => {
      setViewColumns(visibleSubjects.filter(s => s !== subject));
    },
    [visibleSubjects, setViewColumns],
  );

  const showColumn = useCallback(
    (subject: string) => {
      if (visibleSubjects.includes(subject)) {
        return;
      }

      setViewColumns([...visibleSubjects, subject]);
    },
    [visibleSubjects, setViewColumns],
  );

  return { columns, allColumns, reorderColumns, hideColumn, showColumn };
}
