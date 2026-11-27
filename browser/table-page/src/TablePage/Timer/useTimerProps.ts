import { Datatype, Property, Resource, useStore } from '@tomic/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPropertyOnClass } from '../Kanban/createSelectProperty.js';
import { resolveTimerProperties } from './timerProperties.js';

export type TimerPropsStatus = 'resolving' | 'creating' | 'ready';

export interface UseTimerPropsResult {
  /** Timestamp Property holding each entry's start (once resolved). */
  startProp: Property | undefined;
  /** Timestamp Property holding each entry's end (once resolved). */
  endProp: Property | undefined;
  status: TimerPropsStatus;
}

/**
 * Resolves the two timestamp properties a timer view reads and writes,
 * mirroring `useCalendarDateProp` / `useKanbanGroupBy`.
 *
 * The start lives in the View's `view-group-by` slot (shared with kanban's
 * select property and calendar's date property) and the end in `view-end-prop`.
 * A stored value is only trusted when it really is a TIMESTAMP property, so a
 * view whose kind was switched kanban/calendar ↔ timer self-heals instead of
 * timing by the wrong thing — a calendar's DATE property is rejected here even
 * though it sits in the same slot.
 *
 * Precedence per role: a valid configured property wins; otherwise a class
 * property whose shortname looks like `start`/`end` is adopted; otherwise the
 * pair is created. Creation runs once per mount and only for writers.
 */
export function useTimerProps(
  tableClass: Resource,
  allColumns: Property[],
  viewGroupBy: string | undefined,
  setViewGroupBy: (property: string) => void,
  viewEndProp: string | undefined,
  setViewEndProp: (property: string) => void,
  canWrite: boolean,
  /**
   * Only a timer view may resolve — and especially may CREATE — these
   * properties. The hook is called from the table shell for every view kind,
   * so without this a kanban or calendar table would silently grow Start/End
   * columns just by being opened.
   */
  enabled: boolean,
): UseTimerPropsResult {
  const store = useStore();
  const [creating, setCreating] = useState(false);
  // Guards the create-once side effect against React re-runs / double-invoke.
  const creationStartedRef = useRef(false);

  const { start, end, storedStart, storedEnd } = useMemo(
    () => resolveTimerProperties(allColumns, viewGroupBy, viewEndProp),
    [allColumns, viewGroupBy, viewEndProp],
  );

  useEffect(() => {
    if (!enabled) {
      return;
    }

    // Adopt whichever half was only guessed, so the choice persists.
    if (start && !storedStart && canWrite) {
      setViewGroupBy(start.subject);
    }

    if (end && !storedEnd && canWrite) {
      setViewEndProp(end.subject);
    }

    if (start && end) {
      return;
    }

    // At least one half is missing — create it (or both).
    if (!canWrite || creationStartedRef.current || allColumns.length === 0) {
      return;
    }

    creationStartedRef.current = true;
    setCreating(true);

    void (async () => {
      try {
        if (!start) {
          const subject = await createPropertyOnClass(store, tableClass, {
            name: 'Start',
            datatype: Datatype.TIMESTAMP,
            description: 'When tracking of this entry started.',
          });
          setViewGroupBy(subject);
        }

        if (!end) {
          const subject = await createPropertyOnClass(store, tableClass, {
            name: 'End',
            datatype: Datatype.TIMESTAMP,
            description: 'When tracking of this entry stopped.',
          });
          setViewEndProp(subject);
        }
      } finally {
        setCreating(false);
      }
    })().catch(() => {
      // Allow a retry on the next render if creation failed.
      creationStartedRef.current = false;
      setCreating(false);
    });
    // `allColumns.length` gates the "property is missing" decision: we must wait
    // until the class's columns have actually loaded before concluding none is a
    // timestamp (an empty list is the pre-load state, not "no timestamps").
  }, [
    enabled,
    start,
    end,
    storedStart,
    storedEnd,
    canWrite,
    allColumns.length,
    store,
    tableClass,
    setViewGroupBy,
    setViewEndProp,
  ]);

  if (!enabled) {
    return { startProp: undefined, endProp: undefined, status: 'resolving' };
  }

  const status: TimerPropsStatus = creating
    ? 'creating'
    : start && end
      ? 'ready'
      : 'resolving';

  return { startProp: start, endProp: end, status };
}
