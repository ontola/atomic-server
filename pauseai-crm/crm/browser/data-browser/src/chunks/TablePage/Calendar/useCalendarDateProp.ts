import { Datatype, Property, Resource, useStore } from '@tomic/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPropertyOnClass } from '../Kanban/createSelectProperty';

export type CalendarDatePropStatus = 'resolving' | 'creating' | 'ready';

export interface UseCalendarDatePropResult {
  /** The date/timestamp Property whose values place rows on days (once resolved). */
  dateProp: Property | undefined;
  status: CalendarDatePropStatus;
}

/** A property whose values can be bucketed into calendar days. */
export function isDateProperty(property: Property): boolean {
  return (
    property.datatype === Datatype.DATE ||
    property.datatype === Datatype.TIMESTAMP
  );
}

/**
 * Resolves which property a calendar view places its rows by, mirroring
 * `useKanbanGroupBy`. The View's `view-group-by` slot is shared with kanban
 * (which stores a select property there), so a stored value is only trusted
 * when it actually is a date-like property — a view whose kind was switched
 * kanban ↔ calendar self-heals instead of grouping by the wrong thing.
 *
 * Precedence: a valid configured `view-group-by` wins. Otherwise the first
 * date/timestamp property already on the class is adopted. If the class has
 * none, a "Date" property is created and adopted — the user opted into silent
 * creation. Creation runs once per mount and only for writers.
 */
export function useCalendarDateProp(
  tableClass: Resource,
  allColumns: Property[],
  viewGroupBy: string | undefined,
  setViewGroupBy: (property: string) => void,
  canWrite: boolean,
): UseCalendarDatePropResult {
  const store = useStore();
  const [creating, setCreating] = useState(false);
  // Guards the create-once side effect against React re-runs / double-invoke.
  const creationStartedRef = useRef(false);

  const storedDate = useMemo(
    () => allColumns.find(c => c.subject === viewGroupBy && isDateProperty(c)),
    [allColumns, viewGroupBy],
  );

  const existingDate = useMemo(
    () => allColumns.find(isDateProperty),
    [allColumns],
  );

  const resolved = storedDate ?? existingDate;

  useEffect(() => {
    if (storedDate) {
      return;
    }

    if (existingDate) {
      if (canWrite) {
        setViewGroupBy(existingDate.subject);
      }

      return;
    }

    // No date property anywhere — create the default one.
    if (!canWrite || creationStartedRef.current || allColumns.length === 0) {
      return;
    }

    creationStartedRef.current = true;
    setCreating(true);

    void (async () => {
      try {
        const subject = await createPropertyOnClass(store, tableClass, {
          name: 'Date',
          datatype: Datatype.DATE,
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
    // `allColumns.length` gates the "no date property" decision: we must wait
    // until the class's columns have actually loaded before concluding none is
    // a date property (an empty list is the pre-load state, not "no dates").
  }, [
    storedDate,
    existingDate,
    canWrite,
    allColumns.length,
    store,
    tableClass,
    setViewGroupBy,
  ]);

  const status: CalendarDatePropStatus = creating
    ? 'creating'
    : resolved
      ? 'ready'
      : 'resolving';

  return { dateProp: resolved, status };
}
