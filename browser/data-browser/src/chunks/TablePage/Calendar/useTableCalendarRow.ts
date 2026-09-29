import { calendarFields, matchesCalendarField } from '@tomic/lib';
import type { Property, Resource } from '@tomic/react';
import { createContext } from 'react';
import type { CalendarRowContext } from './CalendarRowFields';
import { isDateProperty } from './useCalendarDateProp';
import { useCalendarRecurrenceProp } from './useCalendarRecurrenceProp';

/** The calendar's All day and End day columns, and whether `dateProp` is the
 * calendar's own Day, so they apply to it. */
export function calendarRangeColumns(
  allColumns: Property[],
  dateProp: Property | undefined,
): Pick<CalendarRowContext, 'calendarDate' | 'allDayProp' | 'endDayProp'> {
  return {
    calendarDate: matchesCalendarField(dateProp?.shortname, calendarFields.day),
    allDayProp: allColumns.find(p =>
      matchesCalendarField(p.shortname, calendarFields.allDay),
    ),
    endDayProp: allColumns.find(p =>
      matchesCalendarField(p.shortname, calendarFields.endDay),
    ),
  };
}

/**
 * The calendar fields of a table's rows, for the table view: its row dialog
 * shows the same Repeat field as the calendar's, and its cells a summary.
 * Only a class that already has a recurrence property gets them, and a row
 * repeats from the calendar's Day, else the class's first date column. Unlike
 * the calendar, a table creates no property: without a recurrence or a date
 * column this is undefined.
 */
export function useTableCalendarRow(
  tableClass: Resource,
  allColumns: Property[],
): CalendarRowContext | undefined {
  const { recurrenceProp, ensureRecurrenceProp } = useCalendarRecurrenceProp(
    tableClass,
    allColumns,
  );

  if (!recurrenceProp) return undefined;

  const dateProp =
    allColumns.find(p =>
      matchesCalendarField(p.shortname, calendarFields.day),
    ) ?? allColumns.find(isDateProperty);

  if (!dateProp) return undefined;

  return {
    dateProp,
    ...calendarRangeColumns(allColumns, dateProp),
    recurrenceProp,
    ensureRecurrenceProp,
  };
}

/** The table's {@link useTableCalendarRow}, for its cells. */
export const TableCalendarRowContext = createContext<
  CalendarRowContext | undefined
>(undefined);
