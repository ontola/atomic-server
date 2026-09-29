import { calendarFields, calendarRecurrenceShortname } from '@tomic/lib';
import { Datatype, Property, Resource, Store, useStore } from '@tomic/react';
import { useRef } from 'react';
import { createPropertyOnClass } from '../Kanban/createSelectProperty';
import { calendarPropertyMatches } from './calendarOccurrences';

interface CalendarPropSpec {
  shortname: string;
  name: string;
  datatype: Datatype;
  description: string;
}

// As the atomic-plugins Event ontology defines them.

const RECURRENCE: CalendarPropSpec = {
  shortname: calendarRecurrenceShortname,
  name: 'Recurrence',
  datatype: Datatype.JSON,
  description:
    "Recurrence rule, in the JSON payload AtomicServer's calendar-recurrence reads (browser/lib/src/calendar-recurrence.ts).",
};

const START: CalendarPropSpec = {
  shortname: calendarFields.start,
  name: 'Start',
  datatype: Datatype.STRING,
  description:
    'Exact start instant of a timed event, as an RFC 3339 date-time string with its UTC offset, exactly as the provider gave it. A string rather than a timestamp, so the offset is kept.',
};

const END: CalendarPropSpec = {
  shortname: calendarFields.end,
  name: 'End',
  datatype: Datatype.STRING,
  description:
    'Exact exclusive end instant of a timed event, as an RFC 3339 date-time string with its UTC offset.',
};

/**
 * A calendar property of the table's class, found by shortname, and a way
 * to add it when the class has none. Like the date property (see
 * `useCalendarDateProp`), an existing one is adopted: the calendar's own
 * shortname, or an imported calendar's `lt-google-calendar-property-` one. A
 * native table has none until it is first needed (a row first repeats, or
 * first gets a time): then it is added to the class, with the name, datatype
 * and description the atomic-plugins Event ontology gives it, so every row of
 * the table can use it. Nothing is created just by opening the view or a row.
 */
function useCalendarProp(
  store: Store,
  tableClass: Resource,
  allColumns: Property[],
  spec: CalendarPropSpec,
) {
  const creating = useRef<Promise<string> | undefined>(undefined);
  const property = allColumns.find(p =>
    calendarPropertyMatches(p.shortname, spec.shortname),
  );

  const ensure = async () => {
    if (property) return property.subject;

    creating.current ??= createPropertyOnClass(store, tableClass, spec).catch(
      error => {
        creating.current = undefined;
        throw error;
      },
    );

    return creating.current;
  };

  return [property, ensure] as const;
}

export interface UseCalendarRowPropsResult {
  /** Where a row's series is stored. */
  recurrenceProp: Property | undefined;
  ensureRecurrenceProp: () => Promise<string>;
  /** Where a timed row's exact start and end are stored. */
  startProp: Property | undefined;
  endProp: Property | undefined;
  ensureTimeProps: () => Promise<{ start: string; end: string }>;
}

/** The calendar row properties beyond the date: recurrence and times. */
export function useCalendarRowProps(
  tableClass: Resource,
  allColumns: Property[],
): UseCalendarRowPropsResult {
  const store = useStore();
  const [recurrenceProp, ensureRecurrenceProp] = useCalendarProp(
    store,
    tableClass,
    allColumns,
    RECURRENCE,
  );
  const [startProp, ensureStart] = useCalendarProp(
    store,
    tableClass,
    allColumns,
    START,
  );
  const [endProp, ensureEnd] = useCalendarProp(
    store,
    tableClass,
    allColumns,
    END,
  );

  // One after the other: both attach to the same class.
  const ensureTimeProps = async () => {
    const start = await ensureStart();
    const end = await ensureEnd();

    return { start, end };
  };

  return {
    recurrenceProp,
    ensureRecurrenceProp,
    startProp,
    endProp,
    ensureTimeProps,
  };
}
