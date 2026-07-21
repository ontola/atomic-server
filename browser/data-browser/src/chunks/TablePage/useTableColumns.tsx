import {
  Resource,
  useStore,
  urls,
  useArray,
  Property,
  Datatype,
} from '@tomic/react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { reorderArray } from '@chunks/TableEditor';
import { useDeclaredLanguages } from '../../hooks/useDeclaredLanguages';

/**
 * A rendered grid column. Usually one per property, but a LocalizedText
 * property with split-by-language enabled expands into one column per
 * language tag.
 */
export type TableColumn = {
  property: Property;
  /** Set when this column shows a single language of a LocalizedText property. */
  languageTag?: string;
  /** Stable identity: the property subject, suffixed with the tag when split. */
  key: string;
};

type UseTableColumnsReturnType = {
  /** The columns shown in the grid: visible, in the view's display order. */
  columns: TableColumn[];
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
 * visibility, and expands split LocalizedText properties into one column per
 * declared language. Reorder/hide/show write to the View (via
 * `setViewColumns`), not the class, so they're scoped to the view.
 */
export function useTableColumns(
  tableClass: Resource,
  viewColumns: string[],
  setViewColumns: (columns: string[]) => void,
  splitLanguages: string[],
): UseTableColumnsReturnType {
  const store = useStore();
  const declaredLanguages = useDeclaredLanguages();

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
  // properties that still exist on the class. Empty config → all class
  // columns. A split LocalizedText property expands into one column per
  // language tag of the drive's declared language set.
  const columns = useMemo(() => {
    const ordered =
      viewColumns.length === 0
        ? allColumns
        : (() => {
            const bySubject = new Map(allColumns.map(c => [c.subject, c]));

            return viewColumns
              .map(subject => bySubject.get(subject))
              .filter((c): c is Property => c !== undefined);
          })();

    const languageTags = declaredLanguages ?? ['en'];

    return ordered.flatMap((property): TableColumn[] => {
      if (
        property.datatype === Datatype.LOCALIZEDTEXT &&
        splitLanguages.includes(property.subject)
      ) {
        return languageTags.map(tag => ({
          property,
          languageTag: tag,
          key: `${property.subject}#${tag}`,
        }));
      }

      return [{ property, key: property.subject }];
    });
  }, [allColumns, viewColumns, splitLanguages, declaredLanguages]);

  // The visible property subjects in display order (split columns collapse
  // back into their single property) — the unit `view-columns` stores.
  const visibleSubjects = useMemo(
    () => Array.from(new Set(columns.map(c => c.property.subject))),
    [columns],
  );

  const reorderColumns = useCallback(
    async (sourceIndex: number, destinationIndex: number): Promise<void> => {
      // The grid hands us rendered-column indexes; translate them to
      // property positions so dragging a split column moves the whole
      // property.
      const source = columns[sourceIndex]?.property.subject;
      const destination = columns[destinationIndex]?.property.subject;

      if (
        source === undefined ||
        destination === undefined ||
        source === destination
      ) {
        return;
      }

      const next = reorderArray(
        visibleSubjects,
        visibleSubjects.indexOf(source),
        visibleSubjects.indexOf(destination),
      );
      setViewColumns(next);
    },
    [columns, visibleSubjects, setViewColumns],
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
