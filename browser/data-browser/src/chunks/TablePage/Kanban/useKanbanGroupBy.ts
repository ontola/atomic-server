import {
  Datatype,
  Property,
  Resource,
  dataBrowser,
  useStore,
} from '@tomic/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  createSelectPropertyOnClass,
  DEFAULT_STATUS_TAGS,
} from './createSelectProperty';

export type KanbanGroupByStatus = 'resolving' | 'creating' | 'ready';

export interface UseKanbanGroupByResult {
  /** The SelectProperty subject whose tags define the columns (once resolved). */
  groupBy: string | undefined;
  status: KanbanGroupByStatus;
}

/** A select/enum property = resourceArray of Tags. These become kanban columns. */
function isSelectProperty(property: Property): boolean {
  return (
    property.datatype === Datatype.RESOURCEARRAY &&
    property.classType === dataBrowser.classes.tag
  );
}

/**
 * Resolves which property a kanban view groups its cards by.
 *
 * Precedence: an explicitly-configured `view-group-by` wins. Otherwise the
 * first select/enum property already on the class is adopted. If the class has
 * no enum property at all, a "Status" one (Todo/Doing/Done) is created and
 * adopted — the user opted into silent creation. Creation runs once per mount
 * and only for writers.
 */
export function useKanbanGroupBy(
  tableClass: Resource,
  allColumns: Property[],
  viewGroupBy: string | undefined,
  setViewGroupBy: (property: string) => void,
  canWrite: boolean,
): UseKanbanGroupByResult {
  const store = useStore();
  const [creating, setCreating] = useState(false);
  // Guards the create-once side effect against React re-runs / double-invoke.
  const creationStartedRef = useRef(false);

  const existingSelect = useMemo(
    () => allColumns.find(isSelectProperty),
    [allColumns],
  );

  // If a group-by is already set, trust it. Otherwise adopt an existing enum
  // property if there is one — persisted so it stays stable across reloads.
  const resolved = viewGroupBy ?? existingSelect?.subject;

  useEffect(() => {
    if (viewGroupBy) {
      return;
    }

    if (existingSelect) {
      if (canWrite) {
        setViewGroupBy(existingSelect.subject);
      }

      return;
    }

    // No enum property anywhere — create the default Status one.
    if (!canWrite || creationStartedRef.current || allColumns.length === 0) {
      return;
    }

    creationStartedRef.current = true;
    setCreating(true);

    void (async () => {
      try {
        const subject = await createSelectPropertyOnClass(store, tableClass, {
          name: 'Status',
          tags: DEFAULT_STATUS_TAGS,
        });
        setViewGroupBy(subject);
      } finally {
        setCreating(false);
      }
    })().catch(() => {
      // Allow a retry on the next render if creation failed.
      creationStartedRef.current = false;
      setCreating(false);
    });
    // `allColumns.length` gates the "no enum property" decision: we must wait
    // until the class's columns have actually loaded before concluding none is
    // a select property (an empty list is the pre-load state, not "no enums").
  }, [
    viewGroupBy,
    existingSelect,
    canWrite,
    allColumns.length,
    store,
    tableClass,
    setViewGroupBy,
  ]);

  const status: KanbanGroupByStatus = creating
    ? 'creating'
    : resolved
      ? 'ready'
      : 'resolving';

  return { groupBy: resolved, status };
}
