import { calendarRecurrenceShortname } from '@tomic/lib';
import { Datatype, Property, Resource, useStore } from '@tomic/react';
import { useRef } from 'react';
import { createPropertyOnClass } from '../Kanban/createSelectProperty';
import { calendarPropertyMatches } from './calendarOccurrences';

export interface UseCalendarRecurrencePropResult {
  /** The class's recurrence property, found by shortname, if it has one. */
  recurrenceProp: Property | undefined;
  /** The recurrence property's subject, adding it to the class first when
   * it has none. */
  ensureRecurrenceProp: () => Promise<string>;
}

/**
 * Which property holds a calendar row's series. Like the date property (see
 * `useCalendarDateProp`), an existing one on the class is adopted: the
 * calendar's own `atomic-calendar-recurrence`, or an imported calendar's
 * `lt-google-calendar-property-` one. A native table has none until a row
 * first repeats: then a "Recurrence" JSON property with that shortname, as
 * in the atomic-plugins Event ontology, is added to the class, so every row
 * of the table can use it. Nothing is created just by opening the view or a
 * row.
 */
export function useCalendarRecurrenceProp(
  tableClass: Resource,
  allColumns: Property[],
): UseCalendarRecurrencePropResult {
  const store = useStore();
  const creating = useRef<Promise<string> | undefined>(undefined);

  const recurrenceProp = allColumns.find(p =>
    calendarPropertyMatches(p.shortname, calendarRecurrenceShortname),
  );

  const ensureRecurrenceProp = async () => {
    if (recurrenceProp) return recurrenceProp.subject;

    creating.current ??= createPropertyOnClass(store, tableClass, {
      name: 'Recurrence',
      shortname: calendarRecurrenceShortname,
      datatype: Datatype.JSON,
      description:
        /* @wc-ignore */ "Recurrence rule, in the JSON payload AtomicServer's calendar-recurrence reads (browser/lib/src/calendar-recurrence.ts).",
    }).catch(error => {
      creating.current = undefined;
      throw error;
    });

    return creating.current;
  };

  return { recurrenceProp, ensureRecurrenceProp };
}
